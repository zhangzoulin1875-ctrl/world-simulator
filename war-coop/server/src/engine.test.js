import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildMap, resolveTurn, resolveBattle, powerOf, supplyDistances, validateOrder, terrain, RULES } from './engine.js';

const REGIONS = JSON.parse(readFileSync(new URL('../map/regions.json', import.meta.url), 'utf8'));
const map = buildMap(REGIONS);
const PARIS = map.capital.FR, BERLIN = map.capital.DE;

const freshState = (armies = []) => ({
  turn: 1, belgiumInvaded: false,
  regions: Object.fromEntries(REGIONS.map((r) => [r.id, { owner: r.owner }])),
  armies,
});
let nextId = 1;
const army = (side, region, over = {}) => ({ id: nextId++, side, name: `${side}${nextId}`, region, strength: 100, supply: 100, ...over });
const byName = (id) => REGIONS.find((r) => r.id === id);
// 找德法接壤的一對區(德在前)
const border = (() => { for (const r of REGIONS) if (r.owner === 'DE') for (const n of r.adj) if (byName(n).owner === 'FR') return [r.id, n]; })();

test('地圖基本事實:首都存在、鄰接對稱', () => {
  assert.ok(Number.isInteger(PARIS) && Number.isInteger(BERLIN));
  for (const r of REGIONS) for (const n of r.adj) assert.ok(byName(n).adj.includes(r.id), `${r.id}↔${n} 非對稱`);
});

test('地形類別', () => {
  assert.equal(terrain(map, PARIS), 'capital');
  assert.equal(terrain(map, REGIONS.find((r) => r.tag === 'fortress').id), 'fortress');
});

test('移動到相鄰的空區:成功;不相鄰:命令無效並原地待命', () => {
  const [de, fr] = border;
  const a = army('DE', de);
  const far = REGIONS.find((r) => !byName(de).adj.includes(r.id) && r.id !== de).id;
  const r1 = resolveTurn(freshState([a]), map, [{ armyId: a.id, kind: 'move', target: byName(de).adj.find((x) => byName(x).owner === 'DE') }]);
  assert.notEqual(r1.state.armies[0].region, de);
  const r2 = resolveTurn(freshState([a]), map, [{ armyId: a.id, kind: 'move', target: far }]);
  assert.equal(r2.state.armies[0].region, de);
  assert.match(r2.log.join(), /命令無效/);
});

test('一回合最多走一格(連續兩格不能一次到)', () => {
  const de = border[0];
  const a = army('DE', de);
  const s = resolveTurn(freshState([a]), map, [{ armyId: a.id, kind: 'move', target: byName(de).adj[0] }]).state;
  assert.equal(byName(de).adj.includes(s.armies[0].region), true);
});

test('引擎是純函式:不改傳入的 state,且同樣輸入同樣輸出', () => {
  const [de, fr] = border;
  const a = army('DE', de, { strength: 80 }), b = army('FR', fr);
  const st = freshState([a, b]); const snap = JSON.stringify(st);
  const o = [{ armyId: a.id, kind: 'attack', target: fr }];
  const r1 = resolveTurn(st, map, o), r2 = resolveTurn(st, map, o);
  assert.equal(JSON.stringify(st), snap, '不得修改輸入');
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), '必須決定論');
});

test('戰鬥:兵力多的一方贏,守方有地形加成', () => {
  const plain = REGIONS.find((r) => r.owner === 'FR' && !r.tag && !r.rear).id;
  const fort = REGIONS.find((r) => r.tag === 'fortress' && r.owner === 'FR' || r.tag === 'fortress' && r.owner === 'DE').id;
  const A = [army('DE', 0, { strength: 100 })], D = [army('FR', 0, { strength: 100 })];
  assert.equal(resolveBattle(map, plain, A, D).attackerWins, false, '同兵力攻方不贏(平手算守方)');
  assert.equal(resolveBattle(map, fort, A, D).attackerWins, false, '同兵力攻要塞必敗');
  const strongA = [army('DE', 0, { strength: 160 })];
  assert.equal(resolveBattle(map, fort, strongA, D).attackerWins, true, '160 vs 100×1.5=150 攻方險勝');
  assert.equal(resolveBattle(map, fort, [army('DE', 0, { strength: 140 })], D).attackerWins, false, '140 vs 150 攻方敗');
});

test('戰鬥損失:強者損失少,總損失有上限,不會變負數', () => {
  const plain = REGIONS.find((r) => !r.tag && !r.rear).id;
  const r = resolveBattle(map, plain, [army('DE', 0, { strength: 200 })], [army('FR', 0, { strength: 50 })]);
  assert.ok(r.aLoss < r.dLoss, '強者損失較少');
  assert.ok(r.aLoss >= 0 && r.dLoss >= 0);
  assert.ok(r.aLoss + r.dLoss <= 2 * 50 * RULES.lossRate + 1e-9, '總損失 ≤ 2×較弱方×lossRate');
});

test('補給低的軍團戰力打折,歸零仍有最低戰力', () => {
  assert.equal(powerOf({ strength: 100, supply: 100 }), 100);
  assert.equal(powerOf({ strength: 100, supply: 40 }), 100);
  assert.equal(powerOf({ strength: 100, supply: 0 }), 100 * RULES.minPower);
  assert.ok(powerOf({ strength: 100, supply: 20 }) < 100 && powerOf({ strength: 100, supply: 20 }) > 25);
});

test('攻擊進入敵區勝利 → 佔領該區;敗 → 退回原區', () => {
  const [de, fr] = border;
  const weakDefender = army('FR', fr, { strength: 20 });
  const attacker = army('DE', de, { strength: 100 });
  const win = resolveTurn(freshState([attacker, weakDefender]), map, [{ armyId: attacker.id, kind: 'attack', target: fr }]);
  const a1 = win.state.armies.find((a) => a.id === attacker.id);
  assert.equal(a1.region, fr, '勝者進入');
  assert.equal(win.state.regions[fr].owner, 'DE', '佔領換手');
  const strongDefender = army('FR', fr, { strength: 200 });
  const lose = resolveTurn(freshState([{ ...attacker }, strongDefender]), map, [{ armyId: attacker.id, kind: 'attack', target: fr }]);
  const a2 = lose.state.armies.find((a) => a.id === attacker.id);
  assert.equal(a2?.region ?? de, de, '敗者退回原區');
  assert.equal(lose.state.regions[fr].owner, 'FR', '防守方保住');
});

test('兵力歸零的軍團被移除', () => {
  const [de, fr] = border;
  const a = army('DE', de, { strength: 100 }), d = army('FR', fr, { strength: 400 });
  const r = resolveTurn(freshState([a, d]), map, [{ armyId: a.id, kind: 'attack', target: fr }]);
  for (const x of r.state.armies) assert.ok(x.strength > 0);
});

test('比利時中立:法軍在德軍入侵前不能進;德軍進入後旗標開啟,法軍可進', () => {
  const be = REGIONS.find((r) => r.owner === 'BE' && r.adj.some((n) => byName(n).owner === 'FR'));
  const frHome = be.adj.find((n) => byName(n).owner === 'FR');
  const f = army('FR', frHome);
  const v = validateOrder(freshState([f]), map, f, { kind: 'move', target: be.id });
  assert.equal(v.ok, false); assert.match(v.reason, /中立/);
  const deHome = REGIONS.find((r) => r.owner === 'DE' && r.adj.some((n) => byName(n).owner === 'BE'));
  const beFromDe = deHome.adj.find((n) => byName(n).owner === 'BE');
  const g = army('DE', deHome.id);
  const r = resolveTurn(freshState([g]), map, [{ armyId: g.id, kind: 'move', target: beFromDe }]);
  assert.equal(r.state.belgiumInvaded, true);
  assert.match(r.log.join(), /入侵比利時/);
  assert.equal(validateOrder(r.state, map, f, { kind: 'move', target: be.id }).ok, true);
});

test('補給線被敵控區切斷:深入敵境、有敵軍在場無法佔領的軍團補給下降', () => {
  const [de, fr] = border;
  const lone = army('DE', fr, { supply: 100 });
  const guard = army('FR', fr, { strength: 100 });   // 敵軍同區 → 不會被佔領,區仍為法控
  const s = freshState([lone, guard]);
  assert.equal(supplyDistances(s, map, 'DE').has(fr), false, '敵控區不在德軍補給網內');
  const r = resolveTurn(s, map, [{ armyId: lone.id, kind: 'hold' }, { armyId: guard.id, kind: 'hold' }]);
  const after = r.state.armies.find((x) => x.id === lone.id);
  if (after) assert.ok(after.supply < 100, '被切斷後補給下降');
});

test('佔領後補給線接上(獨佔敵區 → 變己控 → 補給回升)', () => {
  const [, fr] = border;
  const lone = army('DE', fr, { supply: 50 });
  const r = resolveTurn(freshState([lone]), map, []);
  assert.equal(r.state.regions[fr].owner, 'DE');
  assert.ok(r.state.armies[0].supply > 50);
});

test('己方補給源附近的軍團補給回升', () => {
  const home = army('DE', BERLIN, { supply: 30 });
  const r = resolveTurn(freshState([home]), map, []);
  assert.equal(r.state.armies[0].supply, 30 + RULES.supplyRecover);
});

test('勝利:佔領敵方首都 → winner', () => {
  const nParis = byName(PARIS).adj[0];
  const st = freshState([]);
  st.regions[nParis].owner = 'DE';
  const a = army('DE', nParis, { strength: 150 });
  st.armies = [a];
  const r = resolveTurn(st, map, [{ armyId: a.id, kind: 'attack', target: PARIS }]);
  assert.equal(r.winner, 'DE');
  assert.equal(r.state.regions[PARIS].owner, 'DE');
});

test('對向互換位置不會穿越:兩軍在邊界交戰', () => {
  const [de, fr] = border;
  const a = army('DE', de), b = army('FR', fr);
  const r = resolveTurn(freshState([a, b]), map, [
    { armyId: a.id, kind: 'attack', target: fr }, { armyId: b.id, kind: 'attack', target: de }]);
  assert.match(r.log.join(), /會戰/);
  const ra = r.state.armies.find((x) => x.id === a.id), rb = r.state.armies.find((x) => x.id === b.id);
  assert.ok(!(ra?.region === fr && rb?.region === de), '不得互換位置');
});

test('沒有命令的回合:狀態穩定,回合數+1', () => {
  const r = resolveTurn(freshState([army('DE', BERLIN)]), map, []);
  assert.equal(r.state.turn, 2); assert.equal(r.winner, null);
});

test('同一軍團多條命令:以最後一條為準', () => {
  const de = border[0];
  const a = army('DE', de);
  const [t1, t2] = byName(de).adj.filter((n) => byName(n).owner === 'DE').slice(0, 2);
  if (t1 === undefined || t2 === undefined) return;
  const r = resolveTurn(freshState([a]), map, [{ armyId: a.id, kind: 'move', target: t1 }, { armyId: a.id, kind: 'move', target: t2 }]);
  assert.equal(r.state.armies[0].region, t2);
});
