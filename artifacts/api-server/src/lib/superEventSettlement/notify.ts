import type { SuperEvent } from "@workspace/db";
import { logger } from "../logger";
import { notifySuperEvent } from "../gameNotify";
import { loadAffectedPlayers } from "./affectedNations";

/**
 * Task #334 — 一則超事件「剛建立／被觸發」後，即時通知所有受影響的玩家（站內
 * 鈴鐺），讓玩家在下回合結算前有機會前往超事件頁面應對。best-effort：查詢或
 * 通知失敗只記 log，絕不影響建立事件的主流程。
 *
 * 僅供「不會在同回合立即被結算」的建立路徑呼叫（管理員手動建立／管理員 AI 立即
 * 生成）；每回合自動生成與政治觸發的事件會在同回合的超事件結算中被處理並發出
 * 「本回合進展」通知，因此不需要另外的建立通知，以免同回合重複打擾玩家。
 */
export async function notifyNewSuperEvent(
  event: Pick<SuperEvent, "id" | "scope" | "title">,
): Promise<void> {
  try {
    const players = await loadAffectedPlayers(event);
    for (const p of players) {
      notifySuperEvent({
        discordUserId: p.discordUserId,
        eventId: event.id,
        title: event.title,
        kind: "created",
        detail: `一場重大國際事件「${event.title}」爆發，波及你的國家。前往超事件頁面了解詳情，並在下回合結算前做出應對。`,
      });
    }
  } catch (err) {
    logger.error(
      { err, eventId: event.id },
      "new super event notification failed",
    );
  }
}
