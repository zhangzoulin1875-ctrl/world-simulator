import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  diplomacyRelationsTable,
  diplomacyTreatiesTable,
  playerNationsTable,
  vassalConsentRequestsTable,
} from "@workspace/db";
import {
  canonicalPair,
  findActiveSuzerainId,
  findWarBlockingTreatyType,
  treatyTypeLabel,
  type TreatyEffectView,
} from "./diplomacy";
import { notifyVassalConsentRequested } from "./diplomacyNotify";
import { logger } from "./logger";

/**
 * 附庸外交受限（附庸條約的一部分）：附庸要「宣戰」或「聯盟行動」
 * （建立／加入聯盟）時，需先取得宗主同意。
 *
 * - 宗主為 NPC → 伺服器即時「確定性」判定（decideNpcSuzerainConsent 純函式，
 *   不呼叫 AI——與戰爭傷亡同原則：規則由伺服器決定，可測試、可預期）。
 * - 宗主為真人玩家 → 寫入 vassal_consent_requests pending 列＋站內通知，
 *   宗主批准後附庸重試該行動時以 conditional UPDATE 消耗（approved → consumed）。
 *
 * race safety：pending 由部分唯一索引擋重複（onConflictDoNothing → 併發乾淨
 * 收斂為同一則等待訊息）；approved 消耗走 conditional UPDATE，同一份批准
 * 只能用一次。
 */

export type VassalConsentAction =
  | "declare_war"
  | "alliance_create"
  | "alliance_join";

export const VASSAL_CONSENT_ACTION_LABELS: Record<VassalConsentAction, string> =
  {
    declare_war: "宣戰",
    alliance_create: "建立聯盟",
    alliance_join: "加入聯盟",
  };

export function vassalConsentActionLabel(actionType: string): string {
  return (
    VASSAL_CONSENT_ACTION_LABELS[actionType as VassalConsentAction] ?? actionType
  );
}

/**
 * NPC 宗主的確定性判定（純函式，單元測試覆蓋）：
 * - 宣戰：宗主與目標有生效中的阻擋條約（互不侵犯／附庸）→ 拒絕；
 *   宗主與目標關係值 > 0（宗主的朋友）→ 拒絕；其餘同意。
 * - 聯盟行動：宗主與附庸關係值 < 0（附庸失寵）→ 拒絕；其餘同意。
 */
export function decideNpcSuzerainConsent(params: {
  actionType: VassalConsentAction;
  /** 宗主 ↔ 附庸 關係值（查無列視為 0）。 */
  suzerainVassalScore: number;
  /** 宗主 ↔ 宣戰目標 關係值（僅 declare_war；查無列視為 0）。 */
  suzerainTargetScore?: number;
  /** 宗主與宣戰目標之間的阻擋條約類型（僅 declare_war）。 */
  suzerainTargetBlockingTreatyType?: string | null;
}): { approved: boolean; reason: string } {
  if (params.actionType === "declare_war") {
    const blocking = params.suzerainTargetBlockingTreatyType ?? null;
    if (blocking !== null) {
      return {
        approved: false,
        reason: `宗主與目標訂有生效中的${treatyTypeLabel(blocking)}，不允許附庸挑起戰事`,
      };
    }
    if ((params.suzerainTargetScore ?? 0) > 0) {
      return {
        approved: false,
        reason: "宗主與目標關係良好，不允許附庸對其宣戰",
      };
    }
    return { approved: true, reason: "宗主對目標並無好感，同意附庸出兵" };
  }
  if (params.suzerainVassalScore < 0) {
    return {
      approved: false,
      reason: "宗主對我國觀感不佳，不允許附庸擴展聯盟關係",
    };
  }
  return { approved: true, reason: "宗主同意附庸的聯盟行動" };
}

export type ConsentGateResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

async function pairScore(aId: string, bId: string): Promise<number> {
  const { low, high } = canonicalPair(aId, bId);
  const [row] = await db
    .select({ score: diplomacyRelationsTable.score })
    .from(diplomacyRelationsTable)
    .where(
      and(
        eq(diplomacyRelationsTable.nationAId, low),
        eq(diplomacyRelationsTable.nationBId, high),
      ),
    )
    .limit(1);
  return row?.score ?? 0;
}

async function fetchActiveTreatyViews(): Promise<TreatyEffectView[]> {
  return db
    .select({
      type: diplomacyTreatiesTable.type,
      proposerNationId: diplomacyTreatiesTable.proposerNationId,
      targetNationId: diplomacyTreatiesTable.targetNationId,
      status: diplomacyTreatiesTable.status,
      expiresAt: diplomacyTreatiesTable.expiresAt,
      proposerIsVassal: diplomacyTreatiesTable.proposerIsVassal,
    })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.status, "active"));
}

/**
 * 附庸外交守門：無宗主 → 直接放行；有宗主 →
 * 1. 已有符合（同宗主×同行動×同對象）的 approved 請求 → 原子消耗後放行。
 * 2. NPC 宗主 → 確定性判定：同意放行、拒絕 403（zh-TW 理由）。
 * 3. 真人宗主 → 建立（或沿用）pending 請求＋通知宗主，回 409 請附庸等待。
 */
export async function requireSuzerainConsent(params: {
  vassalNationId: string;
  vassalName: string | null;
  actionType: VassalConsentAction;
  /** 宣戰目標（declare_war 必填）。 */
  targetNationId?: string | null;
  /** 聯盟（alliance_join 必填）。 */
  allianceId?: string | null;
  /** 顯示用（目標國名／聯盟名）。 */
  subjectName?: string | null;
  /** 呼叫端已抓的生效條約（省一次查詢；未帶則自查）。 */
  activeTreaties?: TreatyEffectView[];
  now?: Date;
}): Promise<ConsentGateResult> {
  const now = params.now ?? new Date();
  const treaties = params.activeTreaties ?? (await fetchActiveTreatyViews());
  const suzerainId = findActiveSuzerainId(treaties, params.vassalNationId, now);
  if (suzerainId === null) return { ok: true };

  const label = VASSAL_CONSENT_ACTION_LABELS[params.actionType];
  const targetNationId = params.targetNationId ?? null;
  const allianceId = params.allianceId ?? null;

  // 1) 消耗符合的 approved 請求（conditional UPDATE：同一份批准只能用一次）。
  const matchConds = [
    eq(vassalConsentRequestsTable.vassalNationId, params.vassalNationId),
    eq(vassalConsentRequestsTable.suzerainNationId, suzerainId),
    eq(vassalConsentRequestsTable.actionType, params.actionType),
    eq(vassalConsentRequestsTable.status, "approved"),
  ];
  // 嚴格比對目標：無目標（如攻打無人領土）時必須 match target IS NULL，
  // 避免誤耗「針對其他目標」的批准。
  if (params.actionType === "declare_war") {
    matchConds.push(
      targetNationId
        ? eq(vassalConsentRequestsTable.targetNationId, targetNationId)
        : isNull(vassalConsentRequestsTable.targetNationId),
    );
  }
  if (params.actionType === "alliance_join") {
    matchConds.push(
      allianceId
        ? eq(vassalConsentRequestsTable.allianceId, allianceId)
        : isNull(vassalConsentRequestsTable.allianceId),
    );
  }
  const consumed = await db
    .update(vassalConsentRequestsTable)
    .set({ status: "consumed" })
    .where(and(...matchConds))
    .returning({ id: vassalConsentRequestsTable.id });
  if (consumed.length > 0) {
    logger.info(
      {
        requestId: consumed[0]!.id,
        vassalNationId: params.vassalNationId,
        actionType: params.actionType,
      },
      "vassal consent consumed",
    );
    return { ok: true };
  }

  const [suzerain] = await db
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
      isNpc: playerNationsTable.isNpc,
      discordUserId: playerNationsTable.discordUserId,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, suzerainId))
    .limit(1);
  // 宗主國家列不存在（理論上不會發生：條約 FK 保證）→ 不擋行動。
  if (!suzerain) return { ok: true };
  const suzerainName = suzerain.name ?? "（未命名）";

  // 2) NPC 宗主：確定性即時判定，不落列。
  if (suzerain.isNpc) {
    const suzerainVassalScore = await pairScore(
      suzerainId,
      params.vassalNationId,
    );
    let suzerainTargetScore: number | undefined;
    let blockingType: string | null | undefined;
    if (params.actionType === "declare_war" && targetNationId) {
      suzerainTargetScore = await pairScore(suzerainId, targetNationId);
      blockingType = findWarBlockingTreatyType(
        treaties,
        suzerainId,
        targetNationId,
        now,
      );
    }
    const decision = decideNpcSuzerainConsent({
      actionType: params.actionType,
      suzerainVassalScore,
      suzerainTargetScore,
      suzerainTargetBlockingTreatyType: blockingType,
    });
    if (decision.approved) {
      logger.info(
        {
          vassalNationId: params.vassalNationId,
          suzerainId,
          actionType: params.actionType,
        },
        "npc suzerain approved vassal action",
      );
      return { ok: true };
    }
    return {
      ok: false,
      status: 403,
      error: `宗主國「${suzerainName}」不同意${label}：${decision.reason}`,
    };
  }

  // 3) 真人宗主：建立 pending 請求（部分唯一索引擋重複）＋通知。
  const inserted = await db
    .insert(vassalConsentRequestsTable)
    .values({
      vassalNationId: params.vassalNationId,
      suzerainNationId: suzerainId,
      actionType: params.actionType,
      targetNationId,
      allianceId,
      subjectName: params.subjectName ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: vassalConsentRequestsTable.id });
  if (inserted.length > 0) {
    notifyVassalConsentRequested({
      suzerainDiscordUserId: suzerain.discordUserId,
      vassalNationName: params.vassalName,
      actionLabel: label,
      subjectName: params.subjectName ?? null,
    });
    return {
      ok: false,
      status: 409,
      error: `本國為「${suzerainName}」的附庸：已送出「${label}」的同意請求，待宗主批准後再執行一次即可`,
    };
  }
  return {
    ok: false,
    status: 409,
    error: `本國為「${suzerainName}」的附庸：「${label}」的同意請求仍在等待宗主批准`,
  };
}
