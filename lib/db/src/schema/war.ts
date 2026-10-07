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
  uniqueIndex,
  index,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";
import { mapRegionsTable, mapCitiesTable } from "./mapRegions";
import { militaryUnitTemplatesTable } from "./military";
import { diplomacyWarsTable } from "./diplomacy";

/**
 * Task #105 — 戰爭戰役系統。
 *
 * 戰役（campaign）：宣戰後，攻擊方從自己控制的地區對「相鄰且由交戰國控制」
 * 的地區發起。每場戰役涵蓋兩塊地區（出發地與目標地）的領土消長，並以固定
 * 週期（預設 24 小時，管理員可覆寫）由 AI 結算。
 *
 * 城市狀態（city line）：一個地區可能有多座歷史城市，開戰時逐城快照其
 * 城牆階級與耐久（Task #150）。結算時逐城消耗耐久（durability），整條
 * 防線的「陷落」以「所有城市耐久歸零」判定；任一城市尚存 → 守方在該地
 * 區的控制率不得被清零。
 */

/** 城牆階級：木牆 < 石牆 < 碉堡 < 混凝土要塞（Task #150）。 */
export type WallTier = "wood" | "stone" | "bunker" | "concrete";

/** 戰役期間單一城市的城牆狀態（開戰時快照，結算逐城消耗耐久）。 */
export interface WarCity {
  /** map_cities.id */
  cityId: number;
  /** 城市中文名（快照，避免結算時再查表）。 */
  name: string;
  /** 城牆階級（開戰快照；戰役進行中不受後續升級影響）。 */
  wallTier: WallTier;
  /** 該階級城牆的耐久上限（快照）。 */
  maxDurability: number;
  /** 目前耐久；0 = 該城陷落。 */
  durability: number;
}

export interface WarCityState {
  /** 該地區的城市防線（開戰時逐城快照，含城牆階級與耐久）。 */
  cities: WarCity[];
  /** 守軍是否下令駐守城市（抵抗與士氣加成、補給壓力）。 */
  garrisoned: boolean;
}

export const warCampaignsTable = pgTable(
  "war_campaigns",
  {
    id: serial("id").primaryKey(),
    warId: integer("war_id")
      .notNull()
      .references(() => diplomacyWarsTable.id, { onDelete: "cascade" }),
    attackerNationId: uuid("attacker_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    defenderNationId: uuid("defender_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 攻擊方出發地區（攻擊方須有控制權）。 */
    attackerRegionId: integer("attacker_region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    /** 防守方目標地區（防守方須有控制權，且與出發地相鄰）。 */
    defenderRegionId: integer("defender_region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    /** active | ended */
    status: text("status").notNull().default("active"),
    winnerNationId: uuid("winner_nation_id").references(
      () => playerNationsTable.id,
      { onDelete: "set null" },
    ),
    /** territory | ceasefire | nation_removed | stalemate | annihilation */
    endReason: text("end_reason"),
    /** AI 開戰時生成的 ~300 字地理與地形敘述（雙方共用，生成一次）。 */
    terrainBrief: text("terrain_brief"),
    /** 出發地區的城市防線狀態；null = 該地區沒有歷史城市。 */
    attackerCityState: jsonb("attacker_city_state").$type<WarCityState>(),
    /** 目標地區的城市防線狀態；null = 該地區沒有歷史城市。 */
    defenderCityState: jsonb("defender_city_state").$type<WarCityState>(),
    /** 結算週期（小時）；管理員可覆寫（測試用）。 */
    cycleHours: integer("cycle_hours").notNull().default(24),
    /** 已完成的結算週期數；第 N 次結算處理 cycle_number = N-1 期間的指令。 */
    cycleNumber: integer("cycle_number").notNull().default(0),
    nextResolveAt: timestamp("next_resolve_at", {
      withTimezone: true,
    }).notNull(),
    /** 連續 AI 結算失敗次數；達上限後以確定性「僵持」結算避免卡死。 */
    failCount: integer("fail_count").notNull().default(0),
    /** NPC 主動發起的戰役（NPC 開戰節奏限制用）。 */
    initiatedByNpc: boolean("initiated_by_npc").notNull().default(false),
    /** Task #152 — 是否為海上登陸戰役（跨海／跨洋登陸）。 */
    isSeaLanding: boolean("is_sea_landing").notNull().default(false),
    /** 開戰時快照的登陸攻擊力減損百分比；null = 非登陸戰役。 */
    landingAttackReductionPct: integer("landing_attack_reduction_pct"),
    /** 開戰時快照的海上登陸容許量（單場兵力上限）；null = 非登陸戰役。 */
    seaLandingTroopCap: bigint("sea_landing_troop_cap", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index("war_campaigns_status_idx").on(t.status),
    resolveIdx: index("war_campaigns_next_resolve_idx").on(
      t.status,
      t.nextResolveAt,
    ),
    warIdx: index("war_campaigns_war_idx").on(t.warId),
    attackerIdx: index("war_campaigns_attacker_idx").on(t.attackerNationId),
    defenderIdx: index("war_campaigns_defender_idx").on(t.defenderNationId),
    cycleHoursCheck: check(
      "war_campaigns_cycle_hours_check",
      sql`${t.cycleHours} >= 1 AND ${t.cycleHours} <= 168`,
    ),
  }),
);

export type WarCampaign = typeof warCampaignsTable.$inferSelect;
export type InsertWarCampaign = typeof warCampaignsTable.$inferInsert;

/**
 * Task #453 — 戰役參戰國（多國參戰）：每場戰役的所有參戰國家各一列。
 * 發起時種入攻守雙方主帥（is_lead = true）；已與某方主帥交戰中的真人玩家
 * 可晚加入選邊（is_lead = false，join_war_id 記錄其資格戰爭）。
 * 同（戰役, 國家）唯一 — 重複加入由唯一約束擋（409）。
 */
export const warCampaignParticipantsTable = pgTable(
  "war_campaign_participants",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => warCampaignsTable.id, { onDelete: "cascade" }),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** attacker | defender */
    side: text("side").notNull(),
    /** 該方主帥（發起戰役時的攻／守國；領土消長的地區持有方）。 */
    isLead: boolean("is_lead").notNull().default(false),
    /**
     * 晚加入者的資格戰爭（其與敵方主帥的 diplomacy_wars 列）；主帥列
     * 記戰役本身的 war_id。該戰爭結束時晚加入者自動退場。
     */
    joinWarId: integer("join_war_id").references(() => diplomacyWarsTable.id, {
      onDelete: "cascade",
    }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    campaignNationUidx: uniqueIndex("war_campaign_participants_uidx").on(
      t.campaignId,
      t.nationId,
    ),
    campaignIdx: index("war_campaign_participants_campaign_idx").on(
      t.campaignId,
    ),
    nationIdx: index("war_campaign_participants_nation_idx").on(t.nationId),
    joinWarIdx: index("war_campaign_participants_join_war_idx").on(
      t.joinWarId,
    ),
    sideCheck: check(
      "war_campaign_participants_side_check",
      sql`${t.side} IN ('attacker', 'defender')`,
    ),
  }),
);

export type WarCampaignParticipant =
  typeof warCampaignParticipantsTable.$inferSelect;

/**
 * 地區交戰鎖：記錄每場進行中的戰役佔用哪些地區（出發地＋目標地）。
 * Task #648 — 複合主鍵 (campaign_id, region_id)：同場戰役＋同地區才唯一；
 * 不同戰役可同時佔用同一地區，實現多對多攻打。
 * 戰役結束時刪列並寫入 war_region_cooldowns（冷卻仍限同地區一段時間）。
 */
export const warRegionEngagementsTable = pgTable(
  "war_region_engagements",
  {
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => warCampaignsTable.id, { onDelete: "cascade" }),
    regionId: integer("region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.campaignId, table.regionId] }),
  }),
);

export type WarRegionEngagement =
  typeof warRegionEngagementsTable.$inferSelect;

/** 戰役結束後的地區冷卻（24 小時內不得再發起戰役）。 */
export const warRegionCooldownsTable = pgTable("war_region_cooldowns", {
  regionId: integer("region_id")
    .primaryKey()
    .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type WarRegionCooldown = typeof warRegionCooldownsTable.$inferSelect;

/**
 * 軍團：每方每戰役最多 3 個（A／B／C），各有士氣（0–100）與補給（0–100）。
 * NPC 方的軍團同樣存在這裡（nation_id 指向 NPC 國家）。
 */
export const warCampaignLegionsTable = pgTable(
  "war_campaign_legions",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => warCampaignsTable.id, { onDelete: "cascade" }),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** A | B | C */
    slot: text("slot").notNull(),
    morale: integer("morale").notNull().default(80),
    supply: integer("supply").notNull().default(100),
    /** 該軍團是否奉命駐守城市。 */
    garrisoningCity: boolean("garrisoning_city").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    slotUidx: uniqueIndex("war_campaign_legions_slot_uidx").on(
      t.campaignId,
      t.nationId,
      t.slot,
    ),
    campaignIdx: index("war_campaign_legions_campaign_idx").on(t.campaignId),
    nationIdx: index("war_campaign_legions_nation_idx").on(t.nationId),
    moraleCheck: check(
      "war_campaign_legions_morale_check",
      sql`${t.morale} >= 0 AND ${t.morale} <= 100`,
    ),
    supplyCheck: check(
      "war_campaign_legions_supply_check",
      sql`${t.supply} >= 0 AND ${t.supply} <= 100`,
    ),
    slotCheck: check(
      "war_campaign_legions_slot_check",
      sql`${t.slot} IN ('A', 'B', 'C')`,
    ),
  }),
);

export type WarCampaignLegion = typeof warCampaignLegionsTable.$inferSelect;

/**
 * 軍團兵種配置：每軍團最多 5 種兵種（路由交易內強制）。quantity = 前線
 * 可戰數量；wounded = 該軍團中的受傷數量（仍佔用全國兵力，不可再派遣）。
 * 死亡則同步扣減 player_armies 與此處數量。
 */
export const warCampaignLegionUnitsTable = pgTable(
  "war_campaign_legion_units",
  {
    id: serial("id").primaryKey(),
    legionId: integer("legion_id")
      .notNull()
      .references(() => warCampaignLegionsTable.id, { onDelete: "cascade" }),
    templateId: integer("template_id")
      .notNull()
      .references(() => militaryUnitTemplatesTable.id, { onDelete: "cascade" }),
    quantity: bigint("quantity", { mode: "number" }).notNull().default(0),
    wounded: bigint("wounded", { mode: "number" }).notNull().default(0),
    /**
     * Task #389 — NPC 常備軍抽調量：發起時記錄「此列自 npc_armies 抽調的數量」
     * （戰役期間不更新；本土動員民兵補足的部分不計入）。戰役結束時據此把
     * 生還者／傷兵歸還常備軍並實際扣減損失。玩家列恆為 0。
     */
    npcDrawn: bigint("npc_drawn", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    legionTemplateUidx: uniqueIndex("war_campaign_legion_units_uidx").on(
      t.legionId,
      t.templateId,
    ),
    legionIdx: index("war_campaign_legion_units_legion_idx").on(t.legionId),
    quantityCheck: check(
      "war_campaign_legion_units_qty_check",
      sql`${t.quantity} >= 0 AND ${t.wounded} >= 0`,
    ),
  }),
);

export type WarCampaignLegionUnit =
  typeof warCampaignLegionUnitsTable.$inferSelect;

/**
 * 每結算週期的 AI 指令：四種類型各一則（strategy | attack | defense |
 * recon），同（戰役, 國家, 週期, 類型）唯一 — 重複提交以 upsert 覆寫。
 */
export const warCampaignOrdersTable = pgTable(
  "war_campaign_orders",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => warCampaignsTable.id, { onDelete: "cascade" }),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    cycleNumber: integer("cycle_number").notNull(),
    /** strategy | attack | defense | recon */
    orderType: text("order_type").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    orderUidx: uniqueIndex("war_campaign_orders_uidx").on(
      t.campaignId,
      t.nationId,
      t.cycleNumber,
      t.orderType,
    ),
    campaignCycleIdx: index("war_campaign_orders_campaign_cycle_idx").on(
      t.campaignId,
      t.cycleNumber,
    ),
    // 注意：order_type 沒有 DB CHECK 約束（app 層強制 'command'）。
    // 舊約束已由啟動遷移 DROP；Publish 會把 dev DB 的 DDL 差異在部署前套到
    // prod，含髒資料的 CHECK 會讓發布失敗，勿再加回。
  }),
);

export type WarCampaignOrder = typeof warCampaignOrdersTable.$inferSelect;

/** 結算摘要數據（jsonb）：雙方士氣／傷亡／領土／城市變化等。 */
export interface WarReportSideSummary {
  moraleDelta: number;
  woundedTotal: number;
  deadTotal: number;
  territoryPctDelta: number;
  warWearinessDelta: number;
  reconLevel: number;
  /**
   * 該方本週期傷亡量的伺服器確定性成因（zh-TW 定性描述；舊戰報無此欄）。
   * 玩家 API 只回自己那一方，避免敵方戰力對比繞過偵查模糊化被反推。
   */
  lossReasons?: string[];
  /**
   * 補給系統 — 該方本週期的補給結果（舊戰報無此欄）。玩家 API 只回自己那一方
   * （敵方後勤不外洩）。minSupply 取該方各軍團補給的最低值；rationShort/ammoShort
   * 表示有軍團口糧/彈藥吃不飽；collapsedLegions 為崩潰（補給 < 20）的軍團數。
   */
  supply?: {
    minSupply: number;
    rationShort: boolean;
    ammoShort: boolean;
    collapsedLegions: number;
  };
}

/** 結算時逐城城牆狀態快照（顯示用；Task #150）。 */
export interface WarReportCity {
  cityId: number;
  name: string;
  wallTier: WallTier;
  durability: number;
  maxDurability: number;
}

export interface WarReportSummary {
  attacker: WarReportSideSummary;
  defender: WarReportSideSummary;
  /**
   * 舊欄位（沿用相容）：以該方最脆弱尚存城市的耐久推導的整體防線完整度
   * 0–100（無城市 → null）。新前端改讀 attackerCities/defenderCities 的
   * 逐城耐久，但舊戰報僅有此欄位，故繼續一併寫入。
   */
  attackerCityHoldoutPct: number | null;
  defenderCityHoldoutPct: number | null;
  /** 出發地區逐城城牆狀態（Task #150）；舊戰報可能為 undefined。 */
  attackerCities?: WarReportCity[];
  /** 目標地區逐城城牆狀態（Task #150）；舊戰報可能為 undefined。 */
  defenderCities?: WarReportCity[];
  localPopulationLoss: number;
  stalemate?: boolean;
}

/**
 * 每次結算的戰報：雙方各自的敘事（各指令實施效果、互動結果），以及結構化
 * 摘要。敵方視圖的模糊化在讀取端做（偵查等級決定精確度）。
 */
export const warCampaignReportsTable = pgTable(
  "war_campaign_reports",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => warCampaignsTable.id, { onDelete: "cascade" }),
    cycleNumber: integer("cycle_number").notNull(),
    /** 給攻擊方看的完整敘事。 */
    attackerReport: text("attacker_report").notNull(),
    /** 給防守方看的完整敘事。 */
    defenderReport: text("defender_report").notNull(),
    summary: jsonb("summary").$type<WarReportSummary>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    cycleUidx: uniqueIndex("war_campaign_reports_cycle_uidx").on(
      t.campaignId,
      t.cycleNumber,
    ),
    campaignIdx: index("war_campaign_reports_campaign_idx").on(t.campaignId),
  }),
);

export type WarCampaignReport = typeof warCampaignReportsTable.$inferSelect;

/**
 * 全國傷兵池：戰役結束（或途中）後受傷士兵回到國家傷兵池，隨時間復原歸隊
 * （復原速度受軍事科技 recoverySpeed 加成）。傷兵仍計入 player_armies
 * 總量，但不可派遣；復原只是把數量從這裡移除（player_armies 不變動）。
 */
export const playerWoundedUnitsTable = pgTable(
  "player_wounded_units",
  {
    id: serial("id").primaryKey(),
    discordUserId: text("discord_user_id")
      .notNull()
      .references(() => playerNationsTable.discordUserId, {
        onDelete: "cascade",
      }),
    templateId: integer("template_id")
      .notNull()
      .references(() => militaryUnitTemplatesTable.id, { onDelete: "cascade" }),
    wounded: bigint("wounded", { mode: "number" }).notNull().default(0),
    /**
     * 線性復原基準量：每次戰役傷亡加入池時與 wounded 同步累加。
     * recoveryTick 每回合復原 ceil(initialWounded × pctPerTurn% × speedBonus)，
     * 封頂於 wounded，保證在 ceil(100/pctPerTurn) 回合後完全復原。
     */
    initialWounded: bigint("initial_wounded", { mode: "number" })
      .notNull()
      .default(0),
    /** 上次復原結算時間（復原量按經過時間比例計）。 */
    lastRecoveryAt: timestamp("last_recovery_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    playerTemplateUidx: uniqueIndex("player_wounded_units_uidx").on(
      t.discordUserId,
      t.templateId,
    ),
    playerIdx: index("player_wounded_units_player_idx").on(t.discordUserId),
  }),
);

export type PlayerWoundedUnit = typeof playerWoundedUnitsTable.$inferSelect;

/**
 * Task #150 — 城市城牆：每座歷史城市的城牆階級（木/石/碉堡/混凝土）。
 * 城牆屬城市基礎建設（非玩家私有），以 city_id 為鍵——任何掌控該城所在
 * 地區的國家皆可升級（與 city_buildings 的授權一致），升級後由當時駐防
 * 該城的一方於戰役中受惠。未建列 = 木牆（預設）。耐久（durability）僅存
 * 於戰役期間的 WarCityState 快照，本表只保存階級（tier）。
 */
export const cityWallsTable = pgTable("city_walls", {
  cityId: integer("city_id")
    .primaryKey()
    .references(() => mapCitiesTable.id, { onDelete: "cascade" }),
  tier: text("tier").$type<WallTier>().notNull().default("wood"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type CityWall = typeof cityWallsTable.$inferSelect;


/**
 * 導彈發射紀錄(1960 年後解鎖的導彈系統)。同時是:
 *  - 「每國每回合限射一發」的依據:turn_key = 發射當下 world_game_state.last_turn_at 的毫秒字串,
 *    (attacker_nation_id, turn_key) 唯一 → 併發/連點只有一發成功。
 *  - 戰報:目標國、地區、實際造成的人口與建築損失。
 * 無外鍵到 nation(國家被刪後紀錄保留為歷史),故存 nation 名稱快照。
 */
export const missileStrikesTable = pgTable(
  "missile_strikes",
  {
    id: serial("id").primaryKey(),
    attackerNationId: uuid("attacker_nation_id").notNull(),
    attackerName: text("attacker_name").notNull(),
    targetNationId: uuid("target_nation_id").notNull(),
    targetName: text("target_name").notNull(),
    regionId: integer("region_id").notNull(),
    regionName: text("region_name").notNull(),
    /** medium | tactical_nuke | strategic_nuke */
    missileType: text("missile_type").notNull(),
    turnKey: text("turn_key").notNull(),
    costMoney: bigint("cost_money", { mode: "number" }).notNull(),
    populationLost: bigint("population_lost", { mode: "number" }).notNull().default(0),
    buildingsDowngraded: integer("buildings_downgraded").notNull().default(0),
    buildingsDestroyed: integer("buildings_destroyed").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oncePerTurn: uniqueIndex("missile_strikes_attacker_turn_uidx").on(
      t.attackerNationId,
      t.turnKey,
    ),
    targetIdx: index("missile_strikes_target_idx").on(t.targetNationId, t.createdAt),
  }),
);

export type MissileStrike = typeof missileStrikesTable.$inferSelect;
