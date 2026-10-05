import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPACITY_MULTIPLIER, CAPACITY_MIN, CAPACITY_WOBBLE_PCT, fertilityFactor, regionCapacity,
  regionNetGrowth, wobblePct, nationNetGrowth, summarizeCapacity,
} from "./populationCapacity";

test("肥沃度修正:0→0.8、100→1.2、超過 100 封頂、缺值中性", () => {
  assert.equal(fertilityFactor(0), 0.8);
  assert.equal(fertilityFactor(100), 1.2);
  assert.equal(fertilityFactor(120), 1.2);
  assert.equal(fertilityFactor(null), 1);
  assert.ok(Math.abs(fertilityFactor(50) - 1.0) < 1e-9);
});

test("承載量 = 基準人口 × 控制比例 × 倍數 × 肥沃度;小區有下限;未控制為 0", () => {
  const k = regionCapacity({ eraPopulation: 1_000_000, percent: 100, fertility: 50 });
  assert.equal(Math.round(k), Math.round(1_000_000 * CAPACITY_MULTIPLIER * 1.0));
  assert.equal(regionCapacity({ eraPopulation: 1_000_000, percent: 50, fertility: 50 }), k / 2);
  assert.equal(regionCapacity({ eraPopulation: 10, percent: 100, fertility: 50 }), CAPACITY_MIN);
  assert.equal(regionCapacity({ eraPopulation: 1_000_000, percent: 0, fertility: 50 }), 0);
});

test("人口遠低於承載量:接近原本的增長率(行為幾乎不變)", () => {
  // 人口只有承載量的 1/10000:淨成長應該幾乎等於舊公式 pop × 1%。
  const g = regionNetGrowth({ population: 1_000_000, capacity: 10_000_000_000, ratePct: 1 });
  assert.ok(Math.abs(g - 10_000) <= 2, `got ${g}`);
});

test("人口 = 承載量一半:淨成長約為原本的一半", () => {
  const g = regionNetGrowth({ population: 500_000, capacity: 1_000_000, ratePct: 1 });
  assert.equal(g, Math.round(500_000 * 0.01 * 0.5));
});

test("人口 = 承載量:淨成長 0", () => {
  assert.equal(regionNetGrowth({ population: 1_000_000, capacity: 1_000_000, ratePct: 1 }), 0);
});

test("超過承載量:負成長(緩慢回落),且幅度隨超載加大", () => {
  const a = regionNetGrowth({ population: 1_500_000, capacity: 1_000_000, ratePct: 1 });
  const b = regionNetGrowth({ population: 3_000_000, capacity: 1_000_000, ratePct: 1 });
  assert.ok(a < 0 && b < a);
  assert.equal(a, Math.round(1_500_000 * 0.01 * (1 - 1.5)));
  // 最嚴重的 3 倍超載首回合只掉 6%,不是一次砍 20%。
  assert.ok(Math.abs(b / 3_000_000) <= 0.06 + 1e-9);
});

test("零人口 → 0;增長率 ≤ 0 或承載量 ≤ 0 退回舊行為(不吞掉負成長政策)", () => {
  assert.equal(regionNetGrowth({ population: 0, capacity: 1000, ratePct: 1 }), 0);
  assert.equal(regionNetGrowth({ population: 1_000_000, capacity: 1_000_000, ratePct: -2 }), -20_000);
  assert.equal(regionNetGrowth({ population: 1_000_000, capacity: 0, ratePct: 1 }), 10_000);
});

test("擾動:確定性、在範圍內、不同地區/回合不同", () => {
  assert.equal(wobblePct(7, 100), wobblePct(7, 100));
  const vals = new Set<number>();
  for (let s = 1; s <= 50; s++) for (let t = 0; t < 20; t++) {
    const w = wobblePct(s, t);
    assert.ok(Math.abs(w) <= CAPACITY_WOBBLE_PCT);
    vals.add(Math.round(w * 100));
  }
  assert.ok(vals.size > 100, "擾動應該有足夠多樣性");
});

test("長期模擬:人口收斂到承載量附近並在 ±擾動範圍內起伏,不會無限長也不會崩", () => {
  const K = 3_000_000;
  let pop = 1_000_000;
  const tail: number[] = [];
  for (let t = 0; t < 1200; t++) {
    pop += nationNetGrowth([{ regionId: 1, population: pop, capacity: K }], 1, t);
    if (t >= 1000) tail.push(pop);
  }
  const hi = Math.max(...tail), lo = Math.min(...tail);
  assert.ok(hi < K * 1.12, `上限過高 ${hi}`);
  assert.ok(lo > K * 0.88, `下限過低 ${lo}`);
  assert.ok(hi > lo, "穩態應有起伏");
});

test("已經超載 3 倍的國家:約 33 天內回落到上限附近,過程單調下降不崩盤", () => {
  const K = 1_000_000;
  let pop = 3_000_000, prev = pop, turns = 0;
  while (pop > K * 1.1 && turns < 2000) {
    pop += nationNetGrowth([{ regionId: 2, population: pop, capacity: K }], 1, turns);
    assert.ok(pop <= prev + K * 0.001, "回落期間不應大幅反彈");
    assert.ok(prev - pop <= prev * 0.07, "單回合降幅不得超過 7%");
    prev = pop; turns++;
  }
  assert.ok(turns > 100 && turns < 400, `回落用了 ${turns} 回合`);
});

test("極端超載(人口遠大於承載量)也只緩慢回落:單回合最多 −6%,不會一次扣成 0 或負數", () => {
  for (const ratio of [4, 10, 100, 15_490]) {
    const capacity = 1000;
    const population = capacity * ratio;
    const net = regionNetGrowth({ population, capacity, ratePct: 1 });
    assert.ok(net < 0, `ratio ${ratio} 應為負成長`);
    assert.ok(net >= -population * 0.06 - 1, `ratio ${ratio} 單回合扣 ${net} 超過 6%`);
    assert.ok(population + net > 0, "人口不可被扣成 0 或負數");
  }
  const s = summarizeCapacity([{ regionId: 1, population: 15_490_000, capacity: 1000 }], 1);
  assert.ok(s.netGrowthPct >= -6.01 && s.netGrowthPct < 0, `顯示成長率 ${s.netGrowthPct} 應在 −6%~0`);
});

test("3 倍超載以內行為不變(首回合約 −6%)", () => {
  const net = regionNetGrowth({ population: 3000, capacity: 1000, ratePct: 1 });
  assert.equal(net, Math.round(3000 * 0.01 * (1 - 3)));
});
