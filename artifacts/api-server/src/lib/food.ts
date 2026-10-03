import type { MilitaryTechBonus } from "@workspace/db";

/**
 * Task #382 — 糧食系統純函式（DB-free、可單元測試）。
 *
 * 糧食為「非累積性」資源：每回合計算產出與消耗，不儲存結餘。
 * - 產出 = Σ各控制地區（控制面積 × 肥沃度 × 時代指數 × 農民比例 × 校準常數）
 *   × 科技/政策修正（面積基準，2026-07 起；不再以人口為基準）。
 *   控制面積 = 地區面積 km² × 控制比例；農民比例 = farmer_population_pct。
 * - 消耗 = 平民每人口 1 ＋ 軍人每人 5（軍人數 = Σ 軍隊數量 × 兵種人口消耗）。
 * - 產出 < 消耗 → 飢荒：每日回合 −20% 人口（走 region_controls.population_bonus 路徑）。
 * - 人口每下跌 1% → 四階級滿意度與支持度各 −2（適用任何人口下跌來源）。
 *
 * 精度慣例：中間計算保留全精度，只在路由序列化四捨五入（≤1 位小數）。
 */

/**
 * 各時代的糧食產出「時代指數」**預設值**。key 必須涵蓋 mapRegionEras.ts 的
 * 所有 ERAS slug（單元測試驗證）。啟蒙運動 1.5 為科學革命 1 與工業革命 2 的
 * 中間值。管理員可在遊戲平衡頁面覆寫（gameBalance settings `food.eraIndex`），
 * 覆寫值由呼叫端以 overrides 參數傳入——本模組維持 DB-free 純函式。
 */
export const FOOD_ERA_INDEX: Record<string, number> = {
  classical: 0.1,
  roman: 0.2,
  early_medieval: 0.3,
  high_medieval: 0.4,
  renaissance: 0.6,
  discovery: 0.8,
  scientific: 1,
  enlightenment: 1.5,
  industrial: 2,
  ww1: 3,
  ww2: 4,
  cold_war: 6,
  modern: 10,
  future: 20,
};

/**
 * 依時代取得糧食時代指數；未知 slug 回落古典。
 * overrides = 管理員在平衡頁面設定的覆寫表（slug → 指數）；只接受
 * 非負有限數，缺項或非法值回落預設 FOOD_ERA_INDEX。
 */
export function foodEraIndexForEra(
  eraSlug: string,
  overrides?: Readonly<Record<string, number>>,
): number {
  const slug = eraSlug in FOOD_ERA_INDEX ? eraSlug : "classical";
  const override = overrides?.[slug];
  if (typeof override === "number" && Number.isFinite(override) && override >= 0) {
    return override;
  }
  return FOOD_ERA_INDEX[slug]!;
}

/**
 * 全域校準常數（面積基準）：讓古典時代開局（農民比例 100%、時代指數 0.1）
 * 「全球」產出大致等於全球平民消耗（每人口 1 糧食）。以全部 373 區實測：
 * Σ(面積×肥沃度) ≈ 4,799,227,317、古典全球人口 ≈ 216,074,250 →
 * C ≈ 216,074,250 ÷ (4,799,227,317 × 0.1) ≈ 0.45。
 * 注意：面積基準下各國開局不再保證各自收支平衡——地廣人稀盈餘、
 * 人口稠密吃緊，這是刻意的設計取捨。具名常數方便日後調整平衡。
 */
export const FOOD_CALIBRATION = 0.45;

/** 平民每人口每回合糧食消耗。 */
export const CIVILIAN_FOOD_PER_CAPITA = 1;
/** 軍人每人每回合基礎糧食消耗。 */
export const SOLDIER_FOOD_BASE = 5;
/** 軍人每人糧食消耗硬下限（任何科技減免後仍至少 1）。 */
export const SOLDIER_FOOD_MIN = 1;

/** 「增產動員」政策：糧食產出 +10%。 */
export const FOOD_POLICY_OUTPUT_BONUS_PCT = 10;
/** 「節約配給」政策：平民糧食消耗 −10%。 */
export const FOOD_POLICY_RATION_SAVING_PCT = 10;
/** 政策啟用期間每回合的四階級滿意度成本（每項政策各扣此值）。 */
export const FOOD_POLICY_SATISFACTION_COST_PER_TURN = 2;

/** 飢荒時每日回合人口損失百分比（連續饑荒未觸發緩衝時的全額扣幅）。 */
export const FAMINE_POPULATION_LOSS_PCT = 20;
/**
 * Task #443 — 連續饑荒緩衝：連續饑荒超過此回合數後，扣幅開始每回合減半
 * （20 → 10 → 5 → …），下限 FAMINE_MIN_LOSS_PCT。避免 0.8^n 把離線玩家
 * 的人口悄悄清零，同時保留前幾回合的全額壓力。
 */
export const FAMINE_FULL_LOSS_TURNS = 2;
/** 連續饑荒緩衝後的扣幅下限（%）。 */
export const FAMINE_MIN_LOSS_PCT = 2;
/**
 * 饑荒生還者保底：饑荒本身永遠不會把人口扣到低於此值（人口原本就低於
 * 保底時，饑荒不再造成損失）。其他來源（戰爭等）不受此保底限制。
 */
export const FAMINE_SURVIVOR_FLOOR = 1000;
/** 人口每下跌 1% 對四階級滿意度與支持度的懲罰（各 −2）。 */
export const POP_DROP_PENALTY_PER_PCT = 2;

/** 單一地區的糧食產出因子輸入。 */
export interface RegionFoodInput {
  /** 土壤肥沃度（map_regions.soil_fertility，0–120；null 視為 0）。 */
  fertility: number | null;
  /**
   * 該區「控制面積」＝ 地區面積 km²（map_regions.area_km2）× 控制比例
   * （percent / 100）；null/負值視為 0。全精度，不取整。
   */
  controlledAreaKm2: number | null;
  /**
   * 該區「控制人口」＝ round(percent × 時代人口 / 100) + 累積量，下限 0。
   * 面積基準後不再參與產出公式，僅供人口/消耗口徑與顯示使用。
   */
  controlledPopulation: number;
}

/**
 * 單一地區糧食產出（未含政策/科技修正；全精度）：
 * 控制面積 × 肥沃度 × 時代指數 × 農民比例 × 校準常數。
 */
export function regionFoodBase(
  region: RegionFoodInput,
  farmerPct: number,
  eraIndex: number,
): number {
  const fertility = Math.max(0, region.fertility ?? 0);
  const area = Math.max(0, region.controlledAreaKm2 ?? 0);
  const farmerShare = Math.min(100, Math.max(0, farmerPct)) / 100;
  return area * fertility * eraIndex * farmerShare * FOOD_CALIBRATION;
}

/**
 * 全國糧食產出（全精度）＝ Σ 各區基礎產出 ×（1 + 科技加成%）×（1 + 增產動員%）。
 * techBonusPct 為糧食產出科技加成（目前保留 0；未來科技可接入），下限 −100。
 */
export function computeFoodProduction(params: {
  regions: readonly RegionFoodInput[];
  farmerPct: number;
  eraSlug: string;
  techBonusPct?: number;
  mobilizationActive: boolean;
  /** 管理員時代指數覆寫表（gameBalance settings food.eraIndex）。 */
  eraIndexOverrides?: Readonly<Record<string, number>>;
  /**
   * Task #626 — 內政政策糧食增長率修飾（%；0=無加成）：乘進最終產出，
   * 使政策可以以百分比提升糧食產出。由呼叫端自 computeAdjustedNationStats
   * 的 foodGrowthRatePct 欄位取得；預設 0（行為不變）。
   */
  foodGrowthRatePct?: number;
}): {
  base: number;
  total: number;
  eraIndex: number;
  regionOutputs: number[];
} {
  const eraIndex = foodEraIndexForEra(params.eraSlug, params.eraIndexOverrides);
  const regionOutputs = params.regions.map((r) =>
    regionFoodBase(r, params.farmerPct, eraIndex),
  );
  const base = regionOutputs.reduce((s, v) => s + v, 0);
  const techFactor = Math.max(0, 1 + (params.techBonusPct ?? 0) / 100);
  const policyFactor = params.mobilizationActive
    ? 1 + FOOD_POLICY_OUTPUT_BONUS_PCT / 100
    : 1;
  const foodGrowthFactor = Math.max(0, 1 + (params.foodGrowthRatePct ?? 0) / 100);
  return { base, total: base * techFactor * policyFactor * foodGrowthFactor, eraIndex, regionOutputs };
}

/**
 * 每軍人糧食消耗（全精度）：基礎 5 × (1 + 科技加成%)，硬下限 1。
 * foodPct 為軍事科技「foodConsumption」target 的合計百分比（負值 = 減耗）。
 */
export function soldierFoodPerUnit(foodPct: number): number {
  return Math.max(
    SOLDIER_FOOD_MIN,
    SOLDIER_FOOD_BASE * Math.max(0, 1 + foodPct / 100),
  );
}

/** 軍隊列（供軍人數與軍糧消耗計算）。 */
export interface ArmyFoodRow {
  quantity: number;
  popCostPerUnit: number;
  category: string;
}

/** 軍人數 = Σ 軍隊數量 × 兵種人口消耗。 */
export function computeSoldierCount(rows: readonly ArmyFoodRow[]): number {
  return rows.reduce(
    (s, r) => s + Math.max(0, r.quantity) * Math.max(0, r.popCostPerUnit),
    0,
  );
}

/**
 * 已研發軍事科技中「foodConsumption」target 的合計百分比（依類別）。
 * category = null 適用所有類別；同 target 百分比相加（與 applyTechBonuses 一致）。
 */
export function foodConsumptionPctForCategory(
  techs: readonly { bonuses: MilitaryTechBonus[] }[],
  category: string,
): number {
  let pct = 0;
  for (const tech of techs) {
    for (const bonus of tech.bonuses as MilitaryTechBonus[]) {
      if (bonus.target !== "foodConsumption") continue;
      if (bonus.category !== null && bonus.category !== category) continue;
      pct += bonus.pct;
    }
  }
  return pct;
}

/**
 * 軍人糧食消耗（全精度）：每列 軍人數 × 每軍人消耗（依類別套科技、硬下限 1）。
 */
export function computeSoldierFoodConsumption(
  rows: readonly ArmyFoodRow[],
  techs: readonly { bonuses: MilitaryTechBonus[] }[],
): { soldiers: number; total: number } {
  let soldiers = 0;
  let total = 0;
  for (const r of rows) {
    const count = Math.max(0, r.quantity) * Math.max(0, r.popCostPerUnit);
    if (count <= 0) continue;
    const perUnit = soldierFoodPerUnit(
      foodConsumptionPctForCategory(techs, r.category),
    );
    soldiers += count;
    total += count * perUnit;
  }
  return { soldiers, total };
}

/**
 * 平民糧食消耗（全精度）：平民數 × 1 ×（1 − 節約配給%）。
 * 平民數 = max(0, 總人口 − 軍人數)（軍隊人口已含在地區人口內，避免重複計費）。
 */
export function computeCivilianFoodConsumption(params: {
  population: number;
  soldiers: number;
  rationingActive: boolean;
}): { civilians: number; total: number } {
  const civilians = Math.max(0, params.population - params.soldiers);
  const factor = params.rationingActive
    ? 1 - FOOD_POLICY_RATION_SAVING_PCT / 100
    : 1;
  return { civilians, total: civilians * CIVILIAN_FOOD_PER_CAPITA * factor };
}

/** 飢荒判定：產出 < 消耗。 */
export function isFamine(production: number, consumption: number): boolean {
  return production < consumption;
}

/**
 * Task #443 — 本回合饑荒扣幅（%，全精度）。priorConsecutiveFamineTurns 為
 * 「本回合之前」已連續饑荒的回合數：前 FAMINE_FULL_LOSS_TURNS 回合全額
 * 20%，之後每多一回合減半，下限 FAMINE_MIN_LOSS_PCT。
 */
export function famineLossPct(priorConsecutiveFamineTurns: number): number {
  const prior = Math.max(0, Math.floor(priorConsecutiveFamineTurns));
  const excess = Math.max(0, prior - (FAMINE_FULL_LOSS_TURNS - 1));
  const pct = FAMINE_POPULATION_LOSS_PCT / 2 ** excess;
  return Math.max(FAMINE_MIN_LOSS_PCT, pct);
}

/**
 * 飢荒人口損失量（正整數；套用時取負）。
 * Task #443 — 兩層保底：
 * 1. 連續饑荒緩衝：扣幅隨連續回合遞減（famineLossPct）。
 * 2. 生還者保底：損失不會把人口扣到低於 FAMINE_SURVIVOR_FLOOR；
 *    人口原本就 ≤ 保底時，饑荒損失為 0。
 */
export function faminePopulationLoss(
  population: number,
  priorConsecutiveFamineTurns = 0,
): number {
  const pop = Math.max(0, population);
  const pct = famineLossPct(priorConsecutiveFamineTurns);
  const rawLoss = Math.floor((pop * pct) / 100);
  const maxLoss = Math.max(0, pop - FAMINE_SURVIVOR_FLOOR);
  return Math.max(0, Math.min(rawLoss, maxLoss));
}

/**
 * 人口驟降懲罰：人口每下跌 1%（取整）→ 四階級滿意度與支持度各 −2。
 * 回傳懲罰量（非負整數）；prevPopulation ≤ 0 或未下跌回 0。
 */
export function populationDropPenalty(
  prevPopulation: number,
  newPopulation: number,
): number {
  if (prevPopulation <= 0) return 0;
  const drop = prevPopulation - newPopulation;
  if (drop <= 0) return 0;
  const dropPct = Math.floor((drop / prevPopulation) * 100);
  return dropPct * POP_DROP_PENALTY_PER_PCT;
}

/** 整數 0–100 夾限（滿意度／支持度欄位）。 */
export function clampStat0100(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}
