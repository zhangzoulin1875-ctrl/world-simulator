import {
  pgTable, serial, integer, text, doublePrecision, timestamp, uuid, uniqueIndex, index, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { playerNationsTable } from "./playerNations";

/**
 * 廢棄油井勝利條件(2026-10-09)。全部是獨立新表:不碰 war_campaigns,也不改任何既有欄位。
 * 計分以真實經過的小時數為準(見 oilRigCore.ts),不依回合數。
 */

/** 賽季:同一時間只有一個 active。達 10000 分 → cooldown,等管理員選下一賽季年代後重開。 */
export const oilSeasonsTable = pgTable(
  "oil_seasons",
  {
    id: serial("id").primaryKey(),
    seasonNumber: integer("season_number").notNull(),
    /** active | cooldown */
    status: text("status").notNull().default("active"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    winnerNationId: uuid("winner_nation_id").references(() => playerNationsTable.id, { onDelete: "set null" }),
    /** 勝者名稱快照:國家日後被刪除也能在歷史榜單顯示。 */
    winnerNationName: text("winner_nation_name"),
    winnerScore: doublePrecision("winner_score"),
    /** 上次計分結算時間;下次結算以此計算經過小時數。 */
    lastScoredAt: timestamp("last_scored_at", { withTimezone: true }).notNull().defaultNow(),
    /** 管理員在冷卻期間指定的下一賽季年代(eraSlug)。 */
    nextEra: text("next_era"),
  },
  (t) => ({
    seasonNumberUidx: uniqueIndex("oil_seasons_number_uidx").on(t.seasonNumber),
    // 同時只能有一個 active 賽季(部分唯一索引,防並行重複開季)
    oneActiveUidx: uniqueIndex("oil_seasons_one_active_uidx").on(t.status).where(sql`${t.status} = 'active'`),
    statusCheck: check("oil_seasons_status_check", sql`${t.status} IN ('active','cooldown')`),
  }),
);

/** 油井本體。slug 與 oilRigSeeds.ts 對應;持有者隨賽季重置為 null(無人佔領)。 */
export const oilRigsTable = pgTable(
  "oil_rigs",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    sea: text("sea").notNull(),
    lng: doublePrecision("lng").notNull(),
    lat: doublePrecision("lat").notNull(),
    /** 目前佔領國;null = 無人佔領(系統守軍駐守)。 */
    holderNationId: uuid("holder_nation_id").references(() => playerNationsTable.id, { onDelete: "set null" }),
    heldSince: timestamp("held_since", { withTimezone: true }),
    /** 系統守軍強度(無人佔領時的防守值)。 */
    garrisonStrength: integer("garrison_strength").notNull().default(100),
  },
  (t) => ({
    slugUidx: uniqueIndex("oil_rigs_slug_uidx").on(t.slug),
    holderIdx: index("oil_rigs_holder_idx").on(t.holderNationId),
    garrisonCheck: check("oil_rigs_garrison_check", sql`${t.garrisonStrength} >= 0`),
  }),
);

/** 賽季積分:每個(賽季, 國家)一列。 */
export const oilScoresTable = pgTable(
  "oil_scores",
  {
    id: serial("id").primaryKey(),
    seasonId: integer("season_id").notNull().references(() => oilSeasonsTable.id, { onDelete: "cascade" }),
    nationId: uuid("nation_id").notNull().references(() => playerNationsTable.id, { onDelete: "cascade" }),
    score: doublePrecision("score").notNull().default(0),
    /** 首次達到目前分數的時間,同分勝負時取較早者。 */
    reachedAt: timestamp("reached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    seasonNationUidx: uniqueIndex("oil_scores_season_nation_uidx").on(t.seasonId, t.nationId),
    seasonScoreIdx: index("oil_scores_season_score_idx").on(t.seasonId, t.score),
    scoreCheck: check("oil_scores_score_check", sql`${t.score} >= 0`),
  }),
);

export type OilSeason = typeof oilSeasonsTable.$inferSelect;
export type OilRig = typeof oilRigsTable.$inferSelect;
export type OilScore = typeof oilScoresTable.$inferSelect;
