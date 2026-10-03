import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";
import type { SocialTechEffect } from "./socialTech";
import type { ProductionTechEffect } from "./production";
import type { MilitaryTechBonus } from "./military";

/**
 * Task #469 — 全球統一線性科技樹（文明六式）。
 *
 * 三大領域（social／production／military）共用一張全域節點目錄
 * `tech_tree_nodes`：每個節點屬於某領域 × 時代 × 線（主幹線或支線），
 * 線內以 sort_order 排成一條線性鏈（前一節點研發完成才能研發下一個）。
 * 支線第一個節點以 branch_from_node_id 掛在同時代某節點上（研發完掛點
 * 才解鎖支線）。管理員可透過後台 CRUD 自由增刪修改（不受種子限制）。
 *
 * 各國研發狀態：
 * - player_tech_tree_state：每玩家 × 領域一列（目前時代、進行中節點＋
 *   成本快照＋累積進度、科研點數分配比例）。
 * - player_researched_tree_nodes：已研發節點集合。
 *
 * 回合制研發：科研點數不再為研發而累積——回合引擎把當回合科研產出依
 * ratio_pct 分配進各領域「進行中節點」的 progress_points，溢出即棄。
 */

export const TECH_TREE_DOMAINS = ["social", "production", "military"] as const;
export type TechTreeDomain = (typeof TECH_TREE_DOMAINS)[number];

/**
 * 節點效果：依 domain 分別使用既有三套效果語彙（social＝SocialTechEffect、
 * production＝ProductionTechEffect、military＝MilitaryTechBonus）。
 * 讀取端依 domain 轉型；聚合函式沿用各領域既有實作。
 */
export type TechTreeNodeEffect =
  | SocialTechEffect
  | ProductionTechEffect
  | MilitaryTechBonus;

export const techTreeNodesTable = pgTable(
  "tech_tree_nodes",
  {
    id: serial("id").primaryKey(),
    domain: text("domain").notNull(),
    eraSlug: text("era_slug").notNull(),
    /** 線的識別字（同 domain × era 內唯一辨識一條線）。 */
    lineKey: text("line_key").notNull(),
    /** 線的 zh-TW 顯示名稱（同線各節點應一致；以第一個節點為準顯示）。 */
    lineLabel: text("line_label").notNull(),
    /** main = 主幹線（時代推進門檻）；branch = 支線（選研）。 */
    lineKind: text("line_kind").notNull(),
    /** 線內順序（由小到大，線性前置）。不設唯一以便管理員重排。 */
    sortOrder: integer("sort_order").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    /** 基準成本（實際成本 = 基準 × 國力倍率 × 領先時代加價，研發開始時快照）。 */
    baseCost: integer("base_cost").notNull(),
    effects: jsonb("effects")
      .$type<TechTreeNodeEffect[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** 關鍵科技（★）的穩定識別字（沿用政體／建築解鎖對照）；一般節點為 null。 */
    keySlug: text("key_slug"),
    /** 支線掛點：研發完此節點後支線才解鎖（只看支線第一個節點的掛點）。 */
    branchFromNodeId: integer("branch_from_node_id").references(
      (): AnyPgColumn => techTreeNodesTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    keySlugUnique: uniqueIndex("tech_tree_nodes_key_slug_uidx").on(t.keySlug),
    domainEraIdx: index("tech_tree_nodes_domain_era_idx").on(
      t.domain,
      t.eraSlug,
    ),
    lineIdx: index("tech_tree_nodes_line_idx").on(
      t.domain,
      t.eraSlug,
      t.lineKey,
      t.sortOrder,
    ),
  }),
);

export type TechTreeNode = typeof techTreeNodesTable.$inferSelect;
export type InsertTechTreeNode = typeof techTreeNodesTable.$inferInsert;

/**
 * 每國家 × 領域的研發狀態（時代、進行中節點、成本快照、進度、分配比例）。
 *
 * Task #481 起改鍵到 nation_id（NPC 也逐格走樹）：nation_id 為實質主鍵
 * （app 寫入必帶；DB 層保持 nullable 以配合 Publish DDL replay——回填在
 * 啟動遷移完成）。discord_user_id 為已停用的舊鍵，全部 NULL 化保留欄位
 * （prod replay 安全：不可 DROP）。
 */
export const playerTechTreeStateTable = pgTable(
  "player_tech_tree_state",
  {
    id: serial("id").primaryKey(),
    /** 所屬國家（實質 NOT NULL；見上）。 */
    nationId: uuid("nation_id").references(() => playerNationsTable.id, {
      onDelete: "cascade",
    }),
    /** @deprecated 舊鍵，已全 NULL 化；僅為 prod schema replay 相容保留。 */
    discordUserId: text("discord_user_id").references(
      () => playerNationsTable.discordUserId,
      { onDelete: "cascade" },
    ),
    domain: text("domain").notNull(),
    eraSlug: text("era_slug").notNull().default("classical"),
    /** 進行中節點；null = 此領域目前沒有研發中的科技（點數棄置）。 */
    activeNodeId: integer("active_node_id").references(
      () => techTreeNodesTable.id,
      { onDelete: "set null" },
    ),
    /** 研發開始時的成本快照（進行中才有值）。 */
    costSnapshot: integer("cost_snapshot"),
    /** 已投入的科研點數（進行中才累積；完成或取消歸零）。 */
    progressPoints: integer("progress_points").notNull().default(0),
    /** 科研點數分配比例（整數 %；三領域合計必須 = 100）。 */
    ratioPct: integer("ratio_pct").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    userDomainUnique: uniqueIndex("player_tech_tree_state_user_domain_uidx").on(
      t.discordUserId,
      t.domain,
    ),
    nationDomainUnique: uniqueIndex(
      "player_tech_tree_state_nation_domain_uidx",
    ).on(t.nationId, t.domain),
    nationIdx: index("player_tech_tree_state_nation_idx").on(t.nationId),
  }),
);

export type PlayerTechTreeState = typeof playerTechTreeStateTable.$inferSelect;

/** 國家已研發的科技樹節點（nation_id × node_id 唯一；Task #481 改鍵）。 */
export const playerResearchedTreeNodesTable = pgTable(
  "player_researched_tree_nodes",
  {
    id: serial("id").primaryKey(),
    /** 所屬國家（實質 NOT NULL；DB 層 nullable 理由同上）。 */
    nationId: uuid("nation_id").references(() => playerNationsTable.id, {
      onDelete: "cascade",
    }),
    /** @deprecated 舊鍵，已全 NULL 化；僅為 prod schema replay 相容保留。 */
    discordUserId: text("discord_user_id").references(
      () => playerNationsTable.discordUserId,
      { onDelete: "cascade" },
    ),
    nodeId: integer("node_id")
      .notNull()
      .references(() => techTreeNodesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    userNodeUnique: uniqueIndex("player_researched_tree_nodes_uidx").on(
      t.discordUserId,
      t.nodeId,
    ),
    userIdx: index("player_researched_tree_nodes_user_idx").on(
      t.discordUserId,
    ),
    nationNodeUnique: uniqueIndex("player_researched_tree_nodes_nation_uidx").on(
      t.nationId,
      t.nodeId,
    ),
    nationIdx: index("player_researched_tree_nodes_nation_idx").on(t.nationId),
  }),
);

export type PlayerResearchedTreeNode =
  typeof playerResearchedTreeNodesTable.$inferSelect;
