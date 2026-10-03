/**
 * 地區生產力投資費用純函式單元測試（Task #405）。
 * `pnpm --filter @workspace/api-server run test`。
 */
import { strict as assert } from "node:assert";
import test from "node:test";

import {
  effectiveProductivity,
  investmentCostMultiplier,
  investmentCost,
} from "./regionInvestment";

test("effectiveProductivity = era stat + 投資加成", () => {
  assert.equal(effectiveProductivity(50, 0), 50);
  assert.equal(effectiveProductivity(50, 7), 57);
  assert.equal(effectiveProductivity(0, 3), 3);
});

test("倍率：低於或等於全球平均 → 1", () => {
  assert.equal(investmentCostMultiplier(30, 50), 1);
  assert.equal(investmentCostMultiplier(50, 50), 1);
});

test("倍率：高於平均 → 連續比值（不分級、不捨入）", () => {
  assert.equal(investmentCostMultiplier(100, 50), 2);
  assert.equal(investmentCostMultiplier(75, 50), 1.5);
  const m = investmentCostMultiplier(51, 50);
  assert.ok(Math.abs(m - 1.02) < 1e-12);
});

test("倍率：全球平均 ≤ 0 → 1（除零保護）", () => {
  assert.equal(investmentCostMultiplier(80, 0), 1);
  assert.equal(investmentCostMultiplier(80, -5), 1);
});

test("費用 = ceil(人口 × 倍率)，中間值不提前捨入", () => {
  // 平均以下：費用 = 人口
  assert.equal(investmentCost(123456, 40, 50), 123456);
  // 1.02 倍：ceil(100000 × 1.02) = 102000
  assert.equal(investmentCost(100000, 51, 50), 102000);
  // 非整除：ceil(1001 × 51/50) = ceil(1021.02) = 1022
  assert.equal(investmentCost(1001, 51, 50), 1022);
});

test("費用下限 1：人口 0 或負值也不能免費投資", () => {
  assert.equal(investmentCost(0, 50, 50), 1);
  assert.equal(investmentCost(-10, 50, 50), 1);
});
