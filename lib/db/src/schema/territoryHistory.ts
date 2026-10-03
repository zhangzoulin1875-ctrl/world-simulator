import {
  pgTable,
  serial,
  integer,
  text,
  uuid,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { mapRegionsTable } from "./mapRegions";
import { playerNationsTable } from "./playerNations";

/**
 * Task #392 — 領土（region_controls）變更歷史。
 *
 * 每一條會改動「掌控 %」的寫入路徑（建國、戰爭結算、條約割讓、管理員手動
 * 編輯、國家管理 full-replace、每小時超額修復、世界模擬）都在同一交易內
 * 追加紀錄，供 admin 後台依國家查詢完整領土變化時間軸。
 * 只記掌控 % 的變更；population_bonus 的變化不記錄。
 * 國家硬刪 → 紀錄隨 FK cascade 一併刪除（沿用既有 FK 慣例，刪國不會 500）。
 */
export const territoryChangeHistoryTable = pgTable(
  "territory_change_history",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    regionId: integer("region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    /** 變更前掌控 %（0 = 原本未掌控）。 */
    percentBefore: integer("percent_before").notNull(),
    /** 變更後掌控 %（0 = 掌控被清除）。 */
    percentAfter: integer("percent_after").notNull(),
    /**
     * 變更類型：founding｜war｜treaty｜admin_edit｜admin_nation_replace｜
     * overfull_repair｜world_sim。
     */
    changeType: text("change_type").notNull(),
    /** zh-TW 理由文字（系統自動產生，或管理員手動輸入）。 */
    reason: text("reason").notNull(),
    /** 關聯戰爭 id（戰爭領土移轉時填入；無 FK，戰爭列刪除不影響歷史）。 */
    warId: integer("war_id"),
    /** 關聯條約 id（條約割讓時填入；無 FK）。 */
    treatyId: integer("treaty_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationCreatedIdx: index("territory_change_history_nation_created_idx").on(
      t.nationId,
      t.createdAt,
    ),
  }),
);

export type TerritoryChangeHistory =
  typeof territoryChangeHistoryTable.$inferSelect;
export type InsertTerritoryChangeHistory =
  typeof territoryChangeHistoryTable.$inferInsert;
