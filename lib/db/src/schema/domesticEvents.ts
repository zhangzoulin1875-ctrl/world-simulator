import { pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { playerNationsTable } from "./playerNations";

/** 事件呈現給玩家的選項(文字可被 AI 改寫,效果永遠以程式內目錄為準,不存在這裡) */
export interface DomesticEventChoiceView {
  id: string;
  label: string;
  hint: string;
}

/**
 * 國內隨機事件(2026-10-05)。每國同時只有一個 pending 事件(部分唯一索引保證)。
 * 處理完的事件保留為歷史(status = resolved / expired),供日後顯示與除錯。
 */
export const domesticEventsTable = pgTable(
  "domestic_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    choices: jsonb("choices").$type<DomesticEventChoiceView[]>().notNull(),
    /** pending | resolved | expired */
    status: text("status").notNull().default("pending"),
    createdTick: integer("created_tick").notNull(),
    dueTick: integer("due_tick").notNull(),
    chosenId: text("chosen_id"),
    /** 處理結果的一句話摘要(給玩家看) */
    outcome: text("outcome"),
    /** AI 是否已改寫過文字(避免重複排程) */
    aiRewritten: integer("ai_rewritten").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    nationIdx: index("domestic_events_nation_idx").on(t.nationId, t.createdAt),
    onePending: uniqueIndex("domestic_events_one_pending_uq").on(t.nationId).where(sql`${t.status} = 'pending'`),
  }),
);
