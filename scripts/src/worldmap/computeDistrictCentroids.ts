/**
 * 從 artifacts/discord-news/public/world-districts.topo.json 計算每個地區的
 * 球面質心(經緯度),輸出為 api-server 的 generated 檔案,供油井「進攻距離衰減」使用。
 *
 * 一個地區若由多個形狀組成(島嶼/飛地),取「面積加權」的球面質心向量平均,
 * 避免被小島拉偏;跨日界線的地區因此也不會算出錯誤的平面平均值。
 *
 * 執行：pnpm --filter @workspace/scripts run build:centroids
 * （只在地圖幾何變動後需要重跑；輸出檔已提交至 repo）
 */

import fs from "node:fs";
import path from "node:path";
import { feature } from "topojson-client";
import { geoArea, geoCentroid } from "d3-geo";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { FeatureCollection, Geometry } from "geojson";

const TOPO_PATH = path.resolve(import.meta.dirname, "../../../artifacts/discord-news/public/world-districts.topo.json");
const OUTPUT = path.resolve(import.meta.dirname, "../../../artifacts/api-server/src/lib/mapRegionCentroids.generated.ts");

const RAD = Math.PI / 180;

function toVec(lng: number, lat: number): [number, number, number] {
  const la = lat * RAD, lo = lng * RAD;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

function main(): void {
  const topo = JSON.parse(fs.readFileSync(TOPO_PATH, "utf8")) as Topology;
  const layerName = Object.keys(topo.objects)[0]!;
  const layer = topo.objects[layerName] as GeometryCollection<{ district: string }>;
  const fc = feature(topo, layer) as unknown as FeatureCollection<Geometry, { district: string }>;

  const acc = new Map<string, [number, number, number]>();
  for (const f of fc.features) {
    const name = f.properties?.district ?? "";
    if (!name) continue;
    const w = geoArea(f);
    const [lng, lat] = geoCentroid(f);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || !(w > 0)) throw new Error(`地區 ${name} 質心異常`);
    const v = toVec(lng, lat);
    const cur = acc.get(name) ?? [0, 0, 0];
    acc.set(name, [cur[0] + v[0] * w, cur[1] + v[1] * w, cur[2] + v[2] * w]);
  }

  const names = [...acc.keys()].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  const lines = names.map((n) => {
    const [x, y, z] = acc.get(n)!;
    const len = Math.hypot(x, y, z);
    if (!(len > 1e-9)) throw new Error(`地區 ${n} 質心向量退化(形狀互相抵銷)`);
    const lat = Math.asin(z / len) / RAD;
    const lng = Math.atan2(y, x) / RAD;
    return `  ${JSON.stringify(n)}: [${lng.toFixed(3)}, ${lat.toFixed(3)}],`;
  });
  console.log(`✓ 計算 ${names.length} 個地區的質心`);

  fs.writeFileSync(OUTPUT, `/**
 * ⚠ 自動產生檔 — 請勿手動編輯。
 * 由 scripts/src/worldmap/computeDistrictCentroids.ts 從 world-districts.topo.json
 * 計算(多形狀地區為面積加權的球面質心)。
 * 重新產生：pnpm --filter @workspace/scripts run build:centroids
 */

/** 每個地區的質心 [經度, 緯度](度)。 */
export const MAP_REGION_CENTROIDS: Readonly<Record<string, readonly [number, number]>> = {
${lines.join("\n")}
};
`);
  console.log(`✓ 輸出 ${OUTPUT}`);
}

main();
