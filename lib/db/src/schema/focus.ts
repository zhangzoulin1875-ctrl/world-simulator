import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { playerNationsTable } from "./playerNations";

/**
 * 國策樹(2026-10-05)。
 *
 * 靜態國策定義(名稱模板、成本、前置、互斥、效果)放程式碼 lib/focus/catalog,
 * 不進資料庫;這裡只存「每個國家的狀態」。
 */

/** 每國國策總狀態:政治點數、黑/紅線傾向值、國策樹生成版本。 */
export const focusStatesTable = pgTable(
  "focus_states",
  {
    nationId: uuid("nation_id")
      .primaryKey()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 政治點數庫存(整數)。 */
    points: integer("points").notNull().default(0),
    /** 黑線(法西斯)傾向值 0-100。 */
    blackLean: integer("black_lean").notNull().default(0),
    /** 紅線(共產)傾向值 0-100。 */
    redLean: integer("red_lean").notNull().default(0),
    /** 這棵樹的結構種子(開局依國家客觀資料算出,決定分支取捨);null=尚未生成。 */
    treeSeed: text("tree_seed"),
    /** 樹結構版本;目錄改版時可據此遷移。 */
    treeVersion: integer("tree_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pointsCheck: check("focus_states_points_check", sql`${t.points} >= 0`),
    blackCheck: check("focus_states_black_check", sql`${t.blackLean} >= 0 AND ${t.blackLean} <= 100`),
    redCheck: check("focus_states_red_check", sql`${t.redLean} >= 0 AND ${t.redLean} <= 100`),
  }),
);

/** 進行中的國策(每國每槽位最多 1 條)。 */
export const focusActiveTable = pgTable(
  "focus_active",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    focusId: text("focus_id").notNull(),
    /** main | side */
    slot: text("slot").notNull(),
    /** 完成所需回合(啟動當下定案,之後目錄改版不影響進行中的)。 */
    totalTurns: integer("total_turns").notNull(),
    /** 已累積進度(回合當量,受議會滿意度影響,可為小數)。 */
    progress: real("progress").notNull().default(0),
    /** 啟動當下已預扣的政治點數(取消時退還比例由規則決定)。 */
    spentPoints: integer("spent_points").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slotUq: uniqueIndex("focus_active_nation_slot_uq").on(t.nationId, t.slot),
    focusUq: uniqueIndex("focus_active_nation_focus_uq").on(t.nationId, t.focusId),
    slotCheck: check("focus_active_slot_check", sql`${t.slot} IN ('main','side')`),
    progressCheck: check("focus_active_progress_check", sql`${t.progress} >= 0`),
  }),
);

/** 已完成的國策(永久紀錄;互斥與前置判定都查這張)。 */
export const focusCompletedTable = pgTable(
  "focus_completed",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    focusId: text("focus_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    /** 完成當下的世界時代 slug,供歷史與日後統計。 */
    eraSlug: text("era_slug"),
  },
  (t) => ({
    uq: uniqueIndex("focus_completed_nation_focus_uq").on(t.nationId, t.focusId),
    nationIdx: index("focus_completed_nation_idx").on(t.nationId),
  }),
);

/**
 * AI 動態生成的「文字層」覆寫(每國每國策一筆)。
 * 只存名稱/敘述/風味文字;效果數值永遠來自程式目錄,AI 無法影響平衡。
 * 國名、領導人名不進 AI prompt,文字中以 {國名}、{領袖} 佔位,顯示時由程式代入。
 */
export const focusTextOverridesTable = pgTable(
  "focus_text_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    focusId: text("focus_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    flavor: text("flavor"),
    /** 生成來源:ai | template(AI 失敗退回模板) */
    source: text("source").notNull().default("template"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("focus_text_nation_focus_uq").on(t.nationId, t.focusId),
    srcCheck: check("focus_text_source_check", sql`${t.source} IN ('ai','template')`),
  }),
);

/**
 * 國策樹隨機分支(2026-10-05):每個國家在「某個政體」時抽到的分支目的地。
 * 抽出後不重抽;換政體後以新政體為根重抽,舊列保留當歷史。
 * 共產革命是獨立入口,不存在這張表裡。
 */
export const focusBranchesTable = pgTable(
  "focus_branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 根政體 slug(抽選當下的政體) */
    fromGovernment: text("from_government").notNull(),
    /** 抽到的目的地政體 slug */
    toGovernment: text("to_government").notNull(),
    drawnAt: timestamp("drawn_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex("focus_branches_nation_from_to_uq").on(t.nationId, t.fromGovernment, t.toGovernment),
    nationIdx: index("focus_branches_nation_from_idx").on(t.nationId, t.fromGovernment),
  }),
);

/**
 * 「這個國家在這個政體已經抽過分支」的標記。主鍵 (nation_id, from_government) 是原子裁決者:
 * 併發時只有成功 INSERT 這一列的請求有權寫入分支,其餘的讀取結果即可。
 * (不依賴 advisory lock,在任何連線環境下都成立。)
 */
export const focusBranchRootsTable = pgTable(
  "focus_branch_roots",
  {
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    fromGovernment: text("from_government").notNull(),
    drawnAt: timestamp("drawn_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.nationId, t.fromGovernment] }),
  }),
);
