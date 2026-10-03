import type { TechTreeAllocation } from "./techTree";

/**
 * Task #548 — 三領域科研點數分配（最大餘數法，純函式）。
 *
 * 把「整數回合科研收入」依三領域 ratioPct 拆分成整數份額，保證：
 * - 比例合計 = 100（正常情形）時，三領域份額總和恰好等於收入；
 * - 比例合計 < 100 時，未分配比例對應的份額作廢（總和 = floor(收入 × 合計 / 100)）；
 * - 比例合計 > 100（防禦，正常 API 不會發生）時，按比例權重正規化，總和仍 = 收入。
 *
 * 餘數並列時依固定順序 social → production → military 決定，結果確定性。
 * 回合引擎（settleNationResearch）與總覽路由（perTurnPoints）必須共用本函式，
 * 確保玩家看到的每領域每回合點數與實際灌入量一致。
 */
export function allocateResearchPoints(
  totalPoints: number,
  ratios: TechTreeAllocation,
): TechTreeAllocation {
  const total = Math.max(0, Math.floor(totalPoints));
  const order = ["social", "production", "military"] as const;
  const cleaned = order.map((d) => {
    const raw = ratios[d];
    return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  });
  const sum = cleaned[0]! + cleaned[1]! + cleaned[2]!;
  const result: TechTreeAllocation = { social: 0, production: 0, military: 0 };
  if (total <= 0 || sum <= 0) return result;

  // 可分配總量：比例合計 < 100 → 未分配份額作廢；≥ 100 → 全數分配。
  const allocatedTotal =
    sum >= 100 ? total : Math.floor((total * sum) / 100);
  if (allocatedTotal <= 0) return result;

  const quotas = cleaned.map((r) => (allocatedTotal * r) / sum);
  const floors = quotas.map((q) => Math.floor(q));
  let leftover = allocatedTotal - floors.reduce((a, b) => a + b, 0);

  // 最大餘數法：餘數大者先補 1；並列時依 order 固定順序。
  const byRemainder = order
    .map((domain, i) => ({ domain, i, rem: quotas[i]! - floors[i]! }))
    .sort((a, b) => (b.rem !== a.rem ? b.rem - a.rem : a.i - b.i));
  for (const entry of byRemainder) {
    if (leftover <= 0) break;
    floors[entry.i] = floors[entry.i]! + 1;
    leftover -= 1;
  }
  result.social = floors[0]!;
  result.production = floors[1]!;
  result.military = floors[2]!;
  return result;
}
