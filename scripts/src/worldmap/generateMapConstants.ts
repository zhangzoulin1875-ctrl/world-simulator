/**
 * 從 regionMaster.ts（373 區真值）與 world-districts.topo.json（幾何）產生
 * api-server 使用的地圖常數：
 *  - MAP_REGION_SEED（14 大地區 × 區名）
 *  - MAP_ADJACENCY_PAIRS（由 topojson 共享弧線推導的陸地接壤 + 人工橋樑補充）
 *  - EXPECTED_ISOLATED（無陸地鄰接的區）
 *  - REGION_ASSIGNMENTS（profile / 肥沃度 / 人口·發展倍率）
 *  - EXPECTED_REGION_COUNT / EXPECTED_MACRO_REGION_COUNT
 *
 * 執行：pnpm --filter @workspace/scripts run build:mapconstants
 * （只在地圖幾何或 regionMaster 變動後需要重跑；輸出檔已提交至 repo）
 */

import fs from "node:fs";
import path from "node:path";
import { neighbors } from "topojson-client";
import type {
  Topology,
  GeometryCollection,
  GeometryObject,
  GeometryObjectA,
} from "topojson-specification";
import {
  SEED_REGIONS,
  CHINA_REGIONS,
  MACRO_ORDER,
  allRegionNames,
} from "./regionMaster.js";

const TOPO_PATH = path.resolve(
  import.meta.dirname,
  "../../../artifacts/discord-news/public/world-districts.topo.json",
);
const OUTPUT = path.resolve(
  import.meta.dirname,
  "../../../artifacts/api-server/src/lib/mapConstants.generated.ts",
);

/**
 * 人工橋樑／隧道／堤道補充：topojson 只認共享弧線（陸地接壤），跨海的固定
 * 連結（橋、隧道、長堤）不會被偵測到，須在此手動補上。海峽（無固定連結）
 * 不補 → 該島維持孤立。兩端名稱必須存在於 373 區。
 */
const BRIDGE_SUPPLEMENT: ReadonlyArray<readonly [string, string]> = [
  ["北海道", "東北地方"], // 青函隧道
  ["九州島", "山陰山陽"], // 關門橋隧
  ["四國地方", "山陰山陽"], // 瀨戶大橋
  ["四國地方", "近畿"], // 明石海峽大橋 + 大鳴門橋（經淡路島）
];

type DistrictGeom = GeometryObjectA<{ district: string }>;

function main(): void {
  const names = allRegionNames();
  const nameSet = new Set(names);
  if (nameSet.size !== names.length) {
    throw new Error("regionMaster: 區名重複");
  }

  // ── 讀 topo，取幾何與鄰接 ────────────────────────────────
  const topo = JSON.parse(fs.readFileSync(TOPO_PATH, "utf8")) as Topology;
  const layerName = Object.keys(topo.objects)[0]!;
  const layer = topo.objects[layerName] as GeometryCollection<{
    district: string;
  }>;
  const geoms = layer.geometries as DistrictGeom[];
  const geomNames = geoms.map((g) => g.properties?.district ?? "");

  // topo 名稱一致性（灰底 "" 不算）
  const topoNamed = new Set(geomNames.filter((n) => n.length > 0));
  for (const n of topoNamed) {
    if (!nameSet.has(n)) throw new Error(`topo 有但 regionMaster 沒有: ${n}`);
  }
  for (const n of nameSet) {
    if (!topoNamed.has(n)) throw new Error(`regionMaster 有但 topo 沒有幾何: ${n}`);
  }

  // ── topojson 鄰接（共享弧線）→ 無向 pair ────────────────
  const nbr = neighbors(geoms as GeometryObject[]);
  const pairSet = new Set<string>();
  const addPair = (a: string, b: string): void => {
    if (!a || !b || a === b) return;
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    pairSet.add(key);
  };
  nbr.forEach((list, i) => {
    const a = geomNames[i]!;
    for (const j of list) addPair(a, geomNames[j]!);
  });
  const topoPairCount = pairSet.size;

  // ── 人工橋樑補充 ─────────────────────────────────────────
  let bridgeAdded = 0;
  for (const [a, b] of BRIDGE_SUPPLEMENT) {
    if (!nameSet.has(a)) throw new Error(`橋樑補充: 未知區 ${a}`);
    if (!nameSet.has(b)) throw new Error(`橋樑補充: 未知區 ${b}`);
    const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
    if (pairSet.has(key)) {
      console.warn(`⚠ 橋樑補充 ${a}–${b} 已是陸地鄰接，冗餘`);
      continue;
    }
    pairSet.add(key);
    bridgeAdded++;
  }

  // ── pairs（排序，決定輸出順序）──────────────────────────
  const pairs = [...pairSet]
    .map((k) => k.split("\u0000") as [string, string])
    .sort((x, y) =>
      x[0] === y[0] ? x[1].localeCompare(y[1], "zh-Hant") : x[0].localeCompare(y[0], "zh-Hant"),
    );

  // ── 孤立區（無任何鄰接）─────────────────────────────────
  const withNeighbour = new Set<string>();
  for (const [a, b] of pairs) {
    withNeighbour.add(a);
    withNeighbour.add(b);
  }
  const isolated = names.filter((n) => !withNeighbour.has(n)).sort((a, b) => a.localeCompare(b, "zh-Hant"));

  // ── MAP_REGION_SEED（14 大地區）─────────────────────────
  const seedByMacro = new Map<string, string[]>();
  for (const m of MACRO_ORDER) seedByMacro.set(m, []);
  for (const s of SEED_REGIONS) {
    const arr = seedByMacro.get(s.macro);
    if (!arr) throw new Error(`SEED_REGIONS macro 不在 MACRO_ORDER: ${s.macro}`);
    arr.push(s.name);
  }
  for (const c of CHINA_REGIONS) seedByMacro.get("中國")!.push(c.name);

  // ── REGION_ASSIGNMENTS ───────────────────────────────────
  interface Assign {
    p: string;
    f: number;
    pm?: number;
    dm?: number;
  }
  const assignments: Array<[string, Assign]> = [];
  for (const s of SEED_REGIONS) {
    assignments.push([s.name, { p: s.profile, f: s.f, pm: s.pm, dm: s.dm }]);
  }
  for (const c of CHINA_REGIONS) {
    assignments.push([c.name, { p: c.profile, f: c.f, pm: c.pm, dm: c.dm }]);
  }

  // ── 產生檔案內容 ─────────────────────────────────────────
  const seedLines: string[] = [];
  for (const m of MACRO_ORDER) {
    const arr = seedByMacro.get(m)!;
    seedLines.push(`  ${JSON.stringify(m)}: [`);
    // 每行最多 6 個名稱
    for (let i = 0; i < arr.length; i += 6) {
      const chunk = arr.slice(i, i + 6).map((n) => JSON.stringify(n));
      seedLines.push(`    ${chunk.join(", ")},`);
    }
    seedLines.push(`  ],`);
  }

  const pairLines = pairs.map(
    ([a, b]) => `  [${JSON.stringify(a)}, ${JSON.stringify(b)}],`,
  );

  const isolatedLines = isolated.map((n) => `  ${JSON.stringify(n)},`);

  const assignLines = assignments.map(([name, a]) => {
    const parts = [`p: ${JSON.stringify(a.p)}`, `f: ${a.f}`];
    if (a.pm !== undefined) parts.push(`pm: ${a.pm}`);
    if (a.dm !== undefined) parts.push(`dm: ${a.dm}`);
    return `  ${JSON.stringify(name)}: { ${parts.join(", ")} },`;
  });

  const content = `/**
 * ⚠ 自動產生檔 — 請勿手動編輯。
 * 由 scripts/src/worldmap/generateMapConstants.ts 從 regionMaster.ts 與
 * world-districts.topo.json 產生。重新產生：
 *   pnpm --filter @workspace/scripts run build:mapconstants
 */

export const EXPECTED_REGION_COUNT = ${names.length};
export const EXPECTED_MACRO_REGION_COUNT = ${MACRO_ORDER.length};

/** 14 大地區 × 區名（依 regionMaster MACRO_ORDER 與 SEED/CHINA 順序）。 */
export const MAP_REGION_SEED: Readonly<Record<string, readonly string[]>> = {
${seedLines.join("\n")}
};

/**
 * 無向陸地接壤 pair（每對列一次；同步時寫入雙向）。由 topojson 共享弧線推導，
 * 另加 ${bridgeAdded} 條人工橋樑／隧道／堤道補充。
 */
export const MAP_ADJACENCY_PAIRS: ReadonlyArray<readonly [string, string]> = [
${pairLines.join("\n")}
];

/** 無任何陸地鄰接的區（離島且無固定連結）。 */
export const EXPECTED_ISOLATED: readonly string[] = [
${isolatedLines.join("\n")}
];

export interface RegionAssignmentSeed {
  /** 文明 profile 名稱（對應 mapRegionEraStats.PROFILES）。 */
  p: string;
  /** 土壤肥沃度（靜態）。 */
  f: number;
  /** 人口密度倍率（預設 1）。 */
  pm?: number;
  /** 發展指數倍率（預設 1）。 */
  dm?: number;
}

/** ${names.length} 區 → profile / 肥沃度 / 倍率。名稱與 MAP_REGION_SEED 完全一致。 */
export const REGION_ASSIGNMENTS: Readonly<Record<string, RegionAssignmentSeed>> = {
${assignLines.join("\n")}
};
`;

  fs.writeFileSync(OUTPUT, content);
  console.log(
    `✓ 輸出 ${OUTPUT}`,
  );
  console.log(
    `  區數 ${names.length}、大地區 ${MACRO_ORDER.length}、接壤 ${pairs.length}（topo ${topoPairCount} + 橋 ${bridgeAdded}）、孤立 ${isolated.length}`,
  );
  console.log(`  孤立區: ${isolated.join("、")}`);
}

main();
