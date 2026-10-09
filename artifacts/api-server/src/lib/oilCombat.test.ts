import { strict as assert } from "node:assert";
import test from "node:test";
import { shipPower, fleetPower, resolveOilBattle, applyLosses, DEFENDER_ADVANTAGE, WINNER_MAX_LOSS, LOSER_MAX_LOSS, type FleetLine } from "./oilCombat";

const ship = (attack: number, defense: number, hp: number) => ({ attack, defense, hp });
const fleet = (templateId: number, quantity: number, s = ship(100, 100, 100)): FleetLine => ({ templateId, quantity, stats: s });

test("單艦戰力:(攻+防)/2 × sqrt(血)", () => {
  assert.equal(shipPower(ship(100, 100, 100)), 100 * 10);
  assert.equal(shipPower(ship(200, 0, 4)), 100 * 2);
});

test("血量用 sqrt 壓縮:血量 ×100 戰力只 ×10", () => {
  assert.equal(shipPower(ship(10, 10, 10_000)) / shipPower(ship(10, 10, 100)), 10);
});

test("壞資料不會產生 NaN 或負戰力", () => {
  for (const bad of [NaN, -5, Infinity, -Infinity]) {
    const p = shipPower(ship(bad, 10, 100));
    assert.ok(Number.isFinite(p) && p >= 0, String(bad));
  }
  assert.equal(shipPower(ship(10, 10, -100)), 0);
  assert.equal(fleetPower([fleet(1, -3), fleet(2, NaN)]), 0);
});

test("艦隊戰力 = 各艦種數量 × 單艦戰力加總", () => {
  assert.equal(fleetPower([fleet(1, 2), fleet(2, 3, ship(50, 50, 100))]), 2 * 1000 + 3 * 500);
});

test("攻方明顯較強:攻方勝,損失小;守方損失 60%", () => {
  const r = resolveOilBattle([fleet(1, 100)], [fleet(2, 10)]);
  assert.equal(r.outcome, "attacker_wins");
  assert.equal(r.defenderLossRatio, LOSER_MAX_LOSS);
  assert.ok(r.attackerLossRatio < 0.05);
});

test("守方有 15% 地利:攻方只強 10% 仍輸", () => {
  const r = resolveOilBattle([fleet(1, 110)], [fleet(2, 100)]);
  assert.equal(r.outcome, "defender_wins");
  assert.equal(DEFENDER_ADVANTAGE, 1.15);
});

test("攻方強過地利門檻就贏", () => {
  assert.equal(resolveOilBattle([fleet(1, 116)], [fleet(2, 100)]).outcome, "attacker_wins");
});

test("勢均力敵:攻方 1150 對守方 1000(地利後 1150 平手)→ 平手判守方勝,守方贏家損失為 30%", () => {
  const r = resolveOilBattle([fleet(1, 1150)], [fleet(2, 1000)]);
  assert.equal(r.outcome, "defender_wins", "地利後剛好相等 → 平手判守方");
  assert.equal(r.defenderLossRatio, WINNER_MAX_LOSS * 1, "贏家損失 = 30% × (輸家/贏家 = 1)");
  assert.equal(r.attackerLossRatio, LOSER_MAX_LOSS);
});

test("攻方略強於地利後守方:攻方贏,贏家損失接近上限但小於 30%", () => {
  const r = resolveOilBattle([fleet(1, 1200)], [fleet(2, 1000)]);
  assert.equal(r.outcome, "attacker_wins");
  assert.ok(r.attackerLossRatio < WINNER_MAX_LOSS && r.attackerLossRatio > 0.27, String(r.attackerLossRatio));
});

test("平手 → 守方勝(攻守皆空時也是守方勝)", () => {
  assert.equal(resolveOilBattle([fleet(1, 115)], [fleet(2, 100)]).outcome, "defender_wins", "115 對 100 剛好平手,不可因浮點誤差變成攻方贏");
  assert.equal(resolveOilBattle([fleet(1, 230)], [fleet(2, 200)]).outcome, "defender_wins");
  assert.equal(resolveOilBattle([fleet(1, 116)], [fleet(2, 100)]).outcome, "attacker_wins");
  assert.equal(resolveOilBattle([], []).outcome, "defender_wins");
});

test("守方無艦隊:攻方空佔,無損", () => {
  const r = resolveOilBattle([fleet(1, 5)], []);
  assert.deepEqual({ o: r.outcome, a: r.attackerLossRatio, d: r.defenderLossRatio }, { o: "attacker_wins", a: 0, d: 0 });
});

test("攻方無戰力:守方勝,雙方無損", () => {
  const r = resolveOilBattle([fleet(1, 0)], [fleet(2, 5)]);
  assert.deepEqual({ o: r.outcome, a: r.attackerLossRatio, d: r.defenderLossRatio }, { o: "defender_wins", a: 0, d: 0 });
});

test("邊界一致性:平手判定與數量規模無關(各種倍數都一致)", () => {
  for (const k of [1, 3, 7, 20, 100, 1000, 12345]) {
    assert.equal(resolveOilBattle([fleet(1, 115 * k)], [fleet(2, 100 * k)]).outcome, "defender_wins", `k=${k}`);
    assert.equal(resolveOilBattle([fleet(1, 115 * k + 1)], [fleet(2, 100 * k)]).outcome, "attacker_wins", `k=${k}`);
  }
});

test("確定性:同輸入永遠同結果", () => {
  const a = [fleet(1, 37, ship(80, 120, 900))]; const d = [fleet(2, 41, ship(90, 90, 700))];
  assert.deepEqual(resolveOilBattle(a, d), resolveOilBattle(a, d));
});

test("損失:向下取整,但有損失比例時至少損 1 艘", () => {
  assert.deepEqual(applyLosses([fleet(1, 10)], 0.25), [{ templateId: 1, before: 10, lost: 2, after: 8 }]);
  assert.deepEqual(applyLosses([fleet(1, 3)], 0.05), [{ templateId: 1, before: 3, lost: 1, after: 2 }]);
});

test("損失比例 0 → 零損失;比例 > 1 夾到 1;NaN 視為 0;不會損失超過現有", () => {
  assert.equal(applyLosses([fleet(1, 10)], 0)[0]!.lost, 0);
  assert.equal(applyLosses([fleet(1, 10)], 5)[0]!.after, 0);
  assert.equal(applyLosses([fleet(1, 10)], NaN)[0]!.lost, 0);
  assert.equal(applyLosses([fleet(1, 0)], 0.5)[0]!.lost, 0);
});

test("數值極端(AI 設計到 1000 萬)仍有限且可比較", () => {
  const huge = ship(10_000_000, 10_000_000, 10_000_000);
  const p = shipPower(huge);
  assert.ok(Number.isFinite(p) && p > 0);
  assert.equal(resolveOilBattle([fleet(1, 1, huge)], [fleet(2, 1, huge)]).outcome, "defender_wins");
});

import { garrisonFleet, STANDARD_GARRISON_SHIP_POWER, settleTimeFor, validateCommit } from "./oilCombat";

test("守軍折算:garrison 100 → 單艦戰力 100 × 100 艘 = 10000", () => {
  assert.equal(fleetPower(garrisonFleet(100)), 100 * STANDARD_GARRISON_SHIP_POWER);
});

test("守軍:0、負、NaN、小數", () => {
  for (const bad of [0, -5, NaN, Infinity, -Infinity]) assert.deepEqual(garrisonFleet(bad), [], String(bad));
  assert.equal(garrisonFleet(7.9)[0]!.quantity, 7, "小數向下取整");
});

test("守軍對戰:守軍 100 艘(戰力 10000×1.15)擋住 11000 戰力的攻方", () => {
  const atk = [fleet(1, 110)]; // 110 × 1000 = 110000,遠大於 11500 → 其實攻方勝
  assert.equal(resolveOilBattle(atk, garrisonFleet(100)).outcome, "attacker_wins");
  const weak = [fleet(1, 10)]; // 10000 < 11500
  assert.equal(resolveOilBattle(weak, garrisonFleet(100)).outcome, "defender_wins");
});

test("空守軍:攻方空佔無損", () => {
  const r = resolveOilBattle([fleet(1, 1)], garrisonFleet(0));
  assert.deepEqual({ o: r.outcome, a: r.attackerLossRatio }, { o: "attacker_wins", a: 0 });
});

test("結算時間 = 發起 + 6 小時", () => {
  const t = new Date("2026-10-09T00:00:00Z");
  assert.equal(settleTimeFor(t).toISOString(), "2026-10-09T06:00:00.000Z");
  assert.equal(settleTimeFor(t, 1).toISOString(), "2026-10-09T01:00:00.000Z");
});

const ships = new Set([1, 2]);
const isShip = (t: number) => ships.has(t);
const avail = (t: number) => ({ 1: 50, 2: 10 } as Record<number, number>)[t] ?? 0;

test("投入驗證:正常、超量、非艦船、重複、非整數、空", () => {
  assert.deepEqual(validateCommit([{ templateId: 1, quantity: 50 }], isShip, avail), { ok: true, lines: [{ templateId: 1, quantity: 50 }] });
  assert.equal(validateCommit([{ templateId: 1, quantity: 51 }], isShip, avail).ok, false);
  assert.match((validateCommit([{ templateId: 9, quantity: 1 }], isShip, avail) as { error: string }).error, /只能投入艦船/);
  assert.match((validateCommit([{ templateId: 1, quantity: 1 }, { templateId: 1, quantity: 1 }], isShip, avail) as { error: string }).error, /重複/);
  for (const q of [0, -1, 1.5, "3", NaN, null, undefined]) assert.equal(validateCommit([{ templateId: 1, quantity: q }], isShip, avail).ok, false, String(q));
  for (const t of [0, -1, 1.5, "1", null]) assert.equal(validateCommit([{ templateId: t, quantity: 1 }], isShip, avail).ok, false, String(t));
  assert.equal(validateCommit([], isShip, avail).ok, false);
  assert.equal(validateCommit("x" as never, isShip, avail).ok, false);
});

test("投入驗證:上限 50 種;重複項不能繞過逐項上限", () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ templateId: i + 1, quantity: 1 }));
  assert.equal(validateCommit(many, () => true, () => 99).ok, false);
  // 兩項各 30(都 ≤ 50)但同模板:若不擋重複,總計 60 > 50 會被放行
  assert.equal(validateCommit([{ templateId: 1, quantity: 30 }, { templateId: 1, quantity: 30 }], isShip, avail).ok, false);
});
