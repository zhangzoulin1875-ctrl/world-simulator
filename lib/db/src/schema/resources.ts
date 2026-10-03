import {
  pgTable,
  integer,
  text,
  uuid,
  serial,
  timestamp,
  uniqueIndex,
  index,
  bigint,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";
import { mapRegionsTable } from "./mapRegions";

/**
 * Task #406 — 地區資源建築（木材廠／礦場）。
 * 每個地區每種建築最多一座（unique (region_id, building_type)，重複 → 409）。
 * level 1 起跳、逐級升級；產出 = 50 × level／回合，工人 = 1000 × level，
 * 全國工人總數 ≤ 國家人口（寫入端同交易檢查）。建築由建造國持有
 * （nation_id），暫時跟隨地區掌控權的移轉規則之後再議。
 */
export const regionBuildingsTable = pgTable(
  "region_buildings",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    regionId: integer("region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    /** lumber_mill | mine */
    buildingType: text("building_type").notNull(),
    level: integer("level").notNull().default(1),
    /**
     * 本建築歷來占用的生產力總額（建造＋各級升級成本累計；不變量：
     * nation.production_spent = Σ(armies.production_reserved) + Σ(本欄)）。
     * 拆除時據此釋放 production_spent（GREATEST(0, …) 夾底）。
     */
    productionReserved: bigint("production_reserved", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    regionTypeUidx: uniqueIndex("region_buildings_region_type_uidx").on(
      t.regionId,
      t.buildingType,
    ),
    nationIdx: index("region_buildings_nation_idx").on(t.nationId),
  }),
);

export type RegionBuilding = typeof regionBuildingsTable.$inferSelect;
export type InsertRegionBuilding = typeof regionBuildingsTable.$inferInsert;
