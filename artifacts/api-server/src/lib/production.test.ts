import { strict as assert } from "node:assert";
import test from "node:test";
import {
  BUILDINGS,
  PRODUCTION_KEY_TECHS,
  KEY_TECH_BUILDINGS,
  PRODUCTION_ERA_RESEARCH_REQUIREMENT,
  TEMP_POP_GROWTH_TURNS,
  buildingByType,
  productionKeyTechBySlug,
  productionKeyTechsForEra,
  productionKeyTechCost,
  shouldAdvanceProductionDomainEra,
  aggregateProductionEffects,
  aggregateBuildingEffects,
  applyUpkeepReduction,
  describeProductionEffect,
  describeBuildingEffect,
  isProductionTechEffectTarget,
  validateProductionTechTables,
} from "./production";

// ── 靜態資料一致性 ─────────────────────────────────────────────

test("validateProductionTechTables：內建資料無一致性問題", () => {
  assert.deepEqual(validateProductionTechTables(), []);
});

test("PRODUCTION_KEY_TECHS：正好 10 項關鍵技術，key_slug 不重複", () => {
  assert.equal(PRODUCTION_KEY_TECHS.length, 10);
  const slugs = new Set(PRODUCTION_KEY_TECHS.map((k) => k.keySlug));
  assert.equal(slugs.size, 10);
});

test("BUILDINGS：6 種建築，type 不重複", () => {
  assert.equal(BUILDINGS.length, 6);
  const types = new Set(BUILDINGS.map((b) => b.type));
  assert.equal(types.size, 6);
});

test("buildingByType：已知型別回定義、未知回 null", () => {
  assert.equal(buildingByType("granary")?.name, "糧倉");
  assert.equal(buildingByType("nope"), null);
});

test("productionKeyTechBySlug：已知回定義、未知回 null", () => {
  assert.equal(productionKeyTechBySlug("papermaking")?.name, "造紙術");
  assert.equal(productionKeyTechBySlug("nope"), null);
});

test("productionKeyTechsForEra：依時代篩選關鍵技術", () => {
  const roman = productionKeyTechsForEra("roman").map((k) => k.keySlug);
  assert.deepEqual(roman.sort(), ["handicraft", "papermaking"]);
});

// ── 成本與時代推進 ─────────────────────────────────────────────

test("productionKeyTechCost：不低於 20 的下限", () => {
  const cost = productionKeyTechCost("classical");
  assert.ok(cost >= 20);
  assert.equal(Number.isInteger(cost), true);
});

test("shouldAdvanceProductionDomainEra：全關鍵技術完成且達研究門檻才推進", () => {
  const currentEraKeyTechSlugs = ["handicraft", "papermaking"];
  // 關鍵技術未全完成 → 不推進。
  assert.equal(
    shouldAdvanceProductionDomainEra({
      currentEraKeyTechSlugs,
      researchedKeySlugs: ["handicraft"],
      researchedCountInEra: PRODUCTION_ERA_RESEARCH_REQUIREMENT,
    }),
    false,
  );
  // 全完成但研究數不足 → 不推進。
  assert.equal(
    shouldAdvanceProductionDomainEra({
      currentEraKeyTechSlugs,
      researchedKeySlugs: ["handicraft", "papermaking"],
      researchedCountInEra: PRODUCTION_ERA_RESEARCH_REQUIREMENT - 1,
    }),
    false,
  );
  // 全完成且達門檻 → 推進。
  assert.equal(
    shouldAdvanceProductionDomainEra({
      currentEraKeyTechSlugs,
      researchedKeySlugs: ["handicraft", "papermaking", "extra"],
      researchedCountInEra: PRODUCTION_ERA_RESEARCH_REQUIREMENT,
    }),
    true,
  );
});

// ── 效果彙總 ───────────────────────────────────────────────────

test("aggregateProductionEffects：空輸入回全零/全 false 預設", () => {
  const agg = aggregateProductionEffects([]);
  assert.equal(agg.productivityBonusPct, 0);
  assert.equal(agg.techPointsBonusPct, 0);
  assert.equal(agg.populationGrowthBonusPct, 0);
  assert.equal(agg.buildingUpkeepReductionPct, 0);
  assert.deepEqual(agg.unlockedKeyTechSlugs, []);
  assert.deepEqual(agg.unlockedBuildings, []);
  assert.equal(agg.cultureEnabled, false);
  assert.equal(agg.cityWallEnabled, false);
  assert.equal(agg.colonizationEnabled, false);
  assert.equal(agg.navalEnabled, false);
});

test("aggregateProductionEffects：關鍵技術解鎖對應建築", () => {
  const agg = aggregateProductionEffects([
    { keySlug: "irrigation", effects: [{ target: "productivity", value: 5 }] },
    { keySlug: "industrialization", effects: [] },
  ]);
  assert.deepEqual(agg.unlockedKeyTechSlugs.sort(), [
    "industrialization",
    "irrigation",
  ]);
  assert.deepEqual(agg.unlockedBuildings.sort(), ["factory", "granary"]);
  assert.equal(agg.productivityBonusPct, 5);
});

test("aggregateProductionEffects：造紙術開啟文化滿意度", () => {
  const agg = aggregateProductionEffects([
    { keySlug: "papermaking", effects: [{ target: "enableCulture", value: 1 }] },
  ]);
  assert.equal(agg.cultureEnabled, true);
});

test("aggregateProductionEffects：tempPopulationGrowth 不併入常駐彙總", () => {
  const agg = aggregateProductionEffects([
    {
      keySlug: null,
      effects: [{ target: "tempPopulationGrowth", value: 50 }],
    },
  ]);
  assert.equal(agg.populationGrowthBonusPct, 0);
});

test("aggregateProductionEffects：維護費減免夾在 0..100", () => {
  const agg = aggregateProductionEffects([
    {
      keySlug: null,
      effects: [
        { target: "buildingUpkeepReduction", value: 80 },
        { target: "buildingUpkeepReduction", value: 80 },
      ],
    },
  ]);
  assert.equal(agg.buildingUpkeepReductionPct, 100);
});

test("aggregateProductionEffects：旗標類效果各自解鎖", () => {
  const agg = aggregateProductionEffects([
    {
      keySlug: "oceanic_shipbuilding",
      effects: [
        { target: "enableColonization", value: 1 },
        { target: "enableNaval", value: 1 },
      ],
    },
    { keySlug: "windmill", effects: [{ target: "enableCityWall", value: 1 }] },
  ]);
  assert.equal(agg.colonizationEnabled, true);
  assert.equal(agg.navalEnabled, true);
  assert.equal(agg.cityWallEnabled, true);
});

// ── 建築效果彙總與維護費減免 ─────────────────────────────────────

test("aggregateBuildingEffects：疊加效果、累計維護費與數量", () => {
  const agg = aggregateBuildingEffects(["workshop", "workshop", "library"]);
  assert.equal(agg.count, 3);
  assert.equal(agg.productivityBonusPct, 8); // 工作坊 4% × 2
  assert.equal(agg.techPointsBonusPct, 5); // 圖書館 5%
  assert.equal(agg.upkeepTotal, 40 + 40 + 60);
});

test("aggregateBuildingEffects：未知型別忽略", () => {
  const agg = aggregateBuildingEffects(["granary", "nope"]);
  assert.equal(agg.count, 1);
  assert.equal(agg.populationGrowthBonusPct, 2);
});

test("aggregateBuildingEffects：燃氣電廠同時加生產力與科技", () => {
  const agg = aggregateBuildingEffects(["gas_plant"]);
  assert.equal(agg.productivityBonusPct, 8);
  assert.equal(agg.techPointsBonusPct, 5);
});

test("applyUpkeepReduction：風車技術減半、夾範圍、回整數", () => {
  assert.equal(applyUpkeepReduction(100, 50), 50);
  assert.equal(applyUpkeepReduction(100, 0), 100);
  assert.equal(applyUpkeepReduction(100, 150), 0); // 上限 100%
  assert.equal(applyUpkeepReduction(100, -20), 100); // 下限 0%
  assert.equal(applyUpkeepReduction(101, 50), 51); // 四捨五入為整數
});

// ── 顯示字串與型別守衛 ───────────────────────────────────────────

test("describeProductionEffect：暫時人口增長標註持續回合數", () => {
  const s = describeProductionEffect({
    target: "tempPopulationGrowth",
    value: 50,
  });
  assert.ok(s.includes(String(TEMP_POP_GROWTH_TURNS)));
  assert.ok(s.includes("+50"));
});

test("describeProductionEffect：正負號正確", () => {
  assert.equal(
    describeProductionEffect({ target: "productivity", value: 5 }),
    "生產力 +5%",
  );
  assert.equal(
    describeProductionEffect({ target: "buildingUpkeepReduction", value: 50 }),
    "建築維護費 −50%",
  );
});

test("describeBuildingEffect：zh-TW 顯示字串", () => {
  assert.equal(
    describeBuildingEffect({ target: "techPoints", value: 5 }),
    "科技點數發展 +5%",
  );
});

test("isProductionTechEffectTarget：合法目標為真、其他為假", () => {
  assert.equal(isProductionTechEffectTarget("productivity"), true);
  assert.equal(isProductionTechEffectTarget("enableCulture"), true);
  assert.equal(isProductionTechEffectTarget("nope"), false);
});

test("KEY_TECH_BUILDINGS：僅引用合法關鍵技術與建築", () => {
  for (const [slug, builds] of Object.entries(KEY_TECH_BUILDINGS)) {
    assert.ok(productionKeyTechBySlug(slug), `unknown key tech ${slug}`);
    for (const b of builds) {
      assert.ok(buildingByType(b), `unknown building ${b}`);
    }
  }
});
