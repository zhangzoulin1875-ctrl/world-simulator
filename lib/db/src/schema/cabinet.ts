import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  serial,
  timestamp,
  jsonb,
  uuid,
  bigint,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * Task #242 — 內閣系統（地基）。
 *
 * 以「內閣」取代先前的「政治顧問」佔位：三位大臣各自負責一個領域
 *   interior=內政大臣、military=元帥、diplomacy=外交官
 * 每位大臣由 AI 依國家掌控領土的歷史人物生成，具有執政風格
 *   （越權傾向 overreach、膽小程度 timidity、風格敘述 description）。
 *
 * 本檔僅提供三系統共用的資料地基；各領域的實際「代理執行」由下游任務
 * 於各自的領域模組檔（lib/cabinet/domains/*.ts）實作。
 */

/** 大臣／候選人的執政風格（0–100 為百分位傾向；description 為 zh-TW 敘述）。 */
export interface CabinetStyle {
  /** 越權傾向：越高越可能自作主張、超出授權範圍行動。 */
  overreach: number;
  /** 膽小程度：越高越保守、越不願承擔風險。 */
  timidity: number;
  /** 風格敘述（AI 生成的一句話人物性格）。 */
  description: string;
}

/**
 * 在任大臣：每國每領域至多一位在任（status=active，partial unique index）。
 * 時代更替時全部大臣死亡（status=dead），需重新自候選人任命。
 */
export const cabinetMinistersTable = pgTable(
  "cabinet_ministers",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    /** 出身背景（AI 依領土歷史人物生成）。 */
    origin: text("origin").notNull(),
    style: jsonb("style").$type<CabinetStyle>().notNull(),
    /** 任命當時的時代 slug（時代更替 = 死亡的判斷依據）。 */
    era: text("era").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    nationDomainActiveUidx: uniqueIndex("cabinet_ministers_active_uidx")
      .on(t.nationId, t.domain)
      .where(sql`${t.status} = 'active'`),
    nationStatusIdx: index("cabinet_ministers_nation_status_idx").on(
      t.nationId,
      t.status,
    ),
  }),
);

export type CabinetMinister = typeof cabinetMinistersTable.$inferSelect;
export type InsertCabinetMinister = typeof cabinetMinistersTable.$inferInsert;

/**
 * 候選人：AI 一次生成三位供玩家挑選；選定後該領域候選人全數清除。
 * 每國每領域最多同時存在一組候選人。
 */
export const cabinetCandidatesTable = pgTable(
  "cabinet_candidates",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    name: text("name").notNull(),
    origin: text("origin").notNull(),
    style: jsonb("style").$type<CabinetStyle>().notNull(),
    era: text("era").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationDomainIdx: index("cabinet_candidates_nation_domain_idx").on(
      t.nationId,
      t.domain,
    ),
  }),
);

export type CabinetCandidate = typeof cabinetCandidatesTable.$inferSelect;
export type InsertCabinetCandidate = typeof cabinetCandidatesTable.$inferInsert;

/**
 * 領域設定（每國每領域一列）：常駐方針、可代理項目勾選、代理程度。
 * enabledActions 存 domain 模組 actionKeys 的 key 清單；未知 key 讀取時忽略。
 */
export const cabinetDomainSettingsTable = pgTable(
  "cabinet_domain_settings",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    /** 常駐方針（玩家給大臣的自由文字指示）。 */
    directive: text("directive").notNull().default(""),
    /** 已授權代理的動作 key 清單（對應 domain 模組 actionKeys）。 */
    enabledActions: jsonb("enabled_actions")
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 代理程度：conservative=保守、balanced=均衡、aggressive=積極。 */
    agencyLevel: text("agency_level").notNull().default("balanced"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    nationDomainUidx: uniqueIndex("cabinet_domain_settings_uidx").on(
      t.nationId,
      t.domain,
    ),
  }),
);

export type CabinetDomainSettingsRow =
  typeof cabinetDomainSettingsTable.$inferSelect;
export type InsertCabinetDomainSettings =
  typeof cabinetDomainSettingsTable.$inferInsert;

/**
 * 待批准事項佇列：大臣提出但需玩家核准的重大決策。
 * status：pending→approved／rejected（批准後由 domain 模組 executeApproved 執行）。
 * params 為 domain 專屬的動作參數（jsonb，由各 domain 模組自行定義結構）。
 */
export const cabinetApprovalsTable = pgTable(
  "cabinet_approvals",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    /** 對應 domain 模組 actionKeys 的 key。 */
    actionKey: text("action_key").notNull(),
    /** 人類可讀的提案摘要（zh-TW）。 */
    summary: text("summary").notNull(),
    params: jsonb("params").$type<unknown>().notNull().default({}),
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => ({
    nationStatusIdx: index("cabinet_approvals_nation_status_idx").on(
      t.nationId,
      t.status,
    ),
  }),
);

export type CabinetApproval = typeof cabinetApprovalsTable.$inferSelect;
export type InsertCabinetApproval = typeof cabinetApprovalsTable.$inferInsert;

/**
 * 內閣行動紀錄：每次大臣自動執行（mode='auto'）或送交玩家審批
 * （mode='approval'）都寫入一列，供玩家於內閣頁「行動紀錄」檢視。
 * 每國僅保留最新 N 列（由寫入端修剪）。cost_amount／cost_kind 為該行動的
 * 花費（金錢／科技點數／生產力），無花費者為 null。
 */
export const cabinetActionLogsTable = pgTable(
  "cabinet_action_logs",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    /** 對應 domain 模組 actionKeys 的 key。 */
    actionKey: text("action_key").notNull(),
    /** 人類可讀的行動摘要（zh-TW）。 */
    summary: text("summary").notNull(),
    /** 'auto'=大臣自動執行；'approval'=送交玩家審批。 */
    mode: text("mode").notNull(),
    /** 花費數量（無則 null）。 */
    costAmount: bigint("cost_amount", { mode: "number" }),
    /** 花費種類：'money'／'tech'／'production'（無則 null）。 */
    costKind: text("cost_kind"),
    /** 回合當地日期字串（NEWS_SCHEDULE_TZ）。 */
    turnDate: text("turn_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationIdx: index("cabinet_action_logs_nation_idx").on(t.nationId, t.id),
  }),
);

export type CabinetActionLog = typeof cabinetActionLogsTable.$inferSelect;
export type InsertCabinetActionLog =
  typeof cabinetActionLogsTable.$inferInsert;
