import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { db, diplomacyTreatiesTable } from "@workspace/db";
import {
  NPC_HISTORY_MAX_AGE_MS,
  NPC_HISTORY_MAX_ENTRIES,
  type NpcTreatyHistoryRow,
} from "./diplomacy";

/**
 * Task #76 — NPC 提案記憶的歷史查詢（自 routes/diplomacy.ts 抽出，供整合測試直接呼叫）。
 *
 * 查詢條件（改壞任一項都會讓 NPC 記憶靜默失效或記錯帳）：
 * - 同一 pair 雙向都算（A→B 與 B→A 的提案屬同一段關係）
 * - 只撈已結束的三種狀態：rejected / withdrawn / superseded
 * - 只看 NPC_HISTORY_MAX_AGE_MS（7 天）內（以 updatedAt 計）
 * - 排除剛插入的本筆提案（excludeTreatyId；唯讀查詢時可省略）
 * - updatedAt 新→舊排序，最多 NPC_HISTORY_MAX_ENTRIES（5）筆
 */
export async function fetchNpcTreatyHistory(params: {
  myNationId: string;
  npcNationId: string;
  excludeTreatyId?: number;
  now?: Date;
}): Promise<NpcTreatyHistoryRow[]> {
  const { myNationId, npcNationId } = params;
  // 沒有要排除的提案時用 -1（serial id 永遠 ≥ 1，不會命中）。
  const excludeTreatyId = params.excludeTreatyId ?? -1;
  const now = params.now ?? new Date();
  const rows = await db
    .select({
      type: diplomacyTreatiesTable.type,
      status: diplomacyTreatiesTable.status,
      durationDays: diplomacyTreatiesTable.durationDays,
      offerMoney: diplomacyTreatiesTable.offerMoney,
      offerTechPoints: diplomacyTreatiesTable.offerTechPoints,
      offerRegionIds: diplomacyTreatiesTable.offerRegionIds,
      proposerNationId: diplomacyTreatiesTable.proposerNationId,
      responseNote: diplomacyTreatiesTable.responseNote,
      updatedAt: diplomacyTreatiesTable.updatedAt,
    })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        inArray(diplomacyTreatiesTable.status, [
          "rejected",
          "withdrawn",
          "superseded",
        ]),
        gte(
          diplomacyTreatiesTable.updatedAt,
          new Date(now.getTime() - NPC_HISTORY_MAX_AGE_MS),
        ),
        or(
          and(
            eq(diplomacyTreatiesTable.proposerNationId, myNationId),
            eq(diplomacyTreatiesTable.targetNationId, npcNationId),
          ),
          and(
            eq(diplomacyTreatiesTable.proposerNationId, npcNationId),
            eq(diplomacyTreatiesTable.targetNationId, myNationId),
          ),
        ),
        // 排除剛插入的這筆提案本身（狀態不同，理論上不會命中，保險起見）。
        sql`${diplomacyTreatiesTable.id} <> ${excludeTreatyId}`,
      ),
    )
    .orderBy(desc(diplomacyTreatiesTable.updatedAt))
    .limit(NPC_HISTORY_MAX_ENTRIES);

  return rows.map((r) => ({
    type: r.type,
    status: r.status,
    durationDays: r.durationDays,
    offerMoney: r.offerMoney,
    offerTechPoints: r.offerTechPoints,
    offerRegionIds: Array.isArray(r.offerRegionIds) ? r.offerRegionIds : [],
    proposedByNpc: r.proposerNationId === npcNationId,
    responseNote: r.responseNote,
    updatedAt: r.updatedAt,
  }));
}
