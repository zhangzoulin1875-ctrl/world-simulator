import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  integer,
  bigint,
  serial,
  timestamp,
  index,
  uniqueIndex,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";
import { warCampaignLegionsTable } from "./war";

/**
 * 武將系統 — 資料表。
 *
 * 設計原則（與武器系統一致）：AI 只負責生成名字／稱號／背景故事／技能
 * 名稱與描述；所有戰鬥數值（品級加成、技能效果類型與幅度）皆由伺服器
 * 固定表決定，戰鬥結算確定性套用，不回寫任何數值欄位。
 *
 * 生命週期：pool（預產候選池，國家無關）→ drawing（抽出後待玩家決定）
 * → recruited（已招募，計入 8 名上限）→ dismissed（遣返，不退資源）。
 */

/** 一名武將的結構化技能（品級解鎖；效果 = 類型 × 幅度，伺服器夾限）。 */
export interface GeneralSkill {
  /** 技能名稱（AI 生成）。 */
  name: string;
  /** 技能描述（AI 生成；敘事用，不參與結算）。 */
  description: string;
  /** offense | defense | versatile。 */
  effect: string;
  /** 效果幅度（%；0–10，伺服器夾限）。 */
  bonusPct: number;
  /** 解鎖品級（1 = 初始即有；2 / 4 = 升階解鎖）。 */
  unlockGrade: number;
}

/**
 * 武將本體。ownerNationId 指向國家（玩家國家 discordUserId 可反查；
 * 未來 NPC 也可持有）。assignedLegionId 指向某戰役的軍團 slot（A/B/C），
 * FK ON DELETE SET NULL：戰役結束軍團刪除時自動解任（unique index 保證
 * 一個軍團同時最多一名武將坐鎮）。
 */
export const generalsTable = pgTable(
  "generals",
  {
    id: serial("id").primaryKey(),
    /** 持有國家。 */
    ownerNationId: uuid("owner_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 姓名（AI 生成：歷史知名將領優先、無對應人物則虛構）。 */
    name: text("name").notNull(),
    /** 稱號（AI 生成，如「馬其頓的征服者」）。 */
    title: text("title").notNull(),
    /** 背景故事（AI 生成，敘事用）。 */
    background: text("background").notNull(),
    /** 步兵/遠程/裝甲/火炮/艦船/空軍/攻城 專精分類（MILITARY_CATEGORIES）。 */
    category: text("category").notNull(),
    /** 品級 1–5。 */
    grade: integer("grade").notNull().default(1),
    /** candidate | recruited | dismissed。 */
    status: text("status").notNull().default("candidate"),
    /** 技能（jsonb 陣列 GeneralSkill[]；品級不足者為「未解鎖」狀態）。 */
    skills: jsonb("skills").$type<GeneralSkill[]>().notNull().default([]),
    /** 生成時的世界時代 slug（供敘事與未來篩選）。 */
    eraSlug: text("era_slug").notNull(),
    /** 目前指揮的軍團（戰役軍團 id；無 = 未指派）。 */
    assignedLegionId: integer("assigned_legion_id").references(
      () => warCampaignLegionsTable.id,
      { onDelete: "set null" },
    ),
    /** 最近一次成功升階的敘事（AI 生成，失敗不阻塞；null = 尚未升階）。 */
    upgradeNarrative: text("upgrade_narrative"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    ownerIdx: index("generals_owner_idx").on(t.ownerNationId),
    statusIdx: index("generals_status_idx").on(t.ownerNationId, t.status),
    /** 一個軍團同時最多一名武將。 */
    legionUidx: uniqueIndex("generals_assigned_legion_uidx").on(
      t.assignedLegionId,
    ),
    gradeCheck: check("generals_grade_check", sql`${t.grade} >= 1 AND ${t.grade} <= 5`),
  }),
);

export type General = typeof generalsTable.$inferSelect;
export type InsertGeneral = typeof generalsTable.$inferInsert;

/**
 * 預產武將池（國家無關、全體共用）：背景 worker 閒時按「時代 × 分類」
 * 補滿，玩家抽取瞬間直接發牌（零 AI 延遲）。抽取 = 搬一列到 generals
 * （status=candidate）並刪除池列；池空時抽取路由同步呼叫 AI 生成一次
 * （走玩家優先權佇列，與武器設計同款）。
 */
export const generalPoolTable = pgTable(
  "general_pool",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    title: text("title").notNull(),
    background: text("background").notNull(),
    /** MILITARY_CATEGORIES 之一（伺服器擲骰指定，非 AI 自選）。 */
    category: text("category").notNull(),
    /** 技能三條（與 generals.skills 同結構）。 */
    skills: jsonb("skills").$type<GeneralSkill[]>().notNull().default([]),
    eraSlug: text("era_slug").notNull(),
    /**
     * 文化圈 civ profile slug（china_core、persia…）：池列按「時代 × 文化圈」
     * 分桶預產，抽取時優先發給主文化圈相符的國家。
     */
    cultureProfile: text("culture_profile").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    eraCultureIdx: index("general_pool_era_culture_idx").on(
      t.eraSlug,
      t.cultureProfile,
    ),
  }),
);

export type GeneralPoolEntry = typeof generalPoolTable.$inferSelect;
export type InsertGeneralPoolEntry = typeof generalPoolTable.$inferInsert;

/**
 * 每回合抽取流量（flow，不是 stock）：每列 = 一次抽取動作。
 * 「當回合已抽」判定 = created_at > world_game_state.last_turn_at
 * （last_turn_at 為 NULL 時全算當回合）；回合引擎認領新回合後刪除
 * 過期列（與 recruit_production_spends 同款清理）。
 */
export const generalDrawsTable = pgTable(
  "general_draws",
  {
    id: serial("id").primaryKey(),
    ownerNationId: uuid("owner_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** draw = 抽取（一回合一張，quota 判定用）；upgrade = 升階。 */
    kind: text("kind").notNull().default("draw"),
    /** 消耗（記錄用，實際扣款在交易內完成）。 */
    // 必須與 player_nations.money / production_spent 同為 bigint：國家金錢可達
    // 兆級，抽取費 = 國庫 5%，integer（上限 ~21 億）會讓富國抽取／升階整筆 500。
    moneySpent: bigint("money_spent", { mode: "number" }).notNull().default(0),
    productionSpent: bigint("production_spent", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    ownerIdx: index("general_draws_owner_idx").on(
      t.ownerNationId,
      t.createdAt,
    ),
  }),
);

export type GeneralDraw = typeof generalDrawsTable.$inferSelect;
