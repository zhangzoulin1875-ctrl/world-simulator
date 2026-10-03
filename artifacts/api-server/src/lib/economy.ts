/**
 * 經濟系統純函式（Task #117）。DB-free、可單元測試。
 *
 * 核心設計：
 * - 收入完全來自「稅收」，生產力不再產生金錢。
 *   稅收 = floor(總人口 × 稅率% × 稅收效率% / 10000)。
 * - 稅收效率由「時代」決定（古典最低、未來最高），加上國家的額外加成
 *   （未來經濟科技用）。
 * - 每回合盈餘 = 稅收 − 軍隊／建築維護費；金錢下限 0。
 * （四項預算分配系統已於 Task #401 整組移除。）
 */

/** 稅率上限（%）：AI 財政政策不得超過此值。DB CHECK 放寬到 100 作為保險。 */
export const TAX_RATE_MAX = 50;
/** 稅率下限（%）。 */
export const TAX_RATE_MIN = 0;

/** 財政政策自由文字上限。 */
export const FINANCE_IDEA_MAX_LENGTH = 200;

/**
 * 財政流水分類（machine slug）。純顯示用；金錢在來源處已即時變動。
 */
export const FINANCE_LEDGER_CATEGORIES = [
  "treaty",
  "gift",
  "policy_penalty",
  "coup",
  "fiscal_policy",
] as const;
export type FinanceLedgerCategory = (typeof FINANCE_LEDGER_CATEGORIES)[number];

/** 財政流水分類的中文標籤（供 API 回傳與前端顯示）。 */
export const FINANCE_LEDGER_CATEGORY_LABELS: Record<string, string> = {
  treaty: "條約款項",
  gift: "外交贈禮",
  policy_penalty: "政策失敗賠款",
  coup: "政變損失",
  fiscal_policy: "財政政策",
};

/** 取得分類標籤；未知分類回落「其他」。 */
export function financeLedgerCategoryLabel(category: string): string {
  return FINANCE_LEDGER_CATEGORY_LABELS[category] ?? "其他";
}

/**
 * 各時代的稅收效率（%）。古典 1% → 未來 100%，隨時代嚴格遞增。
 * key 必須涵蓋 mapRegionEras.ts 的所有 ERAS slug（單元測試驗證）。
 */
export const TAX_EFFICIENCY_BY_ERA: Record<string, number> = {
  classical: 1,
  roman: 2,
  early_medieval: 3,
  high_medieval: 4,
  renaissance: 6,
  discovery: 9,
  scientific: 13,
  enlightenment: 18,
  industrial: 25,
  ww1: 35,
  ww2: 45,
  cold_war: 60,
  modern: 80,
  future: 100,
};

/** 依時代取得基礎稅收效率（%）；未知 slug 回落古典。 */
export function taxEfficiencyPctForEra(eraSlug: string): number {
  return TAX_EFFICIENCY_BY_ERA[eraSlug] ?? TAX_EFFICIENCY_BY_ERA["classical"]!;
}

/** 有效稅收效率（%）= 時代基礎 + 國家加成（下限 0）。 */
export function effectiveTaxEfficiencyPct(
  eraSlug: string,
  bonus: number,
): number {
  return Math.max(0, taxEfficiencyPctForEra(eraSlug) + Math.trunc(bonus));
}

/** 稅率夾在 [TAX_RATE_MIN, TAX_RATE_MAX]。 */
export function clampTaxRate(v: number): number {
  return Math.max(TAX_RATE_MIN, Math.min(TAX_RATE_MAX, Math.round(v)));
}

/**
 * 稅收 = floor(總人口 × 稅率% × 稅收效率% / 10000)，下限 0。
 * 人口最大約 4 億、稅率 ≤50、效率 ≤~100 → 乘積 < 2^53，安全。
 */
export function computeTaxIncome(params: {
  population: number;
  taxRatePct: number;
  taxEfficiencyPct: number;
}): number {
  const pop = Math.max(0, Math.floor(params.population));
  const rate = Math.max(0, params.taxRatePct);
  const eff = Math.max(0, params.taxEfficiencyPct);
  return Math.max(0, Math.floor((pop * rate * eff) / 10000));
}

/**
 * Task #568 — 可用生產力（純函式）：總生產力 − 已佔用 − 本回合招募花費，
 * 下限 0。
 *
 * 生產力維護費機制（Task #479/#561 的 prodUpkeepWanted/computeProdUpkeepCharge）
 * 已全面移除，改為兩軌分離：
 * - 「軍事已佔用」＝ production_spent（unitProductionReservation 佔用，
 *   解散按比例釋放）——不變；
 * - 「本回合招募花費」＝ recruit_production_spends 的當回合流量合計
 *   （loadCurrentTurnRecruitSpend），跨回合自動失效、解散不退還。
 * 所有可用生產力的顯示與消費守衛（招募／建築／內閣代理）都必須走這個函式。
 */
export function computeAvailableProduction(params: {
  /** 國家總生產力（computeAdjustedNationStats 的 production）。 */
  production: number;
  /** 已佔用生產力（player_nations.production_spent）。 */
  productionSpent: number;
  /** 本回合招募花費合計（loadCurrentTurnRecruitSpend）。 */
  currentTurnSpend: number;
}): number {
  return Math.max(
    0,
    params.production -
      params.productionSpent -
      Math.max(0, params.currentTurnSpend),
  );
}

/** 軍隊維護費逐兵種明細列（供財政分頁顯示）。 */
export interface MilitaryUpkeepLine {
  templateId: number;
  name: string;
  quantity: number;
  upkeepPerUnit: number;
  subtotal: number;
}

/**
 * 軍隊維護費逐兵種彙總（純函式）。
 * 依模板分組，過濾數量 ≤0 者，每列小計 = 數量 × 每單位維護費；
 * 總計 = Σ 小計，並依小計由大到小排序（穩定顯示）。
 */
export function aggregateMilitaryUpkeep(
  rows: {
    templateId: number;
    name: string;
    quantity: number;
    upkeepPerUnit: number;
  }[],
): { lines: MilitaryUpkeepLine[]; total: number } {
  const lines: MilitaryUpkeepLine[] = rows
    .filter((r) => r.quantity > 0)
    .map((r) => ({
      templateId: r.templateId,
      name: r.name,
      quantity: r.quantity,
      upkeepPerUnit: r.upkeepPerUnit,
      subtotal: r.quantity * r.upkeepPerUnit,
    }))
    .sort((a, b) => b.subtotal - a.subtotal);
  const total = lines.reduce((s, l) => s + l.subtotal, 0);
  return { lines, total };
}

export interface TurnFinanceResult {
  taxIncome: number;
  upkeepCharged: number;
  surplus: number;
  newMoney: number;
}

/**
 * 回合財政結算（純函式）。
 * 稅收 − 軍隊／建築維護費 = 盈餘；金錢 = max(0, 金錢 + 盈餘)。
 * 注意：外交／事件的一次性金錢流動在來源處已即時套用，不在此重算（避免
 * 重複計算）——本函式只處理每回合的稅收／維護費。
 */
export function computeTurnFinance(params: {
  money: number;
  population: number;
  taxRatePct: number;
  taxEfficiencyPct: number;
  upkeep: number;
}): TurnFinanceResult {
  const taxIncome = computeTaxIncome({
    population: params.population,
    taxRatePct: params.taxRatePct,
    taxEfficiencyPct: params.taxEfficiencyPct,
  });
  const upkeepCharged = Math.max(0, Math.ceil(params.upkeep));
  const surplus = taxIncome - upkeepCharged;
  const newMoney = Math.max(0, params.money + surplus);
  return { taxIncome, upkeepCharged, surplus, newMoney };
}
