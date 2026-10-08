import { GOODS, type GoodSlug } from "./goods";
import { getEraIndex, isEraSlug } from "../mapRegionEras";

/**
 * 貿易系統 — 庫存結算純函式(DB-free,2026-10-08 定案數值)。
 *
 * 糧食庫存規格:
 *  - 既有國家上線給「6 回合消耗」的期初庫存
 *  - 每回合腐敗 3%(只對糧食)
 *  - 庫存上限 = 12 回合消耗
 *  - 庫存為負才饑荒;條約輸送維持每回合流量、結算時進出庫存
 *
 * 全部以整數庫存運算(寫入 bigint 欄位前一律取整,見 toIntDelta 事故),
 * 腐敗向下取整讓玩家不吃虧(少扣)。
 */

/** 期初庫存 = 此回合數的消耗量。 */
export const FOOD_INITIAL_STOCK_TURNS = 6;
/** 庫存上限 = 此回合數的消耗量。 */
export const FOOD_STOCK_CAP_TURNS = 12;
/** 每回合腐敗率(%)。 */
export const FOOD_SPOIL_PCT = 3;

/** 地區特產在 stats era 尚未解鎖時,產量為 0。 */
export function isGoodUnlocked(good: GoodSlug, statsEra: string): boolean {
  const unlock = GOODS[good].unlockEra;
  if (unlock === null) return true;
  if (!isEraSlug(statsEra) || !isEraSlug(unlock)) return false;
  return getEraIndex(statsEra) >= getEraIndex(unlock);
}

/** 非負整數(NaN/Infinity/負值歸 0,小數向下取整)。 */
function nonNegInt(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

/** 期初庫存:6 回合消耗(消耗 <= 0 時為 0)。 */
export function initialFoodStock(consumptionPerTurn: number): number {
  return nonNegInt(consumptionPerTurn * FOOD_INITIAL_STOCK_TURNS);
}

/** 庫存上限:12 回合消耗(消耗 <= 0 時為 0,即不能囤)。 */
export function foodStockCap(consumptionPerTurn: number): number {
  return nonNegInt(consumptionPerTurn * FOOD_STOCK_CAP_TURNS);
}

export interface FoodSettleInput {
  /** 回合開始時的庫存(可為負? 不可:庫存下限 0,缺口以 shortfall 表達)。 */
  stock: number;
  /** 本回合總供給 = 產出 + 條約流入 − 條約流出(可為負,輸出方不做餘額檢查)。 */
  supply: number;
  /** 本回合總消耗(平民 + 軍隊)。 */
  consumption: number;
}

export interface FoodSettleResult {
  /** 結算後庫存(0 ≤ x ≤ cap)。 */
  stock: number;
  /** 本回合缺口:庫存用完仍不夠吃的量(> 0 即饑荒)。 */
  shortfall: number;
  /** 腐敗損失。 */
  spoiled: number;
  /** 超過上限被捨棄的量。 */
  overflow: number;
  famine: boolean;
  cap: number;
}

/**
 * 糧食庫存單回合結算。順序:
 *   1) 可用 = 庫存 + 供給
 *   2) 扣消耗;可用不足 → 庫存歸 0,差額為 shortfall(饑荒)
 *   3) 對剩餘庫存腐敗 3%(向下取整)
 *   4) 超過上限(12 回合消耗)的部分捨棄
 * 先吃再腐敗:腐敗只作用於「放著沒吃」的糧食。
 */
export function settleFoodStock(input: FoodSettleInput): FoodSettleResult {
  const consumption = nonNegInt(input.consumption);
  const cap = foodStockCap(consumption);
  const stock = nonNegInt(input.stock);
  const supply = Number.isFinite(input.supply) ? Math.floor(input.supply) : 0;

  const available = stock + supply;
  const afterEat = available - consumption;

  if (afterEat < 0) {
    return { stock: 0, shortfall: -afterEat, spoiled: 0, overflow: 0, famine: true, cap };
  }
  const spoiled = Math.floor((afterEat * FOOD_SPOIL_PCT) / 100);
  let next = afterEat - spoiled;
  let overflow = 0;
  if (next > cap) {
    overflow = next - cap;
    next = cap;
  }
  return { stock: next, shortfall: 0, spoiled, overflow, famine: false, cap };
}
