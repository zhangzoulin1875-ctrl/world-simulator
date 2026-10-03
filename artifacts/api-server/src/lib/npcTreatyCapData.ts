import { and, eq, sql } from "drizzle-orm";
import {
  db,
  regionBuildingsTable,
  worldGameStateTable,
  type PlayerNation,
} from "@workspace/db";
import {
  computeNpcTreatyCaps,
  DEFAULT_NPC_TREATY_CAP_SETTINGS,
  type NpcTreatyCaps,
  type NpcTreatyCapSettings,
  type NpcTreatyCapSnapshot,
} from "./npcTreatyCaps";
import { computeAdjustedNationStats, getStatsEraSlug } from "./nationStats";
import { computeTaxIncome, effectiveTaxEfficiencyPct } from "./economy";
import { computeNationFoodReport } from "./foodData";
import { buildingOutput } from "./regionBuildings";

/**
 * Task #570 — NPC 締約資源上限的 DB 載入端（純函式在 npcTreatyCaps.ts）。
 */

/** 讀取世界設定（world_game_state 單列）；讀不到時退回程式內建預設。 */
export async function loadNpcTreatyCapSettings(): Promise<NpcTreatyCapSettings> {
  const [row] = await db
    .select({
      stockCapPct: worldGameStateTable.npcTreatyStockCapPct,
      maxRegions: worldGameStateTable.npcTreatyMaxRegions,
      regionMaxPct: worldGameStateTable.npcTreatyRegionMaxPct,
      perTurnCapPct: worldGameStateTable.npcTreatyPerTurnCapPct,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  return row ?? DEFAULT_NPC_TREATY_CAP_SETTINGS;
}

/** 建立 NPC 國家的資源快照（庫存＋每回合產出）。 */
export async function loadNpcTreatyCapSnapshot(
  nation: PlayerNation,
): Promise<NpcTreatyCapSnapshot> {
  const statsEra = await getStatsEraSlug();
  const [stats, food, buildingRows] = await Promise.all([
    computeAdjustedNationStats(nation, statsEra),
    computeNationFoodReport(nation, statsEra),
    db
      .select({
        buildingType: regionBuildingsTable.buildingType,
        totalLevel: sql<string>`COALESCE(SUM(${regionBuildingsTable.level}), 0)`,
      })
      .from(regionBuildingsTable)
      .where(eq(regionBuildingsTable.nationId, nation.id))
      .groupBy(regionBuildingsTable.buildingType),
  ]);
  const levelByType = new Map(
    buildingRows.map((r) => [r.buildingType, Number(r.totalLevel)]),
  );
  const taxIncomePerTurn = computeTaxIncome({
    population: stats.population,
    taxRatePct: nation.taxRatePct,
    taxEfficiencyPct: effectiveTaxEfficiencyPct(
      statsEra,
      nation.taxEfficiencyBonus,
    ),
  });
  return {
    money: nation.money,
    techPoints: nation.techPoints,
    wood: nation.wood,
    ore: nation.ore,
    taxIncomePerTurn,
    techPerTurn: Math.max(0, Math.floor(stats.techPerTurn)),
    productionPerTurn: Math.max(0, Math.floor(stats.production)),
    foodPerTurn: Math.max(0, Math.floor(food.production.total)),
    woodPerTurn: buildingOutput(levelByType.get("lumber_mill") ?? 0),
    orePerTurn: buildingOutput(levelByType.get("mine") ?? 0),
  };
}

/** 便利入口：設定＋快照 → 各資源上限。 */
export async function loadNpcTreatyCaps(
  nation: PlayerNation,
): Promise<NpcTreatyCaps> {
  const [settings, snapshot] = await Promise.all([
    loadNpcTreatyCapSettings(),
    loadNpcTreatyCapSnapshot(nation),
  ]);
  return computeNpcTreatyCaps(snapshot, settings);
}
