import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import {
  db,
  diplomacyTreatiesTable,
  mapRegionEraStatsTable,
  mapRegionsTable,
  militaryUnitTemplatesTable,
  playerArmiesTable,
  playerNationsTable,
  playerResearchedTreeNodesTable,
  regionControlsTable,
  techTreeNodesTable,
  type MilitaryTechBonus,
  type PlayerNation,
} from "@workspace/db";
import {
  computeCivilianFoodConsumption,
  computeFoodProduction,
  computeSoldierFoodConsumption,
  foodEraIndexForEra,
  type ArmyFoodRow,
} from "./food";
import { readFoodStock } from "./trade/foodStockData";
import { settleFoodStock, foodStockCap, type FoodSettleResult } from "./trade/stock";
import { getGameBalanceSettings } from "./gameBalance";

/**
 * Task #382 — 糧食報告（DB 聚合層）：路由與回合引擎共用同一套計算，
 * 保證顯示與結算口徑一致。全精度；只在路由序列化四捨五入。
 */

export interface RegionFoodDetail {
  regionId: number;
  name: string;
  /** 土壤肥沃度（null = 資料缺失，視為 0 產出）。 */
  fertility: number | null;
  /** 該區控制面積 km²（地區面積 × 控制比例；資料缺失視為 0）。 */
  controlledAreaKm2: number;
  /** 該區控制人口（含累積成長量，下限 0）。 */
  controlledPopulation: number;
  /** 該區農民數（控制人口 × 農民比例；僅供顯示，不參與產出）。 */
  farmers: number;
  /** 該區糧食產出（未含政策/科技修正；全精度）。 */
  output: number;
}

export interface NationFoodReport {
  eraSlug: string;
  eraIndex: number;
  farmerPct: number;
  population: number;
  soldiers: number;
  civilians: number;
  production: { base: number; total: number };
  consumption: { civilian: number; military: number; total: number };
  /** 條約糧食輸送流量（生效自訂條約；inflow=收到、outflow=送出）。 */
  treaty: { inflow: number; outflow: number };
  /** 每回合流量結餘(供給 − 消耗)。語意不變,顯示與內閣沿用。 */
  balance: number;
  /**
   * 糧食庫存(貿易系統):庫存為負才饑荒。純讀取,絕不在此寫入——
   * 唯一的寫入點是回合引擎(用同一個 settleFoodStock,故顯示與結算必然一致)。
   */
  stock: {
    /** 回合開始時的庫存(尚未初始化時為 6 回合消耗的推算值)。 */
    current: number;
    /** 庫存上限 = 12 回合消耗。 */
    cap: number;
    /** 資料庫是否已有庫存列;false = 推算值。 */
    initialized: boolean;
    /** 本回合結算預測(純函式,不寫入)。 */
    settle: FoodSettleResult;
    /** 庫存還能撐幾回合(以目前每回合淨流量估算;流量為正 = null 表示撐得住)。 */
    turnsLeft: number | null;
  };
  /** 本回合結算後是否饑荒(= stock.settle.famine)。 */
  famine: boolean;
  policies: { mobilization: boolean; rationing: boolean };
  regions: RegionFoodDetail[];
}

/** sumTreatyFoodFlows 所需的條約欄位子集。 */
export interface TreatyFoodRow {
  proposerNationId: string;
  targetNationId: string;
  perTurnFood: number;
  /** Task #527 — 反向糧食輸送（由 perTurn 付款方的對方支付）。 */
  requestPerTurnFood: number;
  proposerIsPayer: boolean;
}

/**
 * 純函式：由生效自訂條約列計算某國的糧食輸送流量。
 * 正向 perTurnFood：付款方（proposerIsPayer 決定方向）outflow +N、受益方
 * inflow +N；反向 requestPerTurnFood（Task #527）方向恰好相反，兩方向可同時
 * 存在（雙向互相輸送）。負值/非整數夾成 0（與 planCustomTreatyTransfers 同口徑）。
 * 糧食是流量：付款方「不做餘額檢查」，即使自己不夠吃也照樣送出
 * （可能因此陷入飢荒）——這是條約糧食輸送的刻意語義。
 */
export function sumTreatyFoodFlows(
  nationId: string,
  rows: readonly TreatyFoodRow[],
): { inflow: number; outflow: number } {
  let inflow = 0;
  let outflow = 0;
  for (const r of rows) {
    const payerId = r.proposerIsPayer ? r.proposerNationId : r.targetNationId;
    const beneficiaryId = r.proposerIsPayer
      ? r.targetNationId
      : r.proposerNationId;
    const forward = Math.max(0, Math.trunc(r.perTurnFood));
    if (forward > 0) {
      if (payerId === nationId) outflow += forward;
      else if (beneficiaryId === nationId) inflow += forward;
    }
    const reverse = Math.max(0, Math.trunc(r.requestPerTurnFood));
    if (reverse > 0) {
      if (beneficiaryId === nationId) outflow += reverse;
      else if (payerId === nationId) inflow += reverse;
    }
  }
  return { inflow, outflow };
}

/** 該國參與、生效中且含糧食輸送的自訂條約（口徑同 runCustomTreatySettlement）。 */
async function loadTreatyFoodRows(
  nationId: string,
  now: Date,
): Promise<TreatyFoodRow[]> {
  return db
    .select({
      proposerNationId: diplomacyTreatiesTable.proposerNationId,
      targetNationId: diplomacyTreatiesTable.targetNationId,
      perTurnFood: diplomacyTreatiesTable.perTurnFood,
      requestPerTurnFood: diplomacyTreatiesTable.requestPerTurnFood,
      proposerIsPayer: diplomacyTreatiesTable.proposerIsPayer,
    })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        eq(diplomacyTreatiesTable.type, "custom"),
        eq(diplomacyTreatiesTable.status, "active"),
        or(
          gt(diplomacyTreatiesTable.perTurnFood, 0),
          gt(diplomacyTreatiesTable.requestPerTurnFood, 0),
        ),
        or(
          isNull(diplomacyTreatiesTable.expiresAt),
          gt(diplomacyTreatiesTable.expiresAt, now),
        ),
        or(
          eq(diplomacyTreatiesTable.proposerNationId, nationId),
          eq(diplomacyTreatiesTable.targetNationId, nationId),
        ),
      ),
    );
}

/** 該玩家軍隊列（數量 × 兵種人口消耗 × 類別）。無主/NPC 國家回空陣列。 */
async function loadArmyFoodRows(
  discordUserId: string | null,
): Promise<ArmyFoodRow[]> {
  if (!discordUserId) return [];
  const rows = await db
    .select({
      quantity: playerArmiesTable.quantity,
      popCostPerUnit: militaryUnitTemplatesTable.popCostPerUnit,
      category: militaryUnitTemplatesTable.category,
    })
    .from(playerArmiesTable)
    .innerJoin(
      militaryUnitTemplatesTable,
      eq(militaryUnitTemplatesTable.id, playerArmiesTable.templateId),
    )
    .where(eq(playerArmiesTable.discordUserId, discordUserId));
  return rows;
}

/** 已研發軍事科技的 bonuses（糧耗 target 用）。 */
async function loadResearchedTechBonuses(
  discordUserId: string | null,
): Promise<{ bonuses: MilitaryTechBonus[] }[]> {
  if (!discordUserId) return [];
  const rows = await db
    .select({ effects: techTreeNodesTable.effects })
    .from(playerResearchedTreeNodesTable)
    .innerJoin(
      techTreeNodesTable,
      eq(techTreeNodesTable.id, playerResearchedTreeNodesTable.nodeId),
    )
    .innerJoin(
      playerNationsTable,
      eq(playerNationsTable.id, playerResearchedTreeNodesTable.nationId),
    )
    .where(
      and(
        eq(playerNationsTable.discordUserId, discordUserId),
        eq(techTreeNodesTable.domain, "military"),
      ),
    );
  return rows.map((r) => ({
    bonuses: (r.effects ?? []) as MilitaryTechBonus[],
  }));
}

/**
 * 計算國家糧食報告。statsEra 依「數據時代」慣例（null → current_era 由呼叫端解析）。
 */
export async function computeNationFoodReport(
  nation: Pick<
    PlayerNation,
    | "id"
    | "discordUserId"
    | "farmerPopulationPct"
    | "foodPolicyMobilization"
    | "foodPolicyRationing"
  >,
  statsEra: string,
  /**
   * Task #626 — 內政政策糧食增長率修飾（%；0=無加成）。
   * 由呼叫端自 computeAdjustedNationStats 的 foodGrowthRatePct 取得後傳入；
   * 未傳入時視為 0（顯示路由維持原有行為）。
   */
  foodGrowthRatePct = 0,
): Promise<NationFoodReport> {
  const [regionRows, armyRows, techs, treatyRows, balance] = await Promise.all([
    db
      .select({
        regionId: mapRegionsTable.id,
        name: mapRegionsTable.name,
        fertility: mapRegionsTable.soilFertility,
        areaKm2: mapRegionsTable.areaKm2,
        percent: regionControlsTable.percent,
        accrued: regionControlsTable.populationBonus,
        population: mapRegionEraStatsTable.population,
      })
      .from(regionControlsTable)
      .innerJoin(
        mapRegionsTable,
        eq(mapRegionsTable.id, regionControlsTable.regionId),
      )
      .innerJoin(
        mapRegionEraStatsTable,
        and(
          eq(mapRegionEraStatsTable.regionId, regionControlsTable.regionId),
          eq(mapRegionEraStatsTable.era, statsEra),
        ),
      )
      .where(eq(regionControlsTable.nationId, nation.id))
      .orderBy(asc(mapRegionsTable.id)),
    loadArmyFoodRows(nation.discordUserId),
    loadResearchedTechBonuses(nation.discordUserId),
    loadTreatyFoodRows(nation.id, new Date()),
    getGameBalanceSettings(),
  ]);
  // 管理員可在平衡頁面覆寫的糧食時代指數（缺項/壞資料回落 food.ts 預設）。
  const eraIndexOverrides = balance.food.eraIndex;

  const farmerPct = Math.min(100, Math.max(0, nation.farmerPopulationPct));
  const regionInputs = regionRows.map((r) => ({
    fertility: r.fertility,
    // 面積基準產出：控制面積 = 地區面積 km² × 控制比例（全精度）。
    controlledAreaKm2: Math.max(0, ((r.areaKm2 ?? 0) * r.percent) / 100),
    // 與 nationStats.loadRegionContributions 同口徑：round(percent × 時代人口
    // / 100) + 累積成長量，下限 0。
    controlledPopulation: Math.max(
      0,
      Math.round((Number(r.population) * r.percent) / 100) + r.accrued,
    ),
  }));
  const population = regionInputs.reduce(
    (s, r) => s + r.controlledPopulation,
    0,
  );

  const production = computeFoodProduction({
    regions: regionInputs,
    farmerPct,
    eraSlug: statsEra,
    mobilizationActive: nation.foodPolicyMobilization,
    eraIndexOverrides,
    foodGrowthRatePct,
  });
  const military = computeSoldierFoodConsumption(armyRows, techs);
  const civilian = computeCivilianFoodConsumption({
    population,
    soldiers: military.soldiers,
    rationingActive: nation.foodPolicyRationing,
  });
  const consumptionTotal = civilian.total + military.total;
  // Task #396 — 條約糧食輸送（流量，非庫存）：供給 = 產出 + 輸入 − 輸出。
  // 輸出方不做餘額檢查——即使自己不夠吃也照樣送出（可能因此陷入飢荒）。
  const treaty = sumTreatyFoodFlows(nation.id, treatyRows);
  const supply = production.total + treaty.inflow - treaty.outflow;
  // 貿易系統 — 糧食庫存:純讀取,懶初始化(查無列 = 6 回合消耗期初庫存)。
  const stockRead = await readFoodStock(nation.id, consumptionTotal);
  const settle = settleFoodStock({
    stock: stockRead.stock,
    supply,
    consumption: consumptionTotal,
  });
  const netFlow = supply - consumptionTotal;
  const turnsLeft =
    netFlow >= 0 ? null : Math.floor(stockRead.stock / Math.max(1, -netFlow));

  return {
    eraSlug: statsEra,
    eraIndex: foodEraIndexForEra(statsEra, eraIndexOverrides),
    farmerPct,
    population,
    soldiers: military.soldiers,
    civilians: civilian.civilians,
    production: { base: production.base, total: production.total },
    consumption: {
      civilian: civilian.total,
      military: military.total,
      total: consumptionTotal,
    },
    treaty,
    balance: supply - consumptionTotal,
    stock: {
      current: stockRead.stock,
      cap: foodStockCap(consumptionTotal),
      initialized: stockRead.initialized,
      settle,
      turnsLeft,
    },
    famine: settle.famine,
    policies: {
      mobilization: nation.foodPolicyMobilization,
      rationing: nation.foodPolicyRationing,
    },
    regions: regionRows.map((r, i) => {
      const controlled = regionInputs[i]!.controlledPopulation;
      return {
        regionId: r.regionId,
        name: r.name,
        fertility: r.fertility,
        controlledAreaKm2: regionInputs[i]!.controlledAreaKm2,
        controlledPopulation: controlled,
        farmers: (controlled * farmerPct) / 100,
        output: production.regionOutputs[i]!,
      };
    }),
  };
}

/** 供回合引擎重讀最新政策欄位（政策可能在本回合前被切換）。 */
export async function loadNationFoodPolicyFields(nationId: string) {
  const [row] = await db
    .select({
      id: playerNationsTable.id,
      discordUserId: playerNationsTable.discordUserId,
      farmerPopulationPct: playerNationsTable.farmerPopulationPct,
      foodPolicyMobilization: playerNationsTable.foodPolicyMobilization,
      foodPolicyRationing: playerNationsTable.foodPolicyRationing,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId))
    .limit(1);
  return row ?? null;
}
