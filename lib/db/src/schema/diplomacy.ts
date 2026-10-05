import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  serial,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uuid,
  uniqueIndex,
  index,
  check,
} from "drizzle-orm/pg-core";
import { playerNationsTable } from "./playerNations";

/**
 * Task #34 — 外交系統資料表。
 *
 * 關係值（diplomacy_relations）：每對國家一列，使用「canonical pair」排序
 * （nationAId < nationBId，以 uuid 字串比較）確保同一對國家只有一列。
 * score 為雙方共享的關係值（−100～100，起始 0）。大使館為單向狀態，
 * 折疊到同一列的兩個 boolean（embassyFromA = A 在 B 設有大使館）。
 */
export const diplomacyRelationsTable = pgTable(
  "diplomacy_relations",
  {
    id: serial("id").primaryKey(),
    nationAId: uuid("nation_a_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    nationBId: uuid("nation_b_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    score: integer("score").notNull().default(0),
    embassyFromA: boolean("embassy_from_a").notNull().default(false),
    embassyFromB: boolean("embassy_from_b").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pairUnique: uniqueIndex("diplomacy_relations_pair_uidx").on(
      t.nationAId,
      t.nationBId,
    ),
    orderCheck: check(
      "diplomacy_relations_order_check",
      sql`${t.nationAId} < ${t.nationBId}`,
    ),
    scoreCheck: check(
      "diplomacy_relations_score_check",
      sql`${t.score} >= -100 AND ${t.score} <= 100`,
    ),
  }),
);

export type DiplomacyRelation = typeof diplomacyRelationsTable.$inferSelect;

/** 玩家對玩家的外交私訊（通訊分頁；輪詢讀取）。 */
export const diplomacyMessagesTable = pgTable(
  "diplomacy_messages",
  {
    id: serial("id").primaryKey(),
    senderNationId: uuid("sender_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    recipientNationId: uuid("recipient_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pairIdx: index("diplomacy_messages_pair_idx").on(
      t.senderNationId,
      t.recipientNationId,
      t.id,
    ),
    unreadIdx: index("diplomacy_messages_unread_idx").on(
      t.recipientNationId,
      t.readAt,
    ),
  }),
);

export type DiplomacyMessage = typeof diplomacyMessagesTable.$inferSelect;

/**
 * 玩家大廳群聊（所有玩家共用的單一聊天室；通訊分頁）。
 * 只有發話國家、內容與時間；無收件人／已讀欄位（大廳不觸發任何通知、不算未讀）。
 */
export const diplomacyLobbyMessagesTable = pgTable(
  "diplomacy_lobby_messages",
  {
    id: serial("id").primaryKey(),
    senderNationId: uuid("sender_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdAtIdx: index("diplomacy_lobby_messages_created_at_idx").on(
      t.createdAt,
      t.id,
    ),
  }),
);

export type DiplomacyLobbyMessage =
  typeof diplomacyLobbyMessagesTable.$inferSelect;

/**
 * 條約與提案（締約分頁）。狀態機：
 *   proposed →（awaiting 方）accept → active（到期後 expired）
 *   proposed →（awaiting 方）reject → rejected
 *   proposed →（NPC AI）counter → 原提案 superseded，新列 counter_of=原 id
 * awaitingNationId = 目前需要回覆的一方（一般提案為 target；NPC 對案為原提案者）。
 * 資源承諾（金錢／科技點數／領土）由提案者付出，於成立時一次性轉移。
 */
export const diplomacyTreatiesTable = pgTable(
  "diplomacy_treaties",
  {
    id: serial("id").primaryKey(),
    proposerNationId: uuid("proposer_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    targetNationId: uuid("target_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** nonaggression | alliance | military_access | guarantee | custom */
    type: text("type").notNull(),
    /** 時效（天）；null = 無期限。 */
    durationDays: integer("duration_days"),
    offerMoney: bigint("offer_money", { mode: "number" }).notNull().default(0),
    offerTechPoints: integer("offer_tech_points").notNull().default(0),
    /** Task #406 — 承諾提供的木材／礦石（成立時一次性轉移）。 */
    offerWood: bigint("offer_wood", { mode: "number" }).notNull().default(0),
    offerOre: bigint("offer_ore", { mode: "number" }).notNull().default(0),
    offerRegionIds: jsonb("offer_region_ids")
      .$type<number[]>()
      .notNull()
      .default([]),
    /**
     * Task #341 — 每個承諾／要求領土的轉移百分比（regionId 字串 → 百分比 1..100）。
     * 空物件或某區缺項時 activateTreaty 會轉移該區「整份掌控」（向後相容既有全額轉移）。
     * 有值時只轉移指定百分比（付款方保留其餘），成立時以 LEAST(...,100) 併入受益方。
     */
    offerRegionPercents: jsonb("offer_region_percents")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    /**
     * Task #374 — 「要求對方提供」側（雙向交換）。
     * offer* 由付款方（proposerIsPayer 決定，一般為提案方）付出；
     * request* 一律由另一方付出，於成立時同一交易內一次性反向轉移。
     * requestRegionPercents 語意同 offerRegionPercents（缺項＝整份轉移）。
     */
    requestMoney: bigint("request_money", { mode: "number" })
      .notNull()
      .default(0),
    requestTechPoints: integer("request_tech_points").notNull().default(0),
    /** Task #406 — 要求對方提供的木材／礦石（成立時一次性反向轉移）。 */
    requestWood: bigint("request_wood", { mode: "number" }).notNull().default(0),
    requestOre: bigint("request_ore", { mode: "number" }).notNull().default(0),
    requestRegionIds: jsonb("request_region_ids")
      .$type<number[]>()
      .notNull()
      .default([]),
    requestRegionPercents: jsonb("request_region_percents")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    /**
     * Task #214 — 自訂條約（type='custom'）欄位。
     * customClause：自由條款文字（僅供顯示，無自動效果）。
     * perTurn*：每回合經常性轉移量（付款方 → 受益方，於每日回合結算執行）。
     * proposerIsPayer：true = 提案方付款、對象受益；false = 反之。
     * 這些欄位僅 type='custom' 有意義；其他條約類型皆為預設值。
     */
    customClause: text("custom_clause"),
    perTurnMoney: bigint("per_turn_money", { mode: "number" })
      .notNull()
      .default(0),
    perTurnTech: integer("per_turn_tech").notNull().default(0),
    perTurnProduction: integer("per_turn_production").notNull().default(0),
    /**
     * 每回合糧食輸送量（付款方 → 受益方）。糧食為流量（非庫存），
     * 於 computeNationFoodReport 以即時流量計入雙方糧食報告：
     * 受益方 +N、付款方 −N；付款方即使不足（會陷入飢荒）也照樣送出。
     */
    perTurnFood: integer("per_turn_food").notNull().default(0),
    /**
     * Task #476 — 每回合木材／礦石輸送量（付款方 → 受益方）。與金錢／科技
     * 相同為庫存制：結算時條件式扣款，付款方庫存不足該項則本回合略過並通知。
     */
    perTurnWood: bigint("per_turn_wood", { mode: "number" })
      .notNull()
      .default(0),
    perTurnOre: bigint("per_turn_ore", { mode: "number" }).notNull().default(0),
    /**
     * Task #527 — 反向每回合經常性轉移（雙向定期支付）。
     * perTurn* 由「perTurn 付款方」（proposerIsPayer 決定）支付；
     * requestPerTurn* 一律由另一方支付（方向恰好相反），兩方向各自獨立結算
     * （任一方不足只略過該方向該項）。舊資料此組全 0 = 純單向，語義不變。
     */
    requestPerTurnMoney: bigint("request_per_turn_money", { mode: "number" })
      .notNull()
      .default(0),
    requestPerTurnTech: integer("request_per_turn_tech").notNull().default(0),
    requestPerTurnProduction: integer("request_per_turn_production")
      .notNull()
      .default(0),
    requestPerTurnFood: integer("request_per_turn_food").notNull().default(0),
    requestPerTurnWood: bigint("request_per_turn_wood", { mode: "number" })
      .notNull()
      .default(0),
    requestPerTurnOre: bigint("request_per_turn_ore", { mode: "number" })
      .notNull()
      .default(0),
    proposerIsPayer: boolean("proposer_is_payer").notNull().default(true),
    /**
     * 附庸條約（type='vassal'）欄位。
     * tributePct：附庸每回合上繳稅收的百分比（1–100；其他類型為 0）。
     * proposerIsVassal：true = 提案方為附庸、對象為宗主；false = 反之（語義 SSOT）。
     * vassalNationId：附庸方 nation id 的實體欄位，只在 activateTreaty 轉為
     * active 時寫入（部分唯一索引 diplomacy_treaties_vassal_nation_active_uidx
     * 據此強制「每個附庸同時只能有一個生效中的宗主」）。不用 CASE 表達式索引
     * ——發布（Publish）的 schema 重放工具無法正確重放多行 CASE 運算式索引。
     */
    tributePct: integer("tribute_pct").notNull().default(0),
    proposerIsVassal: boolean("proposer_is_vassal").notNull().default(true),
    vassalNationId: uuid("vassal_nation_id"),
    /**
     * Task #341 — 附條件停戰：綁定的戰爭 id（nullable）。非 null 時本條約成立
     * （activateTreaty）會在同一交易內結束該場戰爭；玩家接受後即停戰。
     */
    boundWarId: integer("bound_war_id"),
    /** proposed | active | rejected | expired | superseded | annulled */
    status: text("status").notNull().default("proposed"),
    awaitingNationId: uuid("awaiting_nation_id").references(
      () => playerNationsTable.id,
      { onDelete: "cascade" },
    ),
    /** NPC 對案時指向原提案。 */
    counterOfTreatyId: integer("counter_of_treaty_id"),
    /** NPC 回覆的說明文字（同意／拒絕／對案理由）。 */
    responseNote: text("response_note"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /**
     * 到期前預警 DM 已寄出的時間；null = 尚未預警。持久化避免重啟後重複通知
     * （到期迴圈以 UPDATE ... WHERE expiry_warned_at IS NULL RETURNING 原子認領）。
     */
    expiryWarnedAt: timestamp("expiry_warned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    proposerIdx: index("diplomacy_treaties_proposer_idx").on(t.proposerNationId),
    targetIdx: index("diplomacy_treaties_target_idx").on(t.targetNationId),
    statusIdx: index("diplomacy_treaties_status_idx").on(t.status),
  }),
);

export type DiplomacyTreaty = typeof diplomacyTreatiesTable.$inferSelect;

/** 交戰狀態（宣戰分頁）：canonical pair，一對國家最多一筆交戰紀錄。 */
export const diplomacyWarsTable = pgTable(
  "diplomacy_wars",
  {
    id: serial("id").primaryKey(),
    nationAId: uuid("nation_a_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    nationBId: uuid("nation_b_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    declaredByNationId: uuid("declared_by_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /**
     * Task #105 — 停戰提案：提出方 nation id；對方接受後戰爭結束
     * （ended_at 設值）。null = 目前沒有待回覆的停戰提案。
     */
    ceasefireProposedBy: uuid("ceasefire_proposed_by").references(
      () => playerNationsTable.id,
      { onDelete: "set null" },
    ),
    /** Task #105 — 戰爭結束時間；null = 交戰中。 */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /**
     * 奪權內戰(2026-10-05):true = 革命方與原政權之間的內戰。
     * 內戰無法停戰、無法用條約結束,只能有一方被完全消滅。
     */
    isCivilWar: boolean("is_civil_war").notNull().default(false),
    /** 內戰的奪權方(革命方)nation id;非內戰為 null。 */
    rebelNationId: uuid("rebel_nation_id").references(() => playerNationsTable.id, { onDelete: "set null" }),
    /** 奪權方意識形態:black | red | parliament(議會革命);決定勝利後的政體。 */
    rebelIdeology: text("rebel_ideology"),
    /**
     * 內戰結算當下的敗方 nation id(純記錄、刻意不設外鍵:不受 CASCADE/SET NULL 影響)。
     * 用來在「標記結束後、刪國前」程序中斷時,精準補做淘汰,不靠土地推論以免誤殺。
     */
    loserNationId: uuid("loser_nation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Task #105 起改為 partial unique（僅進行中的戰爭唯一）；歷史戰爭保留。
    pairUnique: uniqueIndex("diplomacy_wars_pair_active_uidx")
      .on(t.nationAId, t.nationBId)
      .where(sql`${t.endedAt} IS NULL`),
    orderCheck: check(
      "diplomacy_wars_order_check",
      sql`${t.nationAId} < ${t.nationBId}`,
    ),
  }),
);

export type DiplomacyWar = typeof diplomacyWarsTable.$inferSelect;

/**
 * Task #84 — 關係動作事件紀錄（送禮／侮辱／設館／撤館）。
 * 動作除了改 relation score 外，也留下一筆事件（動作類型、方向、時間），
 * 供 NPC 條約判斷 prompt 回顧近期互動（例如「剛被侮辱過 → 更難同意」）。
 * actorNationId = 執行動作的一方；targetNationId = 承受的一方。
 */
export const diplomacyRelationEventsTable = pgTable(
  "diplomacy_relation_events",
  {
    id: serial("id").primaryKey(),
    actorNationId: uuid("actor_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    targetNationId: uuid("target_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** embassy | gift | insult | withdraw */
    action: text("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    actorIdx: index("diplomacy_relation_events_actor_idx").on(
      t.actorNationId,
      t.createdAt,
    ),
    targetIdx: index("diplomacy_relation_events_target_idx").on(
      t.targetNationId,
      t.createdAt,
    ),
  }),
);

export type DiplomacyRelationEvent =
  typeof diplomacyRelationEventsTable.$inferSelect;

/**
 * 每回合污辱額度：同一行動國對同一目標國、同一回合最多送出 1 次污辱。
 * 回合以 world_game_state.game_date（YYYY-MM-DD）為識別，回合引擎推進日期後
 * 額度自然重置；回合引擎也會順手清除非當前回合的舊列，保持資料表極小。
 * 唯一鍵 (actor, target, turn_date) → 併發時只有一個請求能佔用（乾淨 409）。
 */
export const diplomacyInsultQuotasTable = pgTable(
  "diplomacy_insult_quotas",
  {
    id: serial("id").primaryKey(),
    actorNationId: uuid("actor_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    targetNationId: uuid("target_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 回合識別：world_game_state.game_date（YYYY-MM-DD）。 */
    turnDate: text("turn_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tripleUidx: uniqueIndex("diplomacy_insult_quotas_triple_uidx").on(
      t.actorNationId,
      t.targetNationId,
      t.turnDate,
    ),
  }),
);

export type DiplomacyInsultQuota =
  typeof diplomacyInsultQuotasTable.$inferSelect;

/**
 * Task #228 — 每回合 AI 對話額度：每位玩家（以國家識別）每回合最多與 AI（NPC）
 * 對話 5 句（所有 NPC 合計）。回合以 world_game_state.game_date（YYYY-MM-DD）
 * 識別；回合引擎推進日期後額度自然重置（並順手清除舊列）。
 * 唯一鍵 (nation_id, turn_date) + 「INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE used_count < cap RETURNING」→ 併發下原子認領，不會超額。
 */
export const diplomacyAiChatQuotasTable = pgTable(
  "diplomacy_ai_chat_quotas",
  {
    id: serial("id").primaryKey(),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** 回合識別：world_game_state.game_date（YYYY-MM-DD）。 */
    turnDate: text("turn_date").notNull(),
    /** 本回合已使用的 AI 對話次數。 */
    usedCount: integer("used_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pairUidx: uniqueIndex("diplomacy_ai_chat_quotas_pair_uidx").on(
      t.nationId,
      t.turnDate,
    ),
  }),
);

export type DiplomacyAiChatQuota =
  typeof diplomacyAiChatQuotasTable.$inferSelect;

/**
 * 一次性啟動旗標（例如 NPC「德國」種子只跑一次）：以 INSERT ... ON CONFLICT
 * DO NOTHING 原子認領，避免重啟後重複執行副作用。
 */
export const gameFlagsTable = pgTable("game_flags", {
  key: text("key").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Task #215 — 具名多國聯盟。取代原本一對一的「同盟條約」：
 * 一個聯盟可容納多個成員國，成員之間不可互相宣戰（但不會自動參戰——保障獨立
 * 才有自動參戰）。建立聯盟者為創始國（founder），負責邀請／核准／踢除／改名／解散。
 * founderNationId 可為 null（創始國退出且移交後、或聯盟成員清空前的短暫狀態），
 * ON DELETE SET NULL 讓創始國被硬刪時聯盟不連帶消失（成員關係另由 cascade 處理）。
 */
export const alliancesTable = pgTable("alliances", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  founderNationId: uuid("founder_nation_id").references(
    () => playerNationsTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Alliance = typeof alliancesTable.$inferSelect;

/**
 * 聯盟成員：聯盟 × 國家。一國可同時加入多個聯盟；
 * (alliance_id, nation_id) 唯一索引保證「同一聯盟不重複加入」，併發加入時只有一個能成功（乾淨 409）。
 */
export const allianceMembersTable = pgTable(
  "alliance_members",
  {
    id: serial("id").primaryKey(),
    allianceId: uuid("alliance_id")
      .notNull()
      .references(() => alliancesTable.id, { onDelete: "cascade" }),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    allianceNationUidx: uniqueIndex("alliance_members_alliance_nation_uidx").on(
      t.allianceId,
      t.nationId,
    ),
    nationIdx: index("alliance_members_nation_idx").on(t.nationId),
    allianceIdx: index("alliance_members_alliance_idx").on(t.allianceId),
  }),
);

export type AllianceMember = typeof allianceMembersTable.$inferSelect;

/**
 * 聯盟邀請／申請：聯盟 × 國家 × 方向 × 狀態。
 *  - direction='invite'      → 聯盟（創始國）主動邀請某國家。
 *  - direction='application' → 某國家主動申請加入聯盟。
 * status: pending | accepted | rejected | cancelled。
 * (alliance_id, nation_id, direction) 在 pending 時部分唯一 → 併發重複邀請／申請乾淨 409。
 */
export const allianceInvitesTable = pgTable(
  "alliance_invites",
  {
    id: serial("id").primaryKey(),
    allianceId: uuid("alliance_id")
      .notNull()
      .references(() => alliancesTable.id, { onDelete: "cascade" }),
    nationId: uuid("nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** invite（聯盟→國家）| application（國家→聯盟） */
    direction: text("direction").notNull(),
    /** pending | accepted | rejected | cancelled */
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    pendingUidx: uniqueIndex("alliance_invites_pending_uidx")
      .on(t.allianceId, t.nationId, t.direction)
      .where(sql`${t.status} = 'pending'`),
    nationIdx: index("alliance_invites_nation_idx").on(t.nationId, t.status),
    allianceIdx: index("alliance_invites_alliance_idx").on(
      t.allianceId,
      t.status,
    ),
  }),
);

export type AllianceInvite = typeof allianceInvitesTable.$inferSelect;

/**
 * 附庸外交同意請求：附庸要「宣戰」或「聯盟行動」（建立／加入聯盟）時，
 * 需先取得宗主同意。宗主為 NPC → 伺服器即時確定性判定（不落列）；
 * 宗主為真人玩家 → 寫入 pending 列＋站內通知，批准後附庸重試該行動時
 * 以 conditional UPDATE 消耗（approved → consumed），拒絕則記 denied。
 * (vassal_nation_id, action_type) 在 pending 時部分唯一 → 不重複轟炸宗主。
 */
export const vassalConsentRequestsTable = pgTable(
  "vassal_consent_requests",
  {
    id: serial("id").primaryKey(),
    vassalNationId: uuid("vassal_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    suzerainNationId: uuid("suzerain_nation_id")
      .notNull()
      .references(() => playerNationsTable.id, { onDelete: "cascade" }),
    /** declare_war | alliance_create | alliance_join */
    actionType: text("action_type").notNull(),
    /** 宣戰目標（actionType='declare_war' 時必填）。 */
    targetNationId: uuid("target_nation_id").references(
      () => playerNationsTable.id,
      { onDelete: "cascade" },
    ),
    /** 聯盟（actionType='alliance_join' 時必填；聯盟解散則請求連帶刪除）。 */
    allianceId: uuid("alliance_id").references(() => alliancesTable.id, {
      onDelete: "cascade",
    }),
    /** 顯示用快照（目標國名／聯盟名），避免列表 N+1 查詢。 */
    subjectName: text("subject_name"),
    /** pending | approved | denied | consumed */
    status: text("status").notNull().default("pending"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pendingUidx: uniqueIndex("vassal_consent_requests_pending_uidx")
      .on(t.vassalNationId, t.actionType)
      .where(sql`${t.status} = 'pending'`),
    suzerainIdx: index("vassal_consent_requests_suzerain_idx").on(
      t.suzerainNationId,
      t.status,
    ),
    vassalIdx: index("vassal_consent_requests_vassal_idx").on(
      t.vassalNationId,
      t.status,
    ),
  }),
);

export type VassalConsentRequest =
  typeof vassalConsentRequestsTable.$inferSelect;
