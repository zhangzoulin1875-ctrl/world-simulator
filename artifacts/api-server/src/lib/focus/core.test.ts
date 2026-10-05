import test from "node:test";
import assert from "node:assert/strict";
import {
  focusSpeedMultiplier,
  advanceFocus,
  estimateRemainingTurns,
  politicalPointsPerTurn,
  pointsCap,
  BASE_POINTS_BY_TIER,
  checkStartFocus,
  type StartCheckInput,
  type FocusSlot,
} from "./core";

test("速度係數:停擺/慢/線性插值/快,且邊界無斷點", () => {
  assert.equal(focusSpeedMultiplier(0), 0);
  assert.equal(focusSpeedMultiplier(15), 0, "<=15 停擺");
  assert.equal(focusSpeedMultiplier(16), 0.7, "剛脫離停擺 = 慢 30%");
  assert.equal(focusSpeedMultiplier(50), 0.7);
  assert.equal(focusSpeedMultiplier(80), 1.3);
  assert.equal(focusSpeedMultiplier(100), 1.3);
  assert.ok(Math.abs(focusSpeedMultiplier(65) - 1.0) < 1e-9, "中點 65 = 1.0");
  // 單調不減
  let prev = -1;
  for (let s = 0; s <= 100; s++) {
    const m = focusSpeedMultiplier(s);
    assert.ok(m >= prev, `s=${s} 不應下降`);
    prev = m;
  }
  assert.equal(focusSpeedMultiplier(Number.NaN), 0, "NaN 當作 0");
});

test("advanceFocus:累積、完成、停擺", () => {
  let p = 0;
  for (let i = 0; i < 3; i++) p = advanceFocus(p, 4, 65).progress; // 每回合 1.0
  assert.equal(p, 3);
  const done = advanceFocus(p, 4, 65);
  assert.equal(done.completed, true);
  const stalled = advanceFocus(2, 4, 10);
  assert.equal(stalled.progress, 2);
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.completed, false);
  // 不超過總回合
  assert.equal(advanceFocus(3.9, 4, 100).progress, 4);
});

test("estimateRemainingTurns:停擺回 null,其餘向上取整", () => {
  assert.equal(estimateRemainingTurns(0, 4, 10), null);
  assert.equal(estimateRemainingTurns(0, 4, 65), 4);
  assert.equal(estimateRemainingTurns(0, 4, 90), 4); // 4/1.3 = 3.07 → 4
  assert.equal(estimateRemainingTurns(3.5, 4, 65), 1);
});

test("政治點數:檔位基礎 + 人口 + 滿意度,至少 1,人口加成有上限", () => {
  assert.equal(politicalPointsPerTurn({ tier: "autocracy", population: 0, satisfaction: 0 }), BASE_POINTS_BY_TIER.autocracy);
  assert.equal(politicalPointsPerTurn({ tier: "democracy", population: 0, satisfaction: 0 }), BASE_POINTS_BY_TIER.democracy);
  assert.equal(politicalPointsPerTurn({ tier: "semi", population: 10_000_000, satisfaction: 70 }), BASE_POINTS_BY_TIER.semi + 2 + 1);
  assert.equal(politicalPointsPerTurn({ tier: "semi", population: 10_000_000_000, satisfaction: 95 }), BASE_POINTS_BY_TIER.semi + 4 + 2, "人口加成上限 +4");
  assert.ok(politicalPointsPerTurn({ tier: "democracy", population: Number.NaN, satisfaction: -5 }) >= 1);
  assert.equal(pointsCap(5), 100);
});

const base = (over: Partial<StartCheckInput> = {}): StartCheckInput => ({
  focusId: "a",
  cost: 10,
  slot: "main",
  requires: [],
  excludes: [],
  completed: new Set(),
  active: new Map<FocusSlot, string>(),
  points: 10,
  coupPolicyLockTurns: 0,
  ...over,
});

test("checkStartFocus:各種阻擋原因與優先序", () => {
  assert.equal(checkStartFocus(base()), null);
  assert.equal(checkStartFocus(base({ completed: new Set(["a"]) })), "already_completed");
  assert.equal(checkStartFocus(base({ active: new Map([["side", "a"]]) })), "already_active");
  assert.equal(checkStartFocus(base({ coupPolicyLockTurns: 2 })), "policy_locked");
  assert.equal(checkStartFocus(base({ active: new Map([["main", "x"]]) })), "slot_busy");
  assert.equal(checkStartFocus(base({ requires: ["p"] })), "prereq_missing");
  assert.equal(checkStartFocus(base({ requires: ["p"], completed: new Set(["p"]) })), null);
  assert.equal(checkStartFocus(base({ points: 9 })), "insufficient_points");
});

test("checkStartFocus:requiresAny 與互斥(已完成/進行中)", () => {
  assert.equal(checkStartFocus(base({ requiresAny: ["p", "q"] })), "prereq_missing");
  assert.equal(checkStartFocus(base({ requiresAny: ["p", "q"], completed: new Set(["q"]) })), null);
  assert.equal(checkStartFocus(base({ excludes: ["z"], completed: new Set(["z"]) })), "excluded_by_completed");
  assert.equal(
    checkStartFocus(base({ excludes: ["z"], active: new Map([["side", "z"]]) })),
    "excluded_by_completed",
    "互斥對象正在進行中也要擋",
  );
});

test("checkStartFocus:政變鎖定優先於其他原因", () => {
  assert.equal(checkStartFocus(base({ coupPolicyLockTurns: 1, points: 0, requires: ["p"] })), "policy_locked");
});
