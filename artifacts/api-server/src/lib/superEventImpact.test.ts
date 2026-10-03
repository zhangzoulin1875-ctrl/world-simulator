import test from "node:test";
import assert from "node:assert/strict";
import {
  STAGES,
  stageDef,
  stageLabel,
  stageSeverityFactor,
  isSuperEventStage,
  governmentResistanceFactor,
  responseFitFactor,
  computeExposureRatio,
  contagionSpreadChance,
  selectContagionTargets,
  SUPER_EVENT_TARGET_STATS,
  isSuperEventTargetStat,
  targetStatLabel,
  restrictEffectToTargetStats,
  buildTargetStatsGuidance,
  computeDirectPopulationDelta,
  DEFAULT_LOSS_BOUNDS,
  normalizeLossBounds,
  clampHarmfulDelta,
} from "./superEventImpact";
import type { SuperEventEffect } from "./superEventAi";

/**
 * Task #356 — 超事件差異化影響／分階段演變／傳染擴散純函式的單元測試。
 *
 * 這些函式無副作用、不碰 DB，故直接以固定輸入斷言輸出。對照原則：AI 只給敘事與
 * 幅度，這些純函式決定伺服器如何依「暴露程度／政體／應對契合／階段」把幅度差異化。
 */

test("STAGES：五階段順序與蔓延停止", () => {
  assert.deepEqual(
    STAGES.map((s) => s.slug),
    ["outbreak", "spreading", "peak", "receding", "ended"],
  );
  assert.deepEqual(
    STAGES.map((s) => s.order),
    [0, 1, 2, 3, 4],
  );
  // 消退／落幕停止擴散。
  assert.equal(stageDef("receding").spreadFactor, 0);
  assert.equal(stageDef("ended").spreadFactor, 0);
  // 高峰嚴重度倍率最高。
  assert.equal(stageSeverityFactor("peak"), 1.3);
});

test("stageDef／stageLabel：未知階段回退至 outbreak", () => {
  assert.equal(stageDef("outbreak").slug, "outbreak");
  assert.equal(stageLabel("peak"), "高峰");
  assert.equal(stageDef("__nope__").slug, "outbreak");
  assert.equal(stageLabel("__nope__"), "爆發");
});

test("isSuperEventStage：只認得合法階段 slug", () => {
  assert.equal(isSuperEventStage("spreading"), true);
  assert.equal(isSuperEventStage("ended"), true);
  assert.equal(isSuperEventStage("global"), false);
  assert.equal(isSuperEventStage(""), false);
});

test("governmentResistanceFactor：災難集權抗性高、機會開放把握佳", () => {
  // 災難：0.8 + d/100*0.5。集權（君主專制 d=20）幅度小，開放（邦聯制 d=70）幅度大。
  assert.equal(governmentResistanceFactor("君主專制", "disaster"), 0.9);
  assert.equal(governmentResistanceFactor("邦聯制", "disaster"), 1.15);
  // null → d=50 → 1.05。
  assert.equal(governmentResistanceFactor(null, "disaster"), 1.05);
  // 機會：0.85 + d/100*0.4。開放政體幅度較大。
  assert.equal(governmentResistanceFactor("君主專制", "opportunity"), 0.93);
  assert.equal(governmentResistanceFactor("邦聯制", "opportunity"), 1.13);
  // slug 亦可（軍事獨裁 d=15，災難 → 0.875 → round2 0.88）。
  assert.equal(
    governmentResistanceFactor("military_dictatorship", "disaster"),
    0.88,
  );
});

test("responseFitFactor：契合得當緩解災難／放大機會，無應對回 1", () => {
  assert.equal(responseFitFactor(null, "disaster"), 1);
  assert.equal(responseFitFactor(Number.NaN, "opportunity"), 1);
  // 災難：高契合＝幅度小、低契合＝幅度大、中性＝1。
  assert.equal(responseFitFactor(100, "disaster"), 0.6);
  assert.equal(responseFitFactor(0, "disaster"), 1.4);
  assert.equal(responseFitFactor(50, "disaster"), 1);
  // 機會：高契合＝幅度大、低契合＝幅度小。
  assert.equal(responseFitFactor(100, "opportunity"), 1.4);
  assert.equal(responseFitFactor(0, "opportunity"), 0.6);
  // 夾限：超出 0–100 先夾再算，不會越界。
  assert.equal(responseFitFactor(999, "disaster"), 0.6);
  assert.equal(responseFitFactor(-999, "disaster"), 1.4);
});

test("computeExposureRatio：僅 regional 依人口占比縮放，其餘視為整國暴露", () => {
  assert.equal(computeExposureRatio(50, 100, "regional"), 0.5);
  assert.equal(computeExposureRatio(25, 200, "regional"), 0.13);
  // global／targeted 整國暴露。
  assert.equal(computeExposureRatio(50, 100, "global"), 1);
  assert.equal(computeExposureRatio(50, 100, "targeted"), 1);
  // 邊界：總人口 0 或超過全國 → 安全夾限。
  assert.equal(computeExposureRatio(10, 0, "regional"), 1);
  assert.equal(computeExposureRatio(150, 100, "regional"), 1);
});

test("contagionSpreadChance：依嚴重度與階段，消退／落幕停止", () => {
  // 嚴重度 100：base=0.4，乘階段 spreadFactor。
  assert.equal(contagionSpreadChance(100, "spreading"), 0.4);
  assert.equal(contagionSpreadChance(100, "outbreak"), 0.2);
  assert.equal(contagionSpreadChance(100, "peak"), 0.32);
  assert.equal(contagionSpreadChance(100, "receding"), 0);
  assert.equal(contagionSpreadChance(100, "ended"), 0);
  // 嚴重度縮放。
  assert.equal(contagionSpreadChance(50, "spreading"), 0.2);
  assert.equal(contagionSpreadChance(0, "spreading"), 0);
});

test("selectContagionTargets：只納入未涵蓋的相鄰地區，rng 可注入", () => {
  const adjacency = new Map<number, number[]>([
    [1, [2, 3]],
    [2, [1, 4]],
    [3, [1, 5]],
    [4, [2]],
    [5, [3]],
  ]);

  // rng 恆 0（< 任何正機率）→ 納入所有新相鄰地區（去重，排除已涵蓋的 1、2）。
  const all = selectContagionTargets({
    currentRegionIds: [1, 2],
    adjacency,
    spreadChance: 0.4,
    rng: () => 0,
  });
  assert.deepEqual([...all].sort((a, b) => a - b), [3, 4]);

  // rng 恆 1（≥ 機率）→ 不納入任何地區。
  const none = selectContagionTargets({
    currentRegionIds: [1, 2],
    adjacency,
    spreadChance: 0.4,
    rng: () => 1,
  });
  assert.deepEqual(none, []);

  // spreadChance <= 0 → 直接不擴散（不呼叫 rng）。
  const stopped = selectContagionTargets({
    currentRegionIds: [1],
    adjacency,
    spreadChance: 0,
    rng: () => 0,
  });
  assert.deepEqual(stopped, []);

  // 無相鄰資料 → 空。
  const isolated = selectContagionTargets({
    currentRegionIds: [99],
    adjacency,
    spreadChance: 0.9,
    rng: () => 0,
  });
  assert.deepEqual(isolated, []);
});

/* ------------------------------------------------------------------ *
 * 目標數據（管理員指定要打擊／提升的數據欄位）
 * ------------------------------------------------------------------ */

function fullEffect(): SuperEventEffect {
  return {
    populationDeltaPct: -5,
    productivityDeltaPct: -10,
    satisfactionFarmersDelta: -3,
    satisfactionWorkersDelta: 4,
    satisfactionClergyDelta: -6,
    satisfactionNoblesDelta: 2,
    stabilityDelta: -8,
    unrestDelta: 9,
  };
}

test("isSuperEventTargetStat／targetStatLabel：8 個合法 key，未知 key 原樣返回", () => {
  assert.equal(SUPER_EVENT_TARGET_STATS.length, 8);
  for (const s of SUPER_EVENT_TARGET_STATS) {
    assert.equal(isSuperEventTargetStat(s.key), true);
  }
  assert.equal(isSuperEventTargetStat("money"), false);
  assert.equal(isSuperEventTargetStat(""), false);
  assert.equal(targetStatLabel("population"), "人口");
  assert.equal(targetStatLabel("unrest"), "動亂度");
  assert.equal(targetStatLabel("whatever"), "whatever");
});

test("restrictEffectToTargetStats：非目標欄位強制歸零，目標欄位保留", () => {
  const effect = fullEffect();
  const restricted = restrictEffectToTargetStats(effect, [
    "population",
    "unrest",
  ]);
  assert.equal(restricted.populationDeltaPct, -5);
  assert.equal(restricted.unrestDelta, 9);
  assert.equal(restricted.productivityDeltaPct, 0);
  assert.equal(restricted.satisfactionFarmersDelta, 0);
  assert.equal(restricted.satisfactionWorkersDelta, 0);
  assert.equal(restricted.satisfactionClergyDelta, 0);
  assert.equal(restricted.satisfactionNoblesDelta, 0);
  assert.equal(restricted.stabilityDelta, 0);
  // 不可變：原 effect 不被修改。
  assert.equal(effect.productivityDeltaPct, -10);
});

test("restrictEffectToTargetStats：null／空／全未知 key ＝不限（原樣返回）", () => {
  const effect = fullEffect();
  assert.deepEqual(restrictEffectToTargetStats(effect, null), effect);
  assert.deepEqual(restrictEffectToTargetStats(effect, undefined), effect);
  assert.deepEqual(restrictEffectToTargetStats(effect, []), effect);
  assert.deepEqual(restrictEffectToTargetStats(effect, ["money", "x"]), effect);
  // 混雜未知 key：只依合法 key 過濾。
  const mixed = restrictEffectToTargetStats(effect, ["money", "stability"]);
  assert.equal(mixed.stabilityDelta, -8);
  assert.equal(mixed.populationDeltaPct, 0);
});

test("buildTargetStatsGuidance：列出允許欄位；無指定回空字串", () => {
  assert.equal(buildTargetStatsGuidance(null), "");
  assert.equal(buildTargetStatsGuidance(undefined), "");
  assert.equal(buildTargetStatsGuidance([]), "");
  assert.equal(buildTargetStatsGuidance(["nope"]), "");
  const guidance = buildTargetStatsGuidance(["population", "stability"]);
  assert.ok(guidance.includes("populationDeltaPct（人口）"));
  assert.ok(guidance.includes("stabilityDelta（安定度）"));
  assert.ok(guidance.includes("其餘欄位一律填 0"));
  assert.ok(!guidance.includes("unrestDelta"));
});

test("computeDirectPopulationDelta：直接 % 扣除，只乘 popMult", () => {
  // 100 萬人 × -5% × 1 ＝ -5 萬。
  assert.equal(computeDirectPopulationDelta(1_000_000, -5, 1), -50_000);
  // popMult 0.5（事件影響 50%）→ 減半。
  assert.equal(computeDirectPopulationDelta(1_000_000, -5, 0.5), -25_000);
  // popMult 2（impactPct 200%）→ 加倍。
  assert.equal(computeDirectPopulationDelta(1_000_000, -5, 2), -100_000);
  // 正向（機會事件）。
  assert.equal(computeDirectPopulationDelta(200_000, 3, 1), 6_000);
  // 四捨五入到整數人。
  assert.equal(computeDirectPopulationDelta(333, 1, 1), 3);
});

test("computeDirectPopulationDelta：邊界——0／負基數、pct=0、popMult 夾限", () => {
  assert.equal(computeDirectPopulationDelta(0, -5, 1), 0);
  assert.equal(computeDirectPopulationDelta(-100, -5, 1), 0);
  assert.equal(computeDirectPopulationDelta(1_000_000, 0, 1), 0);
  // popMult < 0 夾到 0（管理員 kill-switch impactPct=0 → 無人口變動）。
  assert.equal(computeDirectPopulationDelta(1_000_000, -5, 0), 0);
  assert.equal(computeDirectPopulationDelta(1_000_000, -5, -1), 0);
  // 非有限 popMult → 視為 1。
  assert.equal(computeDirectPopulationDelta(1_000_000, -5, Number.NaN), -50_000);
});

test("normalizeLossBounds：夾 0–100 取整；min>max 以 max 為準；非有限值回預設", () => {
  assert.deepEqual(normalizeLossBounds(0, 100), { minPct: 0, maxPct: 100 });
  assert.deepEqual(normalizeLossBounds(5, 20), { minPct: 5, maxPct: 20 });
  // 超界夾限＋四捨五入。
  assert.deepEqual(normalizeLossBounds(-10, 250), { minPct: 0, maxPct: 100 });
  assert.deepEqual(normalizeLossBounds(2.6, 9.4), { minPct: 3, maxPct: 9 });
  // min > max → 以 max 為準。
  assert.deepEqual(normalizeLossBounds(50, 10), { minPct: 10, maxPct: 10 });
  // 非有限輸入 → 預設 0／100。
  assert.deepEqual(normalizeLossBounds(Number.NaN, Number.NaN), {
    minPct: 0,
    maxPct: 100,
  });
});

test("clampHarmfulDelta：只夾有害方向；0／有利方向原樣；絕不無中生有", () => {
  const b = { minPct: 5, maxPct: 20 };
  // 負向有害（人口／生產／滿意度／安定度）：
  assert.equal(clampHarmfulDelta(-3, -1, b), -5); // 抬到下限
  assert.equal(clampHarmfulDelta(-10, -1, b), -10); // 區間內不動
  assert.equal(clampHarmfulDelta(-50, -1, b), -20); // 壓到上限
  assert.equal(clampHarmfulDelta(0, -1, b), 0); // 無損失 → 不無中生有
  assert.equal(clampHarmfulDelta(8, -1, b), 8); // 增益不受影響
  // 正向有害（暴動度）：
  assert.equal(clampHarmfulDelta(3, 1, b), 5);
  assert.equal(clampHarmfulDelta(50, 1, b), 20);
  assert.equal(clampHarmfulDelta(-4, 1, b), -4); // 暴動度下降＝有利 → 不動
  // 上限 0 ＝ 取消所有損失（±0 皆視為 0）。
  const cancel = { minPct: 0, maxPct: 0 };
  assert.equal(Math.abs(clampHarmfulDelta(-50, -1, cancel)), 0);
  assert.equal(Math.abs(clampHarmfulDelta(30, 1, cancel)), 0);
  // 預設界限＝不設限（區間 0–100 內原樣）。
  assert.equal(clampHarmfulDelta(-42, -1, DEFAULT_LOSS_BOUNDS), -42);
});

test("computeDirectPopulationDelta：帶 bounds 時只夾人口損失", () => {
  const b = { minPct: 5, maxPct: 20 };
  // -50% 壓到 -20%。
  assert.equal(computeDirectPopulationDelta(1_000_000, -50, 1, b), -200_000);
  // -3% 抬到 -5%（本就有損失才會抬）。
  assert.equal(computeDirectPopulationDelta(1_000_000, -3, 1, b), -50_000);
  // 區間內不動。
  assert.equal(computeDirectPopulationDelta(1_000_000, -10, 1, b), -100_000);
  // 增益不受影響。
  assert.equal(computeDirectPopulationDelta(1_000_000, 8, 1, b), 80_000);
  // pct=0 → 不無中生有。
  assert.equal(computeDirectPopulationDelta(1_000_000, 0, 1, b), 0);
  // popMult=0（kill-switch）→ 有效 % 為 0 → 下限也不會憑空造成損失。
  assert.equal(computeDirectPopulationDelta(1_000_000, -50, 0, b), 0);
  // 上限 0 ＝ 取消人口損失。
  assert.equal(
    computeDirectPopulationDelta(1_000_000, -50, 1, { minPct: 0, maxPct: 0 }),
    0,
  );
  // 夾限作用在「乘完 popMult 的有效 %」：-30% × 0.5 = -15%（區間內）。
  assert.equal(computeDirectPopulationDelta(1_000_000, -30, 0.5, b), -150_000);
  // 不帶 bounds → 行為不變。
  assert.equal(computeDirectPopulationDelta(1_000_000, -50, 1), -500_000);
});
