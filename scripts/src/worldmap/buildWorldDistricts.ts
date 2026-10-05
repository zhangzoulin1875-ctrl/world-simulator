/**
 * 世界地圖建置腳本（地圖二代，373 區）：
 *  1. 讀取 Natural Earth 10m admin-1 GeoJSON（/tmp/ne/admin1_10m.geojson）
 *  2. 一般區：以「最近 seed」把各國 admin-1 單元指派給同國候選區
 *     （乾淨海岸線、自動分割一國多區、自動全覆蓋；距離門檻 + 排除框剔除海外屬地／亞洲俄羅斯）
 *  3. 中國 41 區：以 bbox 裁切（Sutherland–Hodgman）近似切割 32 省
 *  4. 與 API（/api/map/regions）名稱互相比對（API 未啟動時警告並跳過）
 *  5. 呼叫 mapshaper：dissolve2 → simplify → TopoJSON 輸出
 *
 * 執行：pnpm --filter @workspace/scripts run build:worldmap
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import {
  SEED_REGIONS,
  CHINA_REGIONS,
  EXCLUDE_BOXES,
  MAX_ASSIGN_KM,
  allRegionNames,
  type SeedRegion,
} from "./regionMaster.js";

const SOURCE = "/tmp/ne/admin1_10m.geojson";
const TAGGED = "/tmp/ne/tagged.geojson";
const OUTPUT = path.resolve(
  import.meta.dirname,
  "../../../artifacts/discord-news/public/world-districts.topo.json",
);
/** 完全不畫的國家（連灰底都不要）。 */
const DROP_COUNTRIES = new Set(["ATA"]);
const SIMPLIFY_PERCENTAGE = "4%";
/**
 * 虛構陸地「姆大陸」14 區的固化幾何（經緯度多邊形，相鄰區共用邊界）。
 * 不在 Natural Earth 內，故不走最近-seed 指派；建置時直接併入 tagged 單元，
 * 之後與其他區一起 dissolve／simplify／輸出，避免重建地圖時把姆大陸弄丟。
 */
const MU_CONTINENT = path.resolve(import.meta.dirname, "data/mu-continent.geojson");

type Bbox = readonly [number, number, number, number];
type Position = [number, number];
type Ring = Position[];
type PolygonCoords = Ring[];
type MultiPolygonCoords = PolygonCoords[];

interface Geometry {
  type: string;
  coordinates: unknown;
}
interface Adm1Feature {
  type: "Feature";
  properties: { adm0_a3: string; name: string; [k: string]: unknown };
  geometry: Geometry;
}

// ── 幾何工具 ────────────────────────────────────────────────
function bboxOf(geom: Geometry): Bbox {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;
  const visit = (coords: unknown): void => {
    if (
      Array.isArray(coords) &&
      coords.length >= 2 &&
      typeof coords[0] === "number" &&
      typeof coords[1] === "number"
    ) {
      const [lon, lat] = coords as Position;
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    if (Array.isArray(coords)) for (const c of coords) visit(c);
  };
  visit(geom.coordinates);
  return [minLon, minLat, maxLon, maxLat];
}

function centroidOf(geom: Geometry): Position {
  const [minLon, minLat, maxLon, maxLat] = bboxOf(geom);
  return [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
}

/** 外環的 shoelace 面積（度²，僅用於比較大小）。 */
function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a) / 2;
}

/**
 * 代表點：MultiPolygon 取「面積最大的多邊形」的 bbox 中心，Polygon 取自身 bbox 中心。
 * 避免跨越換日線的群島（如阿拉斯加阿留申）因整體 bbox 橫跨 ±180 而算出錯誤中心。
 */
function representativePoint(geom: Geometry): Position {
  if (geom.type === "MultiPolygon") {
    let best: PolygonCoords | null = null;
    let bestArea = -1;
    for (const poly of geom.coordinates as MultiPolygonCoords) {
      const area = ringArea(poly[0]);
      if (area > bestArea) {
        bestArea = area;
        best = poly;
      }
    }
    if (best) return centroidOf({ type: "Polygon", coordinates: best });
  }
  return centroidOf(geom);
}

function haversineKm(a: Position, b: Position): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function inBox(p: Position, box: Bbox): boolean {
  return p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];
}

// ── Sutherland–Hodgman：多邊形 ring 對軸對齊矩形裁切 ──────────
type Edge = "left" | "right" | "bottom" | "top";
function inside(p: Position, edge: Edge, box: Bbox): boolean {
  switch (edge) {
    case "left":
      return p[0] >= box[0];
    case "right":
      return p[0] <= box[2];
    case "bottom":
      return p[1] >= box[1];
    case "top":
      return p[1] <= box[3];
  }
}
function intersect(a: Position, b: Position, edge: Edge, box: Bbox): Position {
  const [ax, ay] = a;
  const [bx, by] = b;
  let x: number, y: number;
  switch (edge) {
    case "left":
      x = box[0];
      y = ay + ((by - ay) * (box[0] - ax)) / (bx - ax);
      break;
    case "right":
      x = box[2];
      y = ay + ((by - ay) * (box[2] - ax)) / (bx - ax);
      break;
    case "bottom":
      y = box[1];
      x = ax + ((bx - ax) * (box[1] - ay)) / (by - ay);
      break;
    case "top":
      y = box[3];
      x = ax + ((bx - ax) * (box[3] - ay)) / (by - ay);
      break;
  }
  return [x, y];
}
function clipRing(ring: Ring, box: Bbox): Ring {
  let output: Ring = ring.slice();
  for (const edge of ["left", "right", "bottom", "top"] as Edge[]) {
    if (output.length === 0) break;
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = inside(cur, edge, box);
      const prevIn = inside(prev, edge, box);
      if (curIn) {
        if (!prevIn) output.push(intersect(prev, cur, edge, box));
        output.push(cur);
      } else if (prevIn) {
        output.push(intersect(prev, cur, edge, box));
      }
    }
  }
  if (output.length > 0) {
    const f = output[0];
    const l = output[output.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) output.push([f[0], f[1]]);
  }
  return output;
}
function clipPolygon(poly: PolygonCoords, box: Bbox): PolygonCoords | null {
  const outer = clipRing(poly[0], box);
  if (outer.length < 4) return null;
  const rings: PolygonCoords = [outer];
  for (let i = 1; i < poly.length; i++) {
    const hole = clipRing(poly[i], box);
    if (hole.length >= 4) rings.push(hole);
  }
  return rings;
}
function clipGeometry(geom: Geometry, box: Bbox): Geometry | null {
  if (geom.type === "Polygon") {
    const out = clipPolygon(geom.coordinates as PolygonCoords, box);
    return out ? { type: "Polygon", coordinates: out } : null;
  }
  if (geom.type === "MultiPolygon") {
    const polys: MultiPolygonCoords = [];
    for (const poly of geom.coordinates as MultiPolygonCoords) {
      const out = clipPolygon(poly, box);
      if (out) polys.push(out);
    }
    return polys.length > 0 ? { type: "MultiPolygon", coordinates: polys } : null;
  }
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────
interface TaggedFeature {
  type: "Feature";
  properties: { district: string };
  geometry: Geometry;
}

function main(): void {
  if (!fs.existsSync(SOURCE)) {
    throw new Error(
      `找不到來源檔 ${SOURCE}（需先下載並轉換 Natural Earth 10m admin-1）`,
    );
  }
  const geo = JSON.parse(fs.readFileSync(SOURCE, "utf8")) as {
    features: Adm1Feature[];
  };

  const errors: string[] = [];
  const byCountry = new Map<string, Adm1Feature[]>();
  for (const f of geo.features) {
    const c = f.properties.adm0_a3;
    (byCountry.get(c) ?? byCountry.set(c, []).get(c)!).push(f);
  }

  // 每國候選 seed（該國被列入 countries 的所有區）；裁切區不參與最近-seed 候選。
  const seedsByCountry = new Map<string, SeedRegion[]>();
  for (const s of SEED_REGIONS) {
    if (s.clipUnits) continue;
    for (const c of s.countries) {
      (seedsByCountry.get(c) ?? seedsByCountry.set(c, []).get(c)!).push(s);
    }
  }

  // 由裁切區「消耗」的 admin-1 單元（country|name）：不走最近-seed，改由裁切迴圈處理。
  const clipConsumed = new Set<string>();
  for (const s of SEED_REGIONS) {
    if (!s.clipUnits) continue;
    for (const u of s.clipUnits) clipConsumed.add(`${u.country}|${u.name}`);
  }

  const tagged: TaggedFeature[] = [];
  const assignedNames = new Set<string>();

  // ── 一般區：最近 seed ──────────────────────────────────
  const excluded: string[] = [];
  const dropped: string[] = [];
  for (const [country, feats] of byCountry) {
    if (DROP_COUNTRIES.has(country)) continue;
    const seeds = seedsByCountry.get(country);
    for (const f of feats) {
      if (country === "CHN") continue; // 中國由 clip 處理
      if (clipConsumed.has(`${country}|${f.properties.name}`)) continue; // 裁切區處理
      const c = representativePoint(f.geometry);
      let district = "";
      if (seeds && seeds.length > 0) {
        const box = EXCLUDE_BOXES.find(
          (e) => e.country === country && inBox(c, e.box),
        );
        if (box) {
          excluded.push(`${country}/${f.properties.name}`);
        } else {
          let best: SeedRegion | null = null;
          let bestKm = Infinity;
          for (const s of seeds) {
            const km = haversineKm(c, [s.lon, s.lat]);
            if (km < bestKm) {
              bestKm = km;
              best = s;
            }
          }
          if (best && bestKm <= MAX_ASSIGN_KM) {
            district = best.name;
            assignedNames.add(best.name);
          } else {
            dropped.push(`${country}/${f.properties.name}(${bestKm.toFixed(0)}km)`);
          }
        }
      }
      tagged.push({
        type: "Feature",
        properties: { district },
        geometry: f.geometry,
      });
    }
  }

  // ── 中國 41 區：bbox clip ──────────────────────────────
  const chnFeats = byCountry.get("CHN") ?? [];
  const chnByName = new Map<string, Adm1Feature[]>();
  for (const f of chnFeats) {
    (chnByName.get(f.properties.name) ??
      chnByName.set(f.properties.name, []).get(f.properties.name)!).push(f);
  }
  const referencedProvinces = new Set<string>();
  for (const region of CHINA_REGIONS) {
    for (const prov of region.provinces) {
      referencedProvinces.add(prov.name);
      const feats = chnByName.get(prov.name);
      if (!feats || feats.length === 0) {
        errors.push(`中國 ${region.name}: 找不到省份 "${prov.name}"`);
        continue;
      }
      for (const f of feats) {
        if (prov.clip) {
          const clipped = clipGeometry(f.geometry, prov.clip);
          if (clipped) {
            tagged.push({
              type: "Feature",
              properties: { district: region.name },
              geometry: clipped,
            });
            assignedNames.add(region.name);
          }
        } else {
          tagged.push({
            type: "Feature",
            properties: { district: region.name },
            geometry: f.geometry,
          });
          assignedNames.add(region.name);
        }
      }
    }
  }
  // 中國覆蓋檢查：每個 CHN 省份都必須被引用
  for (const f of chnFeats) {
    if (!referencedProvinces.has(f.properties.name)) {
      errors.push(`中國覆蓋: 省份 "${f.properties.name}" 未被任何區引用`);
    }
  }

  // ── 裁切區：單一大單元切割（如加州拆南／北）──────────────
  for (const s of SEED_REGIONS) {
    if (!s.clipUnits) continue;
    for (const u of s.clipUnits) {
      const feats = (byCountry.get(u.country) ?? []).filter(
        (f) => f.properties.name === u.name,
      );
      if (feats.length === 0) {
        errors.push(`裁切區 ${s.name}: 找不到單元 "${u.country}/${u.name}"`);
        continue;
      }
      for (const f of feats) {
        const geom = u.clip ? clipGeometry(f.geometry, u.clip) : f.geometry;
        if (geom) {
          tagged.push({
            type: "Feature",
            properties: { district: s.name },
            geometry: geom,
          });
          assignedNames.add(s.name);
        }
      }
    }
  }

  // ── 虛構陸地：姆大陸（固化幾何直接併入）─────────────────
  const muFc = JSON.parse(fs.readFileSync(MU_CONTINENT, "utf8")) as {
    features: Array<{ properties: { district: string }; geometry: Geometry }>;
  };
  for (const f of muFc.features) {
    const name = f.properties.district;
    if (assignedNames.has(name)) {
      errors.push(`姆大陸區 "${name}" 與其他區重名`);
      continue;
    }
    tagged.push({
      type: "Feature",
      properties: { district: name },
      geometry: f.geometry,
    });
    assignedNames.add(name);
  }

  // ── 全區皆有幾何檢查 ───────────────────────────────────
  const allNames = allRegionNames();
  for (const n of allNames) {
    if (!assignedNames.has(n)) {
      errors.push(`區 "${n}" 沒有分配到任何行政單元/幾何`);
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error("✗", e);
    throw new Error(`建置驗證失敗，共 ${errors.length} 個問題`);
  }
  console.log(
    `✓ 指派完成：${allNames.length} 區、${tagged.length} 個幾何、` +
      `排除框 ${excluded.length}、超距離剔除 ${dropped.length}`,
  );

  void verifyAgainstApi(allNames).then(() => {
    writeAndBuild(tagged);
  });
}

async function verifyAgainstApi(names: string[]): Promise<void> {
  if (process.env.SKIP_API_VERIFY === "1") {
    console.warn("⚠ SKIP_API_VERIFY=1，跳過 API 名稱比對（重建期間 DB 尚未更新）");
    return;
  }
  const set = new Set(names);
  try {
    const res = await fetch("http://localhost:80/api/map/regions");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      totalRegions: number;
      macroRegions: { regions: { name: string }[] }[];
    };
    const dbNames = new Set(
      data.macroRegions.flatMap((m) => m.regions.map((r) => r.name)),
    );
    const missing = [...dbNames].filter((n) => !set.has(n));
    const extra = [...set].filter((n) => !dbNames.has(n));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `地區名稱不一致 — DB 有但本表沒有: [${missing.join(",")}]；` +
          `本表有但 DB 沒有: [${extra.join(",")}]`,
      );
    }
    console.log(`✓ 與 API 比對通過：${data.totalRegions} 個地區名稱完全一致`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("地區名稱不一致")) {
      throw err;
    }
    console.warn(`⚠ 無法連線 API 進行名稱比對（${String(err)}），跳過`);
  }
}

function writeAndBuild(features: TaggedFeature[]): void {
  fs.writeFileSync(
    TAGGED,
    JSON.stringify({ type: "FeatureCollection", features }),
  );
  console.log(`✓ 已寫入標記檔 ${TAGGED}（${features.length} 個單元）`);

  const require = createRequire(import.meta.url);
  const mapshaperBin = require.resolve("mapshaper/bin/mapshaper");
  const args = [
    TAGGED,
    "-rename-layers",
    "districts",
    "-dissolve2",
    "fields=district",
    "-simplify",
    SIMPLIFY_PERCENTAGE,
    "keep-shapes",
    "-clean",
    "-o",
    "format=topojson",
    "quantization=1e5",
    OUTPUT,
  ];
  console.log("→ mapshaper", args.join(" "));
  execFileSync(process.execPath, [mapshaperBin, ...args], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=6144" },
  });

  const size = fs.statSync(OUTPUT).size;
  console.log(`✓ 輸出 ${OUTPUT}（${(size / 1024 / 1024).toFixed(2)} MB）`);
}

main();
