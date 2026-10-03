import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  date,
  doublePrecision,
  jsonb,
  uuid,
  uniqueIndex,
  index,
  check,
  bigint,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

export const mapRegionsTable = pgTable(
  "map_regions",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    macroRegion: text("macro_region").notNull(),
    hasNoLandBorder: boolean("has_no_land_border").notNull().default(false),
    soilFertility: integer("soil_fertility"),
    areaKm2: integer("area_km2"),
    /**
     * 地區生產力投資累積加成（Task #405）。玩家花錢投資 → +1/次，全地區共享、
     * 跨時代固定加值：有效生產素質 = 該時代 era stat productivity + 此欄。
     * 絕不寫入 map_region_era_stats（確定性種子資料）。
     */
    productivityInvestmentBonus: integer("productivity_investment_bonus")
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    nameUnique: uniqueIndex("map_regions_name_uidx").on(t.name),
    macroIdx: index("map_regions_macro_idx").on(t.macroRegion),
  }),
);

export const mapRegionAdjacenciesTable = pgTable(
  "map_region_adjacencies",
  {
    id: serial("id").primaryKey(),
    regionId: integer("region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    adjacentRegionId: integer("adjacent_region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pairUnique: uniqueIndex("map_region_adjacencies_pair_uidx").on(
      t.regionId,
      t.adjacentRegionId,
    ),
    adjacentIdx: index("map_region_adjacencies_adjacent_idx").on(t.adjacentRegionId),
    noSelfCheck: check(
      "map_region_adjacencies_no_self_check",
      sql`${t.regionId} <> ${t.adjacentRegionId}`,
    ),
  }),
);

/**
 * Per-region, per-era simulated stats (Task #9). One row per (region, era);
 * 202 regions × 14 eras = 2828 rows, seeded idempotently at startup.
 */
export const mapRegionEraStatsTable = pgTable(
  "map_region_era_stats",
  {
    id: serial("id").primaryKey(),
    regionId: integer("region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    era: text("era").notNull(),
    population: integer("population").notNull(),
    productivity: integer("productivity").notNull(),
    techPoints: integer("tech_points").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    regionEraUnique: uniqueIndex("map_region_era_stats_region_era_uidx").on(
      t.regionId,
      t.era,
    ),
  }),
);

/**
 * Historical cities shown on the world map (Task #23). ~172 curated cities,
 * each belonging to one of the 202 map regions; seeded idempotently at
 * startup from the static seed in the api-server.
 */
export const mapCitiesTable = pgTable(
  "map_cities",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    regionId: integer("region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    /**
     * Task #311 — 玩家自訂城市名（單一全域值，非各玩家獨立）。null = 沿用種子
     * 預設名（name 欄）。由「掌控該城市所屬地區佔比最高」的國家玩家設定；
     * 種子同步（runMapCitySync）只更新 region_id/lat/lng，絕不覆寫此欄。
     */
    customName: text("custom_name"),
    /** 設定自訂名的國家（掌控佔比最高者）；國家刪除時歸零→還原預設名。 */
    customNameNationId: uuid("custom_name_nation_id").references(
      () => playerNationsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    nameUnique: uniqueIndex("map_cities_name_uidx").on(t.name),
    regionIdx: index("map_cities_region_idx").on(t.regionId),
  }),
);

/** Single-row global game state (current era pointer, Task #9; 回合引擎設定). */
export const worldGameStateTable = pgTable("world_game_state", {
  id: integer("id").primaryKey().default(1),
  currentEra: text("current_era").notNull(),
  /**
   * 「數據時代」：玩家國家數據（人口/生產力/科技產出）計算所用的時代。
   * 平常與 current_era 同步（回合引擎自然推進時代時一併更新）；
   * 管理員在回合設定改年份/時代而未勾「同步預設」時保持不變，
   * 玩家數據就不會被重設成新時代的預設值。null = 沿用 current_era。
   */
  statsEra: text("stats_era"),
  gameDate: date("game_date", { mode: "string" }).notNull().default("1900-01-01"),
  /** 每日自動回合的當地時間（NEWS_SCHEDULE_TZ）。 */
  turnHour: integer("turn_hour").notNull().default(18),
  turnMinute: integer("turn_minute").notNull().default(0),
  /** 每回合推進的遊戲年數。 */
  yearsPerTurn: integer("years_per_turn").notNull().default(1),
  /** 每回合金錢收入 = 生產力 × pct / 100。 */
  moneyIncomePct: integer("money_income_pct").notNull().default(10),
  /** 最後一次執行回合的當地日期字串（YYYY-MM-DD），null = 尚未執行過。 */
  lastTurnDate: text("last_turn_date"),
  /**
   * Task #289 — 每日多時段回合排程：有序的自動回合時刻清單（NEWS_SCHEDULE_TZ
   * 當地時間）。每個元素為 {hour:0–23, minute:0–59}；每天在每個時刻各觸發一次
   * 完整回合。預設維持單一 18:00，並由既有 turn_hour/turn_minute 回填一次。
   * 既有 turn_hour/turn_minute 保留（顯示／相容用），實際排程以此清單為準。
   */
  turnTimes: jsonb("turn_times")
    .$type<{ hour: number; minute: number }[]>()
    .notNull()
    .default([{ hour: 18, minute: 0 }]),
  /**
   * Task #289 — 最後一次實際執行回合的真實世界時刻（timestamptz），作為多時段
   * 防重的依據：某時刻只有在 last_turn_at 早於該時刻時才會觸發（原子條件式
   * UPDATE 認領），並發／重啟都不會重複結算。null = 尚未執行過。
   */
  lastTurnAt: timestamp("last_turn_at", { withTimezone: true }),
  /**
   * Task #184 — 每回合新聞產生的時間窗游標（真實世界時間）。上一次成功產生
   * 新聞的時刻；下一回合聚合「此時刻之後」新增的宣戰／締約／世界模擬／重大
   * 政治事件。null = 尚未產生過（首回合以近一日為窗，避免翻出全部歷史）。
   */
  lastNewsAt: timestamp("last_news_at", { withTimezone: true }),
  /**
   * Task #176 — AI 自動世界模擬設定。
   * worldSimEnabled：總開關（預設關閉）。開啟後每回合結算末會呼叫 AI 依
   *   推進後的年份／時代自動生成／調整 NPC 並在非玩家間搬動領土。
   * worldSimIntensity：強度（1 低／2 中／3 高），控制每回合最多新增 NPC 數與
   *   領土搬動數，藉此控制成本與世界變動幅度。
   * worldSimHostileToPlayers：是否允許 NPC 對玩家採取敵對行動（提案宣戰／
   *   發動戰爭）；預設關閉，NPC 僅在 NPC／無主之間互動。
   */
  worldSimEnabled: boolean("world_sim_enabled").notNull().default(false),
  worldSimIntensity: integer("world_sim_intensity").notNull().default(1),
  worldSimHostileToPlayers: boolean("world_sim_hostile_to_players")
    .notNull()
    .default(false),
  /**
   * Task #228 — NPC 自動演變獨立背景迴圈排程（不再綁每日回合）。
   * frequencyMinutes：兩次自動演變之間的間隔（分鐘，預設 1440＝約每日一次）。
   * lastRunAt／nextRunAt：持久化的「上次執行／下次到期」時間戳，供
   *   「條件式 UPDATE 認領」使用，確保多實例／重啟不重跑、不漏跑。
   */
  worldSimFrequencyMinutes: integer("world_sim_frequency_minutes")
    .notNull()
    .default(1440),
  worldSimLastRunAt: timestamp("world_sim_last_run_at", { withTimezone: true }),
  worldSimNextRunAt: timestamp("world_sim_next_run_at", { withTimezone: true }),
  /**
   * Task #228 — AI 外交/戰役判定迴圈排程。驅動 NPC 主動外交提案/回應、NPC
   * 開戰決策、以及戰役週期推進/結算。
   * aiJudgmentEnabled：總開關（預設開啟）。
   * aiJudgmentFrequencyMinutes：判定間隔（分鐘，預設 240＝4 小時）。
   * lastRunAt／nextRunAt：同上，條件式認領用。
   * warCycleHours：新發起戰役的週期長度（小時，預設 4），供 initiateCampaign 讀取。
   */
  aiJudgmentEnabled: boolean("ai_judgment_enabled").notNull().default(true),
  aiJudgmentFrequencyMinutes: integer("ai_judgment_frequency_minutes")
    .notNull()
    .default(240),
  aiJudgmentLastRunAt: timestamp("ai_judgment_last_run_at", {
    withTimezone: true,
  }),
  aiJudgmentNextRunAt: timestamp("ai_judgment_next_run_at", {
    withTimezone: true,
  }),
  warCycleHours: integer("war_cycle_hours").notNull().default(4),
  /**
   * 結算靜默時段（當地時間 NEWS_SCHEDULE_TZ 的整點小時 0–23）。在此時段內
   * 「AI 外交／戰役判定」（＝結算）迴圈不執行；落在時段內的到期時間會延到
   * 時段結束（end:00）才結算。start === end = 停用；start < end = 當日
   * [start,end)；start > end = 跨午夜（例 22→6）。預設 0–8（00:00–08:00 不結算）。
   */
  settlementBlackoutStartHour: integer("settlement_blackout_start_hour")
    .notNull()
    .default(0),
  settlementBlackoutEndHour: integer("settlement_blackout_end_hour")
    .notNull()
    .default(8),
  /**
   * Task #233 — AI 外交/戰役判定的「管理員干預指令」（自然語言方針）。注入 NPC
   * 外交（主動提案／條約回覆／對話）與戰役指令的 AI 提示，作為最高優先方針。
   * null／空字串 = 無方針。
   */
  aiJudgmentDirective: text("ai_judgment_directive"),
  /**
   * NPC 對話行動等級（1 保守／2 中等／3 積極；預設 3）。控制 NPC 在玩家↔NPC
   * 外交對話中可主動執行的行動（宣戰／出兵／締約／送禮／土地資源交換等）的
   * 積極度與每則訊息的數量上限。
   */
  npcChatActionLevel: integer("npc_chat_action_level").notNull().default(3),
  /**
   * 人口增長倍率（0–100；預設 100）。以百分比套在每回合算出的人口增長「量」
   * 上：100 = 現行速度（行為不變）、越低越慢、0 = 完全停止增長。管理員可於
   * 回合設定頁調整，用來把過快的人口增長調降到合適水準。回合實際套用與玩家
   * 顯示的「有效人口增長率」皆以此倍率縮放，兩者一致。
   */
  populationGrowthMultiplierPct: integer("population_growth_multiplier_pct")
    .notNull()
    .default(100),
  /**
   * 生產力基礎倍率（0–1000；預設 100）。以百分比套在各國「調整後生產力」
   * 總量上（所有內政乘數/加成計完後最外層縮放）：100 = 不縮放、200 = 兩倍、
   * 越低越少。管理員可於回合設定頁調整（例如延長回合間隔時等比提高）。
   * 研發成本的全球平均生產力同步縮放，故國力研發倍率不受影響。
   */
  productionMultiplierPct: integer("production_multiplier_pct")
    .notNull()
    .default(100),
  /**
   * 科技點數基礎倍率（0–1000；預設 100）。以百分比套在各國「調整後每回合
   * 科技點數產出」上（最外層縮放）：100 = 不縮放、200 = 兩倍。回合實際發放
   * 與玩家顯示皆以此倍率縮放，兩者一致。管理員可於回合設定頁調整。
   */
  techMultiplierPct: integer("tech_multiplier_pct").notNull().default(100),
  /**
   * 領先時代研發成本倍率（≥1；預設 5）。玩家某科技領域時代「領先」世界目前
   * 時代（current_era）時，該領域的科技研發成本乘上此倍率（不隨領先幅度累乘）。
   * 管理員可於回合設定頁調整；1 = 不加價。
   */
  aheadEraCostMultiplier: integer("ahead_era_cost_multiplier")
    .notNull()
    .default(5),
  /**
   * Task #412 — 全域戰爭參數（管理員於戰爭管理頁調整）。
   * warIntensityPct：戰鬥激烈度倍率（%；10–500，預設 100 = 現行傷亡比率）。
   *   乘進每結算週期的傷亡比率（含防守方反攻），硬上限與現有兵力封頂不變。
   * territoryCaptureBasePct：領土奪取基礎值（百分點；1–30，預設 15）。
   *   決定「確定性推進下限」的滿幅上限，也等比縮放 AI territoryShiftPct 的
   *   最終套用值（面積係數另計）。
   */
  warIntensityPct: integer("war_intensity_pct").notNull().default(100),
  territoryCaptureBasePct: integer("territory_capture_base_pct")
    .notNull()
    .default(15),
  /**
   * Task #570 — NPC 締約可提供資源的上限（只約束「NPC 付出」側；真人↔真人
   * 條約與玩家付給 NPC 的一側不受影響）。管理員於 admin /world-sim 調整。
   * npcTreatyStockCapPct：一次性庫存資源（金錢／科技點／木材／礦石）各
   *   ≤ NPC 現有存量的此百分比（0–100，預設 20）。
   * npcTreatyMaxRegions：單一條約可要求 NPC 讓出的地區數上限（0–10，預設 3）。
   * npcTreatyRegionMaxPct：每區可讓渡比例 ≤ NPC 掌控 % × 此百分比（0–100，預設 50）。
   * npcTreatyPerTurnCapPct：每回合輸送（金錢／科技／生產／糧食／木礦）各
   *   ≤ NPC 對應每回合產出的此百分比（0–100，預設 10）。
   */
  npcTreatyStockCapPct: integer("npc_treaty_stock_cap_pct")
    .notNull()
    .default(20),
  npcTreatyMaxRegions: integer("npc_treaty_max_regions").notNull().default(3),
  npcTreatyRegionMaxPct: integer("npc_treaty_region_max_pct")
    .notNull()
    .default(50),
  npcTreatyPerTurnCapPct: integer("npc_treaty_per_turn_cap_pct")
    .notNull()
    .default(10),
  /**
   * Task #504 — 開局資源設定：玩家「自創建國」時新國家獲得的初始科技點數與
   * 金錢（取代 player_nations 欄位預設值的效果）。管理員於「發放資源」頁
   * 調整；接手無主國家與 NPC 生成不受影響。非負整數，上限與發放資源一致
   * （科技點 int4、金錢 int8）。
   */
  startingTechPoints: integer("starting_tech_points").notNull().default(200),
  startingMoney: bigint("starting_money", { mode: "number" })
    .notNull()
    .default(5000),
  /**
   * 開局領土生產力上限：自創建國選 2–3 塊起始地區時，各地區
   * 「生產力 = productivity × population / 1,000,000」加總不可超過此值。
   * 選 1 塊不受限制。管理員於「發放資源」頁調整（預設 10,000）。
   */
  foundingProductionCap: integer("founding_production_cap").notNull().default(10000),
  /**
   * 財政政策獨立排程：下次財政結算的到期時間（timestamptz）。
   * null = 從未執行，視為立即到期。原子條件式 UPDATE 認領，多實例不重跑。
   * 每次執行後前進 4 小時（固定頻率），不依賴每日回合。
   */
  financeNextRunAt: timestamp("finance_next_run_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type MapRegion = typeof mapRegionsTable.$inferSelect;
export type InsertMapRegion = typeof mapRegionsTable.$inferInsert;
export type MapRegionAdjacency = typeof mapRegionAdjacenciesTable.$inferSelect;
export type InsertMapRegionAdjacency = typeof mapRegionAdjacenciesTable.$inferInsert;
export type MapRegionEraStat = typeof mapRegionEraStatsTable.$inferSelect;
export type InsertMapRegionEraStat = typeof mapRegionEraStatsTable.$inferInsert;
export type WorldGameState = typeof worldGameStateTable.$inferSelect;
