import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  superEventRegionsTable,
  superEventNationsTable,
  playerNationsTable,
  regionControlsTable,
  mapRegionEraStatsTable,
  type SuperEvent,
} from "@workspace/db";
import type { AffectedNation } from "./types";

/**
 * 載入受某事件影響的所有國家（含各國受影響地區與統計基準）。
 *
 * Task #356 — 範圍精準化，移除「靜默全球化」後備：
 *  - global：所有掌控地區的國家，整國暴露。
 *  - regional：僅掌控任一受影響地區的國家；scoped = 受影響地區交集。無地區 → 空。
 *  - targeted：僅 super_event_nations 列出的國家，整國暴露；無目標 → 空。
 */
export async function loadAffectedNations(
  event: SuperEvent,
  statsEra: string,
): Promise<AffectedNation[]> {
  const scope = event.scope;

  let eventRegionIds: Set<number> | null = null;
  let targetNationIds: Set<string> | null = null;
  if (scope === "regional") {
    const regionRows = await db
      .select({ regionId: superEventRegionsTable.regionId })
      .from(superEventRegionsTable)
      .where(eq(superEventRegionsTable.eventId, event.id));
    eventRegionIds = new Set(regionRows.map((r) => r.regionId));
    if (eventRegionIds.size === 0) return []; // 無指定地區 → 不影響任何國家
  } else if (scope === "targeted") {
    const nationRows = await db
      .select({ nationId: superEventNationsTable.nationId })
      .from(superEventNationsTable)
      .where(eq(superEventNationsTable.eventId, event.id));
    targetNationIds = new Set(nationRows.map((r) => r.nationId));
    if (targetNationIds.size === 0) return []; // 無指定國家 → 不影響任何國家
  }

  // 逐地區的掌控 × 該地區 statsEra 人口／生產素質。
  const controls = await db
    .select({
      nationId: regionControlsTable.nationId,
      regionId: regionControlsTable.regionId,
      percent: regionControlsTable.percent,
      population: mapRegionEraStatsTable.population,
      productivity: mapRegionEraStatsTable.productivity,
    })
    .from(regionControlsTable)
    .innerJoin(
      mapRegionEraStatsTable,
      and(
        eq(mapRegionEraStatsTable.regionId, regionControlsTable.regionId),
        eq(mapRegionEraStatsTable.era, statsEra),
      ),
    );

  interface RawControl {
    regionId: number;
    percent: number;
    pop: number;
    prod: number;
  }
  const rawByNation = new Map<string, RawControl[]>();
  for (const c of controls) {
    const arr = rawByNation.get(c.nationId) ?? [];
    arr.push({
      regionId: c.regionId,
      percent: c.percent,
      pop: Number(c.population),
      prod: Number(c.productivity),
    });
    rawByNation.set(c.nationId, arr);
  }
  // targeted：即使某目標國家未掌控任何地區，仍須套用齊頭數值（滿意度／穩定度）。
  if (targetNationIds) {
    for (const nid of targetNationIds) {
      if (!rawByNation.has(nid)) rawByNation.set(nid, []);
    }
  }

  const byNation = new Map<
    string,
    { regionIds: number[]; popBase: number; prodBase: number; totalPopBase: number }
  >();
  for (const [nationId, rows] of rawByNation) {
    let qualifies = false;
    if (scope === "global") qualifies = true;
    else if (scope === "targeted") qualifies = targetNationIds!.has(nationId);
    else qualifies = rows.some((r) => eventRegionIds!.has(r.regionId)); // regional
    if (!qualifies) continue;

    const isScoped = (regionId: number) =>
      scope === "regional" ? eventRegionIds!.has(regionId) : true;

    let popBase = 0;
    let prodBase = 0;
    let totalPopBase = 0;
    const regionIds: number[] = [];
    for (const r of rows) {
      const contribPop = (r.percent * r.pop) / 100;
      totalPopBase += contribPop;
      if (isScoped(r.regionId)) {
        regionIds.push(r.regionId);
        popBase += contribPop;
        prodBase += (r.prod * r.percent * r.pop) / 10000;
      }
    }
    byNation.set(nationId, {
      regionIds,
      popBase,
      prodBase,
      totalPopBase,
    });
  }

  const nationIds = [...byNation.keys()];
  if (nationIds.length === 0) return [];
  const nations = await db
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
      government: playerNationsTable.government,
      discordUserId: playerNationsTable.discordUserId,
      isNpc: playerNationsTable.isNpc,
    })
    .from(playerNationsTable)
    .where(inArray(playerNationsTable.id, nationIds));

  return nations.map((n) => {
    const agg = byNation.get(n.id)!;
    return {
      id: n.id,
      name: n.name,
      government: n.government,
      discordUserId: n.discordUserId,
      isNpc: n.isNpc,
      scopedRegionIds: agg.regionIds,
      scopedPopBase: Math.round(agg.popBase),
      scopedProdBase: Math.round(agg.prodBase),
      totalPopBase: Math.round(agg.totalPopBase),
    };
  });
}

/**
 * Task #334 — 找出受某事件影響、且有 Discord 帳號的玩家國家（供「事件剛建立」時
 * 即時通知用；NPC／無主國家排除）。global 事件 → 所有掌控地區的玩家；regional
 * 事件 → 掌控任一受影響地區的玩家。
 */
export async function loadAffectedPlayers(
  event: Pick<SuperEvent, "id" | "scope">,
): Promise<{ nationId: string; discordUserId: string }[]> {
  const scope = event.scope;

  // targeted：直接以 super_event_nations 的玩家為對象。
  if (scope === "targeted") {
    const rows = await db
      .select({
        nationId: superEventNationsTable.nationId,
        discordUserId: playerNationsTable.discordUserId,
        isNpc: playerNationsTable.isNpc,
      })
      .from(superEventNationsTable)
      .innerJoin(
        playerNationsTable,
        eq(playerNationsTable.id, superEventNationsTable.nationId),
      )
      .where(eq(superEventNationsTable.eventId, event.id));
    const byNation = new Map<string, string>();
    for (const r of rows) {
      if (r.isNpc || !r.discordUserId) continue;
      byNation.set(r.nationId, r.discordUserId);
    }
    return [...byNation].map(([nationId, discordUserId]) => ({
      nationId,
      discordUserId,
    }));
  }

  let eventRegionIds: Set<number> | null = null;
  if (scope === "regional") {
    const regionRows = await db
      .select({ regionId: superEventRegionsTable.regionId })
      .from(superEventRegionsTable)
      .where(eq(superEventRegionsTable.eventId, event.id));
    eventRegionIds = new Set(regionRows.map((r) => r.regionId));
    if (eventRegionIds.size === 0) return []; // 無地區 → 不通知任何玩家
  }

  const controls = await db
    .select({
      nationId: regionControlsTable.nationId,
      regionId: regionControlsTable.regionId,
      discordUserId: playerNationsTable.discordUserId,
      isNpc: playerNationsTable.isNpc,
    })
    .from(regionControlsTable)
    .innerJoin(
      playerNationsTable,
      eq(playerNationsTable.id, regionControlsTable.nationId),
    );

  const byNation = new Map<string, string>();
  for (const c of controls) {
    if (c.isNpc || !c.discordUserId) continue;
    if (scope === "regional" && !eventRegionIds!.has(c.regionId)) continue;
    byNation.set(c.nationId, c.discordUserId);
  }
  return [...byNation].map(([nationId, discordUserId]) => ({
    nationId,
    discordUserId,
  }));
}
