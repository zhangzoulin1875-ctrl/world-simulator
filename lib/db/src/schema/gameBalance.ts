import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Task #451 — 遊戲平衡設定（單列 id=1）：params 為部分覆寫，讀取時與程式內
 * 預設值合併（api-server lib/gameBalance.ts 的 zod schema 定義全部可調參數
 * 與預設值；未知鍵與超界值一律丟棄）。
 */
export const gameBalanceSettingsTable = pgTable("game_balance_settings", {
  id: integer("id").primaryKey().default(1),
  params: jsonb("params")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type GameBalanceSettingsRow =
  typeof gameBalanceSettingsTable.$inferSelect;

/**
 * Task #451 — AI 濫用行為紀錄（兵種設計退件／戰爭指令懲罰／內政政策懲罰）。
 * 刻意**不設 FK**：國家被硬刪或玩家退出後紀錄仍須保留供管理員稽核，
 * 以 nationName 快照 + nullable id 欄位承接。
 */
export const aiAbuseRecordsTable = pgTable(
  "ai_abuse_records",
  {
    id: serial("id").primaryKey(),
    /** unit_design | war_order | interior */
    domain: text("domain").notNull(),
    /** rejected（直接退件）| penalized（結算內懲罰） */
    verdict: text("verdict").notNull(),
    discordUserId: text("discord_user_id"),
    nationId: uuid("nation_id"),
    nationName: text("nation_name"),
    /** 玩家原始輸入（自由文字）。 */
    inputText: text("input_text").notNull(),
    /** AI／伺服器給出的退件或懲罰理由（zh-TW）。 */
    reason: text("reason").notNull(),
    /** 額外脈絡（campaignId、category、orderType…）。 */
    context: jsonb("context")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Task #459 — 撤銷/補償：一次性（NULL = 未撤銷）。 */
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    /** 管理員撤銷備註（zh-TW，選填）。 */
    revertNote: text("revert_note"),
    /** 實際套用的補償內容快照（money/satisfaction/stability/unrest delta）。 */
    compensation: jsonb("compensation")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    /** Task #547 — 逐案加重處罰：一次性（NULL = 未加重）；與 revertedAt 互斥。 */
    punishedAt: timestamp("punished_at", { withTimezone: true }),
    /** 管理員加重處罰備註（zh-TW，選填）。 */
    punishNote: text("punish_note"),
    /** 實際套用的加重處罰內容快照（罰款/滿意度/穩定/暴動/厭戰/軍隊傷亡%）。 */
    punishment: jsonb("punishment")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    domainCreatedIdx: index("ai_abuse_records_domain_created_idx").on(
      t.domain,
      t.createdAt,
    ),
    nationCreatedIdx: index("ai_abuse_records_nation_created_idx").on(
      t.nationId,
      t.createdAt,
    ),
    userCreatedIdx: index("ai_abuse_records_user_created_idx").on(
      t.discordUserId,
      t.createdAt,
    ),
  }),
);

export type AiAbuseRecord = typeof aiAbuseRecordsTable.$inferSelect;
export type InsertAiAbuseRecord = typeof aiAbuseRecordsTable.$inferInsert;
