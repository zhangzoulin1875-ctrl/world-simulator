import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  mapRegionsTable,
  regionControlsTable,
  superEventRegionPressureTable,
} from "@workspace/db";
import { REVOLT_AT } from "../revolutionWave";

export type PressureLevel = "calm" | "tense" | "critical";

export interface RegionPressureView {
  regionId: number;
  regionName: string;
  /** 0~100 */
  pressure: number;
  /** 爆發線(目前 100)。 */
  revoltAt: number;
  level: PressureLevel;
  /** 已脫離(爆發革命)。 */
  revolted: boolean;
}

/** 壓力分級:<40 平穩、40~74 緊張、>=75 危急(只影響顯示色)。 */
export function pressureLevel(p: number): PressureLevel {
  if (p >= 75) return "critical";
  if (p >= 40) return "tense";
  return "calm";
}

/**
 * 某國在某革命浪潮事件中的各地區壓力(只含「該國自己掌控」的受波及地區,
 * 絕不洩漏他國地區的壓力)。依壓力由高到低排序。
 */
export async function loadMyRegionPressures(
  eventId: string,
  nationId: string,
): Promise<RegionPressureView[]> {
  const owned = await db
    .select({ regionId: regionControlsTable.regionId })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.nationId, nationId));
  const ownedIds = owned.map((r) => r.regionId);
  if (ownedIds.length === 0) return [];

  const rows = await db
    .select({
      regionId: superEventRegionPressureTable.regionId,
      pressure: superEventRegionPressureTable.pressure,
      revoltedAt: superEventRegionPressureTable.revoltedAt,
      name: mapRegionsTable.name,
    })
    .from(superEventRegionPressureTable)
    .innerJoin(
      mapRegionsTable,
      eq(mapRegionsTable.id, superEventRegionPressureTable.regionId),
    )
    .where(
      and(
        eq(superEventRegionPressureTable.eventId, eventId),
        inArray(superEventRegionPressureTable.regionId, ownedIds),
      ),
    );

  return rows
    .map((r) => ({
      regionId: r.regionId,
      regionName: r.name,
      pressure: r.pressure,
      revoltAt: REVOLT_AT,
      level: pressureLevel(r.pressure),
      revolted: r.revoltedAt !== null,
    }))
    .sort((a, b) => b.pressure - a.pressure || a.regionId - b.regionId);
}
