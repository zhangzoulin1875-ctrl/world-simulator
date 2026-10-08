/**
 * 厭戰度再平衡(2026-10-08)的純函式測試:
 * 攻擊力扣減上限、勝方增量折減、與既有回復/倍率函式的組合行為。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import {
  WAR_WEARINESS_MAX_ATTACK_PENALTY_PCT,
  WAR_WEARINESS_WINNER_GAIN_PCT,
  applyWinnerWearinessDiscount,
  scaleWarWearinessGain,
  warWearinessAttackModifier,
  warWearinessRecovery,
} from "./politics";
import { DEFAULT_GAME_BALANCE_SETTINGS } from "./gameBalance";

test("攻擊修正:低於上限照舊線性扣,超過上限就停在 ×0.5", () => {
  assert.equal(warWearinessAttackModifier(0), 1);
  assert.equal(warWearinessAttackModifier(30), 0.7);
  assert.equal(warWearinessAttackModifier(50), 0.5);
  // 以下是修正前會繼續掉到 0 的區間
  assert.equal(warWearinessAttackModifier(51), 0.5);
  assert.equal(warWearinessAttackModifier(80), 0.5);
  assert.equal(warWearinessAttackModifier(100), 0.5);
  assert.equal(warWearinessAttackModifier(250), 0.5, "超界值照樣夾在上限");
});

test("攻擊修正:非法輸入不爆,且永不低於 1 − 上限", () => {
  const floor = 1 - WAR_WEARINESS_MAX_ATTACK_PENALTY_PCT / 100;
  for (const bad of [Number.NaN, -10, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const m = warWearinessAttackModifier(bad);
    assert.ok(Number.isFinite(m), String(bad));
    assert.ok(m >= floor && m <= 1, `${bad} → ${m}`);
  }
  // 非有限數視為 0 厭戰(不扣攻擊),而不是 +Infinity 就當 100% 厭戰
  assert.equal(warWearinessAttackModifier(Number.NaN), 1);
  assert.equal(warWearinessAttackModifier(Number.POSITIVE_INFINITY), 1);
});

test("勝方折減:戰力較高者增量減半,較低或持平者照舊", () => {
  assert.equal(WAR_WEARINESS_WINNER_GAIN_PCT, 50);
  assert.equal(applyWinnerWearinessDiscount(8, 1000, 500), 4, "佔上風 → 減半");
  assert.equal(applyWinnerWearinessDiscount(8, 500, 1000), 8, "居劣勢 → 照舊");
  assert.equal(applyWinnerWearinessDiscount(8, 700, 700), 8, "持平 → 照舊,不偏袒");
});

test("勝方折減:四捨五入、不為負、增量為 0 維持 0", () => {
  assert.equal(applyWinnerWearinessDiscount(5, 10, 1), 3, "2.5 四捨五入為 3");
  assert.equal(applyWinnerWearinessDiscount(1, 10, 1), 1, "1 × 0.5 = 0.5 → 1,不會被折到 0");
  assert.equal(applyWinnerWearinessDiscount(0, 10, 1), 0);
  assert.equal(applyWinnerWearinessDiscount(-3, 10, 1), 0, "負增量視為 0(厭戰度只升不降)");
  assert.equal(applyWinnerWearinessDiscount(Number.NaN, 10, 1), 0);
});

test("勝方折減:戰力資料無效時,雙方都照原增量(不因壞資料偏袒)", () => {
  for (const [own, enemy] of [[Number.NaN, 5], [5, Number.NaN], [Number.POSITIVE_INFINITY, 5], [Number.NaN, Number.NaN]] as const) {
    assert.equal(applyWinnerWearinessDiscount(8, own, enemy), 8, `${own}/${enemy}`);
  }
});

test("新預設:戰時 2、平時 5、倍率 65", () => {
  const w = DEFAULT_GAME_BALANCE_SETTINGS.war;
  assert.equal(w.warWearinessWartimeRecovery, 2);
  assert.equal(w.warWearinessPeacetimeRecovery, 5);
  assert.equal(w.warWearinessGainMultiplierPct, 65);
  assert.equal(warWearinessRecovery(true, w), 2);
  assert.equal(warWearinessRecovery(false, w), 5);
});

test("端到端算一遍:同一場戰役,新舊設定下 10 輪的厭戰度對比", () => {
  // 每輪 AI 給 6 點。舊制:無折減、倍率 100、戰時不回復。新制:勝方折減 + 倍率 65 + 戰時回復 2。
  const step = (cur: number, gain: number, recovery: number) => Math.max(0, Math.min(100, cur + gain) - recovery);
  let oldW = 0, newWinner = 0, newLoser = 0;
  for (let i = 0; i < 10; i++) {
    oldW = step(oldW, scaleWarWearinessGain(6, 100), 0);
    newWinner = step(newWinner, scaleWarWearinessGain(applyWinnerWearinessDiscount(6, 1000, 500), 65), 2);
    newLoser = step(newLoser, scaleWarWearinessGain(applyWinnerWearinessDiscount(6, 500, 1000), 65), 2);
  }
  assert.equal(oldW, 60, "舊制 10 輪 +60");
  assert.ok(newLoser < oldW, `敗方也比舊制低:${newLoser} < ${oldW}`);
  assert.ok(newWinner < newLoser, `勝方比敗方低:${newWinner} < ${newLoser}`);
  assert.ok(newWinner <= 5, `勝方基本壓得住(實際 ${newWinner})`);
  assert.equal(warWearinessAttackModifier(oldW) >= 0.5, true);
});
