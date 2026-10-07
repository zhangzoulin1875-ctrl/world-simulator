import { integer, serial, text, timestamp, uniqueIndex, index, uuid } from "drizzle-orm/pg-core";
import { pgTable } from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * 國際組織(共產國際為第一個)。世界級 NPC 行為者:玩家不能操作,只有決策層決定它做什麼。
 * 規則見 lib/intlOrg/core.ts。
 */

/** 一個組織一列。slug 唯一(例:comintern)。tick = 這個組織自己的世界結算計數。 */
export const intlOrgsTable = pgTable(
  "intl_orgs",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** 意識形態標籤,對應奪權內戰的 RebelIdeology(red/black…)。 */
    ideology: text("ideology").notNull(),
    influence: integer("influence").notNull().default(10),
    tick: integer("tick").notNull().default(0),
    /** 下次決策的 tick(每 DECISION_EVERY_TURNS 一次)。 */
    nextDecisionTick: integer("next_decision_tick").notNull().default(0),
    /** 累積的挫折(策反失敗、被干涉國好轉),下次影響力計算時扣掉後歸零。 */
    setbacks: integer("setbacks").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ slugUq: uniqueIndex("intl_orgs_slug_uq").on(t.slug) }),
);

/**
 * 預告表:先寫入,到 execute_tick 才執行。玩家看的就是這張表。
 * status: planned / executed / cancelled。
 */
export const intlOrgPlansTable = pgTable(
  "intl_org_plans",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id").notNull().references(() => intlOrgsTable.id, { onDelete: "cascade" }),
    targetNationId: uuid("target_nation_id").references(() => playerNationsTable.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    plannedTick: integer("planned_tick").notNull(),
    executeTick: integer("execute_tick").notNull(),
    status: text("status").notNull().default("planned"),
    /** 決策來源:rule(規則版)/ ai。除錯與對帳用。 */
    source: text("source").notNull().default("rule"),
    /** 執行結果的一行說明(玩家可見的歷史)。 */
    resultSummary: text("result_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
  },
  (t) => ({
    orgStatusIdx: index("intl_org_plans_org_status_idx").on(t.orgId, t.status),
    targetIdx: index("intl_org_plans_target_idx").on(t.targetNationId, t.status),
    // 同一個組織對同一國同時只能有一筆 planned 預告(部分唯一索引在遷移裡建立)
  }),
);
