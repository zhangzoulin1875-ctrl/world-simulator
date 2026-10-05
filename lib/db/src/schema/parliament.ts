import { sql } from "drizzle-orm";
import {
  pgTable, text, integer, serial, timestamp, jsonb, uuid, index, check, boolean,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * 選舉與議會。每國一列議會狀態、多列政黨、多列政策要求紀錄。
 * 席次數字由公式算出（lib/parliament/core.ts），AI 只寫黨名與敘述；玩家唯讀。
 */

/** 每國一列：議會滿意度、回合計數、最近一次對玩家說的話。 */
export const parliamentStateTable = pgTable(
  "parliament_state",
  {
    nationId: uuid("nation_id")
      .primaryKey()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 議會滿意度 0–100；歸零（非專制）觸發革命。 */
    satisfaction: integer("satisfaction").notNull().default(60),
    /** 議會自己的結算回合計數（每次結算 +1），用來算「三回合一次」。 */
    tick: integer("tick").notNull().default(0),
    /** 上次提出政策要求時的 tick；null = 從未提過。 */
    lastDemandTick: integer("last_demand_tick"),
    /** 目前進行中的政策要求（JSON：{stance,text,issuedTick,levels:[...]}）；null = 無。 */
    activeDemand: jsonb("active_demand").$type<ActiveDemand | null>(),
    /** 議會最近一次說的話：抗議內容。 */
    protestText: text("protest_text").notNull().default(""),
    /** 國情報告冷卻：上次提交時的 tick。 */
    lastReportTick: integer("last_report_tick"),
    /** 最近一次國情報告的 AI 評語（給玩家看）。 */
    lastReportFeedback: text("last_report_feedback").notNull().default(""),
    /** 革命發生次數（統計 / 避免連環爆）。 */
    revolutions: integer("revolutions").notNull().default(0),
    /** 上回合快照：稅率與軍隊占用人口，用來算「變化」以判定是否遵守要求。 */
    prevTaxRate: integer("prev_tax_rate"),
    prevArmyPop: text("prev_army_pop"),
    /** 上回合結算時的政策條目數（偵測「本期有沒有寫新政策」）。 */
    prevPolicyCount: integer("prev_policy_count"),
    /** 上次政黨重組時的 tick（AI 組黨節流）。 */
    lastPartiesTick: integer("last_parties_tick"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    satCheck: check("parliament_state_sat_check", sql`${t.satisfaction} >= 0 AND ${t.satisfaction} <= 100`),
  }),
);

export interface ActiveDemand {
  stance: string;
  text: string;
  issuedTick: number;
  /** 期間內每回合的判定結果（長度 0–3）。 */
  levels: string[];
}

/** 議會政黨（AI 自動組黨；席次由公式算）。玩家唯讀。 */
export const parliamentPartiesTable = pgTable(
  "parliament_parties",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    stance: text("stance").notNull(),
    description: text("description").notNull().default(""),
    /** 勢力權重（公式 / AI 建議），席次依此按比例分配。 */
    weight: integer("weight").notNull().default(1),
    seats: integer("seats").notNull().default(0),
    /** 顯示顏色（#rrggbb）。 */
    color: text("color").notNull().default("#888888"),
    isRuling: boolean("is_ruling").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nationIdx: index("parliament_parties_nation_idx").on(t.nationId),
    seatsCheck: check("parliament_parties_seats_check", sql`${t.seats} >= 0 AND ${t.seats} <= 100`),
  }),
);

/** 議會歷史（要求、判定、革命、國情報告）。給玩家看「發生過什麼」。 */
export const parliamentLogTable = pgTable(
  "parliament_log",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    tick: integer("tick").notNull(),
    /** demand | judgement | report | revolution | reshuffle */
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    satDelta: integer("sat_delta").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nationIdx: index("parliament_log_nation_idx").on(t.nationId, t.id),
  }),
);

/**
 * 憲法。每國最多一列。status:draft | reviewing | ratified（none = 沒有這一列）。
 * 通過（ratified）後 final_text 永久鎖定，資料庫層以 trigger 擋下任何修改。
 * 規則在 lib/constitution/core.ts；AI 只負責審查與投票理由，不決定鎖定。
 */
export const constitutionsTable = pgTable(
  "constitutions",
  {
    nationId: uuid("nation_id")
      .primaryKey()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("draft"),
    /** 草稿全文（最多 12000 字）。 */
    draftText: text("draft_text").notNull().default(""),
    /** 通過後的定稿；通過前為 null。永久鎖定。 */
    finalText: text("final_text"),
    /** 通過時的議會 tick 與時間。 */
    ratifiedTick: integer("ratified_tick"),
    ratifiedAt: timestamp("ratified_at", { withTimezone: true }),
    /** 累計送審次數與最近一次送審的 tick（冷卻用）。 */
    submissions: integer("submissions").notNull().default(0),
    lastSubmitTick: integer("last_submit_tick"),
    /** 本次審議開始的時間;伺服器重啟讓背景審查消失時,靠它回收卡在 reviewing 的列。 */
    reviewStartedAt: timestamp("review_started_at", { withTimezone: true }),
    /** 最近一次審查結果（品質分、缺陷、各黨投票），給玩家看。 */
    lastReview: jsonb("last_review").$type<Record<string, unknown> | null>(),
    /** 通過後 AI 掃出的憲法漏洞（階段 3 使用）。 */
    flaws: jsonb("flaws").$type<string[] | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    statusCheck: check("constitutions_status_check", sql`${t.status} IN ('draft','reviewing','ratified')`),
    lenCheck: check("constitutions_len_check", sql`char_length(${t.draftText}) <= 12000`),
  }),
);
