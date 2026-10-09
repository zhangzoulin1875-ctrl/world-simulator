import express from 'express';
import { makePool, migrate } from './db.js';
import { createGame, joinGame, gameView, REGIONS } from './game.js';
import { ROLE_LABEL } from './seats.js';
import { randomBytes } from 'node:crypto';
import { oauthConfig, authorizeUrl, exchangeCode, fetchUser } from './discord.js';
import { parseCookies, STATE_COOKIE, createSession, setSessionCookie, clearSessionCookie, setStateCookie, clearStateCookie, playerFromRequest, deleteSession, purgeExpiredSessions } from './session.js';
import { upsertDiscordPlayer, setNickname, publicPlayer } from './players.js';
import { startGame, submitOrder, assignArmy, settleTurn, dueGames, MAP } from './battle.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const pool = process.env.USE_PGLITE ? await (await import('./test-pool.js')).makePglitePool() : makePool();
await migrate(pool);

// 確保至少有一場遊戲(預覽期:單局)
async function currentGameId() {
  const r = await pool.query("SELECT id FROM games WHERE status <> 'finished' ORDER BY id LIMIT 1");
  return r.rows[0]?.id ?? (await createGame(pool)).id;
}
await currentGameId();
await purgeExpiredSessions(pool).catch(() => {});

const app = express();
app.use(express.json());
app.use('/static', express.static(path.join(here, '..', 'public')));

app.get('/api/healthz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
app.get('/api/game', async (_req, res) => res.json(await gameView(pool, await currentGameId())));
app.get('/api/regions', (_req, res) => res.json(REGIONS.map(({ id, owner, name, tag, area, rear, adj, cx, cy }) => ({ id, owner, name, tag, area, rear, adj, cx, cy }))));
// ── Discord 登入 ────────────────────────────────────────────
// redirect URI 優先用 PUBLIC_URL(Render 上固定),否則由請求推得
const redirectUri = (req) => `${(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '')}/auth/discord/callback`;
app.set('trust proxy', 1);   // Render 在反向代理後,才能得到正確的 https

app.get('/auth/discord/login', (req, res) => {
  const state = randomBytes(16).toString('hex');
  const url = authorizeUrl({ redirectUri: redirectUri(req), state });
  if (!url) return res.status(503).type('text').send('Discord 登入尚未設定');
  setStateCookie(req, res, state);
  res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
  const page = (status, msg) => res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#14171c;color:#e8e6e1;text-align:center;padding:40px"><p>${msg}</p><p><a style="color:#c9a24b" href="/">回首頁</a></p>`);
  try {
    const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
    clearStateCookie(req, res);
    if (req.query.error) return page(400, '已取消授權。');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state || !expected || state !== expected) return page(400, '驗證失敗(state 不符),請重新登入。');
    const token = await exchangeCode({ code, redirectUri: redirectUri(req) });
    const user = await fetchUser(token.access_token);
    const player = await upsertDiscordPlayer(pool, user);
    setSessionCookie(req, res, await createSession(pool, player.id));
    res.redirect('/');
  } catch (e) { console.error('discord callback:', e.message); page(500, '登入過程發生錯誤,請稍後再試。'); }
});

app.post('/auth/logout', async (req, res) => { await deleteSession(pool, req); clearSessionCookie(req, res); res.json({ ok: true }); });

app.get('/api/me', async (req, res) => {
  const p = await playerFromRequest(pool, req);
  res.json({ discordEnabled: !!oauthConfig(), authenticated: !!p, player: publicPlayer(p) });
});

app.post('/api/nickname', async (req, res) => {
  const p = await playerFromRequest(pool, req);
  if (!p) return res.status(401).json({ error: '請先登入 Discord' });
  const r = await setNickname(pool, p.id, req.body?.nickname);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ player: publicPlayer(r.player) });
});

// ── 加入戰局 ────────────────────────────────────────────────
// Discord 已設定:必須登入且已有暱稱,身分取自 session(不信任請求內容)。
// 未設定:維持預覽期的暱稱加入,讓尚未接 Discord 的部署不壞。
app.post('/api/join', async (req, res) => {
  const gameId = await currentGameId();
  let who;
  if (oauthConfig()) {
    const p = await playerFromRequest(pool, req);
    if (!p) return res.status(401).json({ error: '請先登入 Discord' });
    if (!p.name) return res.status(409).json({ error: '請先設定遊戲暱稱', needNickname: true });
    who = { playerId: p.id };
  } else {
    const name = String(req.body?.name ?? '').trim().slice(0, 24);
    if (!name) return res.status(400).json({ error: '請輸入暱稱' });
    who = { discordId: `preview:${name.toLowerCase()}`, name };
  }
  const out = await joinGame(pool, gameId, who);
  res.json({ side: out.seat.side, role: out.seat.role, roleLabel: ROLE_LABEL[out.seat.role], already: out.already });
});

const sideName = { DE: '德意志帝國', FR: '法蘭西共和國' };

// ── 戰局:狀態、命令、分配 ───────────────────────────────────
// 取得目前玩家在本局的席位(需登入;預覽模式沒有 session,命令功能只在 Discord 模式開放)
async function mySeat(req) {
  const p = await playerFromRequest(pool, req);
  if (!p) return null;
  const gameId = await currentGameId();
  const seat = (await pool.query('SELECT * FROM seats WHERE game_id=$1 AND player_id=$2', [gameId, p.id])).rows[0];
  return seat ? { ...seat, gameId } : null;
}
const needSeat = async (req, res) => {
  const seat = await mySeat(req);
  if (!seat) { res.status(401).json({ error: '請先登入並加入戰局' }); return null; }
  return seat;
};

// 地圖狀態:全局可見的部分(區域歸屬、日誌)+ 己方軍團(敵方軍團只在與己方相鄰時可見 = 戰爭迷霧)
app.get('/api/state', async (req, res) => {
  const gameId = await currentGameId();
  const seat = await mySeat(req);
  const g = (await pool.query('SELECT id,status,turn,turn_hours,next_turn_at,winner_side,belgium_invaded FROM games WHERE id=$1', [gameId])).rows[0];
  const regions = (await pool.query('SELECT region_id, owner FROM region_state WHERE game_id=$1', [gameId])).rows;
  const all = (await pool.query('SELECT id,side,name,region_id,strength,supply,pinned,assigned_seat FROM armies WHERE game_id=$1 ORDER BY id', [gameId])).rows;
  let armies = [];
  if (seat) {
    const mine = all.filter((a) => a.side === seat.side);
    const seen = new Set();   // 己方軍團所在區 + 其相鄰區 = 視野
    for (const a of mine) { seen.add(a.region_id); for (const n of MAP.by.get(a.region_id).adj) seen.add(n); }
    armies = [...mine, ...all.filter((a) => a.side !== seat.side && seen.has(a.region_id)).map(({ supply, assigned_seat, ...pub }) => pub)];
  }
  const log = (await pool.query('SELECT turn, summary FROM turn_log WHERE game_id=$1 ORDER BY id DESC LIMIT 20', [gameId])).rows;
  res.json({ game: g, regions, armies, log, me: seat && { seatId: seat.id, side: seat.side, role: seat.role } });
});

app.post('/api/orders', async (req, res) => {
  const seat = await needSeat(req, res); if (!seat) return;
  const { armyId, kind, target } = req.body ?? {};
  const r = await submitOrder(pool, seat.gameId, seat, { armyId: Number(armyId), kind, target: target == null ? null : Number(target) });
  r.ok ? res.json(r) : res.status(r.status).json({ error: r.error });
});

// 我這回合已下的命令(只看得到自己隊的)
app.get('/api/orders', async (req, res) => {
  const seat = await needSeat(req, res); if (!seat) return;
  const g = (await pool.query('SELECT turn FROM games WHERE id=$1', [seat.gameId])).rows[0];
  const rows = (await pool.query(
    `SELECT o.army_id, o.kind, o.target_region, o.seat_id FROM orders o JOIN armies a ON a.id=o.army_id
     WHERE o.game_id=$1 AND o.turn=$2 AND a.side=$3`, [seat.gameId, g.turn, seat.side])).rows;
  res.json({ turn: g.turn, orders: rows });
});

app.post('/api/assign', async (req, res) => {
  const seat = await needSeat(req, res); if (!seat) return;
  const r = await assignArmy(pool, seat.gameId, seat, { armyId: Number(req.body?.armyId), toSeatId: req.body?.toSeatId == null ? null : Number(req.body.toSeatId) });
  r.ok ? res.json(r) : res.status(r.status).json({ error: r.error });
});

// 開始遊戲:僅統帥可按(兩隊統帥任一人),至少每隊各 1 人
app.post('/api/start', async (req, res) => {
  const seat = await needSeat(req, res); if (!seat) return;
  if (seat.role !== 'commander') return res.status(403).json({ error: '只有統帥能開始戰局' });
  const sides = (await pool.query('SELECT side, count(*)::int n FROM seats WHERE game_id=$1 GROUP BY side', [seat.gameId])).rows;
  if (sides.length < 2) return res.status(409).json({ error: '雙方都至少要有 1 名玩家才能開始' });
  const r = await startGame(pool, seat.gameId);
  r.ok ? res.json(r) : res.status(r.status).json({ error: r.error });
});

// ── 排程:每分鐘檢查到期的回合並結算 ─────────────────────────
// 只在單一實例上跑(Render 免費方案本來就只有一個實例)。結算本身以「回合號比對 + 行鎖」保證不重複。
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    for (const g of await dueGames(pool)) {
      const r = await settleTurn(pool, g.id, g.turn);
      if (r.ok) console.log(`回合 ${r.settledTurn} 結算完成(命令 ${r.ordersApplied} 條)${r.winner ? ',勝者 ' + r.winner : ''}`);
    }
  } catch (e) { console.error('排程結算錯誤:', e.message); } finally { ticking = false; }
}
if (!process.env.DISABLE_SCHEDULER) setInterval(tick, 60_000).unref();

app.get('/', async (_req, res) => {
  const v = await gameView(pool, await currentGameId());
  const card = (s) => `<div class="card"><h2>${sideName[s]}</h2><p class="muted">${v.sides[s].members} 人</p>
    <ul>${Object.entries(v.sides[s].core).map(([r, n]) => `<li><b>${ROLE_LABEL[r]}</b>:${n ?? '<span class="muted">空缺</span>'}</li>`).join('')}</ul>
    <p class="muted">一般軍官 ${v.sides[s].officers.length} 人${v.sides[s].officers.length ? ':' + v.sides[s].officers.join('、') : ''}</p></div>`;
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>戰爭合作遊戲 · 1914 西線</title><style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:0 auto;padding:16px;background:#14171c;color:#e8e6e1}
.card{background:#1d2229;border-radius:10px;padding:14px;margin:10px 0}h1{font-size:20px}h2{margin:0 0 4px;font-size:17px}
.muted{color:#8b929c;font-size:13px}ul{padding-left:18px}img{width:100%;border-radius:10px}
input,button{font-size:16px;padding:10px;border-radius:8px;border:0}input{width:60%}button{background:#c9a24b;color:#111;font-weight:600}
#msg{margin-top:8px}</style>
<h1>戰爭合作遊戲 · 1914 德法西線</h1>
<p class="muted">第 ${v.game.turn} 回合 · 狀態:${v.game.status} · 每回合 ${v.game.turn_hours} 小時 · 勝利條件:攻佔對方首都</p>
<img src="/static/map.png" alt="戰略區地圖">
<p class="muted">地圖共 ${REGIONS.length} 區 · 德控 ${v.regionsByOwner.DE ?? 0} · 法控 ${v.regionsByOwner.FR ?? 0} · 比 ${v.regionsByOwner.BE ?? 0} · 盧 ${v.regionsByOwner.LU ?? 0}</p>
${card('DE')}${card('FR')}
<div class="card" id="join"><b>加入戰局</b><div id="box" class="muted">載入中…</div></div>
<script>
const $=(i)=>document.getElementById(i), side=(s)=>s==='DE'?'德意志帝國':'法蘭西共和國';
const esc=(t)=>String(t).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});return {ok:r.ok,status:r.status,data:await r.json().catch(()=>({}))}}
function say(t,bad){const m=$('msg');if(m){m.textContent=t;m.style.color=bad?'#e08a8a':'#9fd19f'}}
async function render(){
  const me=await (await fetch('/api/me')).json(), box=$('box');
  if(!me.discordEnabled){ // 預覽模式:尚未設定 Discord
    box.innerHTML='<p class="muted">預覽模式(尚未啟用 Discord 登入):用暱稱直接加入。</p><input id="n" placeholder="你的暱稱" maxlength="24"> <button id="go">加入</button><div id="msg"></div>';
    $('go').onclick=async()=>{const r=await api('/api/join',{name:$('n').value});done(r)};return}
  if(!me.authenticated){
    box.innerHTML='<p class="muted">用 Discord 登入後,綁定你的遊戲暱稱再加入戰局。</p><a href="/auth/discord/login"><button>以 Discord 登入</button></a>';return}
  const p=me.player;
  const who='<p class="muted">Discord:'+esc(p.discordName||'')+(p.nickname?' · 遊戲暱稱:<b style="color:#e8e6e1">'+esc(p.nickname)+'</b>':'')+' · <a href="#" id="out" style="color:#8b929c">登出</a></p>';
  if(!p.nickname){
    box.innerHTML=who+'<p>先取一個遊戲暱稱(2~16 字,全隊都會看到,改名有 24 小時冷卻):</p><input id="n" maxlength="16" placeholder="遊戲暱稱"> <button id="nk">確定</button><div id="msg"></div>';
    $('nk').onclick=async()=>{const r=await api('/api/nickname',{nickname:$('n').value});r.ok?render():say(r.data.error||'失敗',true)};
  }else{
    box.innerHTML=who+'<button id="go">加入戰局</button> <button id="rn" style="background:#2b323c;color:#e8e6e1">改暱稱</button><div id="msg"></div>';
    $('go').onclick=async()=>{done(await api('/api/join'))};
    $('rn').onclick=()=>{box.innerHTML=who+'<input id="n" maxlength="16" value="'+esc(p.nickname)+'"> <button id="nk">儲存</button> <button id="cx" style="background:#2b323c;color:#e8e6e1">取消</button><div id="msg"></div>';
      $('nk').onclick=async()=>{const r=await api('/api/nickname',{nickname:$('n').value});r.ok?render():say(r.data.error||'失敗',true)};$('cx').onclick=render};
  }
  $('out').onclick=async(e)=>{e.preventDefault();await api('/auth/logout');render()};
}
function done(r){if(r.ok){say((r.data.already?'你已在局內:':'加入成功:')+side(r.data.side)+' · '+r.data.roleLabel);setTimeout(()=>location.reload(),900)}else say(r.data.error||'失敗',true)}
render();
</script>`);
});

// 路由內未捕捉的錯誤:回 500,不讓程序死掉
app.use((err, _req, res, _next) => { console.error('route error:', err.message); res.status(500).json({ error: '伺服器錯誤' }); });
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message ?? e));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log('war-coop listening on', port));
