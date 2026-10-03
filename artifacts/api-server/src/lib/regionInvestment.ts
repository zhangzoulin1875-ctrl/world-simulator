/**
 * Task #405 — 地區生產力投資的純函式費用計算。
 *
 * 規則：
 * - 投資一次 → 該地區生產素質 +1（存 map_regions.productivity_investment_bonus，
 *   跨時代固定加值、全地區共享）。
 * - 基礎費用 = 該地區目前人口數（與地圖/地區數據顯示一致：數據時代 era stat
 *   人口 + 該地區各國累積成長量，下限 0）。
 * - 費用倍率 = 該地區有效生產素質 ÷ 全世界平均有效生產素質；≤ 平均 → ×1，
 *   超過平均幾倍就乘幾倍（連續比值，不分級）。
 * - 最終費用 = ceil(人口 × 倍率)，整數；計算中間值不提前捨入。下限 1，避免
 *   人口為 0 的地區可以免費刷投資。
 */

/** 有效生產素質 = era stat productivity + 投資累積加成（皆整數）。 */
export function effectiveProductivity(
  eraProductivity: number,
  investmentBonus: number,
): number {
  return eraProductivity + investmentBonus;
}

/**
 * 費用倍率（連續比值，下限 1）。全域平均 ≤ 0（理論上不會發生）時回 1，
 * 避免除以零。不做任何捨入。
 */
export function investmentCostMultiplier(
  effective: number,
  globalAvgEffective: number,
): number {
  if (!(globalAvgEffective > 0)) return 1;
  return Math.max(1, effective / globalAvgEffective);
}

/** 下一次投資費用 = max(1, ceil(人口 × 倍率))；人口先夾下限 0。 */
export function investmentCost(
  population: number,
  effective: number,
  globalAvgEffective: number,
): number {
  const pop = Math.max(0, population);
  const mult = investmentCostMultiplier(effective, globalAvgEffective);
  return Math.max(1, Math.ceil(pop * mult));
}
