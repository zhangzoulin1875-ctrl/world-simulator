import { eq, inArray } from "drizzle-orm";
import {
  db,
  mapCitiesTable,
  mapRegionsTable,
  playerNationsTable,
  regionControlsTable,
} from "@workspace/db";
import { REGION_ASSIGNMENTS } from "./mapConstants.generated";
import { logger } from "./logger";

/**
 * 國家「地理人文背景」脈絡（供各 AI 生成器參考）。
 *
 * 目的：讓 AI 生成的科技／軍事／內政內容貼合國家「實際掌控地區」的真實地理與
 * 文化淵源，而非一律預設中華／中國風格。掌控地區的文明圈由 `REGION_ASSIGNMENTS`
 * （地區名 → civ profile slug）推得；地理區由 `map_regions.macro_region` 提供。
 *
 * 本模組刻意只依賴 `@workspace/db` 與 `mapConstants.generated`（不 import cabinet
 * 等模組），避免與內閣註冊表產生循環相依。純字串組裝與 DB 查詢分離：
 *   - `buildGeoCultureText`：純函式，可單元測試。
 *   - `buildNationGeoCultureContext`：查該國掌控地區/城市後委派純函式；查詢失敗
 *     回空字串（呼叫端不加脈絡行），絕不中斷結算。
 */

/** civ profile slug → zh-TW 文化圈標籤（供 AI 判斷應採用哪種歷史文化風格）。 */
export const PROFILE_CULTURE: Readonly<Record<string, string>> = {
  china_core: "華夏中原",
  china_south: "華南",
  china_frontier: "中國邊疆",
  taiwan: "台灣",
  japan: "日本",
  korea_south: "朝鮮半島南部",
  korea_north: "朝鮮半島北部",
  india: "印度次大陸",
  seasia: "中南半島",
  seasia_islands: "南洋群島",
  entrepot: "海峽貿易港埠",
  oceania: "大洋洲",
  steppe: "歐亞草原（游牧）",
  siberia: "西伯利亞",
  arctic: "極地",
  persia: "波斯",
  levant: "黎凡特",
  mesopotamia: "美索不達米亞",
  arabia: "阿拉伯",
  caucasus: "高加索",
  nile: "尼羅河流域（埃及）",
  africa_med: "北非馬格里布",
  africa_desert: "撒哈拉",
  africa_sub: "撒哈拉以南非洲",
  europe_west: "西歐",
  europe_med: "南歐（地中海）",
  europe_central: "中歐",
  europe_east: "東歐",
  scandinavia: "北歐（斯堪地那維亞）",
  north_america: "北美",
  mesoamerica: "中美洲",
  andes: "安地斯（印加）",
  latam_temperate: "南美溫帶",
  latam_tropical: "南美熱帶",
  amazon_frontier: "亞馬遜",
};

/** 東亞（中華文化影響圈）profiles：掌控其一時，允許中華／東亞風格。 */
const EAST_ASIA_PROFILES: ReadonlySet<string> = new Set([
  "china_core",
  "china_south",
  "china_frontier",
  "taiwan",
  "japan",
  "korea_south",
  "korea_north",
]);

/** 每個地理區最多列出的樣本地區名數量（避免超大國家灌爆提示詞）。 */
const MAX_SAMPLE_REGIONS_PER_MACRO = 5;
/** 最多列出的城市數量。 */
const MAX_CITIES = 10;

export interface GeoRegionInput {
  regionName: string;
  macroRegion: string;
}

/**
 * 依掌控地區與城市組出一段 zh-TW「地理人文背景」字串（含給 AI 的文化貼合指示）。
 * 掌控地區為空時回空字串。純函式：civ profile 由 `REGION_ASSIGNMENTS`（記憶體常數）
 * 依地區名查得，不觸及 DB。
 */
export function buildGeoCultureText(
  regions: readonly GeoRegionInput[],
  cityNames: readonly string[],
): string {
  if (regions.length === 0) return "";

  // 依地理區（macro region）分組地區名。
  const byMacro = new Map<string, string[]>();
  for (const r of regions) {
    const list = byMacro.get(r.macroRegion);
    if (list) list.push(r.regionName);
    else byMacro.set(r.macroRegion, [r.regionName]);
  }

  // 統計文化圈（依地區數排序），並偵測是否掌控東亞。
  const cultureCount = new Map<string, number>();
  let controlsEastAsia = false;
  for (const r of regions) {
    const slug = REGION_ASSIGNMENTS[r.regionName]?.p;
    if (!slug) continue;
    if (EAST_ASIA_PROFILES.has(slug)) controlsEastAsia = true;
    const label = PROFILE_CULTURE[slug] ?? slug;
    cultureCount.set(label, (cultureCount.get(label) ?? 0) + 1);
  }

  const macroLines = [...byMacro.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([macro, names]) => {
      if (names.length > MAX_SAMPLE_REGIONS_PER_MACRO) {
        const sample = names.slice(0, MAX_SAMPLE_REGIONS_PER_MACRO).join("、");
        return `${macro}（${sample}等${names.length}個地區）`;
      }
      return `${macro}（${names.join("、")}）`;
    });

  const cultures = [...cultureCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label]) => label);

  const lines: string[] = ["【地理人文背景】"];
  lines.push(`掌控地區（依地理區）：${macroLines.join("；")}`);
  if (cultures.length > 0) {
    lines.push(`主要文化圈：${cultures.join("、")}`);
  }
  if (cityNames.length > 0) {
    lines.push(`境內主要城市：${cityNames.slice(0, MAX_CITIES).join("、")}`);
  }
  lines.push(
    controlsEastAsia
      ? "請讓生成內容的名稱、風格與典故貼合上述地區的真實歷史文化與地理環境。"
      : "請讓生成內容的名稱、風格與典故貼合上述地區的真實歷史文化與地理環境；除非確實掌控東亞，否則不要預設中華／中國風格。",
  );
  return lines.join("\n");
}

/**
 * 查某國掌控地區/城市並組出「地理人文背景」脈絡字串。無掌控地區或查詢失敗時回
 * 空字串（呼叫端不注入脈絡行），絕不拋錯中斷回合結算。
 */
export async function buildNationGeoCultureContext(
  nationId: string,
): Promise<string> {
  try {
    const regionRows = await db
      .select({
        name: mapRegionsTable.name,
        macroRegion: mapRegionsTable.macroRegion,
      })
      .from(regionControlsTable)
      .innerJoin(
        mapRegionsTable,
        eq(mapRegionsTable.id, regionControlsTable.regionId),
      )
      .where(eq(regionControlsTable.nationId, nationId));
    if (regionRows.length === 0) return "";

    const cityRows = await db
      .select({ name: mapCitiesTable.name })
      .from(mapCitiesTable)
      .innerJoin(
        regionControlsTable,
        eq(regionControlsTable.regionId, mapCitiesTable.regionId),
      )
      .where(eq(regionControlsTable.nationId, nationId));

    return buildGeoCultureText(
      regionRows.map((r) => ({ regionName: r.name, macroRegion: r.macroRegion })),
      cityRows.map((r) => r.name),
    );
  } catch (err) {
    logger.error(
      { err, nationId },
      "buildNationGeoCultureContext failed — returning empty context",
    );
    return "";
  }
}

/**
 * 依「地區 id 集合」組出「地理人文背景」脈絡字串——供不綁單一國家的事件使用
 * （如超事件的 regional／targeted 受影響地區集合）。查地區名／macro region／城市後
 * 委派既有純函式 `buildGeoCultureText`。空集合或查詢失敗回空字串（呼叫端不注入脈絡
 * 行），絕不拋錯中斷結算——與 `buildNationGeoCultureContext` 一致，可安全於結算流程
 * await。
 */
export async function buildRegionSetGeoCultureContext(
  regionIds: readonly number[],
): Promise<string> {
  const ids = [...new Set(regionIds)];
  if (ids.length === 0) return "";
  try {
    const regionRows = await db
      .select({
        name: mapRegionsTable.name,
        macroRegion: mapRegionsTable.macroRegion,
      })
      .from(mapRegionsTable)
      .where(inArray(mapRegionsTable.id, ids));
    if (regionRows.length === 0) return "";

    const cityRows = await db
      .select({ name: mapCitiesTable.name })
      .from(mapCitiesTable)
      .where(inArray(mapCitiesTable.regionId, ids));

    return buildGeoCultureText(
      regionRows.map((r) => ({ regionName: r.name, macroRegion: r.macroRegion })),
      cityRows.map((r) => r.name),
    );
  } catch (err) {
    logger.error(
      { err, regionCount: ids.length },
      "buildRegionSetGeoCultureContext failed — returning empty context",
    );
    return "";
  }
}

/**
 * 由玩家 Discord id 反查其國家 uuid（供牌池 direction 分割與地理脈絡查詢共用）。
 * 查無或失敗回 null（呼叫端據此退回全域中性牌池），絕不拋錯。
 */
export async function nationIdForUser(
  discordUserId: string,
): Promise<string | null> {
  try {
    const [row] = await db
      .select({ id: playerNationsTable.id })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.discordUserId, discordUserId))
      .limit(1);
    return row?.id ?? null;
  } catch (err) {
    logger.error({ err, discordUserId }, "nationIdForUser failed");
    return null;
  }
}
