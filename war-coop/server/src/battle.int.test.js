// 整合測試:用內嵌 PGlite 跑真實 SQL(開局、命令、結算、並發)。
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePglitePool } from './test-pool.js';
import { migrate } from './db.js';
import { createGame, joinGame, REGIONS } from './game.js';
import { startGame, submitOrder, assignArmy, settleTurn, dueGames, MAP } from './battle.js';

async function setup(nPlayers = 4) {
  const pool = await makePglitePool(); await migrate(pool);
  const g = await createGame(pool);
  const seats = [];
  for (let i = 0; i < nPlayers; i++) seats.push((await joinGame(pool, g.id, { discordId: `preview:p${i}`, name: `P${i}` })).seat);
  return { pool, g, seats };
}
const seatOf = (seats, side, role) => seats.find((s) => s.side === side && s.role === role);

test('開局:建 12 支軍團、守備、第 1 回合、排定下次結算時間;不能重複開局', async () => {
  const { pool, g } = await setup();
  assert.equal((await startGame(pool, g.id)).ok, true);
  const gg = (await pool.query('SELECT * FROM games WHERE id=$1', [g.id])).rows[0];
  assert.equal(gg.status, 'running'); assert.equal(gg.turn, 1); assert.ok(gg.next_turn_at);
  assert.equal(Object.keys(gg.garrisons).length >= 2, true, '首都與要塞有守備');
  assert.equal((await pool.query('SELECT count(*)::int n FROM armies WHERE game_id=$1', [g.id])).rows[0].n, 12);
  const again = await startGame(pool, g.id); assert.equal(again.ok, false); assert.equal(again.status, 409);
});

test('命令:統帥可下令;後勤官不可攻擊;軍官未分配不可;分配後可', async () => {
  const { pool, g, seats } = await setup(8);
  await startGame(pool, g.id);
  const cmd = seatOf(seats, 'DE', 'commander'), qm = seatOf(seats, 'DE', 'quartermaster'), off = seats.find((s) => s.side === 'DE' && s.role === 'officer');
  const army = (await pool.query(`SELECT * FROM armies WHERE game_id=$1 AND side='DE' ORDER BY id LIMIT 1`, [g.id])).rows[0];
  const adj = MAP.by.get(army.region_id).adj[0];
  assert.equal((await submitOrder(pool, g.id, cmd, { armyId: army.id, kind: 'move', target: adj })).ok, true);
  const q = await submitOrder(pool, g.id, qm, { armyId: army.id, kind: 'attack', target: adj }); assert.equal(q.status, 403);
  assert.equal((await submitOrder(pool, g.id, qm, { armyId: army.id, kind: 'hold' })).ok, true, '後勤官可待命');
  if (off) {
    assert.equal((await submitOrder(pool, g.id, off, { armyId: army.id, kind: 'hold' })).status, 403, '未分配');
    assert.equal((await assignArmy(pool, g.id, cmd, { armyId: army.id, toSeatId: off.id })).ok, true);
    assert.equal((await submitOrder(pool, g.id, off, { armyId: army.id, kind: 'hold' })).ok, true, '分配後可');
    assert.equal((await assignArmy(pool, g.id, off, { armyId: army.id, toSeatId: off.id })).status, 403, '軍官不能分配');
  }
});

test('命令驗證:不相鄰、非整數目標、敵方軍團、未開始的遊戲', async () => {
  const { pool, g, seats } = await setup();
  const cmd = seatOf(seats, 'DE', 'commander');
  assert.equal((await submitOrder(pool, g.id, cmd, { armyId: 1, kind: 'hold' })).status, 409, '未開始');
  await startGame(pool, g.id);
  const mine = (await pool.query(`SELECT * FROM armies WHERE side='DE' ORDER BY id LIMIT 1`)).rows[0];
  const enemy = (await pool.query(`SELECT * FROM armies WHERE side='FR' ORDER BY id LIMIT 1`)).rows[0];
  const far = REGIONS.find((r) => !MAP.by.get(mine.region_id).adj.includes(r.id) && r.id !== mine.region_id).id;
  assert.equal((await submitOrder(pool, g.id, cmd, { armyId: mine.id, kind: 'move', target: far })).status, 400);
  assert.equal((await submitOrder(pool, g.id, cmd, { armyId: mine.id, kind: 'move', target: '5' })).status, 400, '字串目標');
  assert.equal((await submitOrder(pool, g.id, cmd, { armyId: mine.id, kind: 'teleport', target: 1 })).status, 400);
  assert.equal((await submitOrder(pool, g.id, cmd, { armyId: enemy.id, kind: 'hold' })).status, 403, '敵方軍團');
  assert.equal((await submitOrder(pool, g.id, cmd, { armyId: 999999, kind: 'hold' })).status, 404);
});

test('後下的命令覆蓋前下的(每軍團每回合只留一條)', async () => {
  const { pool, g, seats } = await setup();
  await startGame(pool, g.id);
  const cmd = seatOf(seats, 'DE', 'commander');
  const a = (await pool.query(`SELECT * FROM armies WHERE side='DE' ORDER BY id LIMIT 1`)).rows[0];
  const [t1, t2] = MAP.by.get(a.region_id).adj;
  await submitOrder(pool, g.id, cmd, { armyId: a.id, kind: 'move', target: t1 });
  await submitOrder(pool, g.id, cmd, { armyId: a.id, kind: 'move', target: t2 });
  const rows = (await pool.query('SELECT * FROM orders WHERE army_id=$1', [a.id])).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].target_region, t2);
});

test('結算:命令被執行、軍團移動寫回、回合+1、日誌記錄、排下一回合', async () => {
  const { pool, g, seats } = await setup();
  await startGame(pool, g.id);
  const cmd = seatOf(seats, 'DE', 'commander');
  const a = (await pool.query(`SELECT * FROM armies WHERE side='DE' ORDER BY id LIMIT 1`)).rows[0];
  const friendly = MAP.by.get(a.region_id).adj.find((n) => MAP.by.get(n).owner === 'DE');
  await submitOrder(pool, g.id, cmd, { armyId: a.id, kind: 'move', target: friendly });
  const r = await settleTurn(pool, g.id, 1);
  assert.equal(r.ok, true); assert.equal(r.settledTurn, 1); assert.equal(r.nextTurn, 2); assert.equal(r.ordersApplied, 1);
  assert.equal((await pool.query('SELECT region_id FROM armies WHERE id=$1', [a.id])).rows[0].region_id, friendly);
  assert.equal((await pool.query('SELECT turn FROM games WHERE id=$1', [g.id])).rows[0].turn, 2);
  assert.equal((await pool.query(`SELECT status FROM orders WHERE army_id=$1`, [a.id])).rows[0].status, 'executed');
  assert.equal((await pool.query('SELECT count(*)::int n FROM turn_log WHERE game_id=$1 AND turn=1', [g.id])).rows[0].n, 1);
});

test('同一回合不會結算兩次(回合號比對)', async () => {
  const { pool, g } = await setup();
  await startGame(pool, g.id);
  assert.equal((await settleTurn(pool, g.id, 1)).ok, true);
  const second = await settleTurn(pool, g.id, 1);
  assert.equal(second.ok, false); assert.match(second.skipped, /已結算/);
  assert.equal((await pool.query('SELECT turn FROM games WHERE id=$1', [g.id])).rows[0].turn, 2, '回合只前進一次');
});

test('並發結算同一回合:只有一個成功,回合只前進一次', async () => {
  const { pool, g } = await setup();
  await startGame(pool, g.id);
  const rs = await Promise.all([1, 2, 3, 4].map(() => settleTurn(pool, g.id, 1)));
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs.map((r) => r.ok || r.skipped)));
  assert.equal((await pool.query('SELECT turn FROM games WHERE id=$1', [g.id])).rows[0].turn, 2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM turn_log WHERE game_id=$1 AND turn=1', [g.id])).rows[0].n, 1, '第 1 回合結算日誌只有一筆');
  assert.equal((await pool.query('SELECT count(*)::int n FROM turn_log WHERE game_id=$1 AND turn=0', [g.id])).rows[0].n, 1, '開局訊息記在第 0 回合');
});

test('到期查詢:只回傳 next_turn_at 已到的進行中遊戲', async () => {
  const { pool, g } = await setup();
  await startGame(pool, g.id);
  assert.equal((await dueGames(pool)).length, 0, '剛開局未到期');
  await pool.query(`UPDATE games SET next_turn_at = now() - interval '1 minute' WHERE id=$1`, [g.id]);
  assert.deepEqual((await dueGames(pool)).map((x) => x.id), [g.id]);
});

test('完整對局:軍團戰鬥傷亡正確寫回,陣亡者從資料庫刪除', async () => {
  const { pool, g, seats } = await setup();
  await startGame(pool, g.id);
  const cmd = seatOf(seats, 'DE', 'commander');
  const de = (await pool.query(`SELECT * FROM armies WHERE side='DE' ORDER BY id LIMIT 1`)).rows[0];
  const frHome = MAP.by.get(de.region_id).adj.find((n) => MAP.by.get(n).owner === 'FR');
  if (frHome === undefined) return;
  await pool.query(`UPDATE armies SET region_id=$1, strength=5 WHERE id=(SELECT id FROM armies WHERE side='FR' ORDER BY id LIMIT 1)`, [frHome]);
  await submitOrder(pool, g.id, cmd, { armyId: de.id, kind: 'attack', target: frHome });
  const r = await settleTurn(pool, g.id, 1);
  assert.equal(r.ok, true);
  const n = (await pool.query('SELECT count(*)::int n FROM armies WHERE game_id=$1', [g.id])).rows[0].n;
  assert.ok(n <= 12 && n >= 10, `存活 ${n}`);
  for (const row of (await pool.query('SELECT strength FROM armies')).rows) assert.ok(row.strength > 0, '不留 0 兵力軍團');
});

test('輸入防護:NaN、小數、超大數、undefined 一律 400,不丟例外', async () => {
  const { pool, g, seats } = await setup();
  await startGame(pool, g.id);
  const cmd = seatOf(seats, 'DE', 'commander');
  for (const armyId of [NaN, 1.5, -1, 0, 2 ** 40, undefined, null, '1', {}])
    assert.equal((await submitOrder(pool, g.id, cmd, { armyId, kind: 'hold' })).status, 400, `armyId=${String(armyId)}`);
  assert.equal((await submitOrder(pool, g.id, cmd)).status, 400, '整個參數缺失');
  assert.equal((await assignArmy(pool, g.id, cmd, { armyId: 1, toSeatId: 2 ** 40 })).status, 400);
  assert.equal((await assignArmy(pool, g.id, cmd)).status, 400);
});

test('勝利局:佔領敵首都 → finished、記錄勝者、停止排程、之後不能結算或下令', async () => {
  const { pool, g, seats } = await setup();
  await startGame(pool, g.id);
  const cmd = seatOf(seats, 'DE', 'commander');
  const paris = MAP.capital.FR;
  const next = MAP.by.get(paris).adj.find((n) => MAP.by.get(n).owner === 'FR');
  const de = (await pool.query(`SELECT id FROM armies WHERE side='DE' ORDER BY id LIMIT 1`)).rows[0];
  await pool.query(`UPDATE armies SET region_id=$1, strength=400 WHERE id=$2`, [next, de.id]);
  await pool.query(`UPDATE region_state SET owner='DE' WHERE game_id=$1 AND region_id=$2`, [g.id, next]);
  await pool.query(`UPDATE armies SET region_id=$1 WHERE side='FR'`, [MAP.capital.DE]);   // 清掉巴黎外圍的法軍,只測首都攻佔
  await pool.query(`UPDATE games SET garrisons = garrisons - $2 WHERE id=$1`, [g.id, String(paris)]);   // 守備已被打光
  assert.equal((await submitOrder(pool, g.id, cmd, { armyId: de.id, kind: 'attack', target: paris })).ok, true);
  const r = await settleTurn(pool, g.id, 1);
  assert.equal(r.ok, true); assert.equal(r.winner, 'DE');
  const gg = (await pool.query('SELECT * FROM games WHERE id=$1', [g.id])).rows[0];
  assert.equal(gg.status, 'finished'); assert.equal(gg.winner_side, 'DE'); assert.equal(gg.next_turn_at, null, '不再排程');
  assert.equal((await pool.query(`SELECT owner FROM region_state WHERE game_id=$1 AND region_id=$2`, [g.id, paris])).rows[0].owner, 'DE');
  assert.equal((await settleTurn(pool, g.id, gg.turn)).ok, false, '結束後不能再結算');
  assert.equal((await submitOrder(pool, g.id, cmd, { armyId: de.id, kind: 'hold' })).status, 409, '結束後不能下令');
  assert.equal((await dueGames(pool)).length, 0, '結束的遊戲不會被排程撿到');
});
