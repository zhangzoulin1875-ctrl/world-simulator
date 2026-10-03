import { eq, sql } from "drizzle-orm";
import {
  db,
  mapRegionEraStatsTable,
  playerNationsTable,
  regionControlsTable,
  worldGameStateTable,
  type PlayerNation,
} from "@workspace/db";
import { getEraIndex, isEraSlug } from "./mapRegionEras";
import { computeAdjustedNationStats, getStatsEraSlug } from "./nationStats";

/**
 * Task #385 — 科技研發成本依國力浮動。
 *
 * 倍率 = 該國人口 ÷ 全球平均人口（連續倍率，不分段、不設下限）；
 * 全球平均計入所有國家（真人、NPC、無主）。人口採現行 per-request
 * 口徑（basePopulation + accruedGrowth，與玩家看到的一致；不套穩定度
 * 乘數或政策加成）。
 * 最終成本 = max(1, round(基準成本 × 倍率))；倍率中途不取整。
 * 全球平均為 0 或查無國家時，倍率一律視為 1（不得除以零）。
 */

/** 純函式：研發成本倍率（平均 ≤ 0 或非有限值 → 1；人口負值視為 0）。 */
export function researchCostMultiplier(
  population: number,
  globalAvgPopulation: number,
): number {
  if (!Number.isFinite(globalAvgPopulation) || globalAvgPopulation <= 0) {
    return 1;
  }
  const pop = Number.isFinite(population) ? Math.max(0, population) : 0;
  return pop / globalAvgPopulation;
}

/** 純函式：調整後成本 = max(1, round(基準成本 × 倍率))。 */
export function adjustedResearchCost(
  baseCost: number,
  multiplier: number,
): number {
  return Math.max(1, Math.round(baseCost * multiplier));
}

/**
 * 計算全球平均人口（所有國家；無國家 → 0）。
 * 人口 = Σ(percent/100 × era_population) + Σ population_bonus（per-region 累積成長）。
 * 不套穩定度乘數、政策加成或科技 buff，與 computeNationStats 的 population 欄位一致。
 * 效能：兩次查詢（國家清單、地區加權 GROUP BY）即完成。
 */
export async function computeGlobalAveragePopulation(
  statsEra: string,
): Promise<number> {
  const [nations, rawRows] = await Promise.all([
    db.select({ id: playerNationsTable.id }).from(playerNationsTable),
    db
      .select({
        nationId: regionControlsTable.nationId,
        population: sql<string>`COALESCE(
          SUM(${regionControlsTable.percent}::bigint * ${mapRegionEraStatsTable.population}::bigint / 100.0)
          + SUM(${regionControlsTable.populationBonus}),
          0
        )`,
      })
      .from(regionControlsTable)
      .innerJoin(
        mapRegionEraStatsTable,
        sql`${mapRegionEraStatsTable.regionId} = ${regionControlsTable.regionId} AND ${mapRegionEraStatsTable.era} = ${statsEra}`,
      )
      .groupBy(regionControlsTable.nationId),
  ]);
  if (nations.length === 0) return 0;

  const popByNation = new Map<string, number>();
  for (const r of rawRows) {
    popByNation.set(r.nationId, Math.max(0, Math.round(Number(r.population ?? 0))));
  }

  let total = 0;
  for (const nation of nations) {
    total += popByNation.get(nation.id) ?? 0;
  }
  return total / nations.length;
}

const GLOBAL_AVG_TTL_MS = 30_000;
let avgCache: { at: number; era: string; avg: number } | null = null;

/** 全球平均人口（短 TTL 快取，避免每次研發/顯示都全表重算）。 */
export async function getGlobalAveragePopulation(
  statsEra: string,
): Promise<number> {
  const now = Date.now();
  if (avgCache && avgCache.era === statsEra && now - avgCache.at < GLOBAL_AVG_TTL_MS) {
    return avgCache.avg;
  }
  const avg = await computeGlobalAveragePopulation(statsEra);
  avgCache = { at: now, era: statsEra, avg };
  return avg;
}

/** 測試用：清除全球平均快取。 */
export function invalidateGlobalAveragePopulationCache(): void {
  avgCache = null;
}

/** 測試用：檢視全球平均快取內容（斷言失效行為，不受共用 DB 併發影響）。 */
export function peekGlobalAveragePopulationCache(): {
  at: number;
  era: string;
  avg: number;
} | null {
  return avgCache;
}

/**
 * 取某國目前的研發成本倍率（伺服器端扣點前必須以此重算，不信任前端顯示值）。
 * statsEra 可省略（內部載入）；已算好調整後人口時請改用
 * researchCostMultiplier(population, avg) 避免重複查詢。
 */
export async function getNationResearchCostMultiplier(
  nation: PlayerNation,
  statsEra?: string,
): Promise<number> {
  const era = statsEra ?? (await getStatsEraSlug());
  const [stats, avg] = await Promise.all([
    computeAdjustedNationStats(nation, era),
    getGlobalAveragePopulation(era),
  ]);
  return researchCostMultiplier(stats.population, avg);
}

// ── 領先時代研發加價（管理員可調：world_game_state.ahead_era_cost_multiplier）──

/**
 * 純函式：領先時代研發成本加成。某科技領域時代（domainEraSlug）比世界目前
 * 時代（worldEraSlug）更新 → 回傳倍率（下限 1）；否則回 1。未知 slug 一律
 * 回 1（不加價）。不隨領先幅度累乘：領先 1 個或多個時代皆為同一倍率。
 */
export function aheadEraCostFactor(
  domainEraSlug: string,
  worldEraSlug: string,
  multiplier: number,
): number {
  if (!isEraSlug(domainEraSlug) || !isEraSlug(worldEraSlug)) return 1;
  if (getEraIndex(domainEraSlug) <= getEraIndex(worldEraSlug)) return 1;
  return Number.isFinite(multiplier) ? Math.max(1, multiplier) : 1;
}

/**
 * 讀世界目前時代與領先時代研發成本倍率（world_game_state 單列 id=1）。
 * 查無列 → 倍率取預設 5、時代為空字串（aheadEraCostFactor 會視為不加價）。
 * 不做快取：管理員調整需立即生效，且此查詢極輕。
 */
export async function getAheadEraCostSettings(): Promise<{
  worldEra: string;
  multiplier: number;
}> {
  const [row] = await db
    .select({
      worldEra: worldGameStateTable.currentEra,
      multiplier: worldGameStateTable.aheadEraCostMultiplier,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  return { worldEra: row?.worldEra ?? "", multiplier: row?.multiplier ?? 5 };
}

/**
 * 國力倍率 ×「領先時代加成」（domainEraSlug = 該科技領域目前時代）。
 * 三科技樹的顯示與扣點都必須用此值，確保玩家看到的價格＝實際扣的價格。
 */
export async function getNationResearchCostMultiplierForDomain(
  nation: PlayerNation,
  domainEraSlug: string,
): Promise<number> {
  const [base, ahead] = await Promise.all([
    getNationResearchCostMultiplier(nation),
    getAheadEraCostSettings(),
  ]);
  return base * aheadEraCostFactor(domainEraSlug, ahead.worldEra, ahead.multiplier);
}
