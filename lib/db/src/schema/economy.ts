import {
  pgTable,
  text,
  serial,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uuid,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * 經濟系統（Task #117）。
 *
 * - `finance_pending_ideas`：玩家提交的「財政政策」自由文字（加稅／減稅／
 *   增稅來源…），一國僅能有一則待判定想法（unique nation_id）；回合結算時
 *   由 AI 判定，判定後刪除。
 * - `finance_entries`：財政政策判定後的歷史紀錄（好事件／壞事件、實際套用的
 *   稅率／滿意度／穩定度變化）。純顯示用；效果在結算當下已一次性套用，
 *   不會每回合重複套用。Task #564 起財政政策不再變動國庫金錢——新條目不寫
 *   `moneyDelta`；欄位保留為 optional 僅供舊歷史條目顯示。
 * - `nation_finance_ledger`：外交與內政「事件」造成的金錢收支流水（外交贈禮、
 *   條約款項、內政懲罰／政變…）。純顯示用——金錢在來源處已即時變動，本表絕
 *   不再次套用到 money（避免重複計算）。舊 `fiscal_policy` 類別列僅供顯示，
 *   新流水不再產生（Task #564）。
 */

export interface FinanceEntryDetails {
  taxRateBefore?: number;
  taxRateAfter?: number;
  /** Task #564 起新條目不再寫入；保留給舊歷史條目顯示。 */
  moneyDelta?: number;
  satisfactionDelta?: number;
  stabilityDelta?: number;
}

export const financePendingIdeasTable = pgTable(
  "finance_pending_ideas",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    idea: text("idea").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationUidx: uniqueIndex("finance_pending_ideas_nation_uidx").on(t.nationId),
  }),
);
export type FinancePendingIdea = typeof financePendingIdeasTable.$inferSelect;

export const financeEntriesTable = pgTable(
  "finance_entries",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull(),
    isGood: boolean("is_good").notNull(),
    details: jsonb("details")
      .$type<FinanceEntryDetails>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationCreatedIdx: index("finance_entries_nation_created_idx").on(
      t.nationId,
      t.createdAt,
    ),
  }),
);
export type FinanceEntry = typeof financeEntriesTable.$inferSelect;

export const nationFinanceLedgerTable = pgTable(
  "nation_finance_ledger",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    // 有號金額：正 = 收入、負 = 支出。
    amount: bigint("amount", { mode: "number" }).notNull(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationCreatedIdx: index("nation_finance_ledger_nation_created_idx").on(
      t.nationId,
      t.createdAt,
    ),
  }),
);
export type NationFinanceLedger = typeof nationFinanceLedgerTable.$inferSelect;
