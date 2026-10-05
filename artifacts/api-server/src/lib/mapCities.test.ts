import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAP_CITY_SEED,
  CITY_QUOTA_GROUPS,
  EXPECTED_CITY_QUOTAS,
  getAllCitySeeds,
  validateMapCitySeed,
} from "./mapCities";
import { MAP_REGION_SEED } from "./mapRegions";

test("city seed validation passes", () => {
  validateMapCitySeed();
});

test("quotas: 歐洲90 中國20 亞洲其他106 美洲50 非洲22 = 288，另加姆大陸虛構 12", () => {
  assert.deepEqual(EXPECTED_CITY_QUOTAS, {
    europe: 90,
    china: 20,
    otherAsia: 106,
    americas: 50,
    africa: 22,
    mu: 12,
  });
  for (const group of CITY_QUOTA_GROUPS) {
    assert.equal(
      MAP_CITY_SEED[group].length,
      EXPECTED_CITY_QUOTAS[group],
      `group ${group} quota mismatch`,
    );
  }
  assert.equal(getAllCitySeeds().length, 300);
  const real = getAllCitySeeds().filter((c) => !MAP_CITY_SEED.mu.includes(c));
  assert.equal(real.length, 288);
});

test("per-macro city distribution (Task #311 補增後)", () => {
  const regionMacro = new Map<string, string>();
  for (const [macro, regions] of Object.entries(MAP_REGION_SEED)) {
    for (const r of regions) regionMacro.set(r, macro);
  }
  const counts: Record<string, number> = {};
  for (const c of getAllCitySeeds()) {
    const macro = regionMacro.get(c.region);
    assert.ok(macro, `${c.name} region ${c.region} has no macro`);
    counts[macro!] = (counts[macro!] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    非洲: 22,
    西歐: 33,
    北歐: 8,
    東歐: 22,
    南歐: 27,
    西亞: 17,
    中亞: 5,
    北亞: 5,
    中國: 21,
    東亞: 43,
    東南亞與大洋洲: 18,
    美洲: 27,
    南亞: 17,
    南美: 23,
    姆大陸: 12,
  });
});

test("city names are unique across all groups", () => {
  const names = getAllCitySeeds().map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
});

test("every city region exists among the 343 map regions", () => {
  const regionNames = new Set(Object.values(MAP_REGION_SEED).flat());
  for (const c of getAllCitySeeds()) {
    assert.ok(regionNames.has(c.region), `${c.name} has unknown region ${c.region}`);
  }
});

test("coordinates are finite and in range", () => {
  for (const c of getAllCitySeeds()) {
    assert.ok(Number.isFinite(c.lat) && c.lat >= -90 && c.lat <= 90, `${c.name} lat`);
    assert.ok(Number.isFinite(c.lng) && c.lng >= -180 && c.lng <= 180, `${c.name} lng`);
  }
});

test("no city name duplicates a region name (map label disambiguation)", () => {
  const regionNames = new Set(Object.values(MAP_REGION_SEED).flat());
  for (const c of getAllCitySeeds()) {
    assert.ok(!regionNames.has(c.name), `${c.name} collides with a region name`);
  }
});
