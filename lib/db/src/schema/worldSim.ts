import {
  pgTable,
  text,
  jsonb,
  uuid,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Task #176 — AI 驅動 NPC 系統的稽核紀錄。
 *
 * 每次 AI 世界變更（管理員隨選生成或每回合自動模擬）寫入一筆可讀紀錄，
 * 供管理員檢視「AI 這回合做了什麼」。source 區分 manual／auto；instruction
 * 為管理員原始指令（自動模擬時為當回合的歷史脈絡摘要）；summary 為 zh-TW
 * 人類可讀摘要；changes 為結構化變更清單（新增／編輯／刪除國家、領土搬動）。
 * 只寫入 NPC 與無主國家的變更——玩家國家永不被更動，故不會出現於此。
 */
export interface WorldSimAuditChange {
  /** 變更類型：createNpc／updateNpc／deleteNation／moveTerritory／npcTech／npcDiplomacy 等。 */
  action: string;
  /** 相關國家名稱（顯示用）。 */
  nationName: string;
  /** 變更細節（zh-TW，一句話）。 */
  detail: string;
}

export const worldSimAuditsTable = pgTable(
  "world_sim_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** 'manual'（管理員隨選）｜'auto'（回合自動模擬）。 */
    source: text("source").notNull(),
    /** 管理員原始指令；自動模擬時存當回合歷史脈絡摘要。null = 無。 */
    instruction: text("instruction"),
    /** zh-TW 人類可讀摘要。 */
    summary: text("summary").notNull(),
    /** 結構化變更清單。 */
    changes: jsonb("changes")
      .$type<WorldSimAuditChange[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdIdx: index("world_sim_audits_created_idx").on(t.createdAt),
  }),
);

export type WorldSimAudit = typeof worldSimAuditsTable.$inferSelect;
export type InsertWorldSimAudit = typeof worldSimAuditsTable.$inferInsert;
