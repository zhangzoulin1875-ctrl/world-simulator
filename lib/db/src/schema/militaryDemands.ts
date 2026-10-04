import { sql } from "drizzle-orm";
import { pgTable, text, integer, serial, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * 軍方進攻要求。每國同時最多一筆 pending(部分唯一索引)。
 * status: pending(待回應) / accepted(同意並開戰) / refused(拒絕,已扣軍方滿意度)
 *       / auto_war(軍方滿意度過低,直接開戰) / expired(目標失效或已處理)
 */
export const militaryDemandsTable = pgTable(
  "military_demands",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id").notNull().references(() => playerNationsTable.id, { onDelete: "cascade" }),
    regionId: integer("region_id").notNull(),
    regionName: text("region_name").notNull(),
    /** 目標國;null = 無主地 */
    targetNationId: uuid("target_nation_id"),
    targetNationName: text("target_nation_name"),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    nationIdx: index("military_demands_nation_idx").on(t.nationId, t.createdAt),
    onePending: uniqueIndex("military_demands_one_pending_uidx").on(t.nationId).where(sql`${t.status} = 'pending'`),
  }),
);

export type MilitaryDemand = typeof militaryDemandsTable.$inferSelect;
