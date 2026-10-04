import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  uuid,
  integer,
  bigint,
  serial,
  timestamp,
  boolean,
  doublePrecision,
  uniqueIndex,
  index,
  date,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * Task #27 — 軍事系統（建造軍隊）。
 *
 * 兵種模板：一律為 AI 設計的自創兵種，綁定擁有者（玩家 = owner_discord_user_id、
 * NPC = owner_nation_id）。Task #549 起預設種子模板（isDefault = true）已全面
 * 移除；is_default 欄位保留（永不 DROP），僅不再有 true 列。
 * 所有戰鬥數值與招募成本都存在模板上；已研發軍事科技的加成在讀取時套用，
 * 不回寫模板。
 */
/**
 * 武器系統 — 玩家 AI 設計的武器藍圖。相容類別由 AI 建議、伺服器夾限；
 * 每把武器附帶一個 AI 生成的「特殊技能」（名稱＋描述獨一無二，效果為
 * 結構化欄位，戰鬥結算確定性套用）。
 */
export const militaryWeaponsTable = pgTable(
  "military_weapons",
  {
    id: serial("id").primaryKey(),
    /** 設計者（玩家 Discord user id）。 */
    ownerDiscordUserId: text("owner_discord_user_id").references(
      () => playerNationsTable.discordUserId,
      { onDelete: "cascade" },
    ),
    /** Task #389 同款：NPC 以國家 id 持有（目前 NPC 不設計武器，保留欄位）。 */
    ownerNationId: uuid("owner_nation_id").references(
      () => playerNationsTable.id,
      { onDelete: "cascade" },
    ),
    name: text("name").notNull(),
    description: text("description").notNull(),
    /** AI 建議的相容兵種類別（jsonb 陣列，元素為 MILITARY_CATEGORIES）。 */
    compatibleCategories: text("compatible_categories")
      .array()
      .notNull(),
    /** 相容兵種的攻擊加成（%； 夾限 0–15）。 */
    attackPct: integer("attack_pct").notNull().default(0),
    /** 相容兵種的防禦加成（%； 夾限 0–15）。 */
    defensePct: integer("defense_pct").notNull().default(0),
    /** 特殊技能名稱（AI 生成、獨一無二）。 */
    skillName: text("skill_name").notNull(),
    /** 特殊技能描述（AI 生成、獨一無二）。 */
    skillDescription: text("skill_description").notNull(),
    /** 技能效果類型：offense | defense | versatile。 */
    skillEffect: text("skill_effect").notNull(),
    /** 技能效果幅度（%；夾限 0–10）。 */
    skillBonusPct: integer("skill_bonus_pct").notNull().default(0),
    /** AI 設計時的世界時代 slug。 */
    eraSlug: text("era_slug"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    ownerIdx: index("military_weapons_owner_idx").on(t.ownerDiscordUserId),
    ownerNationIdx: index("military_weapons_owner_nation_idx").on(
      t.ownerNationId,
    ),
  }),
);

export type MilitaryWeapon = typeof militaryWeaponsTable.$inferSelect;
export type InsertMilitaryWeapon = typeof militaryWeaponsTable.$inferInsert;

export const militaryUnitTemplatesTable = pgTable(
  "military_unit_templates",
  {
    id: serial("id").primaryKey(),
    /** null = 預設模板（全體玩家可用）；否則為 AI 設計者的 Discord user id。 */
    ownerDiscordUserId: text("owner_discord_user_id").references(
      () => playerNationsTable.discordUserId,
      { onDelete: "cascade" },
    ),
    /**
     * Task #389 — NPC 專屬兵種：以國家 id 持有（NPC 無 discord_user_id）。
     * 玩家自創兵種仍以 owner_discord_user_id 持有；兩者互斥（NPC 模板此欄非
     * null、owner_discord_user_id 為 null）。
     */
    ownerNationId: uuid("owner_nation_id").references(
      () => playerNationsTable.id,
      { onDelete: "cascade" },
    ),
    /** infantry | ranged | armor | artillery | ship | air | siege */
    category: text("category").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isDefault: boolean("is_default").notNull().default(false),
    /** AI 設計時的世界時代 slug（預設模板為 null）。 */
    eraSlug: text("era_slug"),
    hp: integer("hp").notNull(),
    attack: integer("attack").notNull(),
    defense: integer("defense").notNull(),
    speed: doublePrecision("speed").notNull(),
    accuracy: integer("accuracy").notNull(),
    /** melee | ranged */
    range: text("range").notNull(),
    antiCavalryPct: integer("anti_cavalry_pct").notNull().default(0),
    antiRangedPct: integer("anti_ranged_pct").notNull().default(0),
    /** Task #406 — 抗火炮加成（0–100%）。 */
    antiArtilleryPct: integer("anti_artillery_pct").notNull().default(0),
    siegePct: integer("siege_pct").notNull().default(0),
    /** 每 100 單位所需生產力（整數；步兵=1、騎兵=10、艦船=100）。 */
    prodCostPer100: integer("prod_cost_per_100").notNull(),
    /** 每單位所需人口。 */
    popCostPerUnit: integer("pop_cost_per_unit").notNull(),
    /** 金錢直購時每單位價格。 */
    moneyCostPerUnit: bigint("money_cost_per_unit", { mode: "number" }).notNull(),
    /** 每單位「金錢」維護費（Task #406 起維護費拆為金錢＋生產力兩軌）。 */
    upkeepPerUnit: doublePrecision("upkeep_per_unit").notNull().default(0),
    /** Task #406 — 每單位「生產力」維護費（每回合自可用生產力扣除）。 */
    prodUpkeepPerUnit: doublePrecision("prod_upkeep_per_unit")
      .notNull()
      .default(0),
    /** Task #406 — 每單位製造所需木材／礦石（招募與購買時同交易扣庫存）。 */
    woodCostPerUnit: integer("wood_cost_per_unit").notNull().default(0),
    oreCostPerUnit: integer("ore_cost_per_unit").notNull().default(0),
    /**
     * 武器系統 — 已裝備的武器（軍事武器藍圖）；null = 未裝備。
     * 銷毀武器時 FK ON DELETE SET NULL 自動卸除裝備。
     */
    equippedWeaponId: integer("equipped_weapon_id").references(
      () => militaryWeaponsTable.id,
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
    ownerIdx: index("military_unit_templates_owner_idx").on(
      t.ownerDiscordUserId,
    ),
    ownerNationIdx: index("military_unit_templates_owner_nation_idx").on(
      t.ownerNationId,
    ),
  }),
);

export type MilitaryUnitTemplate =
  typeof militaryUnitTemplatesTable.$inferSelect;
export type InsertMilitaryUnitTemplate =
  typeof militaryUnitTemplatesTable.$inferInsert;

/** 玩家持有的軍隊：模板 × 數量。 */
export const playerArmiesTable = pgTable(
  "player_armies",
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
    quantity: bigint("quantity", { mode: "number" }).notNull().default(0),
    productionReserved: bigint("production_reserved", { mode: "number" })
      .notNull()
      .default(0),
    populationReserved: bigint("population_reserved", { mode: "number" })
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
    playerTemplateUidx: uniqueIndex("player_armies_player_template_uidx").on(
      t.discordUserId,
      t.templateId,
    ),
    playerIdx: index("player_armies_player_idx").on(t.discordUserId),
  }),
);

export type PlayerArmy = typeof playerArmiesTable.$inferSelect;

/**
 * Task #389 — NPC 常備軍：以國家 id 持有（NPC 無 discord_user_id，走不了
 * player_armies 的 FK）。quantity = 健康總數（含已抽調至前線者）；
 * committed = 目前抽調在前線的數量（可再抽調 = quantity − committed）；
 * wounded = 全國傷兵恢復池（每回合按比例回歸 quantity）。
 */
export const npcArmiesTable = pgTable(
  "npc_armies",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    templateId: integer("template_id")
      .notNull()
      .references(() => militaryUnitTemplatesTable.id, { onDelete: "cascade" }),
    quantity: bigint("quantity", { mode: "number" }).notNull().default(0),
    committed: bigint("committed", { mode: "number" }).notNull().default(0),
    wounded: bigint("wounded", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    nationTemplateUidx: uniqueIndex("npc_armies_nation_template_uidx").on(
      t.nationId,
      t.templateId,
    ),
    nationIdx: index("npc_armies_nation_idx").on(t.nationId),
  }),
);

export type NpcArmy = typeof npcArmiesTable.$inferSelect;

/**
 * Task #400 — 每日全國軍力快照（每國每遊戲日一列，回合結算時寫入）。
 * 只存聚合人口值（popCostPerUnit 口徑），不存兵種編制，供世界地圖政治
 * 視圖顯示各國軍力趨勢與「傷兵中／前線中」比例。
 */
export const nationMilitarySnapshotsTable = pgTable(
  "nation_military_snapshots",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 遊戲內日期（world_game_state.game_date，YYYY-MM-DD）。 */
    snapshotDate: date("snapshot_date").notNull(),
    /** 軍隊總人口（現役＋傷兵；NPC 含前線抽調）。 */
    armyPopulation: bigint("army_population", { mode: "number" })
      .notNull()
      .default(0),
    /** 傷兵占用人口。 */
    woundedPopulation: bigint("wounded_population", { mode: "number" })
      .notNull()
      .default(0),
    /** 前線（戰役中）占用人口。 */
    committedPopulation: bigint("committed_population", { mode: "number" })
      .notNull()
      .default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationDateUidx: uniqueIndex("nation_military_snapshots_nation_date_uidx").on(
      t.nationId,
      t.snapshotDate,
    ),
    nationIdx: index("nation_military_snapshots_nation_idx").on(t.nationId),
  }),
);

export type NationMilitarySnapshot =
  typeof nationMilitarySnapshotsTable.$inferSelect;

/**
 * 單一加成項：target 指定影響的數值欄位，category 為 null 時適用所有類別，
 * pct 為百分比（可正可負，例如 +50 = +50%）。
 */
export interface MilitaryTechBonus {
  target:
    | "hp"
    | "attack"
    | "defense"
    | "speed"
    | "accuracy"
    | "prodCost"
    | "popCost"
    | "moneyCost"
    | "upkeep"
    | "recoverySpeed"
    | "recoveryRate"
    | "seaLandingCapacity"
    | "landingAttackReduction"
    | "foodConsumption";
  category:
    | "infantry"
    | "ranged"
    | "armor"
    | "artillery"
    | "ship"
    | "air"
    | "siege"
    | null;
  pct: number;
}

/**
 * 金錢購買的每日額度使用量（以 NEWS_SCHEDULE_TZ 當地日曆日為單位；之後的
 * 回合引擎可直接沿用同一張表改成每回合重置）。
 */
export const militaryPurchaseQuotasTable = pgTable(
  "military_purchase_quotas",
  {
    id: serial("id").primaryKey(),
    discordUserId: text("discord_user_id")
      .notNull()
      .references(() => playerNationsTable.discordUserId, {
        onDelete: "cascade",
      }),
    /** 當地日期字串 YYYY-MM-DD。 */
    dateLabel: text("date_label").notNull(),
    usedUnits: bigint("used_units", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    playerDateUidx: uniqueIndex("military_purchase_quotas_player_date_uidx").on(
      t.discordUserId,
      t.dateLabel,
    ),
  }),
);

export type MilitaryPurchaseQuota =
  typeof militaryPurchaseQuotasTable.$inferSelect;

/**
 * Task #63 — 玩家對兵種模板的個人化設定（目前僅自訂顯示名稱）。
 * 預設模板是全體共用的，改名只影響該玩家自己看到的名稱；清空即刪列還原。
 */
export const playerUnitCustomizationsTable = pgTable(
  "player_unit_customizations",
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
    customName: text("custom_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    playerTemplateUidx: uniqueIndex(
      "player_unit_customizations_player_template_uidx",
    ).on(t.discordUserId, t.templateId),
    playerIdx: index("player_unit_customizations_player_idx").on(
      t.discordUserId,
    ),
  }),
);

export type PlayerUnitCustomization =
  typeof playerUnitCustomizationsTable.$inferSelect;

/**
 * Task #568 — 招募的「立即性生產力花費」流量紀錄（flow，不是 stock）：
 * 每筆招募寫一列（國家 × 兵種 × 數量 × 花費量）。「當回合」判定 =
 * created_at > world_game_state.last_turn_at（last_turn_at 為 NULL 時全算
 * 當回合）；回合引擎在認領新回合後刪除過期列（跨回合自動歸零）。
 * 絕不把花費持久化進任何累積欄位（flow vs stock 原則）。
 */
export const recruitProductionSpendsTable = pgTable(
  "recruit_production_spends",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    templateId: integer("template_id")
      .notNull()
      .references(() => militaryUnitTemplatesTable.id, { onDelete: "cascade" }),
    quantity: bigint("quantity", { mode: "number" }).notNull(),
    /** 立即性生產力花費 = ⌈數量 × 有效 prodCostPer100 ÷ 100⌉。 */
    amount: bigint("amount", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationIdx: index("recruit_production_spends_nation_idx").on(t.nationId),
    createdAtIdx: index("recruit_production_spends_created_at_idx").on(
      t.createdAt,
    ),
  }),
);

export type RecruitProductionSpend =
  typeof recruitProductionSpendsTable.$inferSelect;
