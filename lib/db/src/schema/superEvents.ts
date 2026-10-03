import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  boolean,
  uuid,
  serial,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { mapRegionsTable } from "./mapRegions";
import { playerNationsTable } from "./playerNations";

/**
 * Task #333 — 超事件系統（Super Event System）。
 *
 * 全域／多國性的重大國際事件（如國際疾病、蒙古西征式的擴張浪潮、宗教風潮、
 * 生產素質劇變、跨時代關鍵科技突破等）。事件可由管理員手動建立，或由 AI
 * 依世界局勢自動生成，亦可由玩家的政治決策以極低機率（0.5%）觸發。
 *
 * 事件為「進行式」：每回合由 AI 依當前局勢判定本回合的發展與數值影響，套用到
 * 受影響地區所屬國家（人口、生產素質、滿意度、穩定度等），並可能賦予跨時代
 * 關鍵科技或觸發 NPC 行動。玩家可用自由文字提交「應對」，AI 於下回合判定其
 * 應對並回饋效果。
 *
 * 所有數值變動與現有政策／財政決策玩法一致：AI 只給敘事與意圖／幅度，實際
 * 套用由伺服器決定並夾在合法範圍內。
 */

/** 事件成因：管理員建立／AI 自動生成／玩家政治決策觸發。 */
export type SuperEventCause = "admin" | "ai" | "player_decision";

/** 事件狀態：進行中／已結束。 */
export type SuperEventStatus = "active" | "ended";

/** 事件範圍：全球／指定地區／指定國家。 */
export type SuperEventScope = "global" | "regional" | "targeted";

/** 事件屬性：災難（負向）／機會（正向）。 */
export type SuperEventKind = "disaster" | "opportunity";

/**
 * 事件階段（Task #356）：爆發→擴散→高峰→消退→落幕。嚴重度隨階段起伏；
 * 落幕（ended）等同事件結束。由 AI 每回合判定推進。
 */
export type SuperEventStage =
  | "outbreak"
  | "spreading"
  | "peak"
  | "receding"
  | "ended";

/** 已賦予的跨時代關鍵科技（記錄以避免重複賦予）。 */
export interface SuperEventGrantedTech {
  /** military_techs.key_slug（穩定去重鍵）。 */
  keySlug: string;
  name: string;
  era: string;
}

export const superEventsTable = pgTable(
  "super_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    /** 一句話摘要（清單／地圖懸浮顯示）。 */
    summary: text("summary").notNull().default(""),
    /** 目前的敘事（最新一回合後的整體局勢描述）。 */
    narrative: text("narrative").notNull().default(""),
    /** 事件分類（自由文字，如 疾病／戰爭／宗教／科技／天災／經濟）。 */
    category: text("category").notNull().default("其他"),
    /**
     * global = 全球性；regional = 僅影響指定地區所屬國家；
     * targeted = 僅影響指定國家（super_event_nations）。
     */
    scope: text("scope").notNull().default("global"),
    /** disaster = 災難（負向）；opportunity = 機會（正向）。 */
    kind: text("kind").notNull().default("disaster"),
    /** 目前階段：outbreak/spreading/peak/receding/ended。 */
    stage: text("stage").notNull().default("outbreak"),
    /** 區域事件是否會隨回合蔓延到相鄰地區。 */
    canSpread: boolean("can_spread").notNull().default(false),
    /** admin | ai | player_decision */
    cause: text("cause").notNull().default("admin"),
    /** active | ended */
    status: text("status").notNull().default("active"),
    /** 嚴重度 1–100，影響每回合數值變動的幅度。 */
    severity: integer("severity").notNull().default(50),
    /** 本事件的影響程度倍率（%，與全域倍率相乘）。 */
    impactPct: integer("impact_pct").notNull().default(100),
    /** 已進行的回合數。 */
    turnsElapsed: integer("turns_elapsed").notNull().default(0),
    /** 到期回合數（null = 由 AI 判定何時結束）。 */
    maxTurns: integer("max_turns"),
    /** 供每回合 AI 判定使用的額外提示脈絡（管理員可填）。 */
    aiContext: text("ai_context"),
    /**
     * 管理員指定本事件要打擊／提升的目標數據欄位（如 population、stability），
     * null／空 = 不限（由 AI 自行決定）。合法值見 api-server superEventImpact.ts
     * 的 SUPER_EVENT_TARGET_STATS；結算端會把非目標欄位強制歸零。
     */
    targetStats: jsonb("target_stats").$type<string[] | null>(),
    /** 已賦予的跨時代關鍵科技清單（避免重複賦予）。 */
    grantedTechs: jsonb("granted_techs")
      .$type<SuperEventGrantedTech[]>()
      .notNull()
      .default([]),
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
    statusIdx: index("super_events_status_idx").on(t.status),
    createdIdx: index("super_events_created_idx").on(t.createdAt),
  }),
);

export type SuperEvent = typeof superEventsTable.$inferSelect;
export type InsertSuperEvent = typeof superEventsTable.$inferInsert;

/**
 * 事件影響的地區。scope = global 時可為空（影響全世界所有掌控地區的國家）；
 * scope = regional 時列出受影響的地區，僅這些地區所屬國家受影響。
 */
export const superEventRegionsTable = pgTable(
  "super_event_regions",
  {
    id: serial("id").primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => superEventsTable.id, { onDelete: "cascade" }),
    regionId: integer("region_id")
      .notNull()
      .references(() => mapRegionsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventRegionUidx: uniqueIndex("super_event_regions_event_region_uidx").on(
      t.eventId,
      t.regionId,
    ),
    eventIdx: index("super_event_regions_event_idx").on(t.eventId),
  }),
);

export type SuperEventRegion = typeof superEventRegionsTable.$inferSelect;

/**
 * 每回合的事件發展紀錄（時間軸）：本回合敘事 + 套用效果的中文摘要。供事件
 * 詳情頁顯示歷程。
 */
export const superEventTurnLogsTable = pgTable(
  "super_event_turn_logs",
  {
    id: serial("id").primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => superEventsTable.id, { onDelete: "cascade" }),
    turnNumber: integer("turn_number").notNull(),
    narrative: text("narrative").notNull().default(""),
    effectSummary: text("effect_summary").notNull().default(""),
    /** 本回合推進到的階段（outbreak/spreading/peak/receding/ended）。 */
    stage: text("stage").notNull().default("outbreak"),
    /** 本回合傳染擴散新增的地區 id 清單（無擴散為空陣列）。 */
    spreadRegionIds: jsonb("spread_region_ids")
      .$type<number[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventIdx: index("super_event_turn_logs_event_idx").on(t.eventId),
  }),
);

export type SuperEventTurnLog = typeof superEventTurnLogsTable.$inferSelect;

/**
 * 玩家對事件的應對（自由文字）。一國一則（覆寫）：提交後為 pending，下回合由
 * AI 判定並寫回 result；玩家可於判定後再次提交。
 */
export const superEventResponsesTable = pgTable(
  "super_event_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => superEventsTable.id, { onDelete: "cascade" }),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id").notNull(),
    responseText: text("response_text").notNull(),
    /** pending | judged */
    status: text("status").notNull().default("pending"),
    resultTitle: text("result_title"),
    resultDescription: text("result_description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    judgedAt: timestamp("judged_at", { withTimezone: true }),
  },
  (t) => ({
    eventNationUidx: uniqueIndex(
      "super_event_responses_event_nation_uidx",
    ).on(t.eventId, t.nationId),
    eventIdx: index("super_event_responses_event_idx").on(t.eventId),
    nationIdx: index("super_event_responses_nation_idx").on(t.nationId),
  }),
);

export type SuperEventResponse = typeof superEventResponsesTable.$inferSelect;
export type InsertSuperEventResponse =
  typeof superEventResponsesTable.$inferInsert;

/**
 * 單列（id = 1）超事件系統設定：AI 自動生成的每回合機率、全域影響程度倍率、
 * 以及 AI 自動生成的提示詞。由管理端 GET/PUT /api/super-events/settings 管理。
 */
export const superEventSettingsTable = pgTable("super_event_settings", {
  id: integer("id").primaryKey().default(1),
  /** 每回合自動生成新事件的機率（%）。 */
  autoGenerateChancePct: integer("auto_generate_chance_pct")
    .notNull()
    .default(5),
  /** 全域影響程度倍率（%），乘上每個事件自身的 impactPct。 */
  globalImpactPct: integer("global_impact_pct").notNull().default(100),
  /**
   * 每回合負面影響（損失）下限（0–100，%／點）。只在事件本就造成該項損失時
   * 生效（不無中生有）；套用範圍＝人口%、生產素質%、滿意度／安定度下降、
   * 暴動度上升；增益不受影響。
   */
  lossMinPct: integer("loss_min_pct").notNull().default(0),
  /** 每回合負面影響（損失）上限（0–100，%／點）。0＝取消所有負面影響。 */
  lossMaxPct: integer("loss_max_pct").notNull().default(100),
  /** AI 自動生成事件的提示詞／風格導引。 */
  aiGenerationPrompt: text("ai_generation_prompt").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SuperEventSettings = typeof superEventSettingsTable.$inferSelect;

/**
 * Task #356 — 指定國家範圍（scope = targeted）的目標國家清單。事件僅影響此表
 * 列出的國家（含 NPC 與玩家）。
 */
export const superEventNationsTable = pgTable(
  "super_event_nations",
  {
    id: serial("id").primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => superEventsTable.id, { onDelete: "cascade" }),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventNationUidx: uniqueIndex("super_event_nations_event_nation_uidx").on(
      t.eventId,
      t.nationId,
    ),
    eventIdx: index("super_event_nations_event_idx").on(t.eventId),
  }),
);

export type SuperEventNation = typeof superEventNationsTable.$inferSelect;

/**
 * Task #356 — 每回合每國實際套用的數值變動紀錄（供管理員檢視與累計）。記錄的是
 * 「實際套用後」的整數變動（夾限後 new − old；人口為地區累積管道實際套用量）。
 */
export const superEventNationImpactsTable = pgTable(
  "super_event_nation_impacts",
  {
    id: serial("id").primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => superEventsTable.id, { onDelete: "cascade" }),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    turnNumber: integer("turn_number").notNull(),
    populationDelta: integer("population_delta").notNull().default(0),
    productionDelta: integer("production_delta").notNull().default(0),
    satisfactionFarmersDelta: integer("satisfaction_farmers_delta")
      .notNull()
      .default(0),
    satisfactionWorkersDelta: integer("satisfaction_workers_delta")
      .notNull()
      .default(0),
    satisfactionNoblesDelta: integer("satisfaction_nobles_delta")
      .notNull()
      .default(0),
    satisfactionClergyDelta: integer("satisfaction_clergy_delta")
      .notNull()
      .default(0),
    stabilityDelta: integer("stability_delta").notNull().default(0),
    unrestDelta: integer("unrest_delta").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eventIdx: index("super_event_nation_impacts_event_idx").on(t.eventId),
    eventNationIdx: index("super_event_nation_impacts_event_nation_idx").on(
      t.eventId,
      t.nationId,
    ),
  }),
);

export type SuperEventNationImpact =
  typeof superEventNationImpactsTable.$inferSelect;
