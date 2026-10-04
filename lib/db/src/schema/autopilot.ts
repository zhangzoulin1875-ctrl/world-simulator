import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * AI 全權託管（autopilot）設定：每國一列。
 * 啟用後：伺服器端鎖定玩家所有寫入操作（423），回合結算時由託管引擎代打；
 * 僅能由玩家本人「解除託管」。獨立成表，不動 player_nations。
 */
export const AUTOPILOT_STYLES = ["steady", "balanced", "expansion"] as const;
export type AutopilotStyle = (typeof AUTOPILOT_STYLES)[number];

export const autopilotSettingsTable = pgTable("autopilot_settings", {
  nationId: uuid("nation_id")
    .primaryKey()
    .references(() => playerNationsTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  /** steady=穩健發展 / balanced=均衡 / expansion=擴張。 */
  style: text("style").notNull().default("balanced"),
  /** 玩家給託管 AI 的自由文字方針（≤500 字）。 */
  directive: text("directive").notNull().default(""),
  enabledAt: timestamp("enabled_at", { withTimezone: true }),
  /** 託管期間已處理的回合數。 */
  turnsRun: integer("turns_run").notNull().default(0),
  /** 最近一次託管回合的行動摘要（最多 ~30 筆，新到舊）。 */
  recentActions: jsonb("recent_actions")
    .$type<Array<{ at: string; area: string; text: string; ok: boolean }>>()
    .notNull()
    .default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AutopilotSettings = typeof autopilotSettingsTable.$inferSelect;
