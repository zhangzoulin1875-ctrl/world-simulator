import { and, eq } from "drizzle-orm";
import { db, politicsEntriesTable } from "@workspace/db";
import type { ActivePolicySummary } from "./politicsAi";

/**
 * 現行制度脈絡的 DB 載入器（2026-10 政策連續性）。
 *
 * 政治 AI（政策想法／政府決策判定、隨機事件、政變敘事）判定時需要該國
 * status=active 的制度清單作為「既成事實」脈絡（見 politicsAi.ts 頂部說明）。
 * 獨立成小模組是為了讓 aiPregenCache（預產雜湊輸入）與 politicsSettlement
 * （現場判定）共用同一個載入邏輯，避免循環匯入：兩邊都只依賴本模組，
 * 本模組只依賴 DB 與純型別。
 *
 * 排序固定（id 升冪）讓預產與結算兩端拿到「相同清單內容」時雜湊一致；
 * remainingTurns 每回合結算都會變動，預產快取自然只在本回合窗口內有效。
 */
export async function loadActivePolicySummaries(
  nationId: string,
): Promise<ActivePolicySummary[]> {
  return db
    .select({
      title: politicsEntriesTable.title,
      entryType: politicsEntriesTable.entryType,
      remainingTurns: politicsEntriesTable.remainingTurns,
    })
    .from(politicsEntriesTable)
    .where(
      and(
        eq(politicsEntriesTable.nationId, nationId),
        eq(politicsEntriesTable.status, "active"),
      ),
    )
    .orderBy(politicsEntriesTable.id);
}
