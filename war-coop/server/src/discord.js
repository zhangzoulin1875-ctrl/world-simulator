// Discord OAuth2(只用 identify scope:新遊戲只需要知道「你是誰」)。
// Discord 的 access token 只在換取使用者資料時暫用,絕不存入資料庫。
// DISCORD_API_BASE 僅供測試(指向假的 Discord 伺服器);正式環境不設,走官方網址
const API = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';

export function oauthConfig() {
  const clientId = process.env.DISCORD_CLIENT_ID?.trim();
  const clientSecret = process.env.DISCORD_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function authorizeUrl({ redirectUri, state }) {
  const cfg = oauthConfig();
  if (!cfg) return null;
  const p = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'identify', state, prompt: 'none' });
  return `https://discord.com/oauth2/authorize?${p}`;
}

export async function exchangeCode({ code, redirectUri }) {
  const cfg = oauthConfig();
  if (!cfg) throw new Error('Discord OAuth 未設定');
  const res = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Discord token 交換失敗 (${res.status})`);
  return res.json();
}

export async function fetchUser(accessToken) {
  const res = await fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`讀取 Discord 使用者失敗 (${res.status})`);
  const j = await res.json();
  return { id: String(j.id), username: String(j.username ?? ''), globalName: j.global_name ?? null, avatar: j.avatar ?? null };
}
