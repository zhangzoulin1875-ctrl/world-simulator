import { and, eq, isNull, inArray, sql, desc, count } from "drizzle-orm";
import {
  db,
  playerNotificationsTable,
  type PlayerNotification,
} from "@workspace/db";
import { logger } from "./logger";

/**
 * Task #79 — 站內通知（遊戲首頁鈴鐺通知中心）。
 * 站內通知一律寫入資料庫，不受 Discord 私訊開關（dm_notifications_enabled）
 * 影響 — 那個開關只擋 DM。事件來源（外交等）透過 diplomacyNotify.ts 的
 * fireNotify 統一入口同時寫站內通知＋走 DM gate。
 */

/** 每玩家保留的通知上限（寫入時順手清舊，避免無限膨脹）。 */
export const NOTIFICATION_RETENTION = 100;

export type NewPlayerNotification = {
  discordUserId: string;
  type: string;
  title: string;
  body: string;
  /** 站內跳轉路徑（例如 "/game/diplomacy"）；省略 = 不可點擊。 */
  linkPath?: string | null;
};

/**
 * 寫入一則站內通知，並清掉該玩家超過保留上限的舊通知。
 * 呼叫端（通知事件）以 fire-and-forget 使用：失敗只記 log，不影響主流程。
 */
export async function createPlayerNotification(
  n: NewPlayerNotification,
): Promise<void> {
  await db.insert(playerNotificationsTable).values({
    discordUserId: n.discordUserId,
    type: n.type,
    title: n.title,
    body: n.body,
    linkPath: n.linkPath ?? null,
  });
  // 保留最新 NOTIFICATION_RETENTION 則；其餘刪除。用子查詢一次完成，
  // 不需要交易 — 就算併發各自多刪/少刪一列也無礙（下次寫入會再修正）。
  await db.execute(sql`
    DELETE FROM player_notifications
    WHERE discord_user_id = ${n.discordUserId}
      AND id NOT IN (
        SELECT id FROM player_notifications
        WHERE discord_user_id = ${n.discordUserId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${NOTIFICATION_RETENTION}
      )
  `);
}

/** 通知清單（新到舊）＋未讀數。 */
export async function listPlayerNotifications(
  discordUserId: string,
  limit: number,
): Promise<{ notifications: PlayerNotification[]; unreadCount: number }> {
  const [notifications, [unread]] = await Promise.all([
    db
      .select()
      .from(playerNotificationsTable)
      .where(eq(playerNotificationsTable.discordUserId, discordUserId))
      .orderBy(
        desc(playerNotificationsTable.createdAt),
        desc(playerNotificationsTable.id),
      )
      .limit(limit),
    db
      .select({ value: count() })
      .from(playerNotificationsTable)
      .where(
        and(
          eq(playerNotificationsTable.discordUserId, discordUserId),
          isNull(playerNotificationsTable.readAt),
        ),
      ),
  ]);
  return { notifications, unreadCount: unread?.value ?? 0 };
}

/**
 * 標為已讀：ids 省略 = 全部未讀標為已讀；帶 ids = 只標指定通知
 * （僅限自己的通知）。回傳更新後的未讀數。
 */
export async function markPlayerNotificationsRead(
  discordUserId: string,
  ids?: string[],
): Promise<{ unreadCount: number }> {
  const conditions = [
    eq(playerNotificationsTable.discordUserId, discordUserId),
    isNull(playerNotificationsTable.readAt),
  ];
  if (ids && ids.length > 0) {
    conditions.push(inArray(playerNotificationsTable.id, ids));
  }
  await db
    .update(playerNotificationsTable)
    .set({ readAt: new Date() })
    .where(and(...conditions));
  const [unread] = await db
    .select({ value: count() })
    .from(playerNotificationsTable)
    .where(
      and(
        eq(playerNotificationsTable.discordUserId, discordUserId),
        isNull(playerNotificationsTable.readAt),
      ),
    );
  return { unreadCount: unread?.value ?? 0 };
}

/** fire-and-forget 寫入（事件來源用；失敗只記 log）。 */
export function persistNotificationInBackground(
  n: NewPlayerNotification,
): void {
  createPlayerNotification(n).catch((err) => {
    logger.warn({ err, discordUserId: n.discordUserId }, "in-app notification write failed");
  });
}
