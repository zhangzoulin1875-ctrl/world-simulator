/**
 * 從 artifacts/discord-news/public/world-districts.topo.json 計算每個地區的
 * 球面面積（km²），輸出為 api-server 的 generated 檔案，供時代數據種子使用。
 *
 * 執行：pnpm --filter @workspace/scripts run build:areas
 * （只在地圖幾何變動後需要重跑；輸出檔已提交至 repo）
 */

import fs from "node:fs";
import path from "node:path";
import { feature } from "topojson-client";
import { geoArea } from "d3-geo";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { FeatureCollection, Geometry } from "geojson";

const TOPO_PATH = path.resolve(
  import.meta.dirname,
  "../../../artifacts/discord-news/public/world-districts.topo.json",
);
const OUTPUT = path.resolve(
  import.meta.dirname,
  "../../../artifacts/api-server/src/lib/mapRegionAreas.generated.ts",
);

/** 地球平均半徑 (km)。geoArea 回傳球面度（steradians）。 */
const EARTH_RADIUS_KM = 6371;

function main(): void {
  const topo = JSON.parse(fs.readFileSync(TOPO_PATH, "utf8")) as Topology;
  const layerName = Object.keys(topo.objects)[0];
  const layer = topo.objects[layerName] as GeometryCollection<{ district: string }>;
  const fc = feature(topo, layer) as unknown as FeatureCollection<
    Geometry,
    { district: string }
  >;

  const areas = new Map<string, number>();
  for (const f of fc.features) {
    const district = f.properties?.district ?? "";
    if (!district) continue; // 灰色背景（未對應陸地）
    const steradians = geoArea(f);
    const km2 = steradians * EARTH_RADIUS_KM * EARTH_RADIUS_KM;
    areas.set(district, (areas.get(district) ?? 0) + km2);
  }

  const names = [...areas.keys()].sort((a, b) => a.localeCompare(b, "zh-Hant"));
  console.log(`✓ 計算 ${names.length} 個地區的面積`);
  for (const [name, km2] of areas) {
    if (!(km2 > 0)) throw new Error(`地區 ${name} 面積異常: ${km2}`);
  }

  const lines = names.map(
    (name) => `  ${JSON.stringify(name)}: ${Math.round(areas.get(name)!)},`,
  );
  const content = `/**
 * ⚠ 自動產生檔 — 請勿手動編輯。
 * 由 scripts/src/worldmap/computeDistrictAreas.ts 從
 * world-districts.topo.json 幾何計算（球面面積，經 4% 簡化，估算精度）。
 * 重新產生：pnpm --filter @workspace/scripts run build:areas
 */

/** 每個地區的領土面積（km²，四捨五入至整數）。 */
export const MAP_REGION_AREAS_KM2: Readonly<Record<string, number>> = {
${lines.join("\n")}
};
`;
  fs.writeFileSync(OUTPUT, content);
  console.log(`✓ 輸出 ${OUTPUT}（${names.length} 個地區）`);
}

main();
