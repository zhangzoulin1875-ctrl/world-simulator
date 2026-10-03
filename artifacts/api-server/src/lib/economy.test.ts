import { strict as assert } from "node:assert";
import test from "node:test";
import { ERAS } from "./mapRegionEras";
import {
  TAX_EFFICIENCY_BY_ERA,
  TAX_RATE_MAX,
  taxEfficiencyPctForEra,
  effectiveTaxEfficiencyPct,
  clampTaxRate,
  computeTaxIncome,
  computeTurnFinance,
  aggregateMilitaryUpkeep,
  computeAvailableProduction,
} from "./economy";

test("每個時代都有稅收效率，且隨時代嚴格遞增", () => {
  let prev = -Infinity;
  for (const era of ERAS) {
    const v = TAX_EFFICIENCY_BY_ERA[era.slug];
    assert.equal(typeof v, "number", `缺少時代 ${era.slug} 的稅收效率`);
    assert.ok(v! > prev, `時代 ${era.slug} 稅收效率未遞增 (${v} <= ${prev})`);
    prev = v!;
  }
});

test("taxEfficiencyPctForEra 未知 slug 回落古典", () => {
  assert.equal(taxEfficiencyPctForEra("classical"), 1);
  assert.equal(taxEfficiencyPctForEra("future"), 100);
  assert.equal(taxEfficiencyPctForEra("nonsense"), 1);
});

test("effectiveTaxEfficiencyPct 加成疊加、下限 0", () => {
  assert.equal(effectiveTaxEfficiencyPct("classical", 0), 1);
  assert.equal(effectiveTaxEfficiencyPct("classical", 4), 5);
  assert.equal(effectiveTaxEfficiencyPct("classical", -100), 0);
});

test("clampTaxRate 夾在 0..上限並四捨五入", () => {
  assert.equal(clampTaxRate(-3), 0);
  assert.equal(clampTaxRate(999), TAX_RATE_MAX);
  assert.equal(clampTaxRate(12.4), 12);
  assert.equal(clampTaxRate(12.6), 13);
});

test("computeTaxIncome = floor(人口 × 稅率 × 效率 / 10000)", () => {
  // 1,000,000 × 10% × 50% = 50,000
  assert.equal(
    computeTaxIncome({ population: 1_000_000, taxRatePct: 10, taxEfficiencyPct: 50 }),
    50_000,
  );
  // floor 驗證：123,456 × 3 × 7 / 10000 = 259.2 → 259
  assert.equal(
    computeTaxIncome({ population: 123_456, taxRatePct: 3, taxEfficiencyPct: 7 }),
    259,
  );
  // 零稅率 / 零效率 / 零人口 → 0
  assert.equal(computeTaxIncome({ population: 0, taxRatePct: 50, taxEfficiencyPct: 100 }), 0);
  assert.equal(computeTaxIncome({ population: 1_000_000, taxRatePct: 0, taxEfficiencyPct: 100 }), 0);
  assert.equal(computeTaxIncome({ population: 1_000_000, taxRatePct: 50, taxEfficiencyPct: 0 }), 0);
  // 負值防呆
  assert.equal(computeTaxIncome({ population: -5, taxRatePct: 10, taxEfficiencyPct: 10 }), 0);
});

test("computeTurnFinance 盈餘與金錢下限", () => {
  // 稅收 = 1,000,000 × 10 × 50 /10000 = 50,000；維護費 1,000
  // 盈餘 = 50,000 − 1,000 = 49,000；金錢 10,000 → 59,000
  const r = computeTurnFinance({
    money: 10_000,
    population: 1_000_000,
    taxRatePct: 10,
    taxEfficiencyPct: 50,
    upkeep: 1000,
  });
  assert.equal(r.taxIncome, 50_000);
  assert.equal(r.upkeepCharged, 1000);
  assert.equal(r.surplus, 49_000);
  assert.equal(r.newMoney, 59_000);
});

test("computeTurnFinance 金錢不會為負", () => {
  const r = computeTurnFinance({
    money: 100,
    population: 0,
    taxRatePct: 10,
    taxEfficiencyPct: 50,
    upkeep: 5000,
  });
  assert.equal(r.taxIncome, 0);
  assert.equal(r.upkeepCharged, 5000);
  assert.equal(r.surplus, -5000);
  assert.equal(r.newMoney, 0); // max(0, 100 − 5000)
});

test("computeTurnFinance 維護費無條件進位", () => {
  const r = computeTurnFinance({
    money: 0,
    population: 1_000_000,
    taxRatePct: 10,
    taxEfficiencyPct: 50,
    upkeep: 0.1,
  });
  assert.equal(r.upkeepCharged, 1);
});

test("clampTaxRate 上限即 TAX_RATE_MAX 常數", () => {
  assert.equal(clampTaxRate(TAX_RATE_MAX + 10), TAX_RATE_MAX);
});

test("aggregateMilitaryUpkeep 逐兵種小計、總計，並過濾數量 0", () => {
  const { lines, total } = aggregateMilitaryUpkeep([
    { templateId: 1, name: "步兵", quantity: 100, upkeepPerUnit: 0.5 },
    { templateId: 2, name: "騎兵", quantity: 0, upkeepPerUnit: 5 },
    { templateId: 3, name: "艦船", quantity: 3, upkeepPerUnit: 40 },
  ]);
  // 數量 0 的騎兵被過濾。
  assert.equal(lines.length, 2);
  // 依小計由大到小：艦船 120 > 步兵 50。
  assert.equal(lines[0].templateId, 3);
  assert.equal(lines[0].subtotal, 120);
  assert.equal(lines[1].templateId, 1);
  assert.equal(lines[1].subtotal, 50);
  assert.equal(total, 170);
});

test("aggregateMilitaryUpkeep 空陣列 → 無列、總計 0", () => {
  const { lines, total } = aggregateMilitaryUpkeep([]);
  assert.equal(lines.length, 0);
  assert.equal(total, 0);
});

// Task #568 — computeAvailableProduction：可用生產力 = 總生產力 − 已佔用 −
// 本回合招募花費（流量），下限 0。生產力維護費機制已全面移除。
test("computeAvailableProduction 正常情況：總量 − 已佔用 − 本回合花費", () => {
  assert.equal(
    computeAvailableProduction({
      production: 1000,
      productionSpent: 200,
      currentTurnSpend: 30,
    }),
    770,
  );
});

test("computeAvailableProduction 花費超過可用量 → 0（不為負）", () => {
  assert.equal(
    computeAvailableProduction({
      production: 300,
      productionSpent: 100,
      currentTurnSpend: 500,
    }),
    0,
  );
});

test("computeAvailableProduction 已佔用超過總量 → 0（不為負）", () => {
  assert.equal(
    computeAvailableProduction({
      production: 100,
      productionSpent: 150,
      currentTurnSpend: 50,
    }),
    0,
  );
});

test("computeAvailableProduction 花費為負（防禦性）→ 視為 0", () => {
  assert.equal(
    computeAvailableProduction({
      production: 800,
      productionSpent: 300,
      currentTurnSpend: -10,
    }),
    500,
  );
});

test("computeAvailableProduction 無花費 → 總量 − 已佔用", () => {
  assert.equal(
    computeAvailableProduction({
      production: 800,
      productionSpent: 300,
      currentTurnSpend: 0,
    }),
    500,
  );
});
