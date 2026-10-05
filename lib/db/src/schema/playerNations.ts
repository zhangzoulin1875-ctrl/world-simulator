import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  serial,
  timestamp,
  jsonb,
  uuid,
  customType,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { mapRegionsTable } from "./mapRegions";

/** Postgres bytea column (drizzle has no built-in type for it). */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Nations are independent entities (Task #30): a nation has its own uuid id
 * and an OPTIONAL owner (`discordUserId`, unique — one player owns at most
 * one nation at a time). A nation with a null owner is 無主國家: it stays on
 * the map with its region controls and can be claimed by any player. Rows
 * are created only through the founding flow (no more auto-create).
 * Image URLs are per-nation overrides — when null the global defaults from
 * `game_appearance_defaults` (or the shipped static assets) apply.
 */
export const playerNationsTable = pgTable("player_nations", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Owner. Null = 無主國家 (claimable). Unique: one nation per player. */
  discordUserId: text("discord_user_id").unique(),
  name: text("name"),
  /** 領導者名稱（玩家名稱），set during founding / editable in settings. */
  leaderName: text("leader_name"),
  flagUrl: text("flag_url"),
  emblemUrl: text("emblem_url"),
  /**
   * 玩家自訂地圖顏色（#rrggbb 小寫十六進位）。null = 未設定，前端依國家
   * 建立順序退回預設調色盤。
   */
  mapColor: text("map_color"),
  government: text("government"),
  /**
   * Accumulated tech points (stored value; the turn engine that increments it
   * does not exist yet). Population / production / tech-per-turn are NOT
   * stored — they are computed per request from region_controls ×
   * map_region_era_stats for the current era (Task #24).
   */
  techPoints: integer("tech_points").notNull().default(0),
  /**
   * Task #510 — 兵種設計次數（體力條式，0–5 整數）。建國即滿 5 次；每日回合
   * +1（SQL LEAST(5, x+1) 封頂）；每次 AI 兵種設計消耗 1 次，AI 失敗退回
   * 1 次（同樣封頂 5）。取代原本的科技點數設計成本。
   */
  unitDesignCharges: integer("unit_design_charges").notNull().default(5),
  /**
   * 武器設計次數：每回合回滿至 3（weaponDesignChargeCap）；每次 AI 武器
   * 設計消耗 1 次，AI 失敗退回。武器設計屬兵種設計的姊妹系統。
   */
  weaponDesignCharges: integer("weapon_design_charges").notNull().default(3),
  money: bigint("money", { mode: "number" }).notNull().default(10_000),
  /**
   * Task #406 — 資源庫存：木材與礦石（整數 ≥0）。由地區建築（木材廠／礦場）
   * 每回合產出；製造兵種與條約交換時扣減。
   */
  wood: bigint("wood", { mode: "number" }).notNull().default(0),
  ore: bigint("ore", { mode: "number" }).notNull().default(0),
  /**
   * Task #27 — cumulative production / population consumed by military
   * recruiting. Available amounts = computed stats − spent (clamped at 0).
   * Stored because the base stats themselves are computed per request.
   */
  productionSpent: bigint("production_spent", { mode: "number" })
    .notNull()
    .default(0),
  populationSpent: bigint("population_spent", { mode: "number" })
    .notNull()
    .default(0),
  /**
   * Task #214 — 生產力持久化修正量：自訂條約每回合轉移生產力時累積的偏移量
   * （付款方為負、受益方為正）。生產力為即時計算，故轉移以此欄位表現。
   * 有效生產力 = max(0, 地區計算生產力 + productionBonus) 再套內政乘數/加成。
   */
  productionBonus: bigint("production_bonus", { mode: "number" })
    .notNull()
    .default(0),
  /**
   * Task #43 — 內政數值（0–100）。stability/unrest 由回合結算變動；
   * warWeariness 目前只作為軍隊攻擊修正的資料來源（升降規則待戰爭系統）。
   * 四項滿意度為「基底值」，政策／事件的持續性加減成以 politics_entries
   * 疊加後才是有效值。
   */
  stability: integer("stability").notNull().default(50),
  unrest: integer("unrest").notNull().default(0),
  warWeariness: integer("war_weariness").notNull().default(0),
  satisfactionFarmers: integer("satisfaction_farmers").notNull().default(60),
  satisfactionWorkers: integer("satisfaction_workers").notNull().default(60),
  satisfactionNobles: integer("satisfaction_nobles").notNull().default(60),
  satisfactionClergy: integer("satisfaction_clergy").notNull().default(60),
  /**
   * Task #402 — 第五面向「軍方」：軍方滿意度（基底值，politics_entries 疊加後
   * 才是有效值）與軍方服從度（0–100，決定新建軍團初始士氣；低滿意＋低服從
   * 會觸發逃兵／軍事政變）。
   */
  satisfactionMilitary: integer("satisfaction_military").notNull().default(60),
  militaryObedience: integer("military_obedience").notNull().default(60),
  /**
   * Task #584 — 政變後果倒數（每回合 −1，夾 ≥0）：
   * coupPolicyLockTurns > 0 期間封鎖政策想法／政府決策／AI 兵種設計；
   * coupMoralePenaltyTurns > 0 期間戰役結算時全軍士氣以設定懲罰值扣減
   * （純計算層，不寫入軍團 morale）。
   */
  coupPolicyLockTurns: integer("coup_policy_lock_turns").notNull().default(0),
  coupMoralePenaltyTurns: integer("coup_morale_penalty_turns")
    .notNull()
    .default(0),
  /**
   * 農民佔總人口的百分比（0–100，預設 100）；工人 % = 100 − 農民 %。
   * 純顯示用途，不影響任何玩法計算。
   */
  farmerPopulationPct: integer("farmer_population_pct").notNull().default(100),
  /**
   * Task #127 — 政府治理系統。
   * politicalSupport：政治支持度（0–100，預設 50）。影響政府決策成功率與
   *   低支持度時的反制事件機率；決策成功／失敗與回合結算會升降。
   * governmentChangeAcceptance：政體變更接受度（0–100，預設 0）。支持度長期
   *   偏低時累積、偏高時消退；達 100 時（且社會關鍵科技已解鎖其他政體）於回合
   *   結算主動變更政體並歸零。
   * politicalNote：政治註記——AI 依政體／時代生成的「治理風格」短註記，顯示於
   *   政治頁並作為所有後續政治 AI 呼叫的脈絡；政體變更後重新生成。null = 尚未生成
   *   （overview 惰性生成、政體變更時重生）。
   */
  politicalSupport: integer("political_support").notNull().default(50),
  governmentChangeAcceptance: integer("government_change_acceptance")
    .notNull()
    .default(0),
  politicalNote: text("political_note"),
  /**
   * Task #233 — 外交態度：管理員為 NPC／無主國家設定（或由 AI 生成）的一段外交
   * 傾向敘述，與 politicalNote 一起注入該國的外交決策提示，實際影響其談判與對話
   * 傾向。純管理員功能，玩家不可見。null = 未設定。
   */
  diplomaticAttitude: text("diplomatic_attitude"),
  /**
   * 經濟系統（Task #117）。
   * taxRatePct：人口稅率（%，新建國家預設 3；既有國家不動）。只能透過 AI 判定的財政政策調整，
   *   不是直接滑桿——加稅／減稅的代價由 AI 決定。
   * taxEfficiencyBonus：稅收效率的額外加成（%，未來經濟科技用；基礎效率由
   *   時代決定，見 lib/economy.ts）。
   * （四項預算分配 budget_*_pct 已於 Task #401 整組移除。）
   */
  taxRatePct: integer("tax_rate_pct").notNull().default(3),
  taxEfficiencyBonus: integer("tax_efficiency_bonus").notNull().default(0),
  /**
   * Task #382 — 糧食政策開關（非累積資源；產出/消耗 per-request 計算）。
   * foodPolicyMobilization：增產動員（產出 +10%）；
   * foodPolicyRationing：節約配給（平民消耗 −10%）。啟用期間每回合扣滿意度。
   */
  foodPolicyMobilization: boolean("food_policy_mobilization")
    .notNull()
    .default(false),
  foodPolicyRationing: boolean("food_policy_rationing")
    .notNull()
    .default(false),
  /**
   * Task #443 — 連續饑荒回合數（含本回合）。饑荒回合 +1、非饑荒回合歸零。
   * 用於饑荒損失遞減緩衝（連續多回合後扣幅減半再減半）與 zh-TW 告警文案。
   */
  consecutiveFamineTurns: integer("consecutive_famine_turns")
    .notNull()
    .default(0),
  kanbanUrl: text("kanban_url"),
  backgroundUrl: text("background_url"),
  /**
   * Task #303 — 看板顧問說話風格：玩家自訂的一段文字，描述顧問的語氣／人設。
   * 存檔時用 bulk AI 一次產生一批符合風格的遊戲小tips存入 advisorTips，之後
   * 隨機挑用（不即時生成）。null/"" = 未設定（首頁改用內建固定題庫）。
   */
  advisorStyle: text("advisor_style"),
  /**
   * Task #303 — 已產生的顧問小tips（繁體中文短句陣列）。存說話風格時由 AI
   * 一次生成 20–30 則寫入；首頁閒置時隨機挑一則以漫畫泡泡顯示。預設空陣列。
   */
  advisorTips: jsonb("advisor_tips")
    .$type<string[]>()
    .notNull()
    .default([]),
  /**
   * 外交 Discord 私訊通知開關（Task #47 起）。預設開啟；關閉後
   * diplomacyNotify.ts 的所有外交事件私訊（新訊息／條約提案／條約回覆／
   * 宣戰）都不再送出。站內鈴鐺通知不受此開關影響。
   */
  dmDiplomacyEnabled: boolean("dm_diplomacy_enabled").notNull().default(true),
  /**
   * 內政 Discord 私訊通知開關。預設開啟；關閉後 politicsDm.ts 的每回合
   * 內政結算摘要私訊不再送出。站內鈴鐺通知不受此開關影響。
   * 由舊的單一 dm_notifications_enabled 開關拆分而來（值已於啟動遷移沿用）。
   */
  dmPoliticsEnabled: boolean("dm_politics_enabled").notNull().default(true),
  /**
   * Task #34 — NPC 國家：由管理員建立、無擁有者、不可被玩家接手。共用
   * region_controls 與外交系統（AI 即時回覆條約提案）。
   */
  isNpc: boolean("is_npc").notNull().default(false),
  /**
   * NPC 來源:'wild' = 玩家攻打空地時即時生成的對抗 AI 國(戰役出兵受 WILD_NPC_CAMPAIGN_TROOP_CAP 限制);
   * 'natural' = 其他(自然生成、後台建立的 AI 國、內戰、無主國家升格),不受限。既有資料預設 natural。
   */
  npcOrigin: text("npc_origin").notNull().default("natural"),
  /**
   * Task #176 — NPC 每領域科技時代指標（軍事／社會／生產）。
   * NPC 不使用玩家的「已研發科技列 + 三選一抽牌」機制（那些表以
   * discord_user_id NOT NULL 為鍵，NPC 無法擁有）。改以三個輕量時代指標
   * 表示 NPC 的科技水準，由 AI 生成／每回合自主推進，夾在 ERAS 範圍內。
   * null = 沿用世界 current_era。僅對 NPC 有意義；玩家一律為 null。
   */
  techEraMilitary: text("tech_era_military"),
  techEraSocial: text("tech_era_social"),
  techEraProduction: text("tech_era_production"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type PlayerNation = typeof playerNationsTable.$inferSelect;
export type InsertPlayerNation = typeof playerNationsTable.$inferInsert;

/**
 * Single-row (id = 1) admin-managed appearance defaults for the game home
 * page: default 看板娘 image and default background image URLs. Managed via
 * the admin-gated GET/PUT /api/game/appearance-defaults endpoints (dashboard
 * page /game-appearance). When a URL is null the frontend falls back to the
 * static assets shipped with the dashboard.
 */
export const gameAppearanceDefaultsTable = pgTable("game_appearance_defaults", {
  id: integer("id").primaryKey().default(1),
  kanbanUrl: text("kanban_url"),
  backgroundUrl: text("background_url"),
  /**
   * Per-era background overrides for the game home page, keyed by era slug
   * (see mapRegionEras.ts). Resolution: player override → era background for
   * the current era → global backgroundUrl → shipped static asset.
   */
  eraBackgrounds: jsonb("era_backgrounds")
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type GameAppearanceDefaults =
  typeof gameAppearanceDefaultsTable.$inferSelect;

/**
 * Uploaded images (game appearance 看板娘/背景圖, nation 國旗/國徽), stored
 * directly in Postgres. Object storage sidecar auth is broken in this
 * environment, and these are low-volume uploads, so DB storage is the
 * reliable choice — it works identically in development and production.
 * Served via GET /api/storage/images/:id with immutable cache headers.
 */
export const gameImagesTable = pgTable("game_images", {
  id: uuid("id").primaryKey().defaultRandom(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  bytes: bytea("bytes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type GameImage = typeof gameImagesTable.$inferSelect;

/**
 * Background-music tracks for the game home page (Task #73). Audio bytes are
 * stored directly in Postgres for the same reason as `game_images` (object
 * storage sidecar auth is broken in this environment). Uploaded/managed by
 * admins via /api/game/music*, streamed publicly with HTTP Range support at
 * GET /api/storage/music/:id. `sortOrder` drives the playlist order.
 */
export const gameMusicTracksTable = pgTable("game_music_tracks", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  contentType: text("content_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  bytes: bytea("bytes").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type GameMusicTrack = typeof gameMusicTracksTable.$inferSelect;

/**
 * Which nation controls which map region, and at what percentage (Task #24;
 * re-keyed to nation uuid in Task #30). One region may be split across
 * multiple nations (integer percent 1–100 per row, total per region must not
 * exceed 100 — validated in the admin API). Regions with no rows are
 * unclaimed. Written through the admin 地區歸屬管理 endpoints and the
 * founding flow (100% starting region).
 */
export const regionControlsTable = pgTable(
  "region_controls",
  {
    id: serial("id").primaryKey(),
    regionId: integer("region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    percent: integer("percent").notNull(),
    /**
     * Task #322 — 人口成長累積量（per-region）：每日回合依人口增長率、戰爭人口
     * 損失等，按地區人口權重分配累加/累減的持久化偏移量（可正可負）。移到地區
     * 層級後，累積量隨領土轉移而移動、並可反映在地圖上。
     * 該國此地區的人口貢獻 = 時代人口 × percent/100 + populationBonus（下限 0）。
     */
    populationBonus: bigint("population_bonus", { mode: "number" })
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
    regionNationUnique: uniqueIndex("region_controls_region_nation_uidx").on(
      t.regionId,
      t.nationId,
    ),
    nationIdx: index("region_controls_nation_idx").on(t.nationId),
    percentCheck: check(
      "region_controls_percent_check",
      sql`${t.percent} >= 1 AND ${t.percent} <= 100`,
    ),
  }),
);

export type RegionControl = typeof regionControlsTable.$inferSelect;
export type InsertRegionControl = typeof regionControlsTable.$inferInsert;
