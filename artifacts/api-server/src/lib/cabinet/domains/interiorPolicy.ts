import type { CabinetStyle } from "@workspace/db";
import type { AgencyLevel } from "../types";
import { clamp0to100, styleBand } from "../style";

/**
 * Task #243 — 內政大臣代理決策的純函式（無 DB／AI，可單元測試）。
 *
 * 這裡集中「積極度（boldness）」與「是否為重大決策（需送審批）」的判定規則：
 *   - 代理程度（保守／均衡／積極）決定基準積極度。
 *   - 執政風格（越權傾向 overreach 越高越積極；膽小程度 timidity 越高越保守）
 *     在基準上加減。
 * 積極度越高：自動執行的花費門檻越寬、預算單回合可自動調整的幅度越大、
 * 更可能自行提交財政政策；越權傾向高的大臣還會「越界」把未授權的項目送進
 * 審批佇列（但絕不自動執行未授權項目）。
 */

/** 代理程度 → 基準積極度（0–100）。 */
export function agencyBaseBoldness(agencyLevel: AgencyLevel): number {
  switch (agencyLevel) {
    case "conservative":
      return 20;
    case "aggressive":
      return 80;
    case "balanced":
    default:
      return 50;
  }
}

/**
 * 綜合積極度（0–100）：代理程度基準 + 越權傾向加成 − 膽小程度扣減。
 * 每項風格以「距中位 50」的差 × 0.3 貢獻，夾在 0–100。
 */
export function interiorBoldness(
  agencyLevel: AgencyLevel,
  style: CabinetStyle,
): number {
  const base = agencyBaseBoldness(agencyLevel);
  const overreach = clamp0to100(style.overreach);
  const timidity = clamp0to100(style.timidity);
  const raw = base + (overreach - 50) * 0.3 - (timidity - 50) * 0.3;
  return clamp0to100(raw);
}

/**
 * 單筆花費視為「重大」的國庫佔比門檻（0.15–0.65）：積極度越高門檻越寬，
 * 亦即越敢自行動用較大比例的國庫而不送審批。
 */
export function majorSpendThresholdPct(boldness: number): number {
  const b = clamp0to100(boldness);
  return 0.15 + (b / 100) * 0.5;
}

/**
 * 單筆花費是否為重大決策（需送審批）。
 * 花費 ≤0 一律非重大；國庫 ≤0 但仍要花錢 → 視為重大（交由玩家定奪）。
 * 否則：花費 > 國庫 × 門檻 → 重大。
 */
export function isMajorSpend(params: {
  cost: number;
  treasury: number;
  boldness: number;
}): boolean {
  const cost = Math.max(0, Math.floor(params.cost));
  if (cost <= 0) return false;
  const treasury = Math.max(0, Math.floor(params.treasury));
  if (treasury <= 0) return true;
  return cost > treasury * majorSpendThresholdPct(params.boldness);
}

/**
 * 興建是否會用掉該城「最後一個」建築槽（剩餘可用槽 ≤1 表示這次就用到最後一格）。
 * 用光最後一格會鎖死該城後續興建彈性，屬重大決策，送審批交玩家定奪。
 */
export function isLastBuildingSlot(remainingSlots: number): boolean {
  return Number.isFinite(remainingSlots) && remainingSlots <= 1;
}

/**
 * 是否自行提交財政政策（改稅制）而不送審批。稅制屬高影響決策，
 * 僅積極度 ≥60 的大臣才自行提交，否則一律送審批。
 */
export function shouldAutoSubmitFiscalPolicy(boldness: number): boolean {
  return clamp0to100(boldness) >= 60;
}

/**
 * 是否「越界」：越權傾向為「高」帶的大臣，會把玩家未授權的內政項目也
 * 以提案形式送進審批佇列（但永遠不會自動執行未授權項目）。
 */
export function willOverstepAuthorization(style: CabinetStyle): boolean {
  return styleBand(clamp0to100(style.overreach)) === "高";
}

/**
 * 糧食政策切換是否為重大決策（需送審批）。
 * 與糧食情勢「順向」的切換屬小事（授權即可自動執行）：
 *   - 饑荒（或缺口）時「開啟」政策 → 救急，minor。
 *   - 無饑荒時「關閉」政策 → 止血滿意度，minor。
 * 逆向切換屬重大（交玩家定奪）：
 *   - 無饑荒卻要「開啟」政策（平白每回合 −2 滿意度）→ major。
 *   - 饑荒中卻要「關閉」政策（可能加劇饑荒）→ major。
 */
export function isMajorFoodPolicyChange(params: {
  /** true = 開啟政策；false = 關閉政策。 */
  enable: boolean;
  /** 目前是否處於饑荒（產出 < 消耗）。 */
  famine: boolean;
}): boolean {
  return params.enable !== params.famine;
}
