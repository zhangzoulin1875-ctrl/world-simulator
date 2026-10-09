import { validateNickname } from './nickname.js';

/** Discord 登入後建立或更新玩家。新玩家暱稱暫時為 null(必須先取名才能加入戰局)。 */
export async function upsertDiscordPlayer(pool, u) {
  const r = await pool.query(
    `INSERT INTO players(discord_id, name, discord_username, avatar)
     VALUES ($1, NULL, $2, $3)
     ON CONFLICT (discord_id) DO UPDATE SET discord_username = EXCLUDED.discord_username, avatar = EXCLUDED.avatar
     RETURNING *`,
    [u.id, u.globalName || u.username, u.avatar]);
  return r.rows[0];
}

const COOLDOWN_HOURS = 24;   // 改名冷卻,避免洗名字冒充

/** 綁定/更改遊戲暱稱。回傳 { ok, player } 或 { ok:false, status, error } */
export async function setNickname(pool, playerId, raw) {
  const v = validateNickname(raw);
  if (!v.ok) return { ok: false, status: 400, error: v.error };

  const me = (await pool.query('SELECT * FROM players WHERE id=$1', [playerId])).rows[0];
  if (!me) return { ok: false, status: 404, error: '找不到玩家' };
  if (me.name === v.nickname) return { ok: true, player: me, unchanged: true };

  // 改名冷卻(第一次取名不受限)
  if (me.name && me.nickname_changed_at) {
    const waitMs = new Date(me.nickname_changed_at).getTime() + COOLDOWN_HOURS * 3600e3 - Date.now();
    if (waitMs > 0) return { ok: false, status: 429, error: `改名冷卻中,請 ${Math.ceil(waitMs / 3600e3)} 小時後再試` };
  }

  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // 預覽期身分('preview:' 開頭)占著的名字:沒有 Discord 綁定,視為可回收
    await c.query(
      `UPDATE players SET name = name || '#' || id WHERE lower(name) = lower($1) AND discord_id LIKE 'preview:%' AND id <> $2`,
      [v.nickname, playerId]);
    const r = await c.query(
      `UPDATE players SET name=$1, nickname_changed_at=now() WHERE id=$2 RETURNING *`, [v.nickname, playerId]);
    await c.query('COMMIT');
    return { ok: true, player: r.rows[0] };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return { ok: false, status: 409, error: '這個暱稱已被使用' };
    throw e;
  } finally { c.release(); }
}

export const publicPlayer = (p) => p && ({
  id: p.id, nickname: p.name, discordName: p.discord_username, avatar: p.avatar,
  avatarUrl: p.avatar && p.discord_id && !p.discord_id.startsWith('preview:')
    ? `https://cdn.discordapp.com/avatars/${p.discord_id}/${p.avatar}.png?size=64` : null,
});
