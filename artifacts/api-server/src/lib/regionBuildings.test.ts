/**
 * Task #406 — 地區資源建築純函式單元測試：
 * 升級成本公式（基礎 × 1.2^(level−1) 向上取整）、產出、工人、維護費、
 * 類型守門與標籤對照。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILDING_BASE_COST,
  BUILDING_LABEL,
  BUILDING_OUTPUT_PER_LEVEL,
  BUILDING_RESOURCE,
  BUILDING_TYPES,
  BUILDING_UPKEEP_PER_LEVEL,
  BUILDING_WORKERS_PER_LEVEL,
  MAX_BUILDING_LEVEL,
  buildingCost,
  buildingOutput,
  buildingUpkeep,
  buildingWorkers,
  isBuildingType,
} from "./regionBuildings";

test("buildingCost：level 1 等於基礎成本", () => {
  assert.deepEqual(buildingCost(1), {
    money: BUILDING_BASE_COST.money,
    production: BUILDING_BASE_COST.production,
  });
});

test("buildingCost：每級 ×1.2 向上取整", () => {
  // level 2 = 5000×1.2 = 6000 / 200×1.2 = 240
  assert.deepEqual(buildingCost(2), { money: 6000, production: 240 });
  // level 3 = 5000×1.44 = 7200 / 200×1.44 = 288
  assert.deepEqual(buildingCost(3), { money: 7200, production: 288 });
  // level 5 = 5000×1.2^4 = 10368 / 200×1.2^4 = 414.72 → ceil 415
  assert.deepEqual(buildingCost(5), { money: 10368, production: 415 });
});

test("buildingCost：向上取整（非整數結果進位）", () => {
  for (let level = 1; level <= 20; level++) {
    const c = buildingCost(level);
    const factor = Math.pow(1.2, level - 1);
    assert.equal(c.money, Math.ceil(BUILDING_BASE_COST.money * factor));
    assert.equal(
      c.production,
      Math.ceil(BUILDING_BASE_COST.production * factor),
    );
    assert.ok(Number.isInteger(c.money));
    assert.ok(Number.isInteger(c.production));
  }
});

test("buildingCost：成本嚴格遞增且在等級上限內仍是安全整數", () => {
  let prev = buildingCost(1);
  for (let level = 2; level <= MAX_BUILDING_LEVEL; level++) {
    const c = buildingCost(level);
    assert.ok(c.money > prev.money, `level ${level} money 應遞增`);
    assert.ok(c.production > prev.production, `level ${level} production 應遞增`);
    assert.ok(Number.isSafeInteger(c.money));
    assert.ok(Number.isSafeInteger(c.production));
    prev = c;
  }
});

test("buildingOutput / buildingWorkers / buildingUpkeep：線性 × level", () => {
  for (const level of [1, 2, 7, MAX_BUILDING_LEVEL]) {
    assert.equal(buildingOutput(level), BUILDING_OUTPUT_PER_LEVEL * level);
    assert.equal(buildingWorkers(level), BUILDING_WORKERS_PER_LEVEL * level);
    assert.equal(buildingUpkeep(level), BUILDING_UPKEEP_PER_LEVEL * level);
  }
  assert.equal(buildingOutput(1), 50);
  assert.equal(buildingWorkers(1), 1000);
  assert.equal(buildingUpkeep(1), 100);
});

test("buildingWorkers：工人上限判定範例（人口 3000 只容得下 3 級）", () => {
  const population = 3000;
  // Σ level = 3 → 3000 工人 = 剛好打平（允許）；再 +1 級就超過。
  assert.ok(buildingWorkers(3) <= population);
  assert.ok(buildingWorkers(3) + buildingWorkers(1) > population);
});

test("isBuildingType：只接受 lumber_mill / mine", () => {
  assert.ok(isBuildingType("lumber_mill"));
  assert.ok(isBuildingType("mine"));
  assert.ok(!isBuildingType("farm"));
  assert.ok(!isBuildingType(""));
  assert.ok(!isBuildingType("LUMBER_MILL"));
});

test("標籤與資源對照完整（zh-TW）", () => {
  assert.equal(BUILDING_TYPES.length, 2);
  assert.equal(BUILDING_LABEL.lumber_mill, "木材廠");
  assert.equal(BUILDING_LABEL.mine, "礦場");
  assert.equal(BUILDING_RESOURCE.lumber_mill, "wood");
  assert.equal(BUILDING_RESOURCE.mine, "ore");
});
