// 資料庫 ↔ 引擎 的橋:開局、命令、原子結算。
import { REGIONS } from './game.js';
import { buildMap, resolveTurn, initialGarrisons } from './engine.js';
import { planDeployment } from './deploy.js';
import { canOrder, canAssign } from './permissions.js';

export const MAP = buildMap(REGIONS);
const isId = (v) => Number.isInteger(v) && v > 0 && v <= 2147483647;   // Postgres integer 上限
const TURN_HOURS_DEFAULT = 4;

/** 開始遊戲:建軍團、守備,設定第 1 回合與下次結算時間。只能對 lobby 狀態執行一次(原子) */
export async function startGame(pool, gameId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const g = (await c.query('SELECT * FROM games WHERE id=$1 FOR UPDATE', [gameId])).rows[0];
    if (!g) { await c.query('ROLLBACK'); return { ok: false, status: 404, error: '找不到遊戲' }; }
    if (g.status !== 'lobby') { await c.query('ROLLBACK'); return { ok: false, status: 409, error: '遊戲已開始' }; }
    for (const a of planDeployment(REGIONS))
      await c.query('INSERT INTO armies(game_id,side,name,region_id,strength,supply) VALUES ($1,$2,$3,$4,$5,$6)',
        [gameId, a.side, a.name, a.region, a.strength, a.supply]);
    await c.query(
      `UPDATE games SET status='running', turn=1, garrisons=$2::jsonb,
         next_turn_at = now() + (turn_hours || ' hours')::interval WHERE id=$1`,
      [gameId, JSON.stringify(initialGarrisons(MAP))]);
    await c.query('INSERT INTO turn_log(game_id,turn,summary) VALUES ($1,0,$2)', [gameId, '戰爭爆發!第 1 回合開始。']);
    await c.query('COMMIT');
    return { ok: true };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

/** 下達命令。只能在 running 的當前回合;後下覆蓋前下。權限由 canOrder 判斷。 */
export async function submitOrder(pool, gameId, seat, { armyId, kind, target } = {}) {
  if (!isId(armyId)) return { ok: false, status: 400, error: '軍團編號錯誤' };
  const g = (await pool.query('SELECT * FROM games WHERE id=$1', [gameId])).rows[0];
  if (!g || g.status !== 'running') return { ok: false, status: 409, error: '遊戲未進行中' };
  const army = (await pool.query('SELECT * FROM armies WHERE id=$1 AND game_id=$2', [armyId, gameId])).rows[0];
  if (!army) return { ok: false, status: 404, error: '找不到軍團' };
  if (!['move', 'attack', 'hold'].includes(kind)) return { ok: false, status: 400, error: '命令種類錯誤' };
  const perm = canOrder(seat, army, kind);
  if (!perm.ok) return { ok: false, status: 403, error: perm.reason };
  if (kind !== 'hold') {
    const here = MAP.by.get(army.region_id);
    if (!Number.isInteger(target) || !here.adj.includes(target)) return { ok: false, status: 400, error: '目標必須是相鄰的區' };
    if ((army.pinned ?? 0) > 0) return { ok: false, status: 409, error: '這支軍團剛進入敵軍控制區,本回合必須整頓' };
  }
  await pool.query(
    `INSERT INTO orders(game_id,turn,seat_id,army_id,kind,target_region,status) VALUES ($1,$2,$3,$4,$5,$6,'approved')
     ON CONFLICT (game_id, turn, army_id) DO UPDATE SET seat_id=EXCLUDED.seat_id, kind=EXCLUDED.kind, target_region=EXCLUDED.target_region, created_at=now()`,
    [gameId, g.turn, seat.id, armyId, kind, kind === 'hold' ? null : target]);
  return { ok: true, turn: g.turn };
}

/** 分配軍團給軍官(統帥/參謀長) */
export async function assignArmy(pool, gameId, seat, { armyId, toSeatId } = {}) {
  if (!isId(armyId)) return { ok: false, status: 400, error: '軍團編號錯誤' };
  if (toSeatId != null && !isId(toSeatId)) return { ok: false, status: 400, error: '席位編號錯誤' };
  const army = (await pool.query('SELECT * FROM armies WHERE id=$1 AND game_id=$2', [armyId, gameId])).rows[0];
  if (!army) return { ok: false, status: 404, error: '找不到軍團' };
  if (army.side !== seat.side) return { ok: false, status: 403, error: '不是己方軍團' };
  let target = null;
  if (toSeatId != null) {
    target = (await pool.query('SELECT * FROM seats WHERE id=$1 AND game_id=$2', [toSeatId, gameId])).rows[0];
    if (!target) return { ok: false, status: 404, error: '找不到該席位' };
  }
  const perm = canAssign(seat, target);
  if (!perm.ok) return { ok: false, status: 403, error: perm.reason };
  await pool.query('UPDATE armies SET assigned_seat=$1 WHERE id=$2', [toSeatId ?? null, armyId]);
  return { ok: true };
}

/**
 * 原子結算一個回合。鎖定 games 列(FOR UPDATE)+ 回合號比對,保證同一回合只結算一次:
 * 排程與手動同時觸發時,後到者會看到回合號已前進而放棄。
 * expectTurn:呼叫端認為正在結算的回合;不符則不做事。
 */
export async function settleTurn(pool, gameId, expectTurn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const g = (await c.query('SELECT * FROM games WHERE id=$1 FOR UPDATE', [gameId])).rows[0];
    if (!g || g.status !== 'running') { await c.query('ROLLBACK'); return { ok: false, skipped: '遊戲未進行中' }; }
    if (expectTurn != null && g.turn !== expectTurn) { await c.query('ROLLBACK'); return { ok: false, skipped: '此回合已結算' }; }

    const regRows = (await c.query('SELECT region_id, owner FROM region_state WHERE game_id=$1', [gameId])).rows;
    const armyRows = (await c.query('SELECT * FROM armies WHERE game_id=$1 ORDER BY id', [gameId])).rows;
    const orderRows = (await c.query(`SELECT * FROM orders WHERE game_id=$1 AND turn=$2 AND status='approved'`, [gameId, g.turn])).rows;

    const state = {
      turn: g.turn, belgiumInvaded: g.belgium_invaded, garrisons: g.garrisons ?? {},
      regions: Object.fromEntries(regRows.map((r) => [r.region_id, { owner: r.owner }])),
      armies: armyRows.map((a) => ({ id: a.id, side: a.side, name: a.name, region: a.region_id, strength: a.strength, supply: a.supply, pinned: a.pinned })),
    };
    const orders = orderRows.map((o) => ({ armyId: o.army_id, kind: o.kind, target: o.target_region }));
    const { state: next, log, winner } = resolveTurn(state, MAP, orders);

    // 寫回:軍團(存活者更新、陣亡者刪除)、區域歸屬、旗標與守備
    const alive = new Set(next.armies.map((a) => a.id));
    for (const a of next.armies)
      await c.query('UPDATE armies SET region_id=$1, strength=$2, supply=$3, pinned=$4 WHERE id=$5', [a.region, a.strength, a.supply, a.pinned ?? 0, a.id]);
    const dead = armyRows.filter((a) => !alive.has(a.id)).map((a) => a.id);
    if (dead.length) await c.query('DELETE FROM armies WHERE id = ANY($1::int[])', [dead]);
    for (const [rid, r] of Object.entries(next.regions))
      if (state.regions[rid]?.owner !== r.owner) await c.query('UPDATE region_state SET owner=$1 WHERE game_id=$2 AND region_id=$3', [r.owner, gameId, Number(rid)]);
    await c.query(`UPDATE orders SET status='executed' WHERE game_id=$1 AND turn=$2 AND status='approved'`, [gameId, g.turn]);

    await c.query(
      `UPDATE games SET turn=$2, garrisons=$3::jsonb, belgium_invaded=$4, status=$5, winner_side=$6,
         next_turn_at = CASE WHEN $5 = 'running' THEN now() + (turn_hours || ' hours')::interval ELSE NULL END WHERE id=$1`,
      [gameId, next.turn, JSON.stringify(next.garrisons ?? {}), next.belgiumInvaded, winner ? 'finished' : 'running', winner]);
    const summary = log.length ? log.join('\n') : '本回合無重大戰事。';
    await c.query('INSERT INTO turn_log(game_id,turn,summary) VALUES ($1,$2,$3)', [gameId, g.turn, summary]);
    await c.query('COMMIT');
    return { ok: true, settledTurn: g.turn, nextTurn: next.turn, winner, log, ordersApplied: orders.length };
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}

/** 找出到期要結算的遊戲(供排程呼叫) */
export async function dueGames(pool) {
  return (await pool.query(`SELECT id, turn FROM games WHERE status='running' AND next_turn_at IS NOT NULL AND next_turn_at <= now()`)).rows;
}
