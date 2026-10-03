import { eq } from "drizzle-orm";
import {
  db,
  diplomacyTreatiesTable,
  type DiplomacyTreaty,
} from "@workspace/db";
import { HttpError } from "./treatyActivation";

/**
 * Task #71 — 撤回自己送出的待回覆條約提案。
 * 對方已讀不回時，提案國可把仍為 proposed 的條約收回，讓 pair 解鎖
 * （部分唯一索引 diplomacy_treaties_proposed_pair_uidx 限制同一對國家
 * 僅一筆 proposed，卡住就無法再提案）。
 *
 * 規則（tx + FOR UPDATE，與 accept/annul 相同的競態防護）：
 * - 非當事國 → 403
 * - 非 proposed（已被接受／拒絕／取代）→ 409
 * - awaiting 是自己（例如 NPC 對案等你回覆）→ 400，請改用接受／拒絕
 * - 撤回不扣關係分數（與廢除條約不同）
 */
export async function withdrawTreatyAsNation(
  treatyId: number,
  myNationId: string,
): Promise<DiplomacyTreaty> {
  return db.transaction(async (tx) => {
    const [treaty] = await tx
      .select()
      .from(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.id, treatyId))
      .for("update");
    if (!treaty) throw new HttpError(404, "找不到這個條約");
    if (
      treaty.proposerNationId !== myNationId &&
      treaty.targetNationId !== myNationId
    ) {
      throw new HttpError(403, "你不是這份條約的當事國");
    }
    if (treaty.status !== "proposed") {
      throw new HttpError(409, "這個條約已不在待回覆狀態，無法撤回");
    }
    if (treaty.awaitingNationId === myNationId) {
      throw new HttpError(400, "這個條約正等待你回覆，請改用接受或拒絕");
    }
    const [updated] = await tx
      .update(diplomacyTreatiesTable)
      .set({ status: "withdrawn", awaitingNationId: null, updatedAt: new Date() })
      .where(eq(diplomacyTreatiesTable.id, treaty.id))
      .returning();
    if (!updated) throw new HttpError(500, "條約撤回寫入失敗");
    return updated;
  });
}
