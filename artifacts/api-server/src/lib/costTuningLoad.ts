/**
 * 全局開銷旋鈕的 DB 載入層。純計算見 nationCostScale.ts(CostTuning 單例)。
 *
 * 價格函式是同步純函式,到處被呼叫,不能每次查 DB。所以:
 *   - 啟動時載入一次;
 *   - 之後每 REFRESH_MS 背景刷新(多個 instance 也能在數秒內收斂到同一個值);
 *   - 管理員儲存時,本 instance 立刻套用(applyCostTuning),不必等刷新。
 * 讀不到(DB 暫時失敗/還沒遷移)時維持上一個值,絕不讓價格計算掛掉。
 */
import { db, worldGameStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getCostTuning, setCostTuning, type CostTuning } from "./nationCostScale";

export const COST_TUNING_REFRESH_MS = 5_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** 從 DB 讀一次並套用。回傳套用後的值;失敗回傳目前值(不拋錯)。 */
export async function refreshCostTuning(): Promise<CostTuning> {
  try {
    const [row] = await db
      .select({ linearPct: worldGameStateTable.costLinearPct, curvePct: worldGameStateTable.costCurvePct })
      .from(worldGameStateTable)
      .where(eq(worldGameStateTable.id, 1));
    if (row) setCostTuning(row);
  } catch {
    /* 維持上一個值 */
  }
  return getCostTuning();
}

/** 管理員儲存後,本 instance 立刻套用。 */
export function applyCostTuning(t: Partial<CostTuning>): CostTuning {
  setCostTuning({ ...getCostTuning(), ...t });
  return getCostTuning();
}

/** 啟動背景刷新(冪等)。timer 不擋住程序結束。 */
export async function startCostTuningRefresh(): Promise<void> {
  await refreshCostTuning();
  if (timer) return;
  timer = setInterval(() => { void refreshCostTuning(); }, COST_TUNING_REFRESH_MS);
  timer.unref?.();
}
export function stopCostTuningRefresh(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
