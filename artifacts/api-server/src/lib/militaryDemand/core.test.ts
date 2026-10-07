import test from "node:test";
import assert from "node:assert/strict";
import {
  decideMilitaryAction, afterRefuse, pickTarget, DEMAND_CHANCE_PCT, type TargetCandidate,
  isDemandExpired, demandTurnsLeft, DEMAND_DEADLINE_TURNS,
} from "./core";

const cand = (o: Partial<TargetCandidate>): TargetCandidate => ({
  regionId: 1, regionName: "r", ownerNationId: "n1", relationScore: 0, ownerArmy: 1000,
  isAlly: false, warBlocked: false, recentWar: false, ...o,
});
const act = (tier: any, sat: number, pending = false, r = 0.5) =>
  decideMilitaryAction({ tier, satisfaction: sat, hasPendingDemand: pending, rand: () => r });

test("民主國家軍方永遠無要求,連低滿意度也不自動開戰", () => {
  for (const sat of [100, 60, 49, 14, 0]) assert.equal(act("democracy", sat, false, 0).kind, "none");
});

test("滿意度 >= 50:依 20% 擲骰決定是否提出要求", () => {
  assert.equal(act("autocracy", 60, false, 0.19).kind, "demand");
  assert.equal(act("autocracy", 60, false, 0.2).kind, "none");   // 恰好 20 不中
  assert.equal(act("semi", 50, false, 0.0).kind, "demand");      // 恰好 50 仍是詢問
  assert.equal(DEMAND_CHANCE_PCT, 20);
});

test("已有待回應要求時不再擲新的", () => {
  assert.equal(act("autocracy", 80, true, 0).kind, "none");
});

test("滿意度 < 50(含 49):不詢問直接開戰;待回應要求存在時仍會開戰", () => {
  assert.equal(act("autocracy", 49.9, false, 0.99).kind, "auto_war");
  assert.equal(act("semi", 30, false, 0).kind, "auto_war");
  assert.equal(act("semi", 15, true, 0).kind, "auto_war");       // 恰好 15 不政變
});

test("滿意度 < 15:政變,60% 沿用現有機制、40% 軍閥", () => {
  assert.deepEqual(act("autocracy", 14.9, false, 0.59), { kind: "coup", variant: "classic" });
  assert.deepEqual(act("autocracy", 0, false, 0.6), { kind: "coup", variant: "warlord" });
  assert.deepEqual(act("semi", 10, true, 0.0), { kind: "coup", variant: "classic" });
});

test("政變比例統計:約 60/40", () => {
  let classic = 0; const N = 20000;
  for (let i = 0; i < N; i++) {
    const r = decideMilitaryAction({ tier: "autocracy", satisfaction: 5, hasPendingDemand: false, rand: Math.random });
    if (r.kind === "coup" && r.variant === "classic") classic++;
  }
  assert.ok(Math.abs(classic / N - 0.6) < 0.02, `classic=${classic / N}`);
});

test("擲骰比例統計:約 20%", () => {
  let hit = 0; const N = 50000;
  for (let i = 0; i < N; i++)
    if (decideMilitaryAction({ tier: "autocracy", satisfaction: 70, hasPendingDemand: false, rand: Math.random }).kind === "demand") hit++;
  assert.ok(Math.abs(hit / N - 0.2) < 0.01, `rate=${hit / N}`);
});

test("拒絕扣 15 並夾限 0 到 100", () => {
  assert.equal(afterRefuse(60), 45);
  assert.equal(afterRefuse(10), 0);
  assert.equal(afterRefuse(100), 85);
});

test("目標:關係最差 > 無主地 > 弱國", () => {
  const list = [
    cand({ regionId: 10, ownerNationId: "weak", ownerArmy: 100 }),                        // 弱國
    cand({ regionId: 20, ownerNationId: null }),                                            // 無主
    cand({ regionId: 30, ownerNationId: "foe", relationScore: -20 }),                       // 關係差
  ];
  assert.equal(pickTarget(list, 1000)!.regionId, 30);
  assert.equal(pickTarget(list.slice(0, 2), 1000)!.regionId, 20);
  assert.equal(pickTarget(list.slice(0, 1), 1000)!.regionId, 10);
});

test("關係最差者優先;同分取地區 id 小者", () => {
  const list = [
    cand({ regionId: 5, ownerNationId: "a", relationScore: -10 }),
    cand({ regionId: 4, ownerNationId: "b", relationScore: -50 }),
    cand({ regionId: 3, ownerNationId: "c", relationScore: -50 }),
  ];
  assert.equal(pickTarget(list, 1000)!.regionId, 3);
});

test("弱國:越弱越優先;不夠弱(>=80%)或關係非負不算", () => {
  const list = [
    cand({ regionId: 1, ownerNationId: "a", ownerArmy: 700 }),
    cand({ regionId: 2, ownerNationId: "b", ownerArmy: 300 }),
    cand({ regionId: 3, ownerNationId: "c", ownerArmy: 800 }),   // 恰好 80% 不算弱
    cand({ regionId: 4, ownerNationId: "d", ownerArmy: 5000 }),
  ];
  assert.equal(pickTarget(list, 1000)!.regionId, 2);
  assert.equal(pickTarget([list[2]!, list[3]!], 1000), null);
});

test("絕不打盟友、被條約擋住、或剛打完的冷卻目標(即使關係很差)", () => {
  const list = [
    cand({ regionId: 1, ownerNationId: "ally", relationScore: -90, isAlly: true }),
    cand({ regionId: 2, ownerNationId: "pact", relationScore: -80, warBlocked: true }),
    cand({ regionId: 3, ownerNationId: "cool", relationScore: -70, recentWar: true }),
    cand({ regionId: 4, ownerNationId: null, isAlly: true }),
  ];
  assert.equal(pickTarget(list, 1000), null);
  assert.equal(pickTarget([...list, cand({ regionId: 9, ownerNationId: null })], 1000)!.regionId, 9);
});

test("沒有任何候選時回傳 null", () => {
  assert.equal(pickTarget([], 1000), null);
});

test("逾時判定:tick >= dueTick 才算逾時;舊資料(無 dueTick)永不逾時", () => {
  assert.equal(isDemandExpired(4, 5), false);
  assert.equal(isDemandExpired(5, 5), true);
  assert.equal(isDemandExpired(9, 5), true);
  assert.equal(isDemandExpired(99, null), false);
  assert.equal(isDemandExpired(99, undefined), false);
});

test("剩餘回合:最小 0;無期限回 null", () => {
  assert.equal(demandTurnsLeft(3, 5), 2);
  assert.equal(demandTurnsLeft(5, 5), 0);
  assert.equal(demandTurnsLeft(8, 5), 0);
  assert.equal(demandTurnsLeft(3, null), null);
});

test("時限為 2 回合(2026-10-07 確認)", () => {
  assert.equal(DEMAND_DEADLINE_TURNS, 2);
});

test("滿意度 >= 50(含剛好 50)絕不自動開戰,無論擲骰結果", () => {
  for (const sat of [50, 51, 60, 75, 100]) {
    for (const r of [0, 0.19, 0.2, 0.5, 0.999]) {
      for (const pending of [false, true]) {
        const a = decideMilitaryAction({ tier: "autocracy", satisfaction: sat, hasPendingDemand: pending, rand: () => r });
        assert.notEqual(a.kind, "auto_war", `sat=${sat} r=${r} pending=${pending}`);
        assert.notEqual(a.kind, "coup", `sat=${sat} r=${r}`);
      }
    }
  }
});
