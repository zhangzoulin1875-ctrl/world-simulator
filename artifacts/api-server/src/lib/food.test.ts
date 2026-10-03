import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FOOD_ERA_INDEX,
  FOOD_CALIBRATION,
  FOOD_POLICY_OUTPUT_BONUS_PCT,
  FOOD_POLICY_RATION_SAVING_PCT,
  FOOD_POLICY_SATISFACTION_COST_PER_TURN,
  FAMINE_POPULATION_LOSS_PCT,
  FAMINE_FULL_LOSS_TURNS,
  FAMINE_MIN_LOSS_PCT,
  FAMINE_SURVIVOR_FLOOR,
  famineLossPct,
  POP_DROP_PENALTY_PER_PCT,
  SOLDIER_FOOD_BASE,
  SOLDIER_FOOD_MIN,
  foodEraIndexForEra,
  regionFoodBase,
  computeFoodProduction,
  soldierFoodPerUnit,
  computeSoldierCount,
  foodConsumptionPctForCategory,
  computeSoldierFoodConsumption,
  computeCivilianFoodConsumption,
  isFamine,
  faminePopulationLoss,
  populationDropPenalty,
  clampStat0100,
} from "./food";
import { ERAS } from "./mapRegionEras";

test("FOOD_ERA_INDEX 涵蓋所有 ERAS slug，且隨時代單調遞增", () => {
  const slugs = ERAS.map((e) => e.slug);
  for (const slug of slugs) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(FOOD_ERA_INDEX, slug),
      `缺少時代指數：${slug}`,
    );
  }
  const values = slugs.map((s) => FOOD_ERA_INDEX[s]!);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i]! > values[i - 1]!, `時代指數必須遞增：${slugs[i]}`);
  }
  assert.equal(FOOD_ERA_INDEX["classical"], 0.1);
  assert.equal(FOOD_ERA_INDEX["future"], 20);
});

test("foodEraIndexForEra：未知 slug 回落古典", () => {
  assert.equal(foodEraIndexForEra("modern"), 10);
  assert.equal(foodEraIndexForEra("not-an-era"), 0.1);
});

test("foodEraIndexForEra：覆寫表優先；缺項/非法值回落預設", () => {
  const overrides = { roman: 0.5, modern: 0 };
  assert.equal(foodEraIndexForEra("roman", overrides), 0.5);
  // 0 是合法覆寫（管理員可關閉某時代產出）。
  assert.equal(foodEraIndexForEra("modern", overrides), 0);
  // 缺項回落預設。
  assert.equal(foodEraIndexForEra("classical", overrides), 0.1);
  // 未知 slug → 回落古典（含古典的覆寫值）。
  assert.equal(foodEraIndexForEra("not-an-era", { classical: 0.7 }), 0.7);
  // 非法值（NaN/負數/非數字）回落預設。
  assert.equal(foodEraIndexForEra("ww1", { ww1: Number.NaN }), 3);
  assert.equal(foodEraIndexForEra("ww2", { ww2: -1 }), 4);
});

test("computeFoodProduction：eraIndexOverrides 直接改變產出", () => {
  const regions = [
    { fertility: 60, controlledAreaKm2: 1000, controlledPopulation: 0 },
  ];
  const base = computeFoodProduction({
    regions,
    farmerPct: 100,
    eraSlug: "roman",
    mobilizationActive: false,
  });
  const doubled = computeFoodProduction({
    regions,
    farmerPct: 100,
    eraSlug: "roman",
    mobilizationActive: false,
    eraIndexOverrides: { roman: 0.4 },
  });
  assert.equal(base.eraIndex, 0.2);
  assert.equal(doubled.eraIndex, 0.4);
  assert.ok(Math.abs(doubled.total - base.total * 2) < 1e-9);
});

test("regionFoodBase：控制面積 × 肥沃度 × 時代指數 × 農民比例 × 校準常數", () => {
  const out = regionFoodBase(
    { fertility: 60, controlledAreaKm2: 1000, controlledPopulation: 12345 },
    50,
    0.1,
  );
  // 1000 × 60 × 0.1 × 0.5 × 0.45 = 1350；人口不參與產出。
  assert.equal(out, 1000 * 60 * 0.1 * 0.5 * FOOD_CALIBRATION);
});

test("regionFoodBase：人口不影響產出（面積基準）", () => {
  const a = regionFoodBase(
    { fertility: 60, controlledAreaKm2: 500, controlledPopulation: 0 },
    100,
    1,
  );
  const b = regionFoodBase(
    { fertility: 60, controlledAreaKm2: 500, controlledPopulation: 9_999_999 },
    100,
    1,
  );
  assert.equal(a, b);
});

test("regionFoodBase：null 肥沃度/面積視為 0；負值/超界農民比例夾限", () => {
  assert.equal(
    regionFoodBase(
      { fertility: null, controlledAreaKm2: 1000, controlledPopulation: 1000 },
      100,
      1,
    ),
    0,
  );
  assert.equal(
    regionFoodBase(
      { fertility: 60, controlledAreaKm2: null, controlledPopulation: 1000 },
      100,
      1,
    ),
    0,
  );
  assert.equal(
    regionFoodBase(
      { fertility: 60, controlledAreaKm2: -5, controlledPopulation: 1000 },
      100,
      1,
    ),
    0,
  );
  const capped = regionFoodBase(
    { fertility: 60, controlledAreaKm2: 100, controlledPopulation: 100 },
    150,
    1,
  );
  const full = regionFoodBase(
    { fertility: 60, controlledAreaKm2: 100, controlledPopulation: 100 },
    100,
    1,
  );
  assert.equal(capped, full);
});

test("古典開局全球校準：Σ(面積×肥沃度) × 0.1 × C ≈ 全球古典人口（每人 1 糧）", () => {
  // 校準依據（見 FOOD_CALIBRATION 註解）：全部 373 區實測
  // Σ(area_km2 × soil_fertility) ≈ 4,799,227,317、古典全球人口 ≈ 216,074,250。
  const sumAreaFert = 4_799_227_317;
  const classicalPop = 216_074_250;
  const out =
    sumAreaFert * foodEraIndexForEra("classical") * FOOD_CALIBRATION;
  assert.ok(Math.abs(out - classicalPop) / classicalPop < 0.01);
});

test("computeFoodProduction：加總各區、增產動員 +10%", () => {
  const regions = [
    { fertility: 60, controlledAreaKm2: 1000, controlledPopulation: 1000 },
    { fertility: 30, controlledAreaKm2: 4000, controlledPopulation: 2000 },
  ];
  const off = computeFoodProduction({
    regions,
    farmerPct: 100,
    eraSlug: "scientific",
    mobilizationActive: false,
  });
  assert.equal(off.eraIndex, 1);
  assert.equal(off.regionOutputs.length, 2);
  assert.equal(off.base, off.regionOutputs[0]! + off.regionOutputs[1]!);
  assert.equal(off.total, off.base);

  const on = computeFoodProduction({
    regions,
    farmerPct: 100,
    eraSlug: "scientific",
    mobilizationActive: true,
  });
  assert.ok(
    Math.abs(on.total - off.base * (1 + FOOD_POLICY_OUTPUT_BONUS_PCT / 100)) <
      1e-9,
  );
});

test("soldierFoodPerUnit：基礎 5、科技減耗、硬下限 1", () => {
  assert.equal(soldierFoodPerUnit(0), SOLDIER_FOOD_BASE);
  assert.equal(soldierFoodPerUnit(-20), 4);
  assert.equal(soldierFoodPerUnit(-100), SOLDIER_FOOD_MIN);
  assert.equal(soldierFoodPerUnit(-1000), SOLDIER_FOOD_MIN);
  assert.equal(soldierFoodPerUnit(20), 6);
});

test("computeSoldierCount：Σ 數量 × 人口消耗，負值視為 0", () => {
  assert.equal(
    computeSoldierCount([
      { quantity: 10, popCostPerUnit: 2, category: "infantry" },
      { quantity: 5, popCostPerUnit: 1, category: "cavalry" },
      { quantity: -3, popCostPerUnit: 4, category: "navy" },
    ]),
    25,
  );
});

test("foodConsumptionPctForCategory：null category 全類別適用；同 target 相加", () => {
  const techs = [
    {
      bonuses: [
        { target: "foodConsumption", category: null, pct: -10 },
        { target: "attack", category: null, pct: 20 },
      ],
    },
    { bonuses: [{ target: "foodConsumption", category: "infantry", pct: -15 }] },
  ] as never[];
  assert.equal(foodConsumptionPctForCategory(techs, "infantry"), -25);
  assert.equal(foodConsumptionPctForCategory(techs, "cavalry"), -10);
});

test("computeSoldierFoodConsumption：按類別套科技，並回報軍人數", () => {
  const techs = [
    { bonuses: [{ target: "foodConsumption", category: "infantry", pct: -20 }] },
  ] as never[];
  const { soldiers, total } = computeSoldierFoodConsumption(
    [
      { quantity: 10, popCostPerUnit: 1, category: "infantry" },
      { quantity: 2, popCostPerUnit: 3, category: "cavalry" },
    ],
    techs,
  );
  assert.equal(soldiers, 16);
  // infantry: 10 × 4；cavalry: 6 × 5
  assert.equal(total, 10 * 4 + 6 * 5);
});

test("computeCivilianFoodConsumption：平民 = 人口 − 軍人（下限 0）；配給 −10%", () => {
  const off = computeCivilianFoodConsumption({
    population: 1000,
    soldiers: 200,
    rationingActive: false,
  });
  assert.equal(off.civilians, 800);
  assert.equal(off.total, 800);
  const on = computeCivilianFoodConsumption({
    population: 1000,
    soldiers: 200,
    rationingActive: true,
  });
  assert.equal(on.total, 800 * (1 - FOOD_POLICY_RATION_SAVING_PCT / 100));
  const overflow = computeCivilianFoodConsumption({
    population: 100,
    soldiers: 500,
    rationingActive: false,
  });
  assert.equal(overflow.civilians, 0);
  assert.equal(overflow.total, 0);
});

test("isFamine / faminePopulationLoss", () => {
  assert.equal(isFamine(99, 100), true);
  assert.equal(isFamine(100, 100), false);
  assert.equal(FAMINE_POPULATION_LOSS_PCT, 20);
  assert.equal(faminePopulationLoss(100_000), 20_000);
  assert.equal(faminePopulationLoss(4), 0); // ≤ 生還者保底 → 0
  assert.equal(faminePopulationLoss(-10), 0);
});

test("Task #443 famineLossPct：連續饑荒扣幅遞減，有下限", () => {
  assert.equal(FAMINE_FULL_LOSS_TURNS, 2);
  assert.equal(FAMINE_MIN_LOSS_PCT, 2);
  // prior = 本回合之前的連續饑荒回合數
  assert.equal(famineLossPct(0), 20); // 第 1 回合饑荒：全額
  assert.equal(famineLossPct(1), 20); // 第 2 回合：仍全額
  assert.equal(famineLossPct(2), 10); // 第 3 回合：減半
  assert.equal(famineLossPct(3), 5); // 第 4 回合：再減半
  assert.equal(famineLossPct(4), 2.5); // 第 5 回合
  assert.equal(famineLossPct(5), 2); // 下限 2%（1.25 → 夾到 2）
  assert.equal(famineLossPct(50), 2); // 長期饑荒維持下限
  assert.equal(famineLossPct(-3), 20); // 負值視為 0
});

test("Task #443 faminePopulationLoss：遞減扣幅＋生還者保底", () => {
  assert.equal(FAMINE_SURVIVOR_FLOOR, 1000);
  // 連續饑荒緩衝：同一人口，扣幅隨 prior 遞減
  assert.equal(faminePopulationLoss(100_000, 0), 20_000);
  assert.equal(faminePopulationLoss(100_000, 2), 10_000);
  assert.equal(faminePopulationLoss(100_000, 3), 5_000);
  assert.equal(faminePopulationLoss(100_000, 50), 2_000); // 下限 2%
  // 生還者保底：損失不會把人口扣到低於 1000
  assert.equal(faminePopulationLoss(1_200, 0), 200); // 20% = 240 → 夾到 200
  assert.equal(faminePopulationLoss(1_000, 0), 0); // 已在保底 → 0
  assert.equal(faminePopulationLoss(500, 0), 0); // 低於保底 → 0
  // 保底後人口不會低於 1000
  const pop = 1_050;
  assert.ok(pop - faminePopulationLoss(pop, 0) >= FAMINE_SURVIVOR_FLOOR);
});

test("populationDropPenalty：每下跌 1%（取整）× 2；未下跌 0", () => {
  assert.equal(POP_DROP_PENALTY_PER_PCT, 2);
  assert.equal(populationDropPenalty(1000, 800), 40); // 20% × 2
  assert.equal(populationDropPenalty(1000, 995), 0); // 0.5% → floor 0
  assert.equal(populationDropPenalty(1000, 1000), 0);
  assert.equal(populationDropPenalty(1000, 1100), 0);
  assert.equal(populationDropPenalty(0, -10), 0);
});

test("clampStat0100 與政策滿意度成本常數", () => {
  assert.equal(clampStat0100(-5), 0);
  assert.equal(clampStat0100(105), 100);
  assert.equal(clampStat0100(49.6), 50);
  assert.equal(FOOD_POLICY_SATISFACTION_COST_PER_TURN, 2);
});
