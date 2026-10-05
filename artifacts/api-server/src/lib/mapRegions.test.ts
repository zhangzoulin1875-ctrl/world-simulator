import { test } from "node:test";
import assert from "node:assert/strict";
import { REGION_ASSIGNMENTS } from "./mapConstants.generated";
import {
  MAP_REGION_SEED,
  MAP_ADJACENCY_PAIRS,
  EXPECTED_ISOLATED,
  EXPECTED_REGION_COUNT,
  EXPECTED_MACRO_REGION_COUNT,
  getSeedRows,
  getDirectedAdjacency,
  validateMapRegionSeed,
} from "./mapRegions";

test("seed passes internal validation", () => {
  validateMapRegionSeed();
});

test("seed has exactly 397 unique regions across 15 macro regions", () => {
  const rows = getSeedRows();
  assert.equal(rows.length, EXPECTED_REGION_COUNT);
  assert.equal(rows.length, 397);
  assert.equal(new Set(rows.map((r) => r.name)).size, 397);
  assert.equal(Object.keys(MAP_REGION_SEED).length, EXPECTED_MACRO_REGION_COUNT);
  assert.equal(Object.keys(MAP_REGION_SEED).length, 15);
});

test("macro region sizes match the confirmed 二代地圖 taxonomy", () => {
  const sizes = Object.fromEntries(
    Object.entries(MAP_REGION_SEED).map(([k, v]) => [k, v.length]),
  );
  assert.deepEqual(sizes, {
    非洲: 32,
    西歐: 44,
    北歐: 10,
    東歐: 35,
    南歐: 44,
    西亞: 25,
    中亞: 18,
    北亞: 8,
    中國: 42,
    東亞: 23,
    東南亞與大洋洲: 25,
    美洲: 27,
    南亞: 22,
    南美: 18,
    姆大陸: 24,
  });
});

test("directed adjacency is symmetric and duplicate-free", () => {
  const directed = getDirectedAdjacency();
  assert.equal(directed.length, MAP_ADJACENCY_PAIRS.length * 2);
  const keys = new Set(directed.map(([a, b]) => `${a}\u0000${b}`));
  assert.equal(keys.size, directed.length, "no duplicate directed edges");
  for (const [a, b] of directed) {
    assert.ok(keys.has(`${b}\u0000${a}`), `missing reverse edge ${b} → ${a}`);
  }
});

test("isolated regions are exactly the expected islands", () => {
  const withNeighbour = new Set(MAP_ADJACENCY_PAIRS.flat());
  const isolated = getSeedRows()
    .map((r) => r.name)
    .filter((n) => !withNeighbour.has(n))
    .sort();
  assert.deepEqual(isolated, [...EXPECTED_ISOLATED].sort());
});

test("spot checks: adjacency is real and mutual", () => {
  const neighbours = (name: string) =>
    new Set(
      getDirectedAdjacency()
        .filter(([a]) => a === name)
        .map(([, b]) => b),
    );

  // Verified land borders (mutual) in the 二代地圖 taxonomy.
  assert.ok(neighbours("法蘭西島").has("諾曼第大區"));
  assert.ok(neighbours("諾曼第大區").has("法蘭西島"));
  assert.ok(neighbours("大倫敦地區").has("東英格蘭"));

  // Every isolated island has zero land neighbours — cross-checks the
  // has_no_land_border invariant against the directed adjacency list.
  for (const island of EXPECTED_ISOLATED) {
    assert.equal(neighbours(island).size, 0, `${island} should be isolated`);
  }
});

// ─── 肥沃度新基準（0–120）種子測試：鎖定全域上下界與錨點值域帶，防止漂移。 ───

test("soil fertility: every region is an integer within 0–120", () => {
  const entries = Object.entries(REGION_ASSIGNMENTS);
  assert.equal(entries.length, 397);
  for (const [name, a] of entries) {
    assert.ok(Number.isInteger(a.f), `${name} 肥沃度應為整數（得 ${a.f}）`);
    assert.ok(a.f >= 0 && a.f <= 120, `${name} 肥沃度 ${a.f} 超出 0–120`);
  }
});

test("soil fertility: anchor bands hold (deserts cliff-low, great plains cliff-high)", () => {
  const f = (name: string) => {
    const a = REGION_ASSIGNMENTS[name];
    assert.ok(a, `找不到地區 ${name}`);
    return a!.f;
  };

  // 戈壁／沙漠／凍原／貧瘠高原：斷崖式極低。
  assert.ok(f("興安漠北") <= 15, "戈壁（興安漠北）應 ≤15");
  assert.ok(f("撒哈拉中") <= 10, "撒哈拉中應 ≤10");
  assert.ok(f("撒哈拉西") <= 10, "撒哈拉西應 ≤10");
  assert.ok(f("撒哈拉東") <= 10, "撒哈拉東應 ≤10");
  assert.ok(f("南詔滇東") <= 15, "雲南山區（南詔滇東）應 ≤15");
  assert.ok(f("衛藏吐蕃") <= 10, "青藏高原（衛藏吐蕃）應 ≤10");
  assert.ok(f("澳洲中西部內陸") <= 10, "澳洲內陸應 ≤10");
  assert.ok(f("卡達") <= 10 && f("利雅德") <= 10, "阿拉伯沙漠應 ≤10");

  // 東亞／南亞大平原：最高帶 105–110（2026-10 頭部重排：120→110、115→107、
  // 110→105，標尺上限不再被單一文明占滿；詳見 regionMaster.ts）。
  assert.ok(f("北方邦") >= 105 && f("比哈爾") >= 105, "恆河平原應 ≥105");
  assert.ok(f("河洛中原") >= 105 && f("魯西") >= 105, "華北平原應 ≥105");
  assert.ok(f("太湖") >= 105 && f("江漢荊楚") >= 105, "長江流域核心應 ≥105");
  assert.ok(f("湄公河三角洲") >= 105, "湄公河三角洲應 ≥105");

  // 「埃及型」混合地區取平均：不因肥沃帶給高分，也不因沙漠給極低分。
  assert.ok(f("埃及尼羅") >= 40 && f("埃及尼羅") <= 70, "埃及尼羅應為中等平均值");

  // 非洲分層：尼羅 vs 撒哈拉 vs 薩赫爾 vs 剛果雨林 vs 大湖區各自明顯分層。
  assert.ok(f("撒哈拉中") < f("薩赫爾西"), "撒哈拉應低於薩赫爾");
  assert.ok(f("薩赫爾西") < f("埃及尼羅"), "薩赫爾應低於尼羅河谷");
  assert.ok(f("埃及尼羅") < f("剛果盆地"), "尼羅（平均）應低於剛果雨林");
  assert.ok(f("剛果盆地") < f("大湖區北"), "剛果雨林應低於大湖區火山土");
});

test("soil fertility: 西歐 individual band 25–95 with macro average 60–80", () => {
  const west = MAP_REGION_SEED["西歐"]!;
  let sum = 0;
  for (const name of west) {
    const v = REGION_ASSIGNMENTS[name]!.f;
    assert.ok(v >= 25 && v <= 95, `西歐 ${name} 肥沃度 ${v} 應落在 25–95`);
    sum += v;
  }
  const avg = sum / west.length;
  assert.ok(avg >= 60 && avg <= 80, `西歐平均 ${avg.toFixed(1)} 應落在 60–80`);
});
