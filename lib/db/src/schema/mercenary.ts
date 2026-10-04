import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  bigint,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";
import { warCampaignsTable } from "./war";

/**
 * 僱傭兵狀態(一國一列,nation_id 即主鍵 → 天然保證「一次只能一間公司」)。
 *
 * 生命週期:
 *   1. 玩家「解除武裝」→ 建立/更新一列,disarmed = true,company_id = null。
 *   2. 「簽約」→ 設 company_id、signed_at。
 *   3. 「派遣」→ 設 deployed_campaign_id / deployed_slot / deployed_mode;「召回」→ 清空。
 *   4. 「解約」→ company_id = null(disarmed 仍為 true,可立刻換家)。
 *   5. 「恢復建軍」只在沒有合約時允許 → disarmed = false。
 */
export const MERCENARY_DEPLOY_MODES = ["defend", "attack"] as const;
export type MercenaryDeployMode = (typeof MERCENARY_DEPLOY_MODES)[number];

export const mercenaryStatesTable = pgTable(
  "mercenary_states",
  {
    nationId: uuid("nation_id")
      .primaryKey()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 已解除武裝(解鎖軍事合約)。 */
    disarmed: boolean("disarmed").notNull().default(false),
    /** 目前簽約的公司 id(見 lib/mercenary.ts);null = 沒有合約。 */
    companyId: text("company_id"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    /** 派遣目標戰役;null = 待命中(只收租金,不收出動費)。 */
    deployedCampaignId: integer("deployed_campaign_id").references(
      () => warCampaignsTable.id,
      { onDelete: "set null" },
    ),
    /** 佔用的軍團欄位 A | B | C。 */
    deployedSlot: text("deployed_slot"),
    /** defend | attack */
    deployedMode: text("deployed_mode"),
    /** 累計已付租金與出動費(統計用)。 */
    totalRentPaid: bigint("total_rent_paid", { mode: "number" })
      .notNull()
      .default(0),
    totalDeployPaid: bigint("total_deploy_paid", { mode: "number" })
      .notNull()
      .default(0),
    /** 最近一次因付不出租金而自動解約的說明(給玩家看),清除後為 null。 */
    lastTerminationNote: text("last_termination_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    campaignIdx: index("mercenary_states_campaign_idx").on(
      t.deployedCampaignId,
    ),
  }),
);

export type MercenaryState = typeof mercenaryStatesTable.$inferSelect;

/**
 * 傭兵派遣紀錄:一筆 = 傭兵團派進某一場戰役的某個軍團欄位。
 * 一個傭兵團可同時派進多場戰役(每場投入完整兵力),出動費依場次累加。
 * 同一戰役只能派一次;戰役被刪除時整筆跟著刪除(ON DELETE CASCADE)。
 */
export const mercenaryDeploymentsTable = pgTable(
  "mercenary_deployments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    campaignId: integer("campaign_id")
      .notNull()
      .references(() => warCampaignsTable.id, { onDelete: "cascade" }),
    /** 佔用的軍團欄位 A | B | C。 */
    slot: text("slot").notNull(),
    /** defend | attack */
    mode: text("mode").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    nationCampaignUq: uniqueIndex("mercenary_deployments_nation_campaign_uq").on(
      t.nationId,
      t.campaignId,
    ),
    campaignIdx: index("mercenary_deployments_campaign_idx").on(t.campaignId),
  }),
);

export type MercenaryDeployment = typeof mercenaryDeploymentsTable.$inferSelect;
