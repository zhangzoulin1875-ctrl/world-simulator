import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  WALL_TIERS,
  WALL_MAX_DURABILITY,
  WALL_DEFENSE_BONUS_PCT,
  WALL_UPGRADE_COST,
  SIEGE_DAMAGE_K,
  isWallTier,
  wallTierIndex,
  nextWallTier,
  wallTierUnlocked,
  maxNpcWallTierForEra,
  canUpgradeWall,
  computeSiegeDamage,
  applySiegeToCities,
  durabilityPct,
  cityLineFallen,
  cityLineHoldoutPct,
  bestStandingWallDefenseBonusPct,
  applyWallDefenseToCasualty,
  makeWarCity,
} from "./wall";
import type { WallTier, WarCity, WarCityState } from "@workspace/db";

function city(overrides: Partial<WarCity> & { cityId: number }): WarCity {
  return {
    name: `城${overrides.cityId}`,
    wallTier: "wood",
    maxDurability: WALL_MAX_DURABILITY[overrides.wallTier ?? "wood"],
    durability: WALL_MAX_DURABILITY[overrides.wallTier ?? "wood"],
    ...overrides,
  };
}

function state(cities: WarCity[], garrisoned = true): WarCityState {
  return { cities, garrisoned };
}

describe("wall constants", () => {
  test("tiers ordered low→high", () => {
    assert.deepEqual([...WALL_TIERS], ["wood", "stone", "bunker", "concrete"]);
  });
  test("durability monotonically increasing", () => {
    assert.deepEqual(WALL_MAX_DURABILITY, {
      wood: 100,
      stone: 1000,
      bunker: 10000,
      concrete: 50000,
    });
  });
  test("defense bonus is per-tier not cumulative", () => {
    assert.deepEqual(WALL_DEFENSE_BONUS_PCT, {
      wood: 0,
      stone: 50,
      bunker: 50,
      concrete: 80,
    });
  });
  test("upgrade cost defined for buyable tiers", () => {
    assert.equal(WALL_UPGRADE_COST.wood, 0);
    assert.ok(WALL_UPGRADE_COST.stone < WALL_UPGRADE_COST.bunker);
    assert.ok(WALL_UPGRADE_COST.bunker < WALL_UPGRADE_COST.concrete);
  });
});

describe("isWallTier / wallTierIndex / nextWallTier", () => {
  test("isWallTier", () => {
    assert.ok(isWallTier("wood"));
    assert.ok(isWallTier("concrete"));
    assert.ok(!isWallTier("steel"));
    assert.ok(!isWallTier(3));
    assert.ok(!isWallTier(undefined));
  });
  test("wallTierIndex", () => {
    assert.equal(wallTierIndex("wood"), 0);
    assert.equal(wallTierIndex("concrete"), 3);
    assert.equal(wallTierIndex("nope"), -1);
  });
  test("nextWallTier", () => {
    assert.equal(nextWallTier("wood"), "stone");
    assert.equal(nextWallTier("stone"), "bunker");
    assert.equal(nextWallTier("bunker"), "concrete");
    assert.equal(nextWallTier("concrete"), null);
  });
});

describe("wallTierUnlocked", () => {
  const eraModern = { cityWallEnabled: true, productionEraSlug: "modern" };
  const eraIndustrial = {
    cityWallEnabled: true,
    productionEraSlug: "industrial",
  };
  const eraMedieval = {
    cityWallEnabled: true,
    productionEraSlug: "high_medieval",
  };
  const noWallTech = {
    cityWallEnabled: false,
    productionEraSlug: "modern",
  };

  test("wood always unlocked, even without tech", () => {
    assert.ok(wallTierUnlocked("wood", noWallTech));
  });
  test("stone needs cityWallEnabled only", () => {
    assert.ok(wallTierUnlocked("stone", eraMedieval));
    assert.ok(!wallTierUnlocked("stone", noWallTech));
  });
  test("bunker needs industrial era", () => {
    assert.ok(!wallTierUnlocked("bunker", eraMedieval));
    assert.ok(wallTierUnlocked("bunker", eraIndustrial));
    assert.ok(wallTierUnlocked("bunker", eraModern));
  });
  test("concrete needs modern era", () => {
    assert.ok(!wallTierUnlocked("concrete", eraIndustrial));
    assert.ok(wallTierUnlocked("concrete", eraModern));
  });
});

describe("maxNpcWallTierForEra", () => {
  test("wood before high_medieval (no researched tech needed)", () => {
    assert.equal(maxNpcWallTierForEra("classical"), "wood");
    assert.equal(maxNpcWallTierForEra("early_medieval"), "wood");
  });
  test("stone from high_medieval to pre-industrial", () => {
    assert.equal(maxNpcWallTierForEra("high_medieval"), "stone");
    assert.equal(maxNpcWallTierForEra("renaissance"), "stone");
    assert.equal(maxNpcWallTierForEra("enlightenment"), "stone");
  });
  test("bunker from industrial to pre-modern", () => {
    assert.equal(maxNpcWallTierForEra("industrial"), "bunker");
    assert.equal(maxNpcWallTierForEra("ww2"), "bunker");
    assert.equal(maxNpcWallTierForEra("cold_war"), "bunker");
  });
  test("concrete from modern onward", () => {
    assert.equal(maxNpcWallTierForEra("modern"), "concrete");
    assert.equal(maxNpcWallTierForEra("future"), "concrete");
  });
});

describe("canUpgradeWall", () => {
  const modern = { cityWallEnabled: true, productionEraSlug: "modern" };
  const medieval = {
    cityWallEnabled: true,
    productionEraSlug: "high_medieval",
  };
  test("rejects invalid target", () => {
    const r = canUpgradeWall("wood", "steel", modern);
    assert.equal(r.ok, false);
  });
  test("rejects downgrade / same", () => {
    assert.equal(canUpgradeWall("stone", "wood", modern).ok, false);
    assert.equal(canUpgradeWall("stone", "stone", modern).ok, false);
  });
  test("rejects skipping a tier", () => {
    const r = canUpgradeWall("wood", "bunker", modern);
    assert.equal(r.ok, false);
  });
  test("rejects locked tier", () => {
    // wood→stone is one step but stone locked without wall tech
    const r = canUpgradeWall("wood", "stone", {
      cityWallEnabled: false,
      productionEraSlug: "modern",
    });
    assert.equal(r.ok, false);
    // bunker locked in medieval era
    const r2 = canUpgradeWall("stone", "bunker", medieval);
    assert.equal(r2.ok, false);
  });
  test("accepts valid next-tier upgrade", () => {
    const r = canUpgradeWall("wood", "stone", medieval);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.tier, "stone");
    const r2 = canUpgradeWall("bunker", "concrete", modern);
    assert.equal(r2.ok, true);
  });
});

describe("computeSiegeDamage", () => {
  test("zero when no intensity or troops", () => {
    assert.equal(computeSiegeDamage(0, 10000), 0);
    assert.equal(computeSiegeDamage(100, 0), 0);
    assert.equal(computeSiegeDamage(-5, 100), 0);
  });
  test("sqrt-compressed scaling", () => {
    // 100% × 25 × sqrt(10000)=25×100=2500
    assert.equal(computeSiegeDamage(100, 10000), 2500);
    // 50% halves it
    assert.equal(computeSiegeDamage(50, 10000), 1250);
    // 100k troops: 25×sqrt(100000)=25×316.22...=7906
    assert.equal(computeSiegeDamage(100, 100000), Math.round(25 * Math.sqrt(100000)));
  });
  test("intensity clamped to 100", () => {
    assert.equal(computeSiegeDamage(500, 10000), 2500);
  });
  test("K constant is 25", () => {
    assert.equal(SIEGE_DAMAGE_K, 25);
  });
});

describe("applySiegeToCities", () => {
  test("no damage returns copies unchanged", () => {
    const cities = [city({ cityId: 1, wallTier: "stone" })];
    const out = applySiegeToCities(cities, 0);
    assert.equal(out[0]!.durability, 1000);
    assert.notEqual(out, cities); // new array
  });
  test("concentrates on lowest-durability standing city first", () => {
    const cities = [
      city({ cityId: 1, wallTier: "stone", durability: 800 }),
      city({ cityId: 2, wallTier: "stone", durability: 300 }),
    ];
    const out = applySiegeToCities(cities, 200);
    // city 2 (300) is weakest → takes all 200
    assert.equal(out[0]!.durability, 800);
    assert.equal(out[1]!.durability, 100);
  });
  test("overflows to next city after one falls", () => {
    const cities = [
      city({ cityId: 1, wallTier: "wood", durability: 100 }),
      city({ cityId: 2, wallTier: "stone", durability: 1000 }),
    ];
    const out = applySiegeToCities(cities, 250);
    // city1 (100) falls, remaining 150 hits city2
    assert.equal(out[0]!.durability, 0);
    assert.equal(out[1]!.durability, 850);
  });
  test("caps at zero, never negative", () => {
    const cities = [city({ cityId: 1, wallTier: "wood", durability: 100 })];
    const out = applySiegeToCities(cities, 99999);
    assert.equal(out[0]!.durability, 0);
  });
  test("tie broken by array order", () => {
    const cities = [
      city({ cityId: 1, wallTier: "stone", durability: 500 }),
      city({ cityId: 2, wallTier: "stone", durability: 500 }),
    ];
    const out = applySiegeToCities(cities, 200);
    assert.equal(out[0]!.durability, 300);
    assert.equal(out[1]!.durability, 500);
  });
  test("does not mutate input", () => {
    const cities = [city({ cityId: 1, wallTier: "wood", durability: 100 })];
    applySiegeToCities(cities, 50);
    assert.equal(cities[0]!.durability, 100);
  });
});

describe("durabilityPct", () => {
  test("rounds to 0-100", () => {
    assert.equal(durabilityPct(city({ cityId: 1, wallTier: "stone", durability: 1000 })), 100);
    assert.equal(durabilityPct(city({ cityId: 1, wallTier: "stone", durability: 500 })), 50);
    assert.equal(durabilityPct(city({ cityId: 1, wallTier: "stone", durability: 0 })), 0);
  });
  test("max 0 → 0", () => {
    assert.equal(
      durabilityPct({ cityId: 1, name: "x", wallTier: "wood", maxDurability: 0, durability: 0 }),
      0,
    );
  });
});

describe("cityLineFallen", () => {
  test("null / empty → fallen", () => {
    assert.ok(cityLineFallen(null));
    assert.ok(cityLineFallen(state([])));
  });
  test("all zero → fallen", () => {
    assert.ok(
      cityLineFallen(
        state([
          city({ cityId: 1, durability: 0 }),
          city({ cityId: 2, durability: 0 }),
        ]),
      ),
    );
  });
  test("any standing → not fallen", () => {
    assert.ok(
      !cityLineFallen(
        state([
          city({ cityId: 1, durability: 0 }),
          city({ cityId: 2, wallTier: "stone", durability: 5 }),
        ]),
      ),
    );
  });
});

describe("cityLineHoldoutPct", () => {
  test("null/empty → null", () => {
    assert.equal(cityLineHoldoutPct(null), null);
    assert.equal(cityLineHoldoutPct(state([])), null);
  });
  test("all fallen → 0", () => {
    assert.equal(cityLineHoldoutPct(state([city({ cityId: 1, durability: 0 })])), 0);
  });
  test("takes weakest standing city pct", () => {
    const s = state([
      city({ cityId: 1, wallTier: "stone", durability: 1000 }), // 100%
      city({ cityId: 2, wallTier: "stone", durability: 300 }), // 30%
    ]);
    assert.equal(cityLineHoldoutPct(s), 30);
  });
  test("ignores fallen cities when computing weakest", () => {
    const s = state([
      city({ cityId: 1, wallTier: "stone", durability: 0 }), // fallen
      city({ cityId: 2, wallTier: "stone", durability: 600 }), // 60%
    ]);
    assert.equal(cityLineHoldoutPct(s), 60);
  });
});

describe("bestStandingWallDefenseBonusPct", () => {
  test("null → 0", () => {
    assert.equal(bestStandingWallDefenseBonusPct(null), 0);
  });
  test("takes strongest standing tier", () => {
    const s = state([
      city({ cityId: 1, wallTier: "concrete", durability: 0 }), // fallen, ignored
      city({ cityId: 2, wallTier: "stone", durability: 10 }), // +50
    ]);
    assert.equal(bestStandingWallDefenseBonusPct(s), 50);
  });
  test("all fallen → 0", () => {
    const s = state([city({ cityId: 1, wallTier: "concrete", durability: 0 })]);
    assert.equal(bestStandingWallDefenseBonusPct(s), 0);
  });
});

describe("applyWallDefenseToCasualty", () => {
  test("no bonus → unchanged", () => {
    assert.equal(applyWallDefenseToCasualty(100, 0), 100);
  });
  test("+50% → halves", () => {
    assert.equal(applyWallDefenseToCasualty(100, 50), 50);
  });
  test("+80% → 20% remains", () => {
    assert.equal(applyWallDefenseToCasualty(100, 80), 20);
  });
  test("clamps bonus at 90", () => {
    assert.equal(applyWallDefenseToCasualty(100, 999), 10);
  });
  test("zero casualty → zero", () => {
    assert.equal(applyWallDefenseToCasualty(0, 80), 0);
  });
});

describe("makeWarCity", () => {
  test("full durability at snapshot", () => {
    const c = makeWarCity({ cityId: 7, name: "洛陽", tier: "bunker" });
    assert.deepEqual(c, {
      cityId: 7,
      name: "洛陽",
      wallTier: "bunker" as WallTier,
      maxDurability: 10000,
      durability: 10000,
    });
  });
});
