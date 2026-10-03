import {
  db,
  diplomacyWarsTable,
  mapRegionsTable,
  playerNationsTable,
  playerWoundedUnitsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignParticipantsTable,
  warCampaignsTable,
  type PlayerNation,
  type WarCampaign,
  type WarCampaignParticipant,
} from "@workspace/db";
import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { notifyCampaignAutoExit, notifyCampaignJoined } from "../gameNotify";
import { logger } from "../logger";
import { WarActionError, type Tx } from "./shared";

/**
 * Task #453 — 戰役多國參戰（晚加入選邊制）。
 *
 * 規則：
 * - 只有真人玩家（非 NPC、有 discord_user_id）可以晚加入。
 * - 加入某一方的資格 = 與「對面那方的主帥」有進行中的 diplomacy_wars 戰爭
 *   （join_war_id 記錄該戰爭；不會建立任何新戰爭列）。
 * - 重複加入由 (campaign_id, nation_id) 唯一索引擋下（409）。
 * - 資格戰爭結束（停戰等）時，晚加入者自動退出：前線傷兵回全國傷兵池、
 *   軍團刪除（健康部隊自然解除佔用）、參戰列移除、發站內通知。
 */

export type CampaignSide = "attacker" | "defender";

export const SIDE_LABELS: Record<CampaignSide, string> = {
  attacker: "進攻方",
  defender: "防守方",
};

/** 兩國之間是否有進行中的戰爭；回傳戰爭 id 或 null。 */
export async function findActiveWarBetween(
  nationId: string,
  otherNationId: string,
  executor: typeof db | Tx = db,
): Promise<number | null> {
  const [war] = await executor
    .select({ id: diplomacyWarsTable.id })
    .from(diplomacyWarsTable)
    .where(
      and(
        isNull(diplomacyWarsTable.endedAt),
        or(
          and(
            eq(diplomacyWarsTable.nationAId, nationId),
            eq(diplomacyWarsTable.nationBId, otherNationId),
          ),
          and(
            eq(diplomacyWarsTable.nationAId, otherNationId),
            eq(diplomacyWarsTable.nationBId, nationId),
          ),
        ),
      ),
    )
    .limit(1);
  return war?.id ?? null;
}

export async function loadParticipants(
  campaignId: number,
  executor: typeof db | Tx = db,
): Promise<WarCampaignParticipant[]> {
  return executor
    .select()
    .from(warCampaignParticipantsTable)
    .where(eq(warCampaignParticipantsTable.campaignId, campaignId));
}

export interface JoinEligibility {
  /** 可加入的方（每方對應資格戰爭 id）；空 = 不可加入。 */
  joinableSides: { side: CampaignSide; joinWarId: number }[];
  alreadyParticipant: boolean;
}

/**
 * 檢查 nation 對某場戰役的加入資格：與某方主帥的敵方主帥交戰中 → 可加入
 * 該方。已是參戰國（含主帥） → alreadyParticipant。
 */
export async function getJoinEligibility(
  campaign: WarCampaign,
  nation: PlayerNation,
  executor: typeof db | Tx = db,
): Promise<JoinEligibility> {
  const participants = await loadParticipants(campaign.id, executor);
  if (participants.some((p) => p.nationId === nation.id)) {
    return { joinableSides: [], alreadyParticipant: true };
  }
  if (campaign.status !== "active" || nation.isNpc || !nation.discordUserId) {
    return { joinableSides: [], alreadyParticipant: false };
  }
  const joinableSides: { side: CampaignSide; joinWarId: number }[] = [];
  // 加入進攻方 → 需與防守方主帥交戰中；加入防守方 → 需與進攻方主帥交戰中。
  const checks: { side: CampaignSide; enemyLeadId: string }[] = [
    { side: "attacker", enemyLeadId: campaign.defenderNationId },
    { side: "defender", enemyLeadId: campaign.attackerNationId },
  ];
  for (const c of checks) {
    const warId = await findActiveWarBetween(nation.id, c.enemyLeadId, executor);
    if (warId !== null) joinableSides.push({ side: c.side, joinWarId: warId });
  }
  return { joinableSides, alreadyParticipant: false };
}

/**
 * 晚加入戰役選邊。丟 WarActionError（403/404/409）；唯一違反（併發重複
 * 加入）由呼叫端 pgErrorCode 轉 409。成功後通知既有真人參戰國。
 */
export async function joinCampaign(params: {
  campaign: WarCampaign;
  nation: PlayerNation;
  side: CampaignSide;
}): Promise<WarCampaignParticipant> {
  const { campaign, nation, side } = params;
  if (nation.isNpc || !nation.discordUserId) {
    throw new WarActionError(403, "只有真人玩家國家可以加入戰役");
  }
  const inserted = await db.transaction(async (tx) => {
    // 交易內重讀戰役狀態，避免與結束流程競態。
    const [fresh] = await tx
      .select()
      .from(warCampaignsTable)
      .where(eq(warCampaignsTable.id, campaign.id))
      .limit(1);
    if (!fresh || fresh.status !== "active") {
      throw new WarActionError(404, "戰役已結束或不存在");
    }
    const enemyLeadId =
      side === "attacker" ? fresh.defenderNationId : fresh.attackerNationId;
    if (nation.id === enemyLeadId) {
      throw new WarActionError(403, "無法加入與自己敵對的一方");
    }
    const joinWarId = await findActiveWarBetween(nation.id, enemyLeadId, tx);
    if (joinWarId === null) {
      throw new WarActionError(
        403,
        `你必須與${SIDE_LABELS[side === "attacker" ? "defender" : "attacker"]}主帥處於交戰狀態才能加入${SIDE_LABELS[side]}`,
      );
    }
    const [row] = await tx
      .insert(warCampaignParticipantsTable)
      .values({
        campaignId: fresh.id,
        nationId: nation.id,
        side,
        isLead: false,
        joinWarId,
      })
      .returning();
    if (!row) throw new WarActionError(409, "你已是這場戰役的參戰國");
    return row;
  });

  // 通知既有真人參戰國（不含加入者本人）。
  try {
    const participants = await loadParticipants(campaign.id);
    const otherIds = participants
      .map((p) => p.nationId)
      .filter((id) => id !== nation.id);
    const others = otherIds.length
      ? await db
          .select({
            id: playerNationsTable.id,
            discordUserId: playerNationsTable.discordUserId,
            isNpc: playerNationsTable.isNpc,
          })
          .from(playerNationsTable)
          .where(inArray(playerNationsTable.id, otherIds))
      : [];
    const [region] = await db
      .select({ name: mapRegionsTable.name })
      .from(mapRegionsTable)
      .where(eq(mapRegionsTable.id, campaign.defenderRegionId))
      .limit(1);
    for (const o of others) {
      if (o.isNpc || !o.discordUserId) continue;
      notifyCampaignJoined({
        discordUserId: o.discordUserId,
        joinerName: nation.name ?? "未知國家",
        sideLabel: SIDE_LABELS[side],
        regionName: region?.name ?? "未知地區",
        campaignId: campaign.id,
      });
    }
  } catch (err) {
    logger.warn({ err, campaignId: campaign.id }, "join notification failed");
  }
  return inserted;
}

/**
 * 晚加入者退出戰役（交易內）：前線傷兵回全國傷兵池、刪除該國軍團
 * （軍團兵種 cascade）、移除參戰列。主帥不可用此函式退出。
 */
export async function exitParticipantInTx(
  tx: Tx,
  campaignId: number,
  nationId: string,
  now: Date,
): Promise<boolean> {
  const [participant] = await tx
    .select()
    .from(warCampaignParticipantsTable)
    .where(
      and(
        eq(warCampaignParticipantsTable.campaignId, campaignId),
        eq(warCampaignParticipantsTable.nationId, nationId),
        eq(warCampaignParticipantsTable.isLead, false),
      ),
    )
    .limit(1);
  if (!participant) return false;

  // 前線傷兵回全國傷兵池（僅真人玩家；晚加入者必為真人）。
  const woundedRows = await tx
    .select({
      discordUserId: playerNationsTable.discordUserId,
      templateId: warCampaignLegionUnitsTable.templateId,
      wounded: warCampaignLegionUnitsTable.wounded,
    })
    .from(warCampaignLegionUnitsTable)
    .innerJoin(
      warCampaignLegionsTable,
      eq(warCampaignLegionsTable.id, warCampaignLegionUnitsTable.legionId),
    )
    .innerJoin(
      playerNationsTable,
      eq(playerNationsTable.id, warCampaignLegionsTable.nationId),
    )
    .where(
      and(
        eq(warCampaignLegionsTable.campaignId, campaignId),
        eq(warCampaignLegionsTable.nationId, nationId),
        gt(warCampaignLegionUnitsTable.wounded, 0),
        isNotNull(playerNationsTable.discordUserId),
        eq(playerNationsTable.isNpc, false),
      ),
    );
  for (const w of woundedRows) {
    if (!w.discordUserId) continue;
    await tx
      .insert(playerWoundedUnitsTable)
      .values({
        discordUserId: w.discordUserId,
        templateId: w.templateId,
        wounded: w.wounded,
        initialWounded: w.wounded,
        lastRecoveryAt: now,
      })
      .onConflictDoUpdate({
        target: [
          playerWoundedUnitsTable.discordUserId,
          playerWoundedUnitsTable.templateId,
        ],
        set: {
          wounded: sql`${playerWoundedUnitsTable.wounded} + EXCLUDED.wounded`,
          initialWounded: sql`${playerWoundedUnitsTable.initialWounded} + EXCLUDED.initial_wounded`,
        },
      });
  }

  await tx
    .delete(warCampaignLegionsTable)
    .where(
      and(
        eq(warCampaignLegionsTable.campaignId, campaignId),
        eq(warCampaignLegionsTable.nationId, nationId),
      ),
    );
  await tx
    .delete(warCampaignParticipantsTable)
    .where(eq(warCampaignParticipantsTable.id, participant.id));
  return true;
}

/**
 * 某場戰爭結束時，所有以該戰爭為資格的晚加入者自動退出其所在的進行中
 * 戰役（傷兵返國＋通知）。必須在每個結束戰爭的路徑呼叫（停戰、條約等）。
 */
export async function removeJoinersForEndedWar(warId: number): Promise<void> {
  const now = new Date();
  const rows = await db
    .select({
      participant: warCampaignParticipantsTable,
      campaign: warCampaignsTable,
    })
    .from(warCampaignParticipantsTable)
    .innerJoin(
      warCampaignsTable,
      eq(warCampaignsTable.id, warCampaignParticipantsTable.campaignId),
    )
    .where(
      and(
        eq(warCampaignParticipantsTable.joinWarId, warId),
        eq(warCampaignParticipantsTable.isLead, false),
        eq(warCampaignsTable.status, "active"),
      ),
    );
  for (const { participant, campaign } of rows) {
    try {
      const removed = await db.transaction((tx) =>
        exitParticipantInTx(tx, campaign.id, participant.nationId, now),
      );
      if (!removed) continue;
      const [nation] = await db
        .select({ discordUserId: playerNationsTable.discordUserId })
        .from(playerNationsTable)
        .where(eq(playerNationsTable.id, participant.nationId))
        .limit(1);
      if (nation?.discordUserId) {
        const [region] = await db
          .select({ name: mapRegionsTable.name })
          .from(mapRegionsTable)
          .where(eq(mapRegionsTable.id, campaign.defenderRegionId))
          .limit(1);
        notifyCampaignAutoExit({
          discordUserId: nation.discordUserId,
          regionName: region?.name ?? "未知地區",
          campaignId: campaign.id,
        });
      }
    } catch (err) {
      logger.error(
        { err, campaignId: campaign.id, nationId: participant.nationId },
        "auto-exit joiner failed",
      );
    }
  }
}

/**
 * 結算前兜底：戰役中資格戰爭已結束的晚加入者先行退出（防止結束路徑
 * 漏呼叫 removeJoinersForEndedWar 時殘留）。
 */
export async function pruneStaleJoiners(campaignId: number): Promise<void> {
  const now = new Date();
  const stale = await db
    .select({
      nationId: warCampaignParticipantsTable.nationId,
      joinWarId: warCampaignParticipantsTable.joinWarId,
    })
    .from(warCampaignParticipantsTable)
    .leftJoin(
      diplomacyWarsTable,
      eq(diplomacyWarsTable.id, warCampaignParticipantsTable.joinWarId),
    )
    .where(
      and(
        eq(warCampaignParticipantsTable.campaignId, campaignId),
        eq(warCampaignParticipantsTable.isLead, false),
        or(
          isNull(diplomacyWarsTable.id),
          isNotNull(diplomacyWarsTable.endedAt),
        ),
      ),
    );
  for (const row of stale) {
    try {
      await db.transaction((tx) =>
        exitParticipantInTx(tx, campaignId, row.nationId, now),
      );
    } catch (err) {
      logger.error(
        { err, campaignId, nationId: row.nationId },
        "prune stale joiner failed",
      );
    }
  }
}
