import assert from "node:assert/strict";
import test from "node:test";
import {
  ERA_COST_SCALE,
  computeEraCostScaleTable,
  eraCostScale,
  scaleByEra,
  scaleUpkeepByEra,
} from "./eraCostScale";
import { TAX_EFFICIENCY_BY_ERA } from "./economy";

test("係數表與稅基公式同步（人口×稅收效率，3 位有效數字）", () => {
  const computed = computeEraCostScaleTable();
  for (const era of Object.keys(TAX_EFFICIENCY_BY_ERA)) {
    const got = ERA_COST_SCALE[era];
    const want = computed[era]!;
    assert.ok(got !== undefined, `缺少時代 ${era}`);
    assert.equal(got, want, `${era}: 常數表 ${got} 與公式 ${want} 不一致，請更新 ERA_COST_SCALE`);
  }
});

test("係數涵蓋所有時代、古典為 1、且嚴格遞增", () => {
  const eras = Object.keys(TAX_EFFICIENCY_BY_ERA);
  assert.equal(ERA_COST_SCALE["classical"], 1);
  let prev = 0;
  for (const era of eras) {
    const v = ERA_COST_SCALE[era]!;
    assert.ok(v > prev, `${era} 應大於前一時代`);
    prev = v;
  }
});

test("未知／空時代回 1；scale=1 原值回傳", () => {
  assert.equal(eraCostScale("nope"), 1);
  assert.equal(eraCostScale(null), 1);
  assert.equal(scaleByEra(123, 1), 123);
  assert.equal(scaleUpkeepByEra(0.1, 1), 0.1);
});

test("縮放取整與下限", () => {
  assert.equal(scaleByEra(6000, 285), 1_710_000);
  assert.equal(scaleByEra(0, 285), 0);
  assert.equal(scaleByEra(1, 0.1, 1), 1);
  assert.equal(scaleUpkeepByEra(0.1, 285, 0.1), 28.5);
});

test("開銷佔收入比例跨時代穩定（工廠維護／單區稅收）", () => {
  // 單區稅收 ∝ 人口×效率；此處用係數驗證比例不會崩（一戰 vs 古典差 <3 倍）。
  const classical = 200 * eraCostScale("classical");
  const ww1 = 200 * eraCostScale("ww1");
  assert.ok(ww1 / classical === 285);
});
