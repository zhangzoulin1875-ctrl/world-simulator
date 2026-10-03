import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  serial,
  timestamp,
  jsonb,
  uuid,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * Task #43 — 內政系統（政策與傳統／歷史條目／待判定想法／參數設定）。
 *
 * 方向（direction）：law=秩序、culture=文化、religion=宗教、rights=人權。
 * 條目類型（entryType）：policy=政策、tradition=傳統、reform=變革、event=事件。
 * 變革與事件的效果隨回合線性淡化（remaining/duration），政策與傳統不淡化，
 * 直到玩家廢除（status=repealed）或到期（有 durationTurns 的短暫政策）。
 */

/**
 * 持續性加減成：satisfaction/stability 為百分點偏移，production/tech/populationGrowth
 * 為百分比加成。Task #393 起新增「指定方向」的滿意度目標（satisfactionLaw|
 * satisfactionCulture|satisfactionReligion|satisfactionRights）：不論條目掛在哪個
 * 方向，都直接作用在指名的滿意度；舊式 satisfaction 維持依條目 direction 作用。
 */
export interface PoliticsModifier {
  target:
    | "satisfaction"
    | "stability"
    | "production"
    | "tech"
    | "populationGrowth"
    | "warWeariness"
    | "foodGrowth"
    | "satisfactionLaw"
    | "satisfactionCulture"
    | "satisfactionReligion"
    | "satisfactionRights"
    | "satisfactionMilitary"
    | "militaryObedience";
  value: number;
}

export const politicsEntriesTable = pgTable(
  "politics_entries",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    entryType: text("entry_type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    modifiers: jsonb("modifiers")
      .$type<PoliticsModifier[]>()
      .notNull()
      .default([]),
    /** null = 永久（政策／傳統）；否則持續 N 回合。 */
    durationTurns: integer("duration_turns"),
    /** null = 永久；否則剩餘回合，0 時 status → expired。 */
    remainingTurns: integer("remaining_turns"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    nationDirectionIdx: index("politics_entries_nation_direction_idx").on(
      t.nationId,
      t.direction,
    ),
    nationStatusIdx: index("politics_entries_nation_status_idx").on(
      t.nationId,
      t.status,
    ),
  }),
);

export type PoliticsEntry = typeof politicsEntriesTable.$inferSelect;
export type InsertPoliticsEntry = typeof politicsEntriesTable.$inferInsert;

/**
 * 待判定政策想法：全國最多一筆（Task #393 起不分方向，direction='general'），
 * 回合結算時由 AI 綜合判定後刪除。舊制帶方向（law|culture|religion|rights）
 * 的遺留列仍以舊邏輯判定到清空為止。
 */
export const politicsPendingIdeasTable = pgTable(
  "politics_pending_ideas",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 'general' = 新制綜合政策；law|culture|religion|rights = 舊制遺留列。 */
    direction: text("direction").notNull().default("general"),
    idea: text("idea").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    /**
     * 部分唯一索引：只涵蓋新制 direction='general' 列。
     * 不能用全欄唯一索引——正式 DB 仍有舊制多方向遺留列（同國多筆），
     * Publish 的 schema diff 會直接對正式 DB 建索引（先於任何去重）而失敗。
     * 「全國一筆（含舊制遺留列）」由插入路由的前置檢查＋此索引共同保證。
     */
    nationGeneralUidx: uniqueIndex("politics_pending_ideas_nation_general_uidx")
      .on(t.nationId)
      .where(sql`${t.direction} = 'general'`),
  }),
);

export type PoliticsPendingIdea = typeof politicsPendingIdeasTable.$inferSelect;

/**
 * Task #127 — 待判定的政府決策（每國最多一筆，回合結算時由 AI 判定後刪除）。
 * 與四方向政策想法不同：政府決策是「國家級」自由文字施政，AI 依政體、政治
 * 支持度、政治註記判定成敗，結果升降政治支持度並寫入政治歷史。
 */
export const politicsPendingDecisionsTable = pgTable(
  "politics_pending_decisions",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    decision: text("decision").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationUidx: uniqueIndex("politics_pending_decisions_nation_uidx").on(
      t.nationId,
    ),
  }),
);

export type PoliticsPendingDecision =
  typeof politicsPendingDecisionsTable.$inferSelect;

/**
 * Task #127 — 政治歷史（時間軸）：政體變更、政府決策成敗、政變等國家級
 * 政治大事的流水紀錄。eventType：founding=建國、decision_success/decision_failure=
 * 政府決策、government_change=政體變更（主動）、coup=政變（被動變更）。
 */
export const politicsHistoryTable = pgTable(
  "politics_history",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationCreatedIdx: index("politics_history_nation_created_idx").on(
      t.nationId,
      t.createdAt,
    ),
  }),
);

export type PoliticsHistoryEntry = typeof politicsHistoryTable.$inferSelect;

/**
 * 內政參數設定（單列 id=1）：params 為部分覆寫，讀取時與程式內預設值合併
 * （lib politics.ts 的 zod schema 定義全部可調數字與預設）。
 */
export const politicsSettingsTable = pgTable("politics_settings", {
  id: integer("id").primaryKey().default(1),
  params: jsonb("params").$type<Record<string, number>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PoliticsSettingsRow = typeof politicsSettingsTable.$inferSelect;
