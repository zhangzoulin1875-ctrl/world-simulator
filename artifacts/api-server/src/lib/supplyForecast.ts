/**
 * 戰役補給預測與緊急運補報價（純函式、DB-free、可單元測試）。
 *
 * 需求公式一律委託給 supply.ts 的 legionSupplyDemand / allocateSupplyFill，
 * 這樣「戰役頁顯示的預估」與「結算實際扣的量」是同一套數字，不會各算各的。
 */
import {
  allocateSupplyFill,
  ammoEraFactor,
  isSupplyCollapsed,
  legionSupplyDemand,
  type SupplyUnit,
} from "./supply";

/** 緊急運補：每單位彈藥的基礎價（金）。刻意貴於自產（軍工廠產出是免費的）。 */
export const RESUPPLY_BASE_PRICE = 2;
/** 時代越高單價越貴：價格 = 基礎價 × (1 + 時代係數 × 此值)。 */
export const RESUPPLY_ERA_PRICE_SLOPE = 0.1;
/** 單次運補上限 = 未來幾個週期的總需求（避免無限囤積，又足夠撐過一段戰事）。 */
export const RESUPPLY_HORIZON_CYCLES = 5;
/** 沒有軍團需求時的保底：不開放運補（冷兵器時代 / 無火力軍團）。 */
export const MIN_RESUPPLY_AMOUNT = 1;

export interface ForecastLegionInput {
  slot: string;
  mercenary: boolean;
  supply: number;
  units: readonly SupplyUnit[];
}

export interface LegionForecast {
  slot: string;
  mercenary: boolean;
  supply: number;
  collapsed: boolean;
  /** 本週期彈藥需求。僱傭兵自帶補給，恆為 0。 */
  ammoDemand: number;
  /** 本週期口糧需求（人·週期）。僱傭兵恆為 0。 */
  rationDemand: number;
  /** 以目前庫存估算的彈藥滿足度（0–1）。僱傭兵恆為 1。 */
  ammoFill: number;
}

export interface SupplyForecast {
  legions: LegionForecast[];
  totalAmmoDemand: number;
  totalRationDemand: number;
  ammoStock: number;
  /** 庫存 − 本週期總需求；負數 = 缺口。 */
  ammoBalance: number;
  /** 缺口（≥ 0）。 */
  ammoShortfall: number;
  /** 庫存可撐幾個週期；需求為 0 時為 null（不會耗盡）。 */
  cyclesOfAmmo: number | null;
  /** 預估本週期會缺彈的軍團數。 */
  legionsShort: number;
  /** 補給已崩潰的軍團數。 */
  collapsedLegions: number;
  /** 該時代是否有彈藥消耗（冷兵器時代 = false，整個面板顯示「不需彈藥」）。 */
  ammoRelevant: boolean;
}

/** 依目前軍團與庫存預估「下一次結算」的補給狀況。 */
export function forecastCampaignSupply(
  legions: readonly ForecastLegionInput[],
  ammoStock: number,
  eraSlug: string,
): SupplyForecast {
  const stock = Math.max(0, Math.floor(ammoStock));
  const demands = legions.map((l) =>
    l.mercenary ? { ration: 0, ammo: 0 } : legionSupplyDemand(l.units, eraSlug),
  );
  const fills = allocateSupplyFill(
    demands.map((d) => d.ammo),
    stock,
  );
  const rows: LegionForecast[] = legions.map((l, i) => ({
    slot: l.slot,
    mercenary: l.mercenary,
    supply: l.supply,
    collapsed: isSupplyCollapsed(l.supply),
    ammoDemand: demands[i]!.ammo,
    rationDemand: demands[i]!.ration,
    ammoFill: l.mercenary ? 1 : fills[i]!,
  }));
  const totalAmmoDemand = rows.reduce((s, r) => s + r.ammoDemand, 0);
  const totalRationDemand = rows.reduce((s, r) => s + r.rationDemand, 0);
  const ammoBalance = stock - totalAmmoDemand;
  return {
    legions: rows,
    totalAmmoDemand,
    totalRationDemand,
    ammoStock: stock,
    ammoBalance,
    ammoShortfall: Math.max(0, -ammoBalance),
    cyclesOfAmmo:
      totalAmmoDemand > 0 ? Math.floor((stock / totalAmmoDemand) * 10) / 10 : null,
    legionsShort: rows.filter((r) => r.ammoDemand > 0 && r.ammoFill < 1).length,
    collapsedLegions: rows.filter((r) => r.collapsed).length,
    ammoRelevant: ammoEraFactor(eraSlug) > 0,
  };
}

/** 緊急運補每單位單價（金）。時代越高越貴，向上取到小數兩位避免浮點雜訊。 */
export function resupplyUnitPrice(eraSlug: string): number {
  const p = RESUPPLY_BASE_PRICE * (1 + ammoEraFactor(eraSlug) * RESUPPLY_ERA_PRICE_SLOPE);
  return Math.round(p * 100) / 100;
}

/** 一筆運補的總價（整數金，進位）。 */
export function resupplyCost(amount: number, eraSlug: string): number {
  return Math.ceil(Math.max(0, Math.floor(amount)) * resupplyUnitPrice(eraSlug));
}

/**
 * 單次可運補的最大量：未來 N 個週期的總需求 − 目前庫存（不為負）。
 * 庫存已經夠撐 N 個週期就是 0，擋掉無意義囤積。
 */
export function maxResupplyAmount(
  totalAmmoDemand: number,
  ammoStock: number,
): number {
  const target = Math.max(0, Math.floor(totalAmmoDemand)) * RESUPPLY_HORIZON_CYCLES;
  return Math.max(0, target - Math.max(0, Math.floor(ammoStock)));
}

/** 「補到剛好夠一個週期」的建議量（讓玩家一鍵補缺口）。 */
export function suggestedResupplyAmount(forecast: SupplyForecast): number {
  return forecast.ammoShortfall;
}

export type ResupplyCheck =
  | { ok: true; amount: number; cost: number; unitPrice: number }
  | { ok: false; error: string };

/** 驗證一筆運補請求（不碰資料庫；扣款的原子性由路由的條件式 UPDATE 保證）。 */
export function validateResupply(
  rawAmount: unknown,
  forecast: SupplyForecast,
  eraSlug: string,
  money: number,
): ResupplyCheck {
  if (!forecast.ammoRelevant) {
    return { ok: false, error: "目前時代的戰爭不消耗彈藥，無需運補" };
  }
  if (forecast.totalAmmoDemand <= 0) {
    return { ok: false, error: "你的軍團目前沒有彈藥需求" };
  }
  if (typeof rawAmount !== "number" || !Number.isFinite(rawAmount) || !Number.isInteger(rawAmount)) {
    return { ok: false, error: "運補數量必須是整數" };
  }
  if (rawAmount < MIN_RESUPPLY_AMOUNT) {
    return { ok: false, error: "運補數量至少為 1" };
  }
  const cap = maxResupplyAmount(forecast.totalAmmoDemand, forecast.ammoStock);
  if (cap <= 0) {
    return { ok: false, error: `彈藥庫存已足夠撐過 ${RESUPPLY_HORIZON_CYCLES} 個週期，無需再運補` };
  }
  if (rawAmount > cap) {
    return { ok: false, error: `單次最多運補 ${cap.toLocaleString("en-US")}（以撐過 ${RESUPPLY_HORIZON_CYCLES} 個週期為限）` };
  }
  const unitPrice = resupplyUnitPrice(eraSlug);
  const cost = resupplyCost(rawAmount, eraSlug);
  if (!Number.isSafeInteger(cost)) return { ok: false, error: "運補金額過大" };
  if (cost > money) {
    return { ok: false, error: `金錢不足（需要 ${cost.toLocaleString("en-US")}）` };
  }
  return { ok: true, amount: rawAmount, cost, unitPrice };
}
