import { eq, sql } from "drizzle-orm";
import {
  db,
  mapRegionsTable,
  militaryUnitTemplatesTable,
  playerArmiesTable,
  regionBuildingsTable,
} from "@workspace/db";
import { BUILDING_LABEL, isBuildingType } from "./regionBuildings";

// Task #568 — 生產力維護費（loadProdUpkeepWanted / loadProdUpkeepDetail）
// 已全面移除；此檔僅保留「軍事已佔用」逐兵種明細查詢。

/** Task #541 — 逐兵種的生產力佔用明細（player_armies.production_reserved）。 */
export interface ProductionReservedLine {
  templateId: number;
  name: string;
  /** 該兵種持有數量合計。 */
  quantity: number;
  /** 該兵種佔用的生產力合計（production_reserved）。 */
  reserved: number;
}

/**
 * Task #541 — 該玩家軍隊逐兵種的生產力佔用（production_reserved 依模板
 * 彙總，只列佔用 > 0 者，依佔用量由大到小排序）。與 player_nations.
 * production_spent 的加總一致（spent = Σ reserved 為既有不變量，回合引擎
 * 有自我修復回填）。無主國家回空清單。
 */
export async function loadProductionReservedLines(
  discordUserId: string | null,
): Promise<ProductionReservedLine[]> {
  if (!discordUserId) return [];
  const rows = await db
    .select({
      templateId: militaryUnitTemplatesTable.id,
      name: militaryUnitTemplatesTable.name,
      quantity: sql<string>`COALESCE(SUM(${playerArmiesTable.quantity}), 0)`,
      reserved: sql<string>`COALESCE(SUM(${playerArmiesTable.productionReserved}), 0)`,
    })
    .from(playerArmiesTable)
    .innerJoin(
      militaryUnitTemplatesTable,
      eq(militaryUnitTemplatesTable.id, playerArmiesTable.templateId),
    )
    .where(eq(playerArmiesTable.discordUserId, discordUserId))
    .groupBy(militaryUnitTemplatesTable.id, militaryUnitTemplatesTable.name);
  return rows
    .map((r) => ({
      templateId: r.templateId,
      name: r.name,
      quantity: Number(r.quantity),
      reserved: Number(r.reserved),
    }))
    .filter((r) => r.reserved > 0)
    .sort((a, b) => b.reserved - a.reserved);
}

/** 逐建築的生產力佔用明細（region_buildings.production_reserved）。 */
export interface BuildingReservedLine {
  buildingId: number;
  /** 建築名稱（如「木材廠」）。 */
  name: string;
  regionName: string;
  level: number;
  /** 該建築佔用的生產力（建造＋歷次升級累計）。 */
  reserved: number;
}

/**
 * 該國地區資源建築的生產力佔用明細（只列佔用 > 0 者，依佔用量由大到小）。
 * 與軍隊佔用合計 = player_nations.production_spent（既有不變量，
 * productionSpentHealth 每小時健檢自動校正超額）。
 */
export async function loadBuildingReservedLines(
  nationId: string,
): Promise<BuildingReservedLine[]> {
  const rows = await db
    .select({
      buildingId: regionBuildingsTable.id,
      buildingType: regionBuildingsTable.buildingType,
      regionName: mapRegionsTable.name,
      level: regionBuildingsTable.level,
      reserved: regionBuildingsTable.productionReserved,
    })
    .from(regionBuildingsTable)
    .innerJoin(
      mapRegionsTable,
      eq(mapRegionsTable.id, regionBuildingsTable.regionId),
    )
    .where(eq(regionBuildingsTable.nationId, nationId));
  return rows
    .map((r) => ({
      buildingId: r.buildingId,
      name: isBuildingType(r.buildingType)
        ? BUILDING_LABEL[r.buildingType]
        : r.buildingType,
      regionName: r.regionName,
      level: r.level,
      reserved: Number(r.reserved),
    }))
    .filter((r) => r.reserved > 0)
    .sort((a, b) => b.reserved - a.reserved);
}
