import { and, eq, sql } from "drizzle-orm";
import {
  db,
  regionControlsTable,
  mapRegionEraStatsTable,
} from "@workspace/db";
import { allocateProportionally } from "./war";

/**
 * Task #322 — 人口成長改為「按地區累積」（region_controls.population_bonus）。
 *
 * 把一筆帶號的人口變化量（成長為正、損失為負）依「各地區目前實際人口」的權重
 * 分配成每地區的整數增減，使得：
 *  - 分配總和恰等於 delta（守恆；除非負向損失超過總人口）。
 *  - 每地區扣減後不會低於 0（負向時每地區最多扣掉自身的實際人口）。
 *  - 正向：直接以 largest-remainder 依權重分配（重用 allocateProportionally）。
 *  - 總實際人口 ≤ 0：不論方向皆回傳全 0（避免對空地區灌入幽靈人口）。
 *
 * weights 應為各地區「目前實際人口」= max(0, 時代基準貢獻 + 已累積量) 的整數值。
 */
export function distributePopulationDelta(
  weights: readonly number[],
  delta: number,
): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (delta === 0 || total <= 0) return new Array<number>(n).fill(0);

  if (delta > 0) return allocateProportionally(weights, delta);

  // delta < 0：分配「要移除的量」，每地區最多移除自身實際人口。
  const need = -delta;
  if (need >= total) return weights.map((w) => -Math.max(0, w));
  const removed = allocateProportionally(weights, need);
  return removed.map((r, i) => -Math.min(r, Math.max(0, weights[i] ?? 0)));
}

/** db 連線或交易皆可（select/update）。 */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | DbTransaction;

/**
 * 把一筆帶號人口變化量套用到某國掌控地區的 population_bonus 上（依各地區目前
 * 實際人口權重分配、下限 0）。可限定地區集合（如戰爭僅作用於戰場地區）。
 * 回傳實際套用的總量（守恆時 = clamp 後的 delta）。
 */
export async function applyRegionPopulationDelta(
  exec: Exec,
  nationId: string,
  era: string,
  delta: number,
  regionIds?: readonly number[],
): Promise<number> {
  if (delta === 0) return 0;
  if (regionIds && regionIds.length === 0) return 0;

  const rows = await exec
    .select({
      id: regionControlsTable.id,
      regionId: regionControlsTable.regionId,
      percent: regionControlsTable.percent,
      accrued: regionControlsTable.populationBonus,
      eraPopulation: mapRegionEraStatsTable.population,
    })
    .from(regionControlsTable)
    .innerJoin(
      mapRegionEraStatsTable,
      and(
        eq(mapRegionEraStatsTable.regionId, regionControlsTable.regionId),
        eq(mapRegionEraStatsTable.era, era),
      ),
    )
    .where(eq(regionControlsTable.nationId, nationId));

  const scoped =
    regionIds === undefined
      ? rows
      : rows.filter((r) => regionIds.includes(r.regionId));
  if (scoped.length === 0) return 0;

  // 權重 = 各地區目前實際人口 = max(0, round(percent × 時代人口 / 100) + 累積量)。
  const weights = scoped.map((r) =>
    Math.max(
      0,
      Math.round((r.percent * Number(r.eraPopulation)) / 100) + r.accrued,
    ),
  );
  const deltas = distributePopulationDelta(weights, delta);

  let applied = 0;
  for (let i = 0; i < scoped.length; i++) {
    const d = deltas[i] ?? 0;
    if (d === 0) continue;
    const row = scoped[i]!;
    await exec
      .update(regionControlsTable)
      .set({
        populationBonus: sql`${regionControlsTable.populationBonus} + ${d}`,
      })
      .where(eq(regionControlsTable.id, row.id));
    applied += d;
  }
  return applied;
}
