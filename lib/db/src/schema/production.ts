import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";
import { mapCitiesTable } from "./mapRegions";

/**
 * Task #149 — 生產科技（技術樹）系統。
 *
 * 與社會科技（socialTech.ts）結構相同：AI 依「當前時代」批次生成次要科技作為
 * 「3 選 1」抽牌池補充，另有後端種入、每個時代固定的「關鍵技術」（★）帶結構化
 * 效果（生產力／科技點數／人口增長率、暫時人口增長 buff、建築維護費減免、
 * 解鎖文化滿意度、以及城牆/殖民/海軍解鎖旗標）。關鍵技術也會解鎖可興建的城市
 * 建築（見 lib/production.ts 的 KEY_TECH_BUILDINGS）。
 *
 * 牌組（player_tech_hand）與領域時代（player_tech_domains）沿用社會科技建立的
 * 共用表，domain = "production"。
 */

/**
 * 生產科技效果（存於 production_techs.effects jsonb）。數值型效果（生產力、
 * 科技點數、人口增長率、建築維護費減免、暫時人口增長）以 value 疊加或觸發；
 * 旗標型效果（開啟文化滿意度、解鎖城牆/殖民/海軍）以 value≥1 視為開啟。
 * 建築解鎖不放在這裡——由 lib/production.ts 的 KEY_TECH_BUILDINGS 依關鍵技術
 * key_slug 對應。
 */
export type ProductionTechEffectTarget =
  | "productivity"
  | "techPoints"
  | "populationGrowth"
  | "tempPopulationGrowth"
  | "buildingUpkeepReduction"
  | "enableCulture"
  | "enableCityWall"
  | "enableColonization"
  | "enableNaval";

export interface ProductionTechEffect {
  target: ProductionTechEffectTarget;
  value: number;
}

/**
 * 城市建築：某玩家在某城市興建的建築（可同型堆疊，效果疊加）。每座城市的建築
 * 數受建築槽上限（社會科技決定）限制；建築本身帶建造成本、每回合維護費與加成。
 * building_type 對應 lib/production.ts 的 BUILDINGS。
 */
export const cityBuildingsTable = pgTable(
  "city_buildings",
  {
    id: serial("id").primaryKey(),
    discordUserId: text("discord_user_id")
      .notNull()
      .references(() => playerNationsTable.discordUserId, {
        onDelete: "cascade",
      }),
    cityId: integer("city_id")
      .notNull()
      .references(() => mapCitiesTable.id, { onDelete: "cascade" }),
    buildingType: text("building_type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("city_buildings_user_idx").on(t.discordUserId),
    cityIdx: index("city_buildings_city_idx").on(t.cityId),
  }),
);

export type CityBuilding = typeof cityBuildingsTable.$inferSelect;

/**
 * 國家暫時人口增長 buff：研發帶 tempPopulationGrowth 效果的生產科技時建立，
 * 提供 growth_pct 的額外人口增長率，持續 remaining_turns 個回合（每回合結算 −1，
 * 歸零即刪除）。以 discord_user_id 歸戶（只有有主國家能研發）。
 */
export const nationPopulationBuffsTable = pgTable(
  "nation_population_buffs",
  {
    id: serial("id").primaryKey(),
    discordUserId: text("discord_user_id")
      .notNull()
      .references(() => playerNationsTable.discordUserId, {
        onDelete: "cascade",
      }),
    growthPct: integer("growth_pct").notNull(),
    remainingTurns: integer("remaining_turns").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("nation_population_buffs_user_idx").on(t.discordUserId),
  }),
);

export type NationPopulationBuff = typeof nationPopulationBuffsTable.$inferSelect;

/**
 * Task #355 — 國家暫時滿意度 buff：管理員發放「限回合數的滿意度暫時加成」時建立。
 * 針對單一方向（law/culture/religion/rights）提供 satisfaction_offset 的有效值
 * 暫時偏移，持續 remaining_turns 個回合（每回合結算 −1，歸零即刪除）。不改動
 * player_nations 上的滿意度基礎欄位；只在計算「有效滿意度」時作為暫時偏移併入。
 * 以 discord_user_id 歸戶，故只對有主玩家國家生效（NPC／無主國家自動略過）。
 */
export const nationSatisfactionBuffsTable = pgTable(
  "nation_satisfaction_buffs",
  {
    id: serial("id").primaryKey(),
    discordUserId: text("discord_user_id")
      .notNull()
      .references(() => playerNationsTable.discordUserId, {
        onDelete: "cascade",
      }),
    /** 滿意度方向：law／culture／religion／rights。 */
    direction: text("direction").notNull(),
    satisfactionOffset: integer("satisfaction_offset").notNull(),
    remainingTurns: integer("remaining_turns").notNull(),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userIdx: index("nation_satisfaction_buffs_user_idx").on(t.discordUserId),
  }),
);

export type NationSatisfactionBuff =
  typeof nationSatisfactionBuffsTable.$inferSelect;
