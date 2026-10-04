import { isPgInt4Id } from "../lib/pgInt";
import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db,
  mapRegionsTable,
  mapRegionAdjacenciesTable,
  mapRegionEraStatsTable,
  mapCitiesTable,
  worldGameStateTable,
  playerNationsTable,
  regionControlsTable,
  nationMilitarySnapshotsTable,
  superEventsTable,
  superEventRegionsTable,
} from "@workspace/db";
import { schemas } from "@workspace/api-zod";
import { MAP_REGION_SEED } from "../lib/mapRegions";
import { ERAS, DEFAULT_ERA_SLUG, getEraIndex } from "../lib/mapRegionEras";
import { getStatsEraSlug } from "../lib/nationStats";
import { seaNeighborsOf } from "../lib/navalLanding";
import { getSession, readSessionToken } from "../lib/sessions";
import { requireAdmin } from "../middlewares/requireAdmin";
import { pgErrorCode, validateNationName } from "../lib/playerValidation";
import { logger } from "../lib/logger";
import { computeNationMilitaryAggregates } from "../lib/militarySnapshots";

const {
  ListMapRegionsResponse,
  GetMapRegionEraStatsResponse,
  GetWorldGameStateResponse,
  GetWorldEraStatsResponse,
  ListMapCitiesResponse,
  GetMapPoliticalResponse,
} = schemas;

const router: IRouter = Router();

/** Error that maps to an HTTP status (throw inside try → JSON error response). */
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Task #7 — 唯讀世界地圖總覽 API.
 *
 * Returns all 373 map regions grouped by their 14 macro regions, each with
 * its land-border neighbour list. Ordering follows the curated seed order in
 * MAP_REGION_SEED (macro regions and districts alike); any rows not present
 * in the seed (should not happen) are appended alphabetically at the end.
 */

const MACRO_ORDER = new Map(Object.keys(MAP_REGION_SEED).map((m, i) => [m, i]));
const REGION_ORDER = new Map<string, number>();
for (const names of Object.values(MAP_REGION_SEED)) {
  names.forEach((name, i) => REGION_ORDER.set(name, i));
}

function orderIndex(map: Map<string, number>, key: string): number {
  return map.get(key) ?? Number.MAX_SAFE_INTEGER;
}

router.get("/map/regions", async (req, res) => {
  try {
    const [regions, adjacencies] = await Promise.all([
      db.select().from(mapRegionsTable),
      db.select().from(mapRegionAdjacenciesTable),
    ]);

    const byId = new Map(regions.map((r) => [r.id, r]));
    const neighborsByRegion = new Map<number, { id: number; name: string; macroRegion: string }[]>();
    for (const adj of adjacencies) {
      const neighbor = byId.get(adj.adjacentRegionId);
      if (!neighbor) continue;
      const list = neighborsByRegion.get(adj.regionId) ?? [];
      list.push({ id: neighbor.id, name: neighbor.name, macroRegion: neighbor.macroRegion });
      neighborsByRegion.set(adj.regionId, list);
    }
    for (const list of neighborsByRegion.values()) {
      list.sort(
        (a, b) =>
          orderIndex(MACRO_ORDER, a.macroRegion) - orderIndex(MACRO_ORDER, b.macroRegion) ||
          orderIndex(REGION_ORDER, a.name) - orderIndex(REGION_ORDER, b.name) ||
          a.name.localeCompare(b.name, "zh-Hant"),
      );
    }

    const byName = new Map(regions.map((r) => [r.name, r]));
    const seaNeighborsByRegion = new Map<
      number,
      { id: number; name: string; macroRegion: string }[]
    >();
    for (const region of regions) {
      const seaList = seaNeighborsOf(region.name)
        .map((name) => byName.get(name))
        .filter((n): n is (typeof regions)[number] => !!n)
        .map((n) => ({ id: n.id, name: n.name, macroRegion: n.macroRegion }))
        .sort(
          (a, b) =>
            orderIndex(MACRO_ORDER, a.macroRegion) -
              orderIndex(MACRO_ORDER, b.macroRegion) ||
            orderIndex(REGION_ORDER, a.name) - orderIndex(REGION_ORDER, b.name) ||
            a.name.localeCompare(b.name, "zh-Hant"),
        );
      if (seaList.length > 0) seaNeighborsByRegion.set(region.id, seaList);
    }

    const groups = new Map<string, typeof regions>();
    for (const region of regions) {
      const list = groups.get(region.macroRegion) ?? [];
      list.push(region);
      groups.set(region.macroRegion, list);
    }

    const macroRegions = [...groups.entries()]
      .sort(
        (a, b) =>
          orderIndex(MACRO_ORDER, a[0]) - orderIndex(MACRO_ORDER, b[0]) ||
          a[0].localeCompare(b[0], "zh-Hant"),
      )
      .map(([macroRegion, list]) => ({
        macroRegion,
        regions: list
          .sort(
            (a, b) =>
              orderIndex(REGION_ORDER, a.name) - orderIndex(REGION_ORDER, b.name) ||
              a.name.localeCompare(b.name, "zh-Hant"),
          )
          .map((r) => ({
            id: r.id,
            name: r.name,
            macroRegion: r.macroRegion,
            hasNoLandBorder: r.hasNoLandBorder,
            soilFertility: r.soilFertility,
            areaKm2: r.areaKm2,
            neighbors: neighborsByRegion.get(r.id) ?? [],
            seaNeighbors: seaNeighborsByRegion.get(r.id) ?? [],
          })),
      }));

    const data = ListMapRegionsResponse.parse({
      totalRegions: regions.length,
      macroRegions,
    });
    res.json(data);
  } catch (err) {
    (req.log ?? logger).error({ err }, "Failed to list map regions");
    res.status(500).json({ error: "Failed to list map regions" });
  }
});

/** 讀取全域當前時代（無列或未知 slug 時退回預設古典時代）。 */
async function getCurrentEraSlug(): Promise<string> {
  const rows = await db
    .select()
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  const slug = rows[0]?.currentEra;
  if (slug && ERAS.some((e) => e.slug === slug)) return slug;
  return DEFAULT_ERA_SLUG;
}

/**
 * Task #9 — 單一地區的各時代模擬數據（人口/生產素質/科技點數），
 * 依時代順序回傳並標記全域當前時代。
 */
router.get("/map/regions/:id/era-stats", async (req, res) => {
  try {
    const regionId = Number(req.params.id);
    if (!isPgInt4Id(regionId)) {
      res.status(404).json({ error: "Region not found" });
      return;
    }

    const [regionRows, statRows, currentEra, statsEra, accruedRows] =
      await Promise.all([
        db.select().from(mapRegionsTable).where(eq(mapRegionsTable.id, regionId)).limit(1),
        db
          .select()
          .from(mapRegionEraStatsTable)
          .where(eq(mapRegionEraStatsTable.regionId, regionId)),
        getCurrentEraSlug(),
        getStatsEraSlug(),
        // Task #322 — 該地區各國累積人口成長量的總和（顯示於數據時代的人口）。
        db
          .select({
            accrued: sql<string>`COALESCE(SUM(${regionControlsTable.populationBonus}), 0)`,
          })
          .from(regionControlsTable)
          .where(eq(regionControlsTable.regionId, regionId)),
      ]);

    const region = regionRows[0];
    if (!region) {
      res.status(404).json({ error: "Region not found" });
      return;
    }

    const regionAccrued = Math.round(Number(accruedRows[0]?.accrued ?? 0));
    const bySlug = new Map(statRows.map((s) => [s.era, s]));
    const eras = ERAS.filter((e) => bySlug.has(e.slug)).map((e) => {
      const s = bySlug.get(e.slug)!;
      // Task #322 — 僅在「數據時代」把該地區累積成長量疊加到人口（下限 0），
      // 讓地圖人口視圖反映領土上的實際人口成長。
      const population =
        e.slug === statsEra ? Math.max(0, s.population + regionAccrued) : s.population;
      return {
        era: e.slug,
        label: e.label,
        isCurrent: e.slug === currentEra,
        population,
        // Task #405 — 有效生產素質 = era stat + 地區投資累積加成（跨時代固定）。
        productivity: s.productivity + region.productivityInvestmentBonus,
        techPoints: s.techPoints,
      };
    });

    const data = GetMapRegionEraStatsResponse.parse({
      regionId: region.id,
      name: region.name,
      macroRegion: region.macroRegion,
      soilFertility: region.soilFertility,
      areaKm2: region.areaKm2,
      currentEra,
      eras,
    });
    res.json(data);
  } catch (err) {
    (req.log ?? logger).error({ err }, "Failed to get region era stats");
    res.status(500).json({ error: "Failed to get region era stats" });
  }
});

/**
 * Task #13 — 批次時代數據：一次回傳全部地區 × 全部時代的
 * 人口/生產素質/科技點數（依 eras 順序的整數陣列），供地圖
 * choropleth 視圖一次載入後在客戶端即時切換時代與圖層。
 */
router.get("/map/era-stats", async (req, res) => {
  try {
    const [regions, statRows, currentEra, statsEra, accruedRows] =
      await Promise.all([
        db.select().from(mapRegionsTable),
        db.select().from(mapRegionEraStatsTable),
        getCurrentEraSlug(),
        getStatsEraSlug(),
        // Task #322 — 各地區各國累積人口成長量的總和（依地區分組）。
        db
          .select({
            regionId: regionControlsTable.regionId,
            accrued: sql<string>`COALESCE(SUM(${regionControlsTable.populationBonus}), 0)`,
          })
          .from(regionControlsTable)
          .groupBy(regionControlsTable.regionId),
      ]);

    const accruedByRegion = new Map(
      accruedRows.map((r) => [r.regionId, Math.round(Number(r.accrued))]),
    );
    const statsEraIdx = ERAS.findIndex((e) => e.slug === statsEra);
    const eraIndexBySlug = new Map(ERAS.map((e, i) => [e.slug, i]));
    const statsByRegion = new Map<
      number,
      { population: number[]; productivity: number[]; techPoints: number[] }
    >();
    for (const s of statRows) {
      const idx = eraIndexBySlug.get(s.era);
      if (idx === undefined) continue;
      let entry = statsByRegion.get(s.regionId);
      if (!entry) {
        entry = {
          population: new Array<number>(ERAS.length).fill(0),
          productivity: new Array<number>(ERAS.length).fill(0),
          techPoints: new Array<number>(ERAS.length).fill(0),
        };
        statsByRegion.set(s.regionId, entry);
      }
      entry.population[idx] = s.population;
      entry.productivity[idx] = s.productivity;
      entry.techPoints[idx] = s.techPoints;
    }

    // Task #405 — 把各地區投資累積加成疊到每個時代的生產素質（跨時代固定加值），
    // 讓世界地圖生產素質視圖顯示有效值。
    for (const r of regions) {
      if (r.productivityInvestmentBonus <= 0) continue;
      const entry = statsByRegion.get(r.id);
      if (!entry) continue;
      for (let i = 0; i < entry.productivity.length; i++) {
        entry.productivity[i] = (entry.productivity[i] ?? 0) + r.productivityInvestmentBonus;
      }
    }

    // Task #322 — 把各地區累積人口成長量疊加到「數據時代」的人口（下限 0），
    // 讓地圖人口視圖反映領土上的實際人口成長。
    if (statsEraIdx >= 0) {
      for (const [regionId, accrued] of accruedByRegion) {
        const entry = statsByRegion.get(regionId);
        if (!entry) continue;
        entry.population[statsEraIdx] = Math.max(
          0,
          (entry.population[statsEraIdx] ?? 0) + accrued,
        );
      }
    }

    const data = GetWorldEraStatsResponse.parse({
      currentEra,
      eras: ERAS.map((e) => ({ era: e.slug, label: e.label })),
      regions: regions
        .filter((r) => statsByRegion.has(r.id))
        .sort(
          (a, b) =>
            orderIndex(MACRO_ORDER, a.macroRegion) - orderIndex(MACRO_ORDER, b.macroRegion) ||
            orderIndex(REGION_ORDER, a.name) - orderIndex(REGION_ORDER, b.name) ||
            a.name.localeCompare(b.name, "zh-Hant"),
        )
        .map((r) => ({
          id: r.id,
          name: r.name,
          ...statsByRegion.get(r.id)!,
        })),
    });
    res.json(data);
  } catch (err) {
    (req.log ?? logger).error({ err }, "Failed to get world era stats");
    res.status(500).json({ error: "Failed to get world era stats" });
  }
});

/**
 * Task #23 / #311 — 歷史重要城市（唯讀）。回傳全部城市與所屬地區，依地區
 * 種子順序（宏觀區 → 地區 → 城市 id）排序，供地圖點位與地區卡城市列表一次
 * 載入。Task #311：每座城市加上「歸屬國家」（掌控該城所屬地區佔比最高者，
 * 與 /map/political 主控者判定一致）與玩家自訂名（單一全域值；null 沿用預設）。
 */
router.get("/map/cities", async (req, res) => {
  try {
    const [rows, controls] = await Promise.all([
      db
        .select({
          id: mapCitiesTable.id,
          defaultName: mapCitiesTable.name,
          customName: mapCitiesTable.customName,
          lat: mapCitiesTable.lat,
          lng: mapCitiesTable.lng,
          regionId: mapCitiesTable.regionId,
          regionName: mapRegionsTable.name,
          macroRegion: mapRegionsTable.macroRegion,
        })
        .from(mapCitiesTable)
        .innerJoin(mapRegionsTable, eq(mapCitiesTable.regionId, mapRegionsTable.id)),
      // 各地區掌控列（含國家名）；依 percent 降序、id 升序，取每地區第一列為主控者。
      db
        .select({
          regionId: regionControlsTable.regionId,
          nationId: regionControlsTable.nationId,
          percent: regionControlsTable.percent,
          nationName: playerNationsTable.name,
        })
        .from(regionControlsTable)
        .innerJoin(
          playerNationsTable,
          eq(playerNationsTable.id, regionControlsTable.nationId),
        )
        .orderBy(
          asc(regionControlsTable.regionId),
          desc(regionControlsTable.percent),
          asc(regionControlsTable.id),
        ),
    ]);

    // 每地區主控者 = percent 最高者（上面已排序，取首見）。
    const dominantByRegion = new Map<
      number,
      { nationId: string; nationName: string | null }
    >();
    for (const c of controls) {
      if (!dominantByRegion.has(c.regionId)) {
        dominantByRegion.set(c.regionId, {
          nationId: c.nationId,
          nationName: c.nationName,
        });
      }
    }

    const enriched = rows.map((r) => {
      const owner = dominantByRegion.get(r.regionId) ?? null;
      return {
        id: r.id,
        defaultName: r.defaultName,
        name: r.customName ?? r.defaultName,
        lat: r.lat,
        lng: r.lng,
        regionId: r.regionId,
        regionName: r.regionName,
        macroRegion: r.macroRegion,
        ownerNationId: owner?.nationId ?? null,
        ownerNationName: owner?.nationName ?? null,
      };
    });

    enriched.sort(
      (a, b) =>
        orderIndex(MACRO_ORDER, a.macroRegion) - orderIndex(MACRO_ORDER, b.macroRegion) ||
        orderIndex(REGION_ORDER, a.regionName) - orderIndex(REGION_ORDER, b.regionName) ||
        a.id - b.id,
    );

    const data = ListMapCitiesResponse.parse({
      totalCities: enriched.length,
      cities: enriched,
    });
    res.json(data);
  } catch (err) {
    (req.log ?? logger).error({ err }, "Failed to list map cities");
    res.status(500).json({ error: "Failed to list map cities" });
  }
});

/**
 * Task #311 — 玩家自訂城市名（單一全域值，非各玩家獨立）。僅「掌控該城所屬
 * 地區佔比最高」的國家玩家可更名（與 /map/political 主控者判定一致）；伺服器
 * 端再驗證一次歸屬（403）。name 為 null/空字串 → 還原種子預設名。名稱去空白、
 * 上限 25 字、僅允許文字與數字（禁空白與標點），且不得與其他城市預設名/自訂名或任何地區名衝突（全域唯一）。
 */
router.patch("/map/cities/:id/name", async (req, res) => {
  try {
    const session = await getSession(readSessionToken(req));
    if (!session) throw new HttpError(401, "請先以 Discord 登入");
    const userId = session.discordUserId;

    const cityId = Number(req.params.id);
    if (!isPgInt4Id(cityId)) {
      throw new HttpError(400, "城市編號無效");
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawName = body["name"];
    if (rawName !== null && rawName !== undefined && typeof rawName !== "string") {
      throw new HttpError(400, "name 必須是字串或 null");
    }
    // null / 空字串 → 還原種子預設名（不做字元驗證）。
    const trimmedName =
      rawName === null || rawName === undefined ? null : (rawName as string).trim();
    let newName: string | null;
    if (trimmedName === null || trimmedName === "") {
      newName = null;
    } else {
      const validated = validateNationName(trimmedName, "城市名稱");
      if (!validated.ok) throw new HttpError(400, validated.error);
      newName = validated.value;
    }

    // 呼叫者的國家（以 Discord 綁定）。未建國則不可能是任何地區的主控者。
    const [callerNation] = await db
      .select({ id: playerNationsTable.id })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.discordUserId, userId))
      .limit(1);
    if (!callerNation) {
      throw new HttpError(400, "尚未建國，請先在玩家首頁建立或接手國家");
    }

    // 城市 + 所屬地區。
    const [city] = await db
      .select({
        id: mapCitiesTable.id,
        defaultName: mapCitiesTable.name,
        regionId: mapCitiesTable.regionId,
      })
      .from(mapCitiesTable)
      .where(eq(mapCitiesTable.id, cityId))
      .limit(1);
    if (!city) throw new HttpError(404, "找不到這座城市");

    // 主控者 = 該地區 percent 最高者（percent desc, id asc 取首列）。
    const [dominant] = await db
      .select({ nationId: regionControlsTable.nationId })
      .from(regionControlsTable)
      .where(eq(regionControlsTable.regionId, city.regionId))
      .orderBy(desc(regionControlsTable.percent), asc(regionControlsTable.id))
      .limit(1);
    if (!dominant || dominant.nationId !== callerNation.id) {
      throw new HttpError(403, "只有掌控此城市所屬地區佔比最高的國家才能更名");
    }

    // 全域唯一：自訂名不得與任何地區名衝突（設定自訂名時才需檢查）。
    if (newName !== null) {
      const [regionClash] = await db
        .select({ id: mapRegionsTable.id })
        .from(mapRegionsTable)
        .where(eq(mapRegionsTable.name, newName))
        .limit(1);
      if (regionClash) {
        throw new HttpError(409, "此名稱與現有地區名稱相同，請改用其他名稱");
      }
      // 與其他城市的預設名衝突（排除自己）。自訂名衝突由唯一索引攔截。
      const [cityDefaultClash] = await db
        .select({ id: mapCitiesTable.id })
        .from(mapCitiesTable)
        .where(and(eq(mapCitiesTable.name, newName), ne(mapCitiesTable.id, cityId)))
        .limit(1);
      if (cityDefaultClash) {
        throw new HttpError(409, "此名稱與其他城市名稱相同，請改用其他名稱");
      }
    }

    try {
      await db
        .update(mapCitiesTable)
        .set({
          customName: newName,
          customNameNationId: newName === null ? null : callerNation.id,
          updatedAt: new Date(),
        })
        .where(eq(mapCitiesTable.id, cityId));
    } catch (err) {
      // 自訂名撞其他城市的自訂名（部分唯一索引，若有）或並發競態。
      if (pgErrorCode(err) === "23505") {
        throw new HttpError(409, "此名稱與其他城市名稱相同，請改用其他名稱");
      }
      throw err;
    }

    (req.log ?? logger).info(
      { userId, cityId, customName: newName },
      "map city renamed",
    );
    res.json({
      id: city.id,
      name: newName ?? city.defaultName,
      defaultName: city.defaultName,
      customName: newName,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    (req.log ?? logger).error({ err }, "map city rename failed");
    res.status(500).json({ error: "更名失敗，請稍後再試" });
  }
});

/**
 * Task #503 — 管理端一鍵恢復所有城市預設名稱（requireAdmin、raw fetch、
 * 不進 OpenAPI spec，遵循既有 admin API 慣例）。單一 UPDATE 把所有城市的
 * custom_name / custom_name_nation_id 清為 NULL，回傳恢復筆數。
 */
router.post("/admin/map/cities/reset-names", requireAdmin, async (req, res) => {
  try {
    const restored = await db
      .update(mapCitiesTable)
      .set({ customName: null, customNameNationId: null, updatedAt: new Date() })
      .where(
        sql`${mapCitiesTable.customName} IS NOT NULL OR ${mapCitiesTable.customNameNationId} IS NOT NULL`,
      )
      .returning({ id: mapCitiesTable.id });
    (req.log ?? logger).info(
      { restoredCount: restored.length },
      "admin reset all city custom names",
    );
    res.json({ ok: true, restoredCount: restored.length });
  } catch (err) {
    (req.log ?? logger).error({ err }, "admin reset city names failed");
    res.status(500).json({ error: "恢復城市預設名稱失敗，請稍後再試" });
  }
});

/**
 * Task #46 — 世界地圖政治視圖公開資料（唯讀）。
 * 回傳所有國家（id／名稱／是否 NPC）與所有地區掌控列
 * （regionId／nationId／percent）。刻意排除 discordUserId 等
 * 私人欄位；國家依建立時間排序，讓前端調色盤分配穩定且
 * 與管理頁一致。
 */
router.get("/map/political", async (req, res) => {
  try {
    // Task #58 — 大略人口以「數據時代」計算（與玩家國家數據一致）。
    const statsEra = await getStatsEraSlug();
    const [nations, controls, popRows, militaryAgg, trendRows] =
      await Promise.all([
      db
        .select({
          id: playerNationsTable.id,
          name: playerNationsTable.name,
          isNpc: playerNationsTable.isNpc,
          // 無主國家：未綁定玩家且非 NPC；不外洩 discordUserId 本身。
          isUnowned:
            sql<boolean>`(${playerNationsTable.discordUserId} IS NULL AND ${playerNationsTable.isNpc} = false)`.as(
              "is_unowned",
            ),
          // Task #58 — 地圖上顯示的國旗（可為 null）與政體標籤（已存 zh-TW）。
          flagUrl: playerNationsTable.flagUrl,
          // 玩家自訂地圖顏色（#rrggbb）；null = 前端退回預設調色盤。
          mapColor: playerNationsTable.mapColor,
          government: playerNationsTable.government,
          // Task #302 — 國庫金錢與科技點數，供國情面板比較與排序。
          money: playerNationsTable.money,
          techPoints: playerNationsTable.techPoints,
        })
        .from(playerNationsTable)
        .orderBy(asc(playerNationsTable.createdAt)),
      db
        .select({
          regionId: regionControlsTable.regionId,
          nationId: regionControlsTable.nationId,
          percent: regionControlsTable.percent,
          populationBonus: regionControlsTable.populationBonus,
        })
        .from(regionControlsTable)
        .orderBy(asc(regionControlsTable.regionId), asc(regionControlsTable.id)),
      // Task #58 — 大略人口：Σ(percent/100 × 該時代地區人口)，一次 GROUP BY 全部國家。
      // 缺該時代 era-stats 的地區被 inner join 排除（不會整頁掛掉，只是不計入）。
      db
        .select({
          nationId: regionControlsTable.nationId,
          population: sql<string>`COALESCE(SUM(${regionControlsTable.percent}::bigint * ${mapRegionEraStatsTable.population}::bigint / 100.0 + ${regionControlsTable.populationBonus}), 0)`,
        })
        .from(regionControlsTable)
        .innerJoin(
          mapRegionEraStatsTable,
          and(
            eq(mapRegionEraStatsTable.regionId, regionControlsTable.regionId),
            eq(mapRegionEraStatsTable.era, statsEra),
          ),
        )
        .groupBy(regionControlsTable.nationId),
      // Task #388/#389/#400 — 軍力聚合（popCostPerUnit 口徑）：現役＋傷兵＋
      // 前線占用，玩家與 NPC 共用同一套計算（與每日快照一致）。刻意只回傳
      // 聚合人口值，不外洩各兵種數量或編制。
      computeNationMilitaryAggregates(),
      // Task #400 — 近期每日軍力快照（每國最多保留 30 列；此處取全部後於
      // JS 端各國取最新 14 點，由舊到新）。
      db
        .select({
          nationId: nationMilitarySnapshotsTable.nationId,
          date: sql<string>`to_char(${nationMilitarySnapshotsTable.snapshotDate}, 'YYYY-MM-DD')`,
          armyPopulation: nationMilitarySnapshotsTable.armyPopulation,
        })
        .from(nationMilitarySnapshotsTable)
        .orderBy(
          asc(nationMilitarySnapshotsTable.nationId),
          asc(nationMilitarySnapshotsTable.snapshotDate),
        ),
    ]);

    const popByNation = new Map(
      popRows.map((r) => [r.nationId, Number(r.population)]),
    );

    // 各國軍力趨勢（由舊到新，最多 14 點）。
    const trendByNation = new Map<
      string,
      { date: string; armyPopulation: number }[]
    >();
    for (const row of trendRows) {
      const arr = trendByNation.get(row.nationId) ?? [];
      arr.push({
        date: row.date,
        armyPopulation: Math.max(0, Math.round(Number(row.armyPopulation))),
      });
      trendByNation.set(row.nationId, arr);
    }

    const nationsOut = nations.map((n) => {
      const agg = militaryAgg.get(n.id);
      return {
        id: n.id,
        name: n.name,
        isNpc: n.isNpc,
        isUnowned: n.isUnowned,
        flagUrl: n.flagUrl,
        // 玩家自訂地圖顏色（#rrggbb）；null = 前端退回預設調色盤。
        mapColor: n.mapColor,
        government: n.government,
        // 大略人口 = Σ(地區加權人口 + 各地區人口增長累積量)，下限 0，取整數。
        population: Math.max(0, Math.round(popByNation.get(n.id) ?? 0)),
        // 軍隊人口數 = Σ(部隊數量 × popCostPerUnit)＋傷兵池，下限 0，取整數
        // （無常備軍為 0）。
        armyPopulation: Math.max(0, Math.round(agg?.armyPopulation ?? 0)),
        // Task #400 — 傷兵中／前線中占用人口與近期軍力趨勢。
        woundedPopulation: Math.max(0, Math.round(agg?.woundedPopulation ?? 0)),
        committedPopulation: Math.max(
          0,
          Math.round(agg?.committedPopulation ?? 0),
        ),
        armyTrend: (trendByNation.get(n.id) ?? []).slice(-14),
        // Task #302 — 國庫金錢與科技點數，下限 0（NPC／無主國家亦一併回傳）。
        money: Math.max(0, n.money),
        techPoints: Math.max(0, n.techPoints),
      };
    });

    const data = GetMapPoliticalResponse.parse({
      nations: nationsOut,
      controls,
    });
    res.json(data);
  } catch (err) {
    (req.log ?? logger).error({ err }, "Failed to get map political data");
    res.status(500).json({ error: "Failed to get map political data" });
  }
});

/** Task #9 — 全域遊戲狀態（當前時代）；Task #21 加上遊戲日期。 */
router.get("/map/game-state", async (req, res) => {
  try {
    const rows = await db
      .select({
        currentEra: worldGameStateTable.currentEra,
        // node-postgres 會把 DATE 解析成 JS Date（再序列化成 ISO datetime），
        // 直接在 SQL 端轉成 YYYY-MM-DD 字串以符合契約。
        gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
      })
      .from(worldGameStateTable)
      .where(eq(worldGameStateTable.id, 1))
      .limit(1);
    const rawEra = rows[0]?.currentEra;
    const currentEra =
      rawEra && ERAS.some((e) => e.slug === rawEra) ? rawEra : DEFAULT_ERA_SLUG;
    const data = GetWorldGameStateResponse.parse({
      currentEra,
      currentEraLabel: ERAS[getEraIndex(currentEra)]!.label,
      gameDate: rows[0]?.gameDate ?? "1900-01-01",
    });
    res.json(data);
  } catch (err) {
    (req.log ?? logger).error({ err }, "Failed to get world game state");
    res.status(500).json({ error: "Failed to get world game state" });
  }
});

/**
 * Task #333 — 超事件地圖圖層（公開，唯讀）。回傳進行中的超事件及其影響地區
 * id；global 事件無 regionIds（前端視為全域高亮）。不外洩私有欄位。
 */
router.get("/map/super-events", async (req, res) => {
  try {
    const events = await db
      .select({
        id: superEventsTable.id,
        title: superEventsTable.title,
        category: superEventsTable.category,
        scope: superEventsTable.scope,
        severity: superEventsTable.severity,
      })
      .from(superEventsTable)
      .where(eq(superEventsTable.status, "active"))
      .orderBy(desc(superEventsTable.createdAt));
    const ids = events.map((e) => e.id);
    const regionRows =
      ids.length > 0
        ? await db
            .select({
              eventId: superEventRegionsTable.eventId,
              regionId: superEventRegionsTable.regionId,
            })
            .from(superEventRegionsTable)
            .where(inArray(superEventRegionsTable.eventId, ids))
        : [];
    const byEvent = new Map<string, number[]>();
    for (const r of regionRows) {
      const arr = byEvent.get(r.eventId) ?? [];
      arr.push(r.regionId);
      byEvent.set(r.eventId, arr);
    }
    res.json({
      events: events.map((e) => ({
        id: e.id,
        title: e.title,
        category: e.category,
        scope: e.scope,
        severity: e.severity,
        regionIds: byEvent.get(e.id) ?? [],
      })),
    });
  } catch (err) {
    (req.log ?? logger).error({ err }, "Failed to get map super events");
    res.status(500).json({ error: "Failed to get map super events" });
  }
});

export default router;
