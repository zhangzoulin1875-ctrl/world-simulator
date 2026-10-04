import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  db,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  diplomacyRelationsTable,
  diplomacyRelationEventsTable,
  playerNationsTable,
  regionControlsTable,
  type DiplomacyTreaty,
} from "@workspace/db";
import { clampNpcOfferToCaps } from "./npcTreatyCaps";
import { loadNpcTreatyCaps } from "./npcTreatyCapData";
import {
  canonicalPair,
  findWarBlockingTreatyType,
  findActiveSuzerainId,
  autoJoinNationIds,
  type TreatyType,
  type TreatyEffectView,
} from "./diplomacy";
import { notifyWarDeclared } from "./diplomacyNotify";
import { pgErrorCode } from "./playerValidation";
import { nationsInSameAlliance } from "./alliances";
import { logger } from "./logger";

/**
 * Task #176 T11 — NPC 主動外交／宣戰的資料寫入層（供 npcInitiative 使用）。
 *
 * 這裡把「插入條約提案」與「宣戰」兩個寫入動作，連同它們既有的條約規則與
 * 自動參戰語意，抽成可重用的函式。**刻意不重構玩家路由**（routes/diplomacy.ts
 * 已龐大且有整合測試覆蓋）——這裡以相同語意重建 NPC 主動路徑所需的最小集合。
 *
 * 安全性：宣戰前重查關係值（必須 < 0）、阻擋條約（互不侵犯／同盟）、以及近期
 * 剛結束戰爭的冷卻；插入皆走 onConflictDoNothing／部分唯一索引，併發時乾淨去重。
 */

/** 戰爭結束後的「重新宣戰」冷卻（7 天）：避免 NPC 每回合對剛停戰的玩家再宣戰。 */
export const WAR_REDECLARE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 純函式：某對國家是否在冷卻窗內剛結束過戰爭。
 * endedAts = 該 pair 的所有戰爭列的 endedAt（交戰中為 null，忽略）；
 * 只要有一筆在 cooldownMs 內結束就回 true（應略過本次宣戰）。
 */
export function hasRecentEndedWar(
  endedAts: readonly (Date | null)[],
  now: Date = new Date(),
  cooldownMs: number = WAR_REDECLARE_COOLDOWN_MS,
): boolean {
  return endedAts.some(
    (t) => t !== null && now.getTime() - t.getTime() < cooldownMs,
  );
}

/**
 * 以 NPC 身分插入一筆條約提案（status=proposed，awaiting=target）。
 *
 * 預設「資源零承諾」（NPC 每回合主動外交用，避免破產與資源轉移副作用）。
 * Task #256 — 對話中的「土地／資源交換」需要 NPC 一次性附帶自己的金錢／科技／
 * 領土作為提議，故開放可選的 offer 欄位；type === "custom" 時另可帶 customClause，
 * 並固定 proposerIsPayer=true、perTurn 全 0（純一次性轉移，無經常性效果）。
 * offer 只在提案「被接受」時（activateTreaty）由提案方 NPC 轉給對方；此處不扣款。
 *
 * 同一 pair 已有 proposed 提案時（部分唯一索引 23505）→ 回 null（略過，不丟錯）。
 */
export async function insertNpcTreatyProposal(params: {
  proposerNationId: string;
  targetNationId: string;
  type: TreatyType;
  durationDays: number | null;
  offerMoney?: number;
  offerTechPoints?: number;
  offerRegionIds?: number[];
  /** Task #341 — 每區轉移百分比（regionId 字串 → 百分比）；空 = 整份轉移。 */
  offerRegionPercents?: Record<string, number>;
  /** Task #380 — request 側（要求對方一次性付出）：NPC 主動提案可索求金錢／領土。 */
  requestMoney?: number;
  requestTechPoints?: number;
  requestRegionIds?: number[];
  requestRegionPercents?: Record<string, number>;
  customClause?: string | null;
  /**
   * Task #341 — 付款方旗標。預設沿用既有語意（custom=true、其他=false）；
   * 附條件停戰（NPC 向玩家「索求」資源）需明確傳 false（提案方 NPC 為受益方）。
   */
  proposerIsPayer?: boolean;
  /**
   * Task #341 — 綁定的戰爭 id：非 null 時此條約為「附條件停戰」，接受後結束該場戰爭。
   */
  boundWarId?: number | null;
}): Promise<DiplomacyTreaty | null> {
  const isCustom = params.type === "custom";

  // Task #570 — NPC 締約可提供資源的上限：NPC 主動提案（npcInitiative／
  // 對話交換／AI 生成）的 offer 側夾進世界設定的上限，覆蓋所有 NPC 出資路徑。
  // request 側（要求對方付出）不在此夾——那是對方（玩家）付的。
  // 注意 activateTreaty 的 oneTimeFlip：非 custom 且 proposerIsPayer=false 時，
  // 一次性 offer 側改由「對方」付出（附條件停戰語意），此時 offer 不是 NPC
  // 出資，不得夾限。
  let offerMoney = Math.max(0, params.offerMoney ?? 0);
  let offerTechPoints = Math.max(0, params.offerTechPoints ?? 0);
  let offerRegionIds = params.offerRegionIds ?? [];
  let offerRegionPercents = params.offerRegionPercents ?? {};
  const hasOffer =
    offerMoney > 0 || offerTechPoints > 0 || offerRegionIds.length > 0;
  const proposerPaysOffer =
    (params.proposerIsPayer ?? (isCustom ? true : false)) || isCustom;
  if (hasOffer && proposerPaysOffer) {
    const [proposer] = await db
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, params.proposerNationId))
      .limit(1);
    if (proposer?.isNpc) {
      const [caps, controls] = await Promise.all([
        loadNpcTreatyCaps(proposer),
        db
          .select({
            regionId: regionControlsTable.regionId,
            percent: regionControlsTable.percent,
          })
          .from(regionControlsTable)
          .where(eq(regionControlsTable.nationId, proposer.id)),
      ]);
      const held = new Map(controls.map((r) => [r.regionId, r.percent]));
      const clamped = clampNpcOfferToCaps(
        { offerMoney, offerTechPoints, offerRegionIds, offerRegionPercents },
        held,
        caps,
      );
      if (clamped.clamped) {
        logger.info(
          {
            proposerNationId: proposer.id,
            before: { offerMoney, offerTechPoints, offerRegionIds },
            after: {
              offerMoney: clamped.offerMoney,
              offerTechPoints: clamped.offerTechPoints,
              offerRegionIds: clamped.offerRegionIds,
            },
          },
          "npc treaty offer clamped to caps",
        );
      }
      offerMoney = clamped.offerMoney;
      offerTechPoints = clamped.offerTechPoints;
      offerRegionIds = clamped.offerRegionIds;
      offerRegionPercents = clamped.offerRegionPercents;
    }
  }

  try {
    const [treaty] = await db
      .insert(diplomacyTreatiesTable)
      .values({
        proposerNationId: params.proposerNationId,
        targetNationId: params.targetNationId,
        type: params.type,
        durationDays: params.durationDays,
        offerMoney,
        offerTechPoints,
        offerRegionIds,
        offerRegionPercents,
        requestMoney: params.requestMoney ?? 0,
        requestTechPoints: params.requestTechPoints ?? 0,
        requestRegionIds: params.requestRegionIds ?? [],
        requestRegionPercents: params.requestRegionPercents ?? {},
        customClause: isCustom ? (params.customClause ?? null) : null,
        perTurnMoney: 0,
        perTurnTech: 0,
        perTurnProduction: 0,
        perTurnFood: 0,
        perTurnWood: 0,
        perTurnOre: 0,
        // Task #527 — NPC／對話產生的提案不含反向定期支付。
        requestPerTurnMoney: 0,
        requestPerTurnTech: 0,
        requestPerTurnProduction: 0,
        requestPerTurnFood: 0,
        requestPerTurnWood: 0,
        requestPerTurnOre: 0,
        proposerIsPayer: params.proposerIsPayer ?? (isCustom ? true : false),
        boundWarId: params.boundWarId ?? null,
        status: "proposed",
        awaitingNationId: params.targetNationId,
      })
      .returning();
    return treaty ?? null;
  } catch (err) {
    if (pgErrorCode(err) === "23505") return null;
    throw err;
  }
}

/** declareWarByNpc 的結果：declared=是否成功宣戰；未成功時附上略過原因。 */
export interface DeclareWarResult {
  declared: boolean;
  warId?: number;
  reason?:
    | "self"
    | "relation_non_negative"
    | "blocking_treaty"
    | "same_alliance"
    | "recent_war_cooldown"
    | "already_at_war"
    | "vassal_requires_consent";
}

/**
 * 以 NPC 身分對「真人玩家」宣戰。重建玩家宣戰路由的完整語意：
 * 關係值 < 0 檢查、阻擋條約檢查、canonical pair 插入（onConflictDoNothing）、
 * declare_war 關係事件、被宣戰方同盟／保障獨立夥伴自動參戰、以及對被宣戰方與
 * 被拖入戰爭的夥伴私訊通知。額外加上 7 天內剛結束戰爭的重新宣戰冷卻。
 *
 * 呼叫端須先確保 target 是真人玩家（is_npc=false 且有 discordUserId）——戰爭引擎
 * npcWarTick 只處理 NPC↔真人玩家的戰爭，對 NPC↔NPC／無主國家的戰爭列視而不見
 * （會變成永久無效列）。
 */
export async function declareWarByNpc(params: {
  declarerNationId: string;
  declarerName: string | null;
  target: { id: string; name: string | null; discordUserId: string | null };
  now?: Date;
  /** 軍方越權開戰:略過「關係必須為負」這一項檢查,其餘條約/同盟/冷卻檢查照舊 */
  ignoreRelation?: boolean;
}): Promise<DeclareWarResult> {
  const now = params.now ?? new Date();
  const myId = params.declarerNationId;
  const targetId = params.target.id;
  if (myId === targetId) return { declared: false, reason: "self" };
  const { low, high } = canonicalPair(myId, targetId);

  const [[relation], activeTreaties, pairWars] = await Promise.all([
    db
      .select({ score: diplomacyRelationsTable.score })
      .from(diplomacyRelationsTable)
      .where(
        and(
          eq(diplomacyRelationsTable.nationAId, low),
          eq(diplomacyRelationsTable.nationBId, high),
        ),
      )
      .limit(1),
    db
      .select({
        type: diplomacyTreatiesTable.type,
        proposerNationId: diplomacyTreatiesTable.proposerNationId,
        targetNationId: diplomacyTreatiesTable.targetNationId,
        status: diplomacyTreatiesTable.status,
        expiresAt: diplomacyTreatiesTable.expiresAt,
        // 附庸條約方向（宗主自動參戰需要）。
        proposerIsVassal: diplomacyTreatiesTable.proposerIsVassal,
      })
      .from(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.status, "active")),
    db
      .select({ endedAt: diplomacyWarsTable.endedAt })
      .from(diplomacyWarsTable)
      .where(
        and(
          eq(diplomacyWarsTable.nationAId, low),
          eq(diplomacyWarsTable.nationBId, high),
        ),
      ),
  ]);

  const score = relation?.score ?? 0;
  if (score >= 0 && !params.ignoreRelation) return { declared: false, reason: "relation_non_negative" };

  const treatyViews: TreatyEffectView[] = activeTreaties;
  if (findWarBlockingTreatyType(treatyViews, myId, targetId, now) !== null) {
    return { declared: false, reason: "blocking_treaty" };
  }

  // 附庸外交受限：NPC 附庸不主動宣戰（無法徵求宗主同意，直接略過）。
  if (findActiveSuzerainId(treatyViews, myId, now) !== null) {
    return { declared: false, reason: "vassal_requires_consent" };
  }

  // 聯盟規則（Task #215）：同屬一個聯盟的成員不可互相宣戰。
  if (await nationsInSameAlliance(myId, targetId)) {
    return { declared: false, reason: "same_alliance" };
  }

  if (hasRecentEndedWar(pairWars.map((w) => w.endedAt), now)) {
    return { declared: false, reason: "recent_war_cooldown" };
  }

  const inserted = await db
    .insert(diplomacyWarsTable)
    .values({ nationAId: low, nationBId: high, declaredByNationId: myId })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    return { declared: false, reason: "already_at_war" };
  }

  await db.insert(diplomacyRelationEventsTable).values({
    actorNationId: myId,
    targetNationId: targetId,
    action: "declare_war",
  });

  // 被宣戰方的同盟／保障獨立夥伴自動對 NPC 進入交戰。
  // 僅拖入「真人玩家」夥伴：戰爭引擎 npcWarTick 只處理 NPC↔真人玩家的戰爭，
  // 若把 NPC 夥伴也拉進來會產生一筆永遠不會結束（endedAt 恆 null）的 NPC↔NPC
  // 戰爭列，反而永久卡住那兩個 NPC 之間的外交（activeWarPairs），故在此過濾掉。
  const joinerIds = autoJoinNationIds(treatyViews, targetId, myId, now);
  if (joinerIds.length > 0) {
    const joinerNations = await db
      .select({
        id: playerNationsTable.id,
        discordUserId: playerNationsTable.discordUserId,
      })
      .from(playerNationsTable)
      .where(
        and(
          inArray(playerNationsTable.id, joinerIds),
          eq(playerNationsTable.isNpc, false),
          isNotNull(playerNationsTable.discordUserId),
        ),
      );
    for (const joiner of joinerNations) {
      const pair = canonicalPair(joiner.id, myId);
      const joined = await db
        .insert(diplomacyWarsTable)
        .values({
          nationAId: pair.low,
          nationBId: pair.high,
          declaredByNationId: joiner.id,
        })
        .onConflictDoNothing()
        .returning({ id: diplomacyWarsTable.id });
      if (joined.length > 0) {
        // 被拖入戰爭的夥伴（可能是真人玩家）也通知：現在與該 NPC 交戰。
        notifyWarDeclared({
          targetDiscordUserId: joiner.discordUserId,
          declarerNationName: params.declarerName,
        });
      }
    }
  }

  logger.info(
    { warId: inserted[0]!.id, npcId: myId, targetId },
    "npc declared war",
  );

  notifyWarDeclared({
    targetDiscordUserId: params.target.discordUserId,
    declarerNationName: params.declarerName,
  });

  return { declared: true, warId: inserted[0]!.id };
}
