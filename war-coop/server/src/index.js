import express from 'express';
import { makePool, migrate } from './db.js';
import { createGame, joinGame, gameView, REGIONS } from './game.js';
import { ROLE_LABEL } from './seats.js';
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

const app = express();
app.use(express.json());
app.use('/static', express.static(path.join(here, '..', 'public')));

app.get('/api/healthz', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
});
app.get('/api/game', async (_req, res) => res.json(await gameView(pool, await currentGameId())));
app.get('/api/regions', (_req, res) => res.json(REGIONS.map(({ id, owner, name, tag, area, rear, adj, cx, cy }) => ({ id, owner, name, tag, area, rear, adj, cx, cy }))));
app.post('/api/join', async (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 24);
  if (!name) return res.status(400).json({ error: '請輸入暱稱' });
  // 預覽期身分:暱稱即身分(同名視為同一人)。之後換成 Discord OAuth。
  const out = await joinGame(pool, await currentGameId(), { discordId: `preview:${name.toLowerCase()}`, name });
  res.json({ side: out.seat.side, role: out.seat.role, roleLabel: ROLE_LABEL[out.seat.role], already: out.already });
});

const sideName = { DE: '德意志帝國', FR: '法蘭西共和國' };
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
<div class="card"><b>加入戰局</b><p class="muted">系統自動分邊:先補滿各隊三個核心職位(統帥、參謀長、後勤官),之後加入的都是一般軍官。</p>
<input id="n" placeholder="你的暱稱" maxlength="24"> <button onclick="j()">加入</button><div id="msg"></div></div>
<script>async function j(){const name=document.getElementById('n').value;const r=await fetch('/api/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});const d=await r.json();
document.getElementById('msg').textContent=d.error||((d.already?'你已在局內:':'加入成功:')+(d.side==='DE'?'德意志帝國':'法蘭西共和國')+' · '+d.roleLabel);if(!d.error)setTimeout(()=>location.reload(),900)}</script>`);
});

// 路由內未捕捉的錯誤:回 500,不讓程序死掉
app.use((err, _req, res, _next) => { console.error('route error:', err.message); res.status(500).json({ error: '伺服器錯誤' }); });
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message ?? e));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log('war-coop listening on', port));
