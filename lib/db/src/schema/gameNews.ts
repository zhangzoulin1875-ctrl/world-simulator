import {
  pgTable,
  text,
  integer,
  timestamp,
  uuid,
  index,
} from "drizzle-orm/pg-core";

/**
 * Task #184 — 每回合新聞（重大國際／各國事件）。
 *
 * 每日回合結算末段，AI（bulk 模型）把當回合各來源的重大事件（宣戰、締約、
 * 時代推進、NPC 興亡等世界模擬變更、政變／政體更替等重大政治事件）整理成
 * 精簡的繁中新聞條目寫入此表，只保留「重大」事件。公開唯讀端點依 created_at
 * 新到舊列出。寫入時清舊，保留最新 NEWS_RETENTION 則（見 lib/gameNews.ts）。
 *
 * 與已移除的舊新聞/公告管線（announcements/news_reports）完全無關，不共用資料表。
 */
export const gameNewsTable = pgTable(
  "game_news",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 事件發生的遊戲日期（YYYY-MM-DD，回合推進後的當回合日期）。 */
    gameDate: text("game_date").notNull(),
    /** 遊戲年份（由 gameDate 取出，方便顯示/排序）。 */
    year: integer("year").notNull(),
    /** 時代 slug（例如 "modern"）。 */
    era: text("era").notNull(),
    /**
     * 分類 slug：war（宣戰）｜treaty（締約）｜era（時代推進）｜
     * rise_fall（國家興亡）｜politics（重大政治）｜world（其他國際局勢）。
     */
    category: text("category").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** 重大程度：目前一律 'major'（僅重大事件會寫入）。保留欄位供日後分級。 */
    significance: text("significance").notNull().default("major"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdIdx: index("game_news_created_idx").on(t.createdAt),
  }),
);

export type GameNews = typeof gameNewsTable.$inferSelect;
export type InsertGameNews = typeof gameNewsTable.$inferInsert;
