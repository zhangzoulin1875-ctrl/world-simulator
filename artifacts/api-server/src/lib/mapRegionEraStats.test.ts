import { test } from "node:test";
import assert from "node:assert/strict";
import { ERAS, ERA_COUNT, DEFAULT_ERA_SLUG, getEraIndex } from "./mapRegionEras";
import {
  validateEraStatSeed,
  generateEraStatRows,
  getRegionStaticRows,
  REGION_ASSIGNMENTS,
} from "./mapRegionEraStats";
import { MAP_REGION_AREAS_KM2 } from "./mapRegionAreas.generated";
import { getSeedRows, EXPECTED_REGION_COUNT } from "./mapRegions";

test("era definitions: 14 eras, unique slugs, user-specified averages", () => {
  assert.equal(ERA_COUNT, 14);
  assert.equal(new Set(ERAS.map((e) => e.slug)).size, 14);
  assert.deepEqual(
    ERAS.map((e) => e.prodAvg),
    [5, 10, 15, 20, 30, 100, 200, 300, 500, 1000, 1500, 3000, 5000, 10000],
  );
  // 科技錨點：古典 10、中世紀 ~20、科學革命 50、現代 500
  assert.equal(ERAS[getEraIndex("classical")]!.techAvg, 10);
  assert.equal(ERAS[getEraIndex("high_medieval")]!.techAvg, 20);
  assert.equal(ERAS[getEraIndex("scientific")]!.techAvg, 50);
  assert.equal(ERAS[getEraIndex("modern")]!.techAvg, 500);
  // 科技點數平均嚴格遞增
  for (let i = 1; i < ERAS.length; i++) {
    assert.ok(ERAS[i]!.techAvg > ERAS[i - 1]!.techAvg);
  }
  assert.equal(DEFAULT_ERA_SLUG, "classical");
});

test("seed validation passes and covers exactly the 373 seed regions", () => {
  validateEraStatSeed();
  const seedNames = getSeedRows().map((r) => r.name);
  assert.equal(seedNames.length, EXPECTED_REGION_COUNT);
  assert.deepEqual(
    new Set(Object.keys(REGION_ASSIGNMENTS)),
    new Set(seedNames),
  );
});

test("all 373 regions have a positive generated area", () => {
  for (const name of getSeedRows().map((r) => r.name)) {
    const area = MAP_REGION_AREAS_KM2[name];
    assert.ok(area !== undefined && area > 0, `${name} missing/invalid area`);
  }
});

test("anchor region areas match real-world magnitudes (±20%)", () => {
  // 真實世界參考值（km²），容差 ±20% — 抓單位錯誤／重投影錯誤，不追求測繪精度。
  const anchors: Record<string, number> = {
    埃及尼羅: 1_010_000, // 埃及全境
    卡達: 11_600,
    爪哇島: 132_000, // 爪哇（含馬都拉）
    斯里蘭卡: 65_600,
    九州島: 36_800,
    冰島: 103_000,
  };
  for (const [name, real] of Object.entries(anchors)) {
    const area = MAP_REGION_AREAS_KM2[name];
    assert.ok(area !== undefined, `${name} missing area`);
    assert.ok(
      area! >= real * 0.8 && area! <= real * 1.2,
      `${name} area ${area} 偏離真實值 ${real} 超過 ±20%`,
    );
  }
  // 抽樣合理性（球面計算，4% 簡化幾何的估算值）
  const iceland = MAP_REGION_AREAS_KM2["冰島"]!;
  assert.ok(iceland > 50_000 && iceland < 200_000, `冰島 area suspicious: ${iceland}`);
  const sahara = MAP_REGION_AREAS_KM2["撒哈拉中"]!;
  assert.ok(
    sahara > 1_500_000 && sahara < 4_000_000,
    `撒哈拉中 area suspicious: ${sahara}`,
  );
});

test("static rows: fertility follows user baselines with variance", () => {
  const byName = new Map(getRegionStaticRows().map((r) => [r.name, r]));
  // 新基準 0–120：東亞大平原斷崖式最高、沙漠斷崖式極低
  assert.ok(byName.get("太湖")!.soilFertility >= 110);
  assert.ok(byName.get("撒哈拉中")!.soilFertility <= 10);
  assert.ok(
    byName.get("太湖")!.soilFertility >=
      10 * byName.get("撒哈拉中")!.soilFertility,
  );
  // 埃及型混合地區取平均（尼羅河谷＋沙漠腹地）；歐洲核心高帶
  const nile = byName.get("埃及尼羅")!.soilFertility;
  assert.ok(nile >= 40 && nile <= 70);
  assert.ok(byName.get("法蘭西島")!.soilFertility >= 85);
  for (const row of byName.values()) {
    assert.ok(row.soilFertility > 0 && row.soilFertility <= 120);
    assert.ok(row.areaKm2 > 0);
  }
});

test("era stat rows: complete 373×14 grid, all values positive", () => {
  const rows = generateEraStatRows();
  assert.equal(rows.length, EXPECTED_REGION_COUNT * ERA_COUNT);
  const seen = new Set<string>();
  for (const r of rows) {
    assert.ok(r.population > 0, `${r.name}/${r.era} population`);
    assert.ok(r.productivity > 0, `${r.name}/${r.era} productivity`);
    assert.ok(r.techPoints > 0, `${r.name}/${r.era} techPoints`);
    assert.ok(Number.isInteger(r.population));
    assert.ok(Number.isInteger(r.productivity));
    assert.ok(Number.isInteger(r.techPoints));
    const key = `${r.name}\u0000${r.era}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
  }
});

test("per-era unweighted mean productivity stays near the world average", () => {
  const rows = generateEraStatRows();
  for (const era of ERAS) {
    const er = rows.filter((r) => r.era === era.slug);
    const mean = er.reduce((s, r) => s + r.productivity, 0) / er.length;
    const ratio = mean / era.prodAvg;
    assert.ok(
      ratio > 0.5 && ratio < 1.8,
      `era ${era.slug}: mean productivity ${mean.toFixed(1)} vs avg ${era.prodAvg} (ratio ${ratio.toFixed(2)})`,
    );
  }
});

test("world population totals are historically plausible", () => {
  const rows = generateEraStatRows();
  const total = (slug: string) =>
    rows.filter((r) => r.era === slug).reduce((s, r) => s + r.population, 0);
  const classical = total("classical");
  const modern = total("modern");
  assert.ok(classical > 80e6 && classical < 400e6, `classical total ${classical}`);
  assert.ok(modern > 4e9 && modern < 12e9, `modern total ${modern}`);
  // 每個地區現代人口 > 古典人口
  const byRegion = new Map<string, { classical?: number; modern?: number }>();
  for (const r of rows) {
    if (r.era !== "classical" && r.era !== "modern") continue;
    const e = byRegion.get(r.name) ?? {};
    if (r.era === "classical") e.classical = r.population;
    else e.modern = r.population;
    byRegion.set(r.name, e);
  }
  for (const [name, e] of byRegion) {
    assert.ok(e.modern! > e.classical!, `${name}: modern pop not > classical`);
  }
});

test("tech point spread is narrower than productivity spread in every era", () => {
  const rows = generateEraStatRows();
  for (const era of ERAS) {
    const er = rows.filter((r) => r.era === era.slug);
    const prods = er.map((r) => r.productivity);
    const techs = er.map((r) => r.techPoints);
    const prodSpread = Math.max(...prods) / Math.min(...prods);
    const techSpread = Math.max(...techs) / Math.min(...techs);
    assert.ok(
      techSpread < prodSpread,
      `era ${era.slug}: tech spread ${techSpread.toFixed(1)} not < prod spread ${prodSpread.toFixed(1)}`,
    );
  }
});
