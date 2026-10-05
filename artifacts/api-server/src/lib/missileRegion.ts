import { and, eq } from "drizzle-orm";
import { db, mapRegionEraStatsTable, regionControlsTable } from "@workspace/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 某國在某地區的「實際人口」= max(0, round(控制率 × 時代人口 / 100) + 累積量)。
 * 與 applyRegionPopulationDelta 的權重公式一致(同一個口徑才不會扣得對不上)。
 */
export async function mapRegionPopulation(
  tx: Tx,
  nationId: string,
  regionId: number,
  statsEra: string,
): Promise<number> {
  const [row] = await tx
    .select({
      percent: regionControlsTable.percent,
      accrued: regionControlsTable.populationBonus,
      eraPopulation: mapRegionEraStatsTable.population,
    })
    .from(regionControlsTable)
    .innerJoin(
      mapRegionEraStatsTable,
      and(eq(mapRegionEraStatsTable.regionId, regionControlsTable.regionId), eq(mapRegionEraStatsTable.era, statsEra)),
    )
    .where(and(eq(regionControlsTable.nationId, nationId), eq(regionControlsTable.regionId, regionId)))
    .limit(1);
  if (!row) return 0;
  return Math.max(0, Math.round((row.percent * Number(row.eraPopulation)) / 100) + row.accrued);
}
