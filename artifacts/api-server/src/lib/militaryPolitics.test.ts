import { test } from "node:test";
import assert from "node:assert/strict";
import {
  armyPopulationRatioPct,
  desertionAmount,
  desertionRatioPct,
  isMilitaryCoup,
  legionInitialMorale,
  militaryRiskLevel,
  militaryUnrestChancePct,
  overreachChancePct,
  upkeepShortfallMilitaryPenalty,
  MILITARY_OVERREACH_THRESHOLD_PCT,
  OVERREACH_CHANCE_MAX_PCT,
  MILITARY_UNREST_CHANCE_MAX_PCT,
  DESERTION_RATIO_MIN_PCT,
  DESERTION_RATIO_MAX_PCT,
  UPKEEP_PENALTY_MIN,
  UPKEEP_PENALTY_MAX,
} from "./militaryPolitics";

// ── 軍隊占人口比 ──

test("armyPopulationRatioPct 基本計算與邊界", () => {
  assert.equal(armyPopulationRatioPct(0, 1000), 0);
  assert.equal(armyPopulationRatioPct(-5, 1000), 0);
  assert.equal(armyPopulationRatioPct(100, 1000), 10);
  assert.equal(armyPopulationRatioPct(50, 0), 100); // 無人口但有軍隊 → 100%
  assert.ok(Math.abs(armyPopulationRatioPct(1, 3) - 33.333) < 0.01);
});

// ── 越權機率 ──

test("overreachChancePct 門檻與上限", () => {
  assert.equal(overreachChancePct(0), 0);
  assert.equal(overreachChancePct(MILITARY_OVERREACH_THRESHOLD_PCT), 0);
  assert.equal(overreachChancePct(11), 8);
  assert.equal(overreachChancePct(15), 40);
  assert.equal(overreachChancePct(20), OVERREACH_CHANCE_MAX_PCT);
  assert.equal(overreachChancePct(99), OVERREACH_CHANCE_MAX_PCT);
});

// ── 逃兵/政變機率與條件 ──

test("militaryUnrestChancePct 需兩者皆低於 30", () => {
  assert.equal(militaryUnrestChancePct(30, 10), 0);
  assert.equal(militaryUnrestChancePct(10, 30), 0);
  assert.equal(militaryUnrestChancePct(60, 60), 0);
  assert.equal(militaryUnrestChancePct(20, 20), 20);
  assert.equal(militaryUnrestChancePct(0, 0), MILITARY_UNREST_CHANCE_MAX_PCT);
  assert.equal(militaryUnrestChancePct(29, 29), 2);
});

test("isMilitaryCoup 需兩者皆低於 15", () => {
  assert.equal(isMilitaryCoup(14, 14), true);
  assert.equal(isMilitaryCoup(15, 14), false);
  assert.equal(isMilitaryCoup(14, 15), false);
  assert.equal(isMilitaryCoup(0, 0), true);
});

// ── 逃兵比例與數量 ──

test("desertionRatioPct 夾在 5–20", () => {
  assert.equal(desertionRatioPct(29, 29), DESERTION_RATIO_MIN_PCT + 1); // 5 + 0.5 → 6? round(5.5)=6
  assert.equal(desertionRatioPct(30, 30), DESERTION_RATIO_MIN_PCT);
  assert.equal(desertionRatioPct(0, 0), DESERTION_RATIO_MAX_PCT);
  const r = desertionRatioPct(10, 25);
  assert.ok(r >= DESERTION_RATIO_MIN_PCT && r <= DESERTION_RATIO_MAX_PCT);
  assert.equal(desertionRatioPct(10, 25), 15); // min=10 → 5+10=15
});

test("desertionAmount 為 floor 且不為負", () => {
  assert.equal(desertionAmount(100, 10), 10);
  assert.equal(desertionAmount(99, 10), 9);
  assert.equal(desertionAmount(0, 10), 0);
  assert.equal(desertionAmount(-5, 10), 0);
  assert.equal(desertionAmount(9, 5), 0); // floor(0.45)
});

// ── 初始士氣 ──

test("legionInitialMorale = 服從度（夾 0–100 取整）", () => {
  assert.equal(legionInitialMorale(40), 40);
  assert.equal(legionInitialMorale(80), 80);
  assert.equal(legionInitialMorale(120), 100);
  assert.equal(legionInitialMorale(-3), 0);
  assert.equal(legionInitialMorale(59.6), 60);
});

// ── 維護費缺口懲罰 ──

test("upkeepShortfallMilitaryPenalty 範圍與比例", () => {
  assert.equal(upkeepShortfallMilitaryPenalty(0, 100), 0);
  assert.equal(upkeepShortfallMilitaryPenalty(-10, 100), 0);
  assert.equal(upkeepShortfallMilitaryPenalty(100, 100), UPKEEP_PENALTY_MAX);
  assert.equal(upkeepShortfallMilitaryPenalty(1, 1000), UPKEEP_PENALTY_MIN);
  assert.equal(upkeepShortfallMilitaryPenalty(50, 100), 10); // 5 + floor(5)
  assert.equal(upkeepShortfallMilitaryPenalty(10, 0), UPKEEP_PENALTY_MAX); // upkeep 0 防禦
});

// ── 風險等級 ──

test("militaryRiskLevel 分級", () => {
  assert.equal(militaryRiskLevel(2, 80, 80), "low");
  assert.equal(militaryRiskLevel(8, 80, 80), "medium"); // 接近門檻
  assert.equal(militaryRiskLevel(2, 35, 80), "medium"); // 滿意度偏低
  assert.equal(militaryRiskLevel(12, 80, 80), "high"); // 超門檻
  assert.equal(militaryRiskLevel(2, 20, 20), "high"); // 可能逃兵/政變
});
