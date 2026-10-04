import test from "node:test";
import assert from "node:assert/strict";
import { GLOBAL_COST_DISCOUNT, PRICE_FACTOR_MAX, PRICE_FACTOR_MIN, UPKEEP_FACTOR_MAX, UPKEEP_FACTOR_MIN, effectivePriceScale, effectiveUpkeepScale, powerRatio, priceFactor, standardNationPopulation, upkeepFactor } from "./nationCostScale";
import { eraCostScale } from "./eraCostScale";

test("標準國（r=1）國力倍率為 1；有效尺度 = 時代係數 × 全域折扣", () => {
  assert.equal(priceFactor(1), 1);
  assert.equal(upkeepFactor(1), 1);
  const pop = standardNationPopulation("ww1");
  const expected = Math.round(eraCostScale("ww1") * GLOBAL_COST_DISCOUNT * 10000) / 10000;
  assert.equal(effectivePriceScale(eraCostScale("ww1"), pop, "ww1"), expected);
  assert.equal(effectiveUpkeepScale(eraCostScale("ww1"), pop, "ww1"), expected);
});

test("全域折扣：一次性價格與維護費共用同一個折扣（兩者比例不因折扣失衡）", () => {
  assert.ok(GLOBAL_COST_DISCOUNT > 0 && GLOBAL_COST_DISCOUNT <= 1);
  const era = eraCostScale("industrial");
  for (const mult of [0.3, 1, 2]) {
    const pop = standardNationPopulation("industrial") * mult;
    const price = effectivePriceScale(era, pop, "industrial");
    const upkeep = effectiveUpkeepScale(era, pop, "industrial");
    // 窄夾限內兩者同曲線 → 比值 = priceFactor/upkeepFactor，與折扣無關。
    const ratio = priceFactor(powerRatio(pop, "industrial")) / upkeepFactor(powerRatio(pop, "industrial"));
    assert.ok(Math.abs(price / upkeep - ratio) < 0.01);
  }
});

test("小國有補貼：價格降得比國力慢，但負擔仍高於標準國", () => {
  for (const r of [0.05, 0.1, 0.25, 0.5]) {
    const f = priceFactor(r);
    assert.ok(f < 1, `r=${r} 價格應低於標準`);
    assert.ok(f > r, `r=${r} 價格降幅應小於國力降幅（有補貼但不完全）`);
    assert.ok(f / r > 1, `r=${r} 小國相對負擔應仍高於標準國`);
  }
});

test("大國保有優勢：價格漲得比收入慢，負擔低於標準國", () => {
  for (const r of [2, 4, 10, 30]) {
    const f = priceFactor(r);
    assert.ok(f > 1, `r=${r} 價格應高於標準`);
    assert.ok(f < r, `r=${r} 價格漲幅應小於國力漲幅`);
    assert.ok(f / r < 1, `r=${r} 大國相對負擔應低於標準國`);
  }
});

test("大國優勢是嚴格遞增的：越大負擔越輕；小國越小負擔越重", () => {
  const burden = (r: number) => priceFactor(r) / r;
  assert.ok(burden(0.1) > burden(0.5) && burden(0.5) > burden(1));
  assert.ok(burden(1) > burden(4) && burden(4) > burden(30));
});

test("夾限：零人口、負數、NaN、極端值都不會產生 0／無限／NaN", () => {
  assert.equal(priceFactor(0), PRICE_FACTOR_MIN);
  assert.equal(priceFactor(-5), PRICE_FACTOR_MIN);
  assert.equal(priceFactor(NaN), PRICE_FACTOR_MIN);
  assert.equal(priceFactor(1e12), PRICE_FACTOR_MAX);
  assert.equal(upkeepFactor(0), UPKEEP_FACTOR_MIN);
  assert.equal(upkeepFactor(1e12), UPKEEP_FACTOR_MAX);
  assert.equal(powerRatio(0, "ww1"), 0);
  assert.equal(powerRatio(NaN, "ww1"), 0);
});

test("維護費倍率比一次性價格窄：極端國力下維護費波動較小", () => {
  assert.ok(upkeepFactor(0.01) >= priceFactor(0.01));
  assert.ok(upkeepFactor(1000) <= priceFactor(1000));
  assert.ok(UPKEEP_FACTOR_MAX / UPKEEP_FACTOR_MIN < PRICE_FACTOR_MAX / PRICE_FACTOR_MIN);
});

test("單調性：國力越大，價格與維護費絕不降低", () => {
  let p = 0, u = 0;
  for (let r = 0.001; r < 100; r *= 1.3) {
    assert.ok(priceFactor(r) >= p);
    assert.ok(upkeepFactor(r) >= u);
    p = priceFactor(r); u = upkeepFactor(r);
  }
});

test("標準國人口隨時代成長；未知時代回古典", () => {
  assert.ok(standardNationPopulation("future") > standardNationPopulation("ww1"));
  assert.equal(standardNationPopulation("nope"), standardNationPopulation("classical"));
  assert.equal(standardNationPopulation(null), standardNationPopulation("classical"));
});

test("有效尺度結果為穩定的 4 位小數", () => {
  const s = effectiveUpkeepScale(285, 1_234_567, "ww1");
  assert.equal(s, Math.round(s * 10000) / 10000);
});
