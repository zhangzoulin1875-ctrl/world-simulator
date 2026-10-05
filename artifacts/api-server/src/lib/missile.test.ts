import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MISSILE_DEFS, isMissileUnlocked, gameYearOf, missileCost, missileMinTreasury,
  populationLoss, buildingLevelAfter, reservedAfter, isMissileType,
} from "./missile";

test("規格:費用與損失百分比", () => {
  assert.deepEqual([MISSILE_DEFS.medium.costPct, MISSILE_DEFS.medium.damagePct], [10, 3]);
  assert.deepEqual([MISSILE_DEFS.tactical_nuke.costPct, MISSILE_DEFS.tactical_nuke.damagePct], [33, 12]);
  assert.deepEqual([MISSILE_DEFS.strategic_nuke.costPct, MISSILE_DEFS.strategic_nuke.damagePct], [50, 20]);
});

test("1960 年起解鎖(含當年),之前不行", () => {
  assert.equal(isMissileUnlocked("1959-12-31"), false);
  assert.equal(isMissileUnlocked("1960-01-01"), true);
  assert.equal(isMissileUnlocked("2026-10-05"), true);
  assert.equal(isMissileUnlocked("1900-01-01"), false);
  assert.equal(isMissileUnlocked("壞資料"), false);
  assert.equal(gameYearOf("-0044-03-15"), -44);
});

test("費用 = 國庫 × 百分比,無條件捨去", () => {
  assert.equal(missileCost(1_000_000, "medium"), 100_000);
  assert.equal(missileCost(1_000_000, "tactical_nuke"), 330_000);
  assert.equal(missileCost(1_000_000, "strategic_nuke"), 500_000);
  assert.equal(missileCost(999, "medium"), 99);
  assert.equal(missileCost(-5, "strategic_nuke"), 0);
});

test("門檻隨時代倍率縮放,倍率小於 1 當 1", () => {
  assert.equal(missileMinTreasury(1), 100_000);
  assert.equal(missileMinTreasury(2980), 298_000_000);
  assert.equal(missileMinTreasury(0.2), 100_000);
});

test("人口損失百分比", () => {
  assert.equal(populationLoss(1_000_000, "medium"), 30_000);
  assert.equal(populationLoss(1_000_000, "tactical_nuke"), 120_000);
  assert.equal(populationLoss(1_000_000, "strategic_nuke"), 200_000);
  assert.equal(populationLoss(0, "strategic_nuke"), 0);
  assert.equal(populationLoss(-10, "medium"), 0);
});

test("建築降級:至少掉 1 級、1 級被炸毀", () => {
  assert.equal(buildingLevelAfter(10, "strategic_nuke"), 8);
  assert.equal(buildingLevelAfter(10, "tactical_nuke"), 8); // floor(8.8)=8
  assert.equal(buildingLevelAfter(10, "medium"), 9); // floor(9.7)=9
  assert.equal(buildingLevelAfter(3, "medium"), 2); // floor(2.91)=2
  assert.equal(buildingLevelAfter(2, "medium"), 1); // floor(1.94)=1
  assert.equal(buildingLevelAfter(1, "medium"), 0); // 1 級 → 炸毀
  assert.equal(buildingLevelAfter(1, "strategic_nuke"), 0);
  // 低百分比也至少掉 1 級(floor(2×0.97)=1 → min(1, 1))
  for (const lv of [1, 2, 5, 50, 100]) {
    for (const t of ["medium", "tactical_nuke", "strategic_nuke"] as const) {
      const n = buildingLevelAfter(lv, t);
      assert.ok(n >= 0 && n < lv, `lv${lv} ${t} → ${n}`);
    }
  }
});

test("生產力占用等比釋放,炸毀全額釋放,總量守恆", () => {
  assert.deepEqual(reservedAfter(10, 8, 1000), { newReserved: 800, released: 200 });
  assert.deepEqual(reservedAfter(10, 0, 1000), { newReserved: 0, released: 1000 });
  assert.deepEqual(reservedAfter(3, 2, 10), { newReserved: 6, released: 4 });
  for (const [o, n, r] of [[7, 5, 999], [100, 80, 12345], [2, 1, 1]] as const) {
    const x = reservedAfter(o, n, r);
    assert.equal(x.newReserved + x.released, r);
    assert.ok(x.newReserved >= 0 && x.released >= 0);
  }
});

test("isMissileType 擋掉亂填", () => {
  assert.equal(isMissileType("medium"), true);
  assert.equal(isMissileType("nuke"), false);
  assert.equal(isMissileType(undefined), false);
});
