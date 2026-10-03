/**
 * Task #420 — 地區稅收貢獻分配（最大餘數法）對帳不變量測試。
 * 鎖住：Σ 地區稅收 = 全國稅收（各種邊界都成立）、權重口徑 =
 * 基準時代人口 × 掌控比例 / 100 + 累積成長量。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateRegionPopulations,
  allocateRegionTax,
  exactRegionPopulations,
  type RegionTaxInput,
} from "./regionTax";

const region = (
  eraPopulation: number | string | null,
  percent: number,
  accrued = 0,
): RegionTaxInput => ({ eraPopulation, percent, accrued });

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe("exactRegionPopulations", () => {
  test("基準人口 × 比例 + 累積成長量，保留小數", () => {
    const pops = exactRegionPopulations([
      region(1000, 33, 5),
      region(200, 50),
    ]);
    assert.deepEqual(pops, [335, 100]);
  });

  test("缺時代數據（null）→ 權重只剩累積成長量", () => {
    assert.deepEqual(
      exactRegionPopulations([region(null, 80, 42), region(null, 100)]),
      [42, 0],
    );
  });

  test("字串型 bigint 與負累積量夾在 0", () => {
    assert.deepEqual(
      exactRegionPopulations([region("1000000", 10), region(100, 100, -999)]),
      [100000, 0],
    );
  });
});

describe("allocateRegionTax", () => {
  test("Σ 地區稅收 = 全國稅收（無法整除時用最大餘數）", () => {
    const regions = [region(100, 100), region(100, 100), region(100, 100)];
    const alloc = allocateRegionTax(regions, 10);
    assert.equal(sum(alloc), 10);
    assert.deepEqual(alloc, [4, 3, 3]);
  });

  test("依人口比例分配", () => {
    const alloc = allocateRegionTax(
      [region(100, 100), region(900, 100)],
      1000,
    );
    assert.deepEqual(alloc, [100, 900]);
  });

  test("0 人口地區分不到稅收，總和仍守恆", () => {
    const alloc = allocateRegionTax(
      [region(0, 100), region(null, 100), region(500, 100)],
      777,
    );
    assert.deepEqual(alloc, [0, 0, 777]);
    assert.equal(sum(alloc), 777);
  });

  test("全部地區 0 人口 → 平均分配，總和仍守恆", () => {
    const alloc = allocateRegionTax([region(0, 100), region(0, 100)], 5);
    assert.equal(sum(alloc), 5);
    assert.deepEqual(alloc, [3, 2]);
  });

  test("單一地區拿全部稅收", () => {
    assert.deepEqual(allocateRegionTax([region(123, 47, 9)], 999), [999]);
  });

  test("全 0 稅收與負稅收 → 全 0", () => {
    assert.deepEqual(
      allocateRegionTax([region(100, 100), region(200, 100)], 0),
      [0, 0],
    );
    assert.deepEqual(
      allocateRegionTax([region(100, 100), region(200, 100)], -5),
      [0, 0],
    );
  });

  test("空地區列表 → 空陣列", () => {
    assert.deepEqual(allocateRegionTax([], 100), []);
  });

  test("守恆不變量：隨機情境掃描 Σ = 稅收（tax）", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const n = (seed % 7) + 1;
      const regions = Array.from({ length: n }, (_, i) =>
        region(
          (seed * 37 + i * 101) % 5 === 0 ? null : ((seed * 13 + i * 71) % 900),
          ((seed + i * 31) % 100) + 1,
          ((seed * 7 + i * 17) % 40) - 5,
        ),
      );
      const tax = (seed * 997) % 10000;
      const alloc = allocateRegionTax(regions, tax);
      assert.equal(alloc.length, n);
      assert.equal(sum(alloc), Math.max(0, tax), `seed=${seed}`);
      for (const v of alloc) assert.ok(v >= 0, `seed=${seed} 非負`);
    }
  });
});

describe("allocateRegionPopulations（Task #430）", () => {
  test("Σ 地區顯示人口 = 全國人口（無法整除時用最大餘數）", () => {
    const regions = [region(1000, 33), region(1000, 33), region(1000, 34)];
    const alloc = allocateRegionPopulations(regions, 1000);
    assert.equal(sum(alloc), 1000);
    // 權重 330 / 330 / 340 → 依比例分配
    assert.deepEqual(alloc, [330, 330, 340]);
  });

  test("缺時代數據（null）→ 該地區只靠累積成長量取得份額", () => {
    const alloc = allocateRegionPopulations(
      [region(null, 100, 300), region(300, 100)],
      600,
    );
    assert.deepEqual(alloc, [300, 300]);
    assert.equal(sum(alloc), 600);
  });

  test("負累積成長量夾 0 → 該地區分 0，總和仍守恆", () => {
    const alloc = allocateRegionPopulations(
      [region(100, 100, -999), region(500, 100)],
      777,
    );
    assert.deepEqual(alloc, [0, 777]);
  });

  test("全國人口 ≤ 0 → 全 0", () => {
    assert.deepEqual(
      allocateRegionPopulations([region(100, 100), region(200, 100)], 0),
      [0, 0],
    );
    assert.deepEqual(
      allocateRegionPopulations([region(100, 100), region(200, 100)], -10),
      [0, 0],
    );
  });

  test("權重全 0（缺數據且無成長量）→ 平均分配，總和仍守恆", () => {
    const alloc = allocateRegionPopulations(
      [region(null, 100), region(0, 100)],
      7,
    );
    assert.equal(sum(alloc), 7);
    assert.deepEqual(alloc, [4, 3]);
  });

  test("空地區列表 → 空陣列", () => {
    assert.deepEqual(allocateRegionPopulations([], 100), []);
  });

  test("守恆不變量：隨機情境掃描 Σ = 全國人口（含缺數據/負累積量）", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const n = (seed % 7) + 1;
      const regions = Array.from({ length: n }, (_, i) =>
        region(
          (seed * 37 + i * 101) % 5 === 0 ? null : ((seed * 13 + i * 71) % 900),
          ((seed + i * 31) % 100) + 1,
          ((seed * 7 + i * 17) % 40) - 20,
        ),
      );
      const nationPop = (seed * 991) % 20000;
      const alloc = allocateRegionPopulations(regions, nationPop);
      assert.equal(alloc.length, n);
      assert.equal(sum(alloc), Math.max(0, nationPop), `seed=${seed}`);
      for (const v of alloc) assert.ok(v >= 0, `seed=${seed} 非負`);
    }
  });
});
