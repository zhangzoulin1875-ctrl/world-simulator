import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SEA_ADJACENCY_PAIRS,
  COMPASS_ONLY_ISLANDS,
  BASE_SEA_LANDING_CAPACITY,
  COMPASS_CAPACITY_MULTIPLIER,
  BASE_LANDING_ATTACK_REDUCTION_PCT,
  MIN_LANDING_ATTACK_REDUCTION_PCT,
  buildSeaAdjacency,
  isSeaAdjacent,
  seaNeighborsOf,
  classifyLanding,
  effectiveSeaLandingCapacity,
  effectiveLandingAttackReductionPct,
  validateSeaAdjacency,
} from "./navalLanding";

describe("navalLanding sea adjacency", () => {
  test("adjacency is symmetric", () => {
    for (const [a, b] of SEA_ADJACENCY_PAIRS) {
      assert.ok(isSeaAdjacent(a, b), `${a}→${b} 應近海相鄰`);
      assert.ok(isSeaAdjacent(b, a), `${b}→${a} 應近海相鄰（對稱）`);
    }
  });

  test("non-listed regions are not sea adjacent", () => {
    assert.equal(isSeaAdjacent("蘇門答臘島", "冰島"), false);
    assert.equal(isSeaAdjacent("蘇門答臘島", "蘇門答臘島"), false);
  });

  test("seaNeighborsOf returns sorted unique list", () => {
    const n = seaNeighborsOf("蘇門答臘島");
    assert.ok(n.includes("半島東西海岸"));
    assert.ok(n.includes("爪哇島"));
    const sorted = [...n].sort((x, y) => x.localeCompare(y, "zh-Hant"));
    assert.deepEqual(n, sorted);
  });

  test("buildSeaAdjacency covers both directions", () => {
    const map = buildSeaAdjacency();
    assert.ok(map.get("九州島")?.has("釜山廣域圈"));
    assert.ok(map.get("釜山廣域圈")?.has("九州島"));
  });

  test("validateSeaAdjacency passes on curated data", () => {
    assert.doesNotThrow(() => validateSeaAdjacency());
  });

  test("compass-only islands have no near-sea link", () => {
    for (const island of COMPASS_ONLY_ISLANDS) {
      assert.equal(seaNeighborsOf(island).length, 0, `${island} 不應有近海連結`);
    }
  });
});

describe("navalLanding classifyLanding", () => {
  test("land adjacency takes priority", () => {
    assert.equal(classifyLanding(true, true), "land");
    assert.equal(classifyLanding(true, false), "land");
  });

  test("near-sea when only sea adjacent", () => {
    assert.equal(classifyLanding(false, true), "nearSea");
  });

  test("trans-ocean when neither", () => {
    assert.equal(classifyLanding(false, false), "transOcean");
  });
});

describe("navalLanding capacity", () => {
  test("base without compass or bonus", () => {
    assert.equal(
      effectiveSeaLandingCapacity(0, false),
      BASE_SEA_LANDING_CAPACITY,
    );
  });

  test("compass multiplies capacity", () => {
    assert.equal(
      effectiveSeaLandingCapacity(0, true),
      BASE_SEA_LANDING_CAPACITY * COMPASS_CAPACITY_MULTIPLIER,
    );
  });

  test("positive bonus raises capacity, applied before compass", () => {
    assert.equal(effectiveSeaLandingCapacity(20, false), 6_000);
    assert.equal(effectiveSeaLandingCapacity(20, true), 60_000);
  });

  test("capacity never negative", () => {
    assert.equal(effectiveSeaLandingCapacity(-500, false), 0);
  });
});

describe("navalLanding attack reduction", () => {
  test("base reduction with no bonus", () => {
    assert.equal(
      effectiveLandingAttackReductionPct(0),
      BASE_LANDING_ATTACK_REDUCTION_PCT,
    );
  });

  test("bonus lowers reduction (better landings)", () => {
    assert.equal(effectiveLandingAttackReductionPct(20), 30);
  });

  test("reduction clamped to minimum floor", () => {
    assert.equal(
      effectiveLandingAttackReductionPct(100),
      MIN_LANDING_ATTACK_REDUCTION_PCT,
    );
  });

  test("negative bonus never exceeds base ceiling", () => {
    assert.equal(
      effectiveLandingAttackReductionPct(-50),
      BASE_LANDING_ATTACK_REDUCTION_PCT,
    );
  });
});
