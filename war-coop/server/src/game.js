import { assignSeat, CORE_ROLES } from './seats.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REGIONS = JSON.parse(readFileSync(path.join(here, '..', 'map', 'regions.json'), 'utf8'));
export const CAPITALS = { DE: REGIONS.find((r) => r.tag === 'capital_de')?.id, FR: REGIONS.find((r) => r.tag === 'capital_fr')?.id };

/** 建立一場遊戲,並用 1914 初始國別寫入所有區域 */
export async function createGame(pool, scenario = 'ww1-west-1914') {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const g = (await c.query("INSERT INTO games(scenario) VALUES ($1) RETURNING *", [scenario])).rows[0];
    const vals = REGIONS.map((r, i) => `($1,$${i * 2 + 2},$${i * 2 + 3})`).join(',');
    await c.query(`INSERT INTO region_state(game_id,region_id,owner) VALUES ${vals}`, [g.id, ...REGIONS.flatMap((r) => [r.id, r.owner])]);
    await c.query('COMMIT');
    return g;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

/** 加入遊戲:自動分邊與職位。已在局內則回傳原席位。
 *  並發安全:兩人同時搶同一核心席位時,唯一索引會擋下後者,這裡重試(最多 5 次)重新分配。 */
export async function joinGame(pool, gameId, player) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const p = (await c.query(
        `INSERT INTO players(discord_id,name) VALUES ($1,$2)
         ON CONFLICT (discord_id) DO UPDATE SET name = EXCLUDED.name RETURNING *`, [player.discordId, player.name])).rows[0];
      const exist = (await c.query('SELECT * FROM seats WHERE game_id=$1 AND player_id=$2', [gameId, p.id])).rows[0];
      if (exist) { await c.query('COMMIT'); return { seat: exist, already: true }; }
      const seats = (await c.query('SELECT side, role FROM seats WHERE game_id=$1', [gameId])).rows;
      const { side, role } = assignSeat(seats);
      const seat = (await c.query(
        'INSERT INTO seats(game_id,player_id,side,role) VALUES ($1,$2,$3,$4) RETURNING *', [gameId, p.id, side, role])).rows[0];
      await c.query('COMMIT');
      return { seat, already: false };
    } catch (e) {
      await c.query('ROLLBACK');
      if (e.code === '23505' && attempt < 4) continue;   // 唯一衝突:有人搶先,重算
      throw e;
    } finally { c.release(); }
  }
}

export async function gameView(pool, gameId) {
  const g = (await pool.query('SELECT * FROM games WHERE id=$1', [gameId])).rows[0];
  if (!g) return null;
  const seats = (await pool.query(
    `SELECT s.side, s.role, p.name FROM seats s JOIN players p ON p.id=s.player_id WHERE s.game_id=$1 ORDER BY s.side, s.id`, [gameId])).rows;
  const owners = (await pool.query('SELECT owner, count(*)::int n FROM region_state WHERE game_id=$1 GROUP BY owner', [gameId])).rows;
  const view = { game: g, capitals: CAPITALS, regionsByOwner: Object.fromEntries(owners.map((o) => [o.owner, o.n])), sides: {} };
  for (const side of ['DE', 'FR']) {
    const ss = seats.filter((s) => s.side === side);
    view.sides[side] = {
      members: ss.length,
      core: Object.fromEntries(CORE_ROLES.map((r) => [r, ss.find((s) => s.role === r)?.name ?? null])),
      officers: ss.filter((s) => s.role === 'officer').map((s) => s.name),
    };
  }
  return view;
}
