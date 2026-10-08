import { strict as assert } from "node:assert";
import test from "node:test";
import type { MilitaryTechBonus } from "@workspace/db";
import {
  MILITARY_CATEGORIES,
  MAX_CUSTOM_UNITS_PER_CATEGORY,
  MAX_ORDER_QUANTITY,
  applyTechBonuses,
  categoryLabel,
  categoryRequiredKeyTech,
  dailyPurchaseCap,
  effectiveUnitRange,
  isCategoryUnlocked,
  isMilitaryCategory,
  militaryKeyTechsForEra,
  normalizeCustomUnitName,
  normalizeTechDirection,
  recruitCost,
  recruitProductionSpend,
  summarizeTechBonuses,
  unitProductionReservation,
  validateMilitaryKeyTechs,
  MILITARY_KEY_TECHS,
} from "./military";

test("MILITARY_CATEGORIES has 7 unique categories", () => {
  assert.equal(MILITARY_CATEGORIES.length, 7);
  assert.equal(new Set(MILITARY_CATEGORIES).size, 7);
  for (const c of MILITARY_CATEGORIES) assert.ok(isMilitaryCategory(c));
  assert.equal(isMilitaryCategory("navy"), false);
});

test("categoryLabel renames armor to 騎兵 before ww1", () => {
  assert.equal(categoryLabel("armor", "classical"), "騎兵");
  assert.equal(categoryLabel("armor", "renaissance"), "騎兵");
  assert.equal(categoryLabel("armor", "ww1"), "裝甲");
  assert.equal(categoryLabel("armor", "future"), "裝甲");
  assert.equal(categoryLabel("infantry", "classical"), "步兵");
  assert.equal(categoryLabel("ship", "future"), "戰船");
});

test("category unlocks gate on key techs, not eras", () => {
  assert.equal(categoryRequiredKeyTech("ranged"), "marksmanship");
  assert.equal(categoryRequiredKeyTech("ship"), "naval_warfare");
  assert.equal(categoryRequiredKeyTech("artillery"), "gunpowder");
  assert.equal(categoryRequiredKeyTech("air"), "aviation");
  assert.equal(categoryRequiredKeyTech("infantry"), null);
  assert.equal(categoryRequiredKeyTech("armor"), null);
  assert.equal(categoryRequiredKeyTech("siege"), null);

  // infantry/armor/siege are always available (no key tech).
  for (const c of ["infantry", "armor", "siege"] as const) {
    assert.equal(isCategoryUnlocked(c, []), true, c);
  }

  // gated categories require their key tech.
  assert.equal(isCategoryUnlocked("artillery", []), false);
  assert.equal(isCategoryUnlocked("artillery", ["gunpowder"]), true);
  assert.equal(isCategoryUnlocked("air", ["gunpowder"]), false);
  assert.equal(isCategoryUnlocked("air", ["aviation"]), true);
  assert.equal(isCategoryUnlocked("ship", ["naval_warfare"]), true);

  // ranged unlocks with marksmanship, then locks again after musketeer.
  assert.equal(isCategoryUnlocked("ranged", []), false);
  assert.equal(isCategoryUnlocked("ranged", ["marksmanship"]), true);
  assert.equal(
    isCategoryUnlocked("ranged", ["marksmanship", "musketeer"]),
    false,
  );
});

test("effectiveUnitRange: musketeer makes infantry ranged", () => {
  const infantry = { category: "infantry" as const, range: "melee" };
  assert.equal(effectiveUnitRange(infantry, []), "melee");
  assert.equal(effectiveUnitRange(infantry, ["musketeer"]), "ranged");
  const cavalry = { category: "armor" as const, range: "melee" };
  assert.equal(effectiveUnitRange(cavalry, ["musketeer"]), "melee");
  const archer = { category: "ranged" as const, range: "ranged" };
  assert.equal(effectiveUnitRange(archer, []), "ranged");
});

test("MILITARY_KEY_TECHS: 7 valid key techs, medicine grants recoveryRate", () => {
  assert.equal(MILITARY_KEY_TECHS.length, 7);
  assert.deepEqual(validateMilitaryKeyTechs(), []);
  assert.equal(militaryKeyTechsForEra("classical").length, 1);
  assert.equal(militaryKeyTechsForEra("classical")[0]!.keySlug, "marksmanship");
  const medicine = MILITARY_KEY_TECHS.find((k) => k.keySlug === "medicine")!;
  assert.deepEqual(medicine.bonuses, [
    { target: "recoveryRate", category: null, pct: 50 },
  ]);
});

test("recruitCost: money and population are linear per unit", () => {
  const infantry = {
    prodUpkeepPerUnit: 0,
    moneyCostPerUnit: 100,
    popCostPerUnit: 1,
    woodCostPerUnit: 2,
    oreCostPerUnit: 1,
  };
  assert.deepEqual(recruitCost(infantry, 100), {
    production: 0,
    money: 10000,
    population: 100,
    wood: 200,
    ore: 100,
  });
  assert.deepEqual(recruitCost(infantry, 50), {
    production: 0,
    money: 5000,
    population: 50,
    wood: 100,
    ore: 50,
  });
  assert.deepEqual(recruitCost(infantry, 1), {
    production: 0,
    money: 100,
    population: 1,
    wood: 2,
    ore: 1,
  });

  const ship = {
    prodUpkeepPerUnit: 0,
    moneyCostPerUnit: 1000,
    popCostPerUnit: 100,
    woodCostPerUnit: 0,
    oreCostPerUnit: 0,
  };
  assert.deepEqual(recruitCost(ship, 3), {
    production: 0,
    money: 3000,
    population: 300,
    wood: 0,
    ore: 0,
  });
});

test("recruitCost: production = unitProductionReservation（與購買同公式，無時代係數）", () => {
  const infantry = {
    prodUpkeepPerUnit: 0.1,
    moneyCostPerUnit: 0,
    popCostPerUnit: 1,
    woodCostPerUnit: 3,
    oreCostPerUnit: 2,
  };
  // Task #557 — 生產力佔用 = ⌈數量 × prodUpkeepPerUnit ÷ 100⌉，不乘時代係數。
  assert.deepEqual(recruitCost(infantry, 100), {
    production: 1, // ceil(100 × 0.1 ÷ 100)
    money: 0,
    population: 100,
    wood: 300,
    ore: 200,
  });
  assert.equal(
    recruitCost(infantry, 12_345).production,
    unitProductionReservation(infantry, 12_345),
  );
  // 較重維護費的兵種佔用線性放大。
  const ship = {
    prodUpkeepPerUnit: 5,
    moneyCostPerUnit: 1000,
    popCostPerUnit: 100,
    woodCostPerUnit: 10,
    oreCostPerUnit: 2,
  };
  assert.equal(recruitCost(ship, 70).production, 4); // ceil(350/100)
});

// ── Task #546/#557 — 招募與金錢購買共用的生產力佔用公式 ─────────

test("unitProductionReservation = ceil(quantity × prodUpkeepPerUnit ÷ 100)", () => {
  // 基準：每單位生產力維護費 0.1（下限值）→ 100 單位佔用 ⌈0.1⌉ = 1。
  assert.equal(
    unitProductionReservation({ prodUpkeepPerUnit: 0.1 }, 100),
    1,
  );
  // 向上取整：任何 > 0 的量至少佔 1。
  assert.equal(unitProductionReservation({ prodUpkeepPerUnit: 0.1 }, 1), 1);
  // 整除情形不多收：1000 × 0.1 ÷ 100 = 1。
  assert.equal(
    unitProductionReservation({ prodUpkeepPerUnit: 0.1 }, 1000),
    1,
  );
  assert.equal(
    unitProductionReservation({ prodUpkeepPerUnit: 0.1 }, 1001),
    2,
  );
  // 較重維護費的兵種佔用線性放大。
  assert.equal(
    unitProductionReservation({ prodUpkeepPerUnit: 2.5 }, 1000),
    25,
  );
  assert.equal(
    unitProductionReservation({ prodUpkeepPerUnit: 3 }, 70),
    3, // ceil(210/100)
  );
});

test("unitProductionReservation: zero/negative inputs reserve 0", () => {
  assert.equal(unitProductionReservation({ prodUpkeepPerUnit: 1 }, 0), 0);
  assert.equal(unitProductionReservation({ prodUpkeepPerUnit: 1 }, -5), 0);
  assert.equal(unitProductionReservation({ prodUpkeepPerUnit: 0 }, 100), 0);
});

// ── Task #568 — 招募的立即性生產力花費（一次性消耗，與佔用分離）─────

test("recruitProductionSpend = ceil(quantity × prodCostPer100 ÷ 100)", () => {
  // 基準步兵：每 100 單位 1 生產力 → 100 單位花 1。
  assert.equal(recruitProductionSpend({ prodCostPer100: 1 }, 100), 1);
  // 向上取整：任何 > 0 的量至少花 1。
  assert.equal(recruitProductionSpend({ prodCostPer100: 1 }, 1), 1);
  // 整除不多收；超過即進位。
  assert.equal(recruitProductionSpend({ prodCostPer100: 1 }, 1000), 10);
  assert.equal(recruitProductionSpend({ prodCostPer100: 1 }, 1001), 11);
  // 較貴兵種線性放大：艦船每 1 單位 1 生產力（prodCostPer100 = 100）。
  assert.equal(recruitProductionSpend({ prodCostPer100: 100 }, 3), 3);
  assert.equal(recruitProductionSpend({ prodCostPer100: 10 }, 70), 7);
  assert.equal(recruitProductionSpend({ prodCostPer100: 2.5 }, 30), 1); // ceil(0.75)
});

test("recruitProductionSpend: zero/negative inputs spend 0", () => {
  assert.equal(recruitProductionSpend({ prodCostPer100: 1 }, 0), 0);
  assert.equal(recruitProductionSpend({ prodCostPer100: 1 }, -5), 0);
  assert.equal(recruitProductionSpend({ prodCostPer100: 0 }, 100), 0);
});

test("dailyPurchaseCap = floor(1% of population), min 0", () => {
  assert.equal(dailyPurchaseCap(0), 0);
  assert.equal(dailyPurchaseCap(99), 0);
  assert.equal(dailyPurchaseCap(100), 1);
  assert.equal(dailyPurchaseCap(1_000_000), 10_000);
  assert.equal(dailyPurchaseCap(-5), 0);
});

test("MAX_ORDER_QUANTITY is 10 million", () => {
  assert.equal(MAX_ORDER_QUANTITY, 10_000_000);
});

const baseTemplate = {
  category: "infantry",
  hp: 100,
  attack: 100,
  defense: 10,
  speed: 1,
  accuracy: 80,
  prodCostPer100: 10,
  popCostPerUnit: 2,
  moneyCostPerUnit: 10,
  upkeepPerUnit: 0.1,
  prodUpkeepPerUnit: 0.1,
  woodCostPerUnit: 1,
  oreCostPerUnit: 1,
};

test("applyTechBonuses: no techs → unchanged", () => {
  const out = applyTechBonuses(baseTemplate, []);
  assert.deepEqual(out, {
    hp: 100,
    attack: 100,
    defense: 10,
    speed: 1,
    accuracy: 80,
    prodCostPer100: 10,
    popCostPerUnit: 2,
    moneyCostPerUnit: 10,
    upkeepPerUnit: 0.1,
    prodUpkeepPerUnit: 0.1,
    woodCostPerUnit: 1,
    oreCostPerUnit: 1,
  });
});

test("applyTechBonuses: same-target percentages add before applying", () => {
  const techs: { bonuses: MilitaryTechBonus[] }[] = [
    { bonuses: [{ target: "attack", category: null, pct: 50 }] },
    { bonuses: [{ target: "attack", category: null, pct: 20 }] },
  ];
  const out = applyTechBonuses(baseTemplate, techs);
  assert.equal(out.attack, 170); // ×1.7, not ×1.5×1.2=180
});

test("applyTechBonuses: negative stacking floors at 0", () => {
  const techs: { bonuses: MilitaryTechBonus[] }[] = [
    { bonuses: [{ target: "prodCost", category: null, pct: -60 }] },
    { bonuses: [{ target: "prodCost", category: null, pct: -60 }] },
  ];
  const out = applyTechBonuses(baseTemplate, techs);
  assert.equal(out.prodCostPer100, 0); // 1 - 1.2 → clamped to 0
});

test("applyTechBonuses: category-scoped bonus only hits matching category", () => {
  const techs: { bonuses: MilitaryTechBonus[] }[] = [
    { bonuses: [{ target: "hp", category: "armor", pct: 100 }] },
    { bonuses: [{ target: "defense", category: "infantry", pct: 100 }] },
  ];
  const out = applyTechBonuses(baseTemplate, techs);
  assert.equal(out.hp, 100); // armor-only bonus ignored
  assert.equal(out.defense, 20); // infantry bonus applied
});

test("applyTechBonuses: unknown targets ignored, speed rounds to 2dp, upkeep floors at 0.1", () => {
  const techs = [
    {
      bonuses: [
        { target: "morale", category: null, pct: 500 },
        { target: "speed", category: null, pct: 33 },
        { target: "upkeep", category: null, pct: -33 },
      ] as unknown as MilitaryTechBonus[],
    },
  ];
  const out = applyTechBonuses(baseTemplate, techs);
  assert.equal(out.speed, 1.33);
  // Task #365 — 減免後有效維護費不會低於 0.1（0.1×0.67=0.067 被提高到 0.1）。
  assert.equal(out.upkeepPerUnit, 0.1);
});

test("applyTechBonuses: heavy upkeep discount still floors at 0.1", () => {
  const techs: { bonuses: MilitaryTechBonus[] }[] = [
    { bonuses: [{ target: "upkeep", category: null, pct: -90 }] },
  ];
  const out = applyTechBonuses(baseTemplate, techs);
  assert.equal(out.upkeepPerUnit, 0.1);
});

test("normalizeTechDirection trims, collapses whitespace, lowercases", () => {
  assert.equal(normalizeTechDirection("  海軍  火力 "), "海軍 火力");
  assert.equal(normalizeTechDirection("Naval\t POWER"), "naval power");
  assert.equal(normalizeTechDirection("步兵防護"), "步兵防護");
});

// ── Task #63 helpers ─────────────────────────────────────────

test("MAX_CUSTOM_UNITS_PER_CATEGORY is 5", () => {
  assert.equal(MAX_CUSTOM_UNITS_PER_CATEGORY, 5);
});

test("normalizeCustomUnitName: null/undefined/empty/whitespace → clear (null)", () => {
  for (const raw of [null, undefined, "", "   ", "\t\n"]) {
    const out = normalizeCustomUnitName(raw);
    assert.deepEqual(out, { ok: true, name: null });
  }
});

test("normalizeCustomUnitName: trims and keeps valid names", () => {
  assert.deepEqual(normalizeCustomUnitName("  皇家禁衛軍  "), {
    ok: true,
    name: "皇家禁衛軍",
  });
  const max = "甲".repeat(40);
  assert.deepEqual(normalizeCustomUnitName(max), { ok: true, name: max });
});

test("normalizeCustomUnitName: >40 chars rejected with zh-TW error", () => {
  const out = normalizeCustomUnitName("甲".repeat(41));
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /40/);
});

test("summarizeTechBonuses: sums per (target, category) and sorts stably", () => {
  const techs: { bonuses: MilitaryTechBonus[] }[] = [
    {
      bonuses: [
        { target: "attack", category: "infantry", pct: 10 },
        { target: "attack", category: null, pct: 5 },
      ],
    },
    {
      bonuses: [
        { target: "attack", category: "infantry", pct: 15 },
        { target: "hp", category: null, pct: 20 },
      ],
    },
  ];
  const out = summarizeTechBonuses(techs);
  assert.deepEqual(out, [
    { target: "attack", category: null, pct: 5 },
    { target: "attack", category: "infantry", pct: 25 },
    { target: "hp", category: null, pct: 20 },
  ]);
});

test("summarizeTechBonuses: zero-sum entries dropped; empty input → empty", () => {
  const techs: { bonuses: MilitaryTechBonus[] }[] = [
    { bonuses: [{ target: "prodCost", category: null, pct: -30 }] },
    { bonuses: [{ target: "prodCost", category: null, pct: 30 }] },
  ];
  assert.deepEqual(summarizeTechBonuses(techs), []);
  assert.deepEqual(summarizeTechBonuses([]), []);
});

import {
  availableCategories as _availableCategories,
  eraAvailableCategories as _eraAvailableCategories,
} from "./military";

test("eraAvailableCategories：火槍時代起沒有射手、古代沒有空軍/艦船/火砲", () => {
  const classical = _eraAvailableCategories("classical");
  assert.ok(classical.includes("ranged"));
  assert.ok(!classical.includes("air"));
  assert.ok(!classical.includes("ship"));
  assert.ok(!classical.includes("artillery"));
  for (const era of ["renaissance", "industrial", "ww2", "modern"]) {
    assert.ok(!_eraAvailableCategories(era).includes("ranged"), `${era} 不應有射手`);
    assert.ok(_eraAvailableCategories(era).includes("armor"), `${era} 應有騎兵/裝甲`);
    assert.ok(_eraAvailableCategories(era).includes("infantry"));
  }
  assert.ok(_eraAvailableCategories("ww1").includes("air"));
});

test("availableCategories：玩家研發火槍兵後射手被剔除", () => {
  assert.ok(_availableCategories(["marksmanship"]).includes("ranged"));
  assert.ok(!_availableCategories(["marksmanship", "musketeer"]).includes("ranged"));
});
