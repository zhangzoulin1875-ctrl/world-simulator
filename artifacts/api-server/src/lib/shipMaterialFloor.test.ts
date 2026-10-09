import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampUnitDesign, minMaterialCosts, DEFAULT_GAME_BALANCE_SETTINGS,
  SHIP_MIN_WOOD_COST_PER_UNIT, SHIP_MIN_ORE_COST_PER_UNIT,
  type UnitDesignStats, type UnitCategoryAverages,
} from "./gameBalance";

const AVG: UnitCategoryAverages = { hp: 100, attack: 100, defense: 10, speed: 1, woodCost: 1, oreCost: 1, upkeep: 0.5, prodUpkeep: 0.5, count: 10 };
const design = (o?: Partial<UnitDesignStats>): UnitDesignStats => ({
  hp: 120, attack: 130, defense: 12, speed: 1, prodCostPer100: 5, popCostPerUnit: 1, moneyCostPerUnit: 10,
  upkeepPerUnit: 0.5, prodUpkeepPerUnit: 0.5, woodCostPerUnit: 5, oreCostPerUnit: 5, ...o,
});
const S = DEFAULT_GAME_BALANCE_SETTINGS;

test("下限常數就是 3 / 3(需求寫死,不放進可調設定)", () => {
  assert.equal(SHIP_MIN_WOOD_COST_PER_UNIT, 3); assert.equal(SHIP_MIN_ORE_COST_PER_UNIT, 3);
  assert.deepEqual(minMaterialCosts("ship"), { wood: 3, ore: 3 });
});
test("非船艦沒有下限(其他兵種維持可為 0)", () => {
  for (const c of ["infantry", "cavalry", "ranged", "artillery", "anything"]) assert.deepEqual(minMaterialCosts(c), { wood: 0, ore: 0 }, c);
});
test("船 0 木 0 礦 → 補到 3 / 3,並留下說明", () => {
  const { design: out, clamps } = clampUnitDesign(design({ woodCostPerUnit: 0, oreCostPerUnit: 0 }), "ship", AVG, S);
  assert.equal(out.woodCostPerUnit, 3); assert.equal(out.oreCostPerUnit, 3);
  assert.equal(clamps.filter((c) => /船艦最低/.test(c)).length, 2);
});
test("只有一項違規只補那一項:0 木 / 10 礦 → 3 / 10;10 木 / 2 礦 → 10 / 3", () => {
  const a = clampUnitDesign(design({ woodCostPerUnit: 0, oreCostPerUnit: 10 }), "ship", AVG, S).design;
  assert.deepEqual([a.woodCostPerUnit, a.oreCostPerUnit], [3, 10]);
  const b = clampUnitDesign(design({ woodCostPerUnit: 10, oreCostPerUnit: 2 }), "ship", AVG, S).design;
  assert.deepEqual([b.woodCostPerUnit, b.oreCostPerUnit], [10, 3]);
});
test("邊界:剛好 3 不動、2 補到 3;已高於 3 一律不被拉低", () => {
  const ok = clampUnitDesign(design({ woodCostPerUnit: 3, oreCostPerUnit: 3 }), "ship", AVG, S);
  assert.deepEqual([ok.design.woodCostPerUnit, ok.design.oreCostPerUnit], [3, 3]);
  assert.equal(ok.clamps.filter((c) => /船艦最低/.test(c)).length, 0, "合格時不產生說明");
  const two = clampUnitDesign(design({ woodCostPerUnit: 2, oreCostPerUnit: 2 }), "ship", AVG, S).design;
  assert.deepEqual([two.woodCostPerUnit, two.oreCostPerUnit], [3, 3]);
  const big = clampUnitDesign(design({ woodCostPerUnit: 500, oreCostPerUnit: 900 }), "ship", AVG, S).design;
  assert.deepEqual([big.woodCostPerUnit, big.oreCostPerUnit], [500, 900]);
});
test("非船艦 0 木 0 礦維持原樣(規則只針對船)", () => {
  const { design: out } = clampUnitDesign(design({ woodCostPerUnit: 0, oreCostPerUnit: 0 }), "infantry", AVG, S);
  assert.deepEqual([out.woodCostPerUnit, out.oreCostPerUnit], [0, 0]);
});
test("與既有上限交互:上限設成 0 也不能讓船低於下限(下限優先)", () => {
  const capped = structuredClone(S); capped.unitDesign.woodCostMax = 0; capped.unitDesign.oreCostMax = 0;
  const { design: out } = clampUnitDesign(design({ woodCostPerUnit: 50, oreCostPerUnit: 50 }), "ship", AVG, capped);
  assert.deepEqual([out.woodCostPerUnit, out.oreCostPerUnit], [3, 3]);
});
test("不修改傳入的 design 物件(純函式)", () => {
  const d = design({ woodCostPerUnit: 0, oreCostPerUnit: 0 });
  clampUnitDesign(d, "ship", AVG, S);
  assert.deepEqual([d.woodCostPerUnit, d.oreCostPerUnit], [0, 0]);
});
