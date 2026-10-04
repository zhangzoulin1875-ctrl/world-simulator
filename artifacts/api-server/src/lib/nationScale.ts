/**
 * 國家動態開銷尺度的 DB 載入層。純計算見 nationCostScale.ts。
 *
 * 一次性價格（造價／招募／購買）與持續性維護費各自取得尺度：
 *   - 價格：effectivePriceScale（寬夾限，即時國力）
 *   - 維護費：effectiveUpkeepScale（窄夾限，避免人口起伏造成維護費劇烈震盪）
 * 兩者都以「標準稅率」為基準，與玩家實際稅率無關。
 */
import { db, regionControlsTable, mapRegionEraStatsTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { eraCostScale } from "./eraCostScale";
import {
  effectivePriceScale,
  effectiveUpkeepScale,
} from "./nationCostScale";

export interface NationScales {
  /** 一次性價格尺度（造價、招募、購買、開局資源）。 */
  price: number;
  /** 持續性維護費尺度。 */
  upkeep: number;
  /** 僅時代係數（舊行為；供不屬於任何國家的場景使用）。 */
  era: number;
  population: number;
}

/** 由人口與時代組出尺度（純函式；批次路徑共用）。 */
export function scalesFromPopulation(
  population: number,
  statsEra: string,
): NationScales {
  const era = eraCostScale(statsEra);
  return {
    price: effectivePriceScale(era, population, statsEra),
    upkeep: effectiveUpkeepScale(era, population, statsEra),
    era,
    population,
  };
}

/** 單國：查一次該國人口（含累積成長）。 */
export async function loadNationScales(
  nationId: string,
  statsEra: string,
): Promise<NationScales> {
  const [row] = await db
    .select({
      base: sql<string>`COALESCE(SUM(${regionControlsTable.percent}::bigint * ${mapRegionEraStatsTable.population}::bigint / 100.0), 0)`,
      accrued: sql<string>`COALESCE(SUM(${regionControlsTable.populationBonus}), 0)`,
    })
    .from(regionControlsTable)
    .innerJoin(
      mapRegionEraStatsTable,
      and(
        eq(mapRegionEraStatsTable.regionId, regionControlsTable.regionId),
        eq(mapRegionEraStatsTable.era, statsEra),
      ),
    )
    .where(eq(regionControlsTable.nationId, nationId));
  const population = Math.max(
    0,
    Math.round(Number(row?.base ?? 0)) + Math.round(Number(row?.accrued ?? 0)),
  );
  return scalesFromPopulation(population, statsEra);
}

/**
 * 批次：一次 SQL 取得所有國家的人口並換算尺度（回合引擎用，避免 N+1）。
 * 無任何掌控地區的國家不在結果內，呼叫端回落到 scalesFromPopulation(0, era)。
 */
export async function loadAllNationScales(
  statsEra: string,
): Promise<Map<string, NationScales>> {
  const rows = await db
    .select({
      nationId: regionControlsTable.nationId,
      base: sql<string>`COALESCE(SUM(${regionControlsTable.percent}::bigint * ${mapRegionEraStatsTable.population}::bigint / 100.0), 0)`,
      accrued: sql<string>`COALESCE(SUM(${regionControlsTable.populationBonus}), 0)`,
    })
    .from(regionControlsTable)
    .innerJoin(
      mapRegionEraStatsTable,
      and(
        eq(mapRegionEraStatsTable.regionId, regionControlsTable.regionId),
        eq(mapRegionEraStatsTable.era, statsEra),
      ),
    )
    .groupBy(regionControlsTable.nationId);
  const out = new Map<string, NationScales>();
  for (const r of rows) {
    const population = Math.max(
      0,
      Math.round(Number(r.base)) + Math.round(Number(r.accrued)),
    );
    out.set(r.nationId, scalesFromPopulation(population, statsEra));
  }
  return out;
}

