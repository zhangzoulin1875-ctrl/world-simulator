import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
} from "drizzle-orm/pg-core";

/**
 * Task #79 — 站內通知（遊戲首頁鈴鐺通知中心）。
 * 以 Discord user id 為鍵（非 nation id）：退出國家後歷史通知仍保留。
 * 站內通知一律寫入，不受 player_nations.dm_notifications_enabled 影響
 * （那個開關只擋 Discord 私訊）。每玩家保留最新 100 則（寫入時順手清舊，
 * 見 api-server lib/playerNotify.ts）。
 */
export const playerNotificationsTable = pgTable(
  "player_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    discordUserId: text("discord_user_id").notNull(),
    /** 事件類型（例如 "diplomacy"），前端可依類型決定跳轉行為。 */
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** 站內跳轉路徑（例如 "/game/diplomacy"）；null = 不可點擊。 */
    linkPath: text("link_path"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** null = 未讀。 */
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => ({
    userReadIdx: index("player_notifications_user_read_idx").on(
      t.discordUserId,
      t.readAt,
    ),
    userCreatedIdx: index("player_notifications_user_created_idx").on(
      t.discordUserId,
      t.createdAt,
    ),
  }),
);

export type PlayerNotification = typeof playerNotificationsTable.$inferSelect;
export type InsertPlayerNotification =
  typeof playerNotificationsTable.$inferInsert;
