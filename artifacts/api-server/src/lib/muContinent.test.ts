import test from "node:test";
import assert from "node:assert/strict";
import {
  MAP_REGION_SEED,
  MAP_ADJACENCY_PAIRS,
  EXPECTED_ISOLATED,
} from "./mapConstants.generated";
import { MAP_REGION_AREAS_KM2 } from "./mapRegionAreas.generated";
import { REGION_ASSIGNMENTS, generateEraStatRows } from "./mapRegionEraStats";
import { ERA_GLOBAL_POPULATION } from "./eraCostScale";
import { GLOBAL_REGION_COUNT } from "./nationCostScale";
import { foodEraIndexForEra, FOOD_CALIBRATION } from "./food";
import { MAP_CITY_SEED } from "./mapCities";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * 姆大陸（虛構陸地，太平洋中央）：24 區、可建國、無特殊限制。
 * 鎖住它的設計承諾，避免日後改地圖時悄悄壞掉。
 */

const MU = MAP_REGION_SEED["姆大陸"] ?? [];
const MU_SET = new Set(MU);

test("姆大陸：24 區，名稱唯一，且不與其他大地區重名", () => {
  assert.equal(MU.length, 24);
  assert.equal(MU_SET.size, 24);
  for (const [macro, names] of Object.entries(MAP_REGION_SEED)) {
    if (macro === "姆大陸") continue;
    for (const n of names) assert.ok(!MU_SET.has(n), `${n} 同時出現在 ${macro} 與姆大陸`);
  }
});

test("姆大陸：是一整塊連通陸地（無孤立區），且與既有陸地沒有陸地接壤", () => {
  for (const n of MU) assert.ok(!EXPECTED_ISOLATED.includes(n), `${n} 不應是孤立區`);
  const inside = MAP_ADJACENCY_PAIRS.filter(([a, b]) => MU_SET.has(a) && MU_SET.has(b));
  const crossing = MAP_ADJACENCY_PAIRS.filter(
    ([a, b]) => MU_SET.has(a) !== MU_SET.has(b),
  );
  assert.deepEqual(crossing, [], "姆大陸是獨立大陸，與其他陸地只隔海");
  // BFS 連通性
  const adj = new Map<string, string[]>();
  for (const [a, b] of inside) {
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<string>([MU[0]!]);
  const q = [MU[0]!];
  while (q.length) for (const m of adj.get(q.pop()!) ?? []) if (!seen.has(m)) (seen.add(m), q.push(m));
  assert.equal(seen.size, 24, "24 區必須彼此連通");
});

test("姆大陸：每區面積落在合理範圍（大小懸殊，非等面積格狀），總面積約 936 萬 km²", () => {
  let total = 0;
  for (const n of MU) {
    const a = MAP_REGION_AREAS_KM2[n]!;
    assert.ok(a >= 100_000 && a <= 1_100_000, `${n} 面積 ${a} km² 應在 10–110 萬之間（與既有區分布相近，大小懸殊）`);
    total += a;
  }
  assert.ok(total > 8_500_000 && total < 10_000_000, `總面積 ${total} 應約 850–1000 萬 km²`);
});

test("姆大陸：使用 mu profile、肥沃度 0–120、沿用一般土地規則（無特殊欄位）", () => {
  for (const n of MU) {
    const a = REGION_ASSIGNMENTS[n]!;
    assert.equal(a.p, "mu");
    assert.ok(a.f >= 0 && a.f <= 120);
    assert.equal(a.dm, undefined, "不設發展倍率特例");
  }
});

test("姆大陸：各時代佔全球人口比例受控（古典 ≈1.2%，任何時代 ≤ 5%）", () => {
  const byEra: Record<string, { mu: number; all: number }> = {};
  for (const r of generateEraStatRows()) {
    const e = (byEra[r.era] ??= { mu: 0, all: 0 });
    e.all += r.population;
    if (MU_SET.has(r.name)) e.mu += r.population;
  }
  for (const [era, { mu, all }] of Object.entries(byEra)) {
    assert.ok(mu / all <= 0.05, `${era} 姆大陸佔比 ${((mu / all) * 100).toFixed(2)}% 超過 5%`);
  }
  assert.ok(byEra["classical"]!.mu / byEra["classical"]!.all < 0.015);
});

test("全球人口與區數常數與種子資料同步（含姆大陸）", () => {
  assert.equal(GLOBAL_REGION_COUNT, Object.values(MAP_REGION_SEED).flat().length);
  const sums: Record<string, number> = {};
  for (const r of generateEraStatRows()) sums[r.era] = (sums[r.era] ?? 0) + r.population;
  for (const [era, pop] of Object.entries(ERA_GLOBAL_POPULATION)) {
    assert.equal(pop, sums[era], `${era} 全球人口應等於 397 區加總`);
  }
});

test("姆大陸：糧食潛力（面積×肥沃度）占全球比例不超過 8%，全球糧食/人口誤差 ≤ 5%", () => {
  let all = 0;
  let mu = 0;
  for (const [n, a] of Object.entries(REGION_ASSIGNMENTS)) {
    const v = MAP_REGION_AREAS_KM2[n]! * a.f;
    all += v;
    if (MU_SET.has(n)) mu += v;
  }
  assert.ok(mu / all < 0.08, `姆大陸糧食潛力占比 ${((mu / all) * 100).toFixed(2)}% 過高`);
  // 古典開局全球校準：Σ(面積×肥沃度) × 0.1 × C ≈ 全球古典人口。姆大陸人少地多，允許誤差略放寬到 5%。
  const out = all * foodEraIndexForEra("classical") * FOOD_CALIBRATION;
  const pop = ERA_GLOBAL_POPULATION["classical"]!;
  assert.ok(Math.abs(out - pop) / pop <= 0.05, `全球古典糧食 ${out} 與人口 ${pop} 誤差過大`);
});

test("姆大陸：分區大小懸殊、不是規則格狀（最大／最小面積比 ≥ 5，鄰居數不全相同）", () => {
  const areas = MU.map((n) => MAP_REGION_AREAS_KM2[n]!);
  const ratio = Math.max(...areas) / Math.min(...areas);
  assert.ok(ratio >= 5, `最大/最小面積比 ${ratio.toFixed(1)} 太小，看起來像等面積格子`);
  const deg = MU.map(
    (n) => MAP_ADJACENCY_PAIRS.filter(([a, b]) => a === n || b === n).length,
  );
  assert.ok(new Set(deg).size >= 4, "鄰居數分佈應有變化");
  assert.ok(Math.min(...deg) >= 1 && Math.max(...deg) >= 6, "應有尾端單一鄰居與多鄰居樞紐");
});

function pointInRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

test("姆大陸城市：12 座虛構城市，座標真的落在所屬區幾何內", () => {
  const geo = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../../scripts/src/worldmap/data/mu-continent.geojson", import.meta.url)),
      "utf8",
    ),
  ) as { features: { properties: { district: string }; geometry: { coordinates: number[][][] } }[] };
  const ring = new Map(geo.features.map((f) => [f.properties.district, f.geometry.coordinates[0]!]));
  assert.equal(MAP_CITY_SEED.mu.length, 12);
  for (const c of MAP_CITY_SEED.mu) {
    assert.ok(MU_SET.has(c.region), `${c.name} 的區 ${c.region} 不是姆大陸`);
    assert.ok(pointInRing(c.lng, c.lat, ring.get(c.region)!), `${c.name} 座標不在 ${c.region} 內`);
  }
});
