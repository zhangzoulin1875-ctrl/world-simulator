import { randomBytes, createHash } from 'node:crypto';

export const COOKIE = 'wc_session';
export const STATE_COOKIE = 'wc_oauth_state';
const TTL_DAYS = 30;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** 簡單的 cookie 解析(不引入額外套件) */
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* 忽略壞 cookie */ } }
  }
  return out;
}

function cookieStr(name, value, { maxAgeSec, secure }) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
export const isSecure = (req) => req.protocol === 'https';

export async function createSession(pool, playerId) {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO sessions(token_hash, player_id, expires_at) VALUES ($1,$2, now() + ($3 || ' days')::interval)`,
    [sha256(token), playerId, String(TTL_DAYS)]);
  return token;
}
export const setSessionCookie = (req, res, token) => res.append('Set-Cookie', cookieStr(COOKIE, token, { maxAgeSec: TTL_DAYS * 86400, secure: isSecure(req) }));
export const clearSessionCookie = (req, res) => res.append('Set-Cookie', cookieStr(COOKIE, '', { maxAgeSec: 0, secure: isSecure(req) }));
export const setStateCookie = (req, res, state) => res.append('Set-Cookie', cookieStr(STATE_COOKIE, state, { maxAgeSec: 600, secure: isSecure(req) }));
export const clearStateCookie = (req, res) => res.append('Set-Cookie', cookieStr(STATE_COOKIE, '', { maxAgeSec: 0, secure: isSecure(req) }));

/** 由請求取得目前登入的玩家(沒登入或過期回 null) */
export async function playerFromRequest(pool, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const r = await pool.query(
    `SELECT p.* FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]);
  return r.rows[0] ?? null;
}
export async function deleteSession(pool, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}
export const purgeExpiredSessions = (pool) => pool.query('DELETE FROM sessions WHERE expires_at <= now()');
