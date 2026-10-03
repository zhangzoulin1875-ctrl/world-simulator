import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adjustedResearchCost,
  aheadEraCostFactor,
  researchCostMultiplier,
} from "./researchCost";

describe("researchCostMultiplier", () => {
  it("全球平均 ≤ 0 時回傳 1（不縮放）", () => {
    assert.equal(researchCostMultiplier(500, 0), 1);
    assert.equal(researchCostMultiplier(500, -10), 1);
  });

  it("人口為平均 3 倍 → 乘數 3", () => {
    assert.equal(researchCostMultiplier(300, 100), 3);
  });

  it("人口為平均一半 → 乘數 0.5", () => {
    assert.equal(researchCostMultiplier(50, 100), 0.5);
  });

  it("人口 0 → 乘數 0", () => {
    assert.equal(researchCostMultiplier(0, 100), 0);
  });

  it("人口為負時視為 0", () => {
    assert.equal(researchCostMultiplier(-5, 100), 0);
  });
});

describe("adjustedResearchCost", () => {
  it("成本 = round(base × mult)", () => {
    assert.equal(adjustedResearchCost(100, 3), 300);
    assert.equal(adjustedResearchCost(100, 0.5), 50);
    assert.equal(adjustedResearchCost(7, 1.5), 11); // 10.5 → round → 11（銀行家？Math.round → 11）
  });

  it("下限為 1（乘數 0 或極小仍至少 1 點）", () => {
    assert.equal(adjustedResearchCost(100, 0), 1);
    assert.equal(adjustedResearchCost(3, 0.001), 1);
  });

  it("乘數 1 → 原價", () => {
    assert.equal(adjustedResearchCost(250, 1), 250);
  });
});

describe("aheadEraCostFactor", () => {
  it("領域時代領先世界時代 → 回傳設定倍率", () => {
    assert.equal(aheadEraCostFactor("roman", "classical", 5), 5);
    assert.equal(aheadEraCostFactor("modern", "classical", 3), 3);
  });

  it("領先多個時代不累乘（同一倍率）", () => {
    assert.equal(
      aheadEraCostFactor("future", "classical", 5),
      aheadEraCostFactor("roman", "classical", 5),
    );
  });

  it("同時代或落後 → 1（不加價）", () => {
    assert.equal(aheadEraCostFactor("classical", "classical", 5), 1);
    assert.equal(aheadEraCostFactor("classical", "modern", 5), 1);
  });

  it("未知 slug（任一側）→ 1", () => {
    assert.equal(aheadEraCostFactor("not-an-era", "classical", 5), 1);
    assert.equal(aheadEraCostFactor("roman", "", 5), 1);
    assert.equal(aheadEraCostFactor("", "", 5), 1);
  });

  it("倍率下限 1；非有限值 → 1", () => {
    assert.equal(aheadEraCostFactor("roman", "classical", 0), 1);
    assert.equal(aheadEraCostFactor("roman", "classical", -3), 1);
    assert.equal(aheadEraCostFactor("roman", "classical", Number.NaN), 1);
    assert.equal(aheadEraCostFactor("roman", "classical", Infinity), 1);
  });

  it("倍率 1 → 不加價（管理員可關閉此機制）", () => {
    assert.equal(aheadEraCostFactor("roman", "classical", 1), 1);
  });
});
