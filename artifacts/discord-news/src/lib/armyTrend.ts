/**
 * Task #400 — 世界地圖政治視圖：各國軍力趨勢判定（純函式，供國情面板使用）。
 * 快照由伺服器每回合寫入；此處只比較最新與最舊點（至少 2 點才有趨勢）。
 */

export interface ArmyTrendPoint {
  date: string;
  armyPopulation: number;
}

export interface ArmyTrendSummary {
  kind: "up" | "down" | "flat";
  pct: number;
}

/**
 * 比較最新快照與最舊快照：變化幅度 ≥3% 視為擴軍／縮編，其餘視為持平。
 * 少於 2 點回傳 null（不顯示趨勢）；從 0 長出軍隊視為擴軍 +100%。
 */
export function armyTrendSummary(
  trend: ArmyTrendPoint[],
): ArmyTrendSummary | null {
  if (trend.length < 2) return null;
  const first = trend[0]!.armyPopulation;
  const last = trend[trend.length - 1]!.armyPopulation;
  if (first <= 0) {
    return last > 0 ? { kind: "up", pct: 100 } : { kind: "flat", pct: 0 };
  }
  const pct = ((last - first) / first) * 100;
  if (pct >= 3) return { kind: "up", pct };
  if (pct <= -3) return { kind: "down", pct };
  return { kind: "flat", pct };
}
