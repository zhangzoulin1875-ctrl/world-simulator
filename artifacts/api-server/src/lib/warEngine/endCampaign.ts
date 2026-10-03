import {
  db,
  mapRegionsTable,
  playerNationsTable,
  playerWoundedUnitsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignsTable,
  warRegionCooldownsTable,
  warRegionEngagementsTable,
  type PlayerNation,
  type WarCampaign,
} from "@workspace/db";
import { and, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import { REGION_COOLDOWN_MINUTES } from "../war";
import { notifyCampaignEnded } from "../gameNotify";
import { returnNpcTroopsInTx } from "../npcMilitary";
import { logger } from "../logger";
import type { Tx } from "./shared";

// ── 戰役結束 ───────────────────────────────────────────────────

export type CampaignEndReason =
  | "territory"
  | "ceasefire"
  | "nation_removed"
  | "stalemate"
  | "annihilation";

export async function endCampaignInTx(
  tx: Tx,
  campaignId: number,
  params: {
    reason: CampaignEndReason;
    winnerNationId: string | null;
    now: Date;
  },
): Promise<WarCampaign | null> {
  const [row] = await tx
    .update(warCampaignsTable)
    .set({
      status: "ended",
      winnerNationId: params.winnerNationId,
      endReason: params.reason,
      endedAt: params.now,
    })
    .where(
      and(
        eq(warCampaignsTable.id, campaignId),
        eq(warCampaignsTable.status, "active"),
      ),
    )
    .returning();
  if (!row) return null;

  await tx
    .delete(warRegionEngagementsTable)
    .where(eq(warRegionEngagementsTable.campaignId, campaignId));

  const expiresAt = new Date(
    params.now.getTime() + REGION_COOLDOWN_MINUTES * 60_000,
  );
  // Task #349 — 同區爭奪只涉及單一地區，去重避免對同一地區重複寫冷卻。
  const cooldownRegionIds =
    row.attackerRegionId === row.defenderRegionId
      ? [row.attackerRegionId]
      : [row.attackerRegionId, row.defenderRegionId];
  for (const regionId of cooldownRegionIds) {
    await tx
      .insert(warRegionCooldownsTable)
      .values({ regionId, expiresAt })
      .onConflictDoUpdate({
        target: warRegionCooldownsTable.regionId,
        set: {
          expiresAt: sql`GREATEST(${warRegionCooldownsTable.expiresAt}, EXCLUDED.expires_at)`,
        },
      });
  }

  // 前線傷兵回到全國傷兵池（玩家側）；健康部隊自然解除佔用。
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
        lastRecoveryAt: params.now,
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

  // Task #389 — NPC 常備軍結算歸還（所有結束路徑共用）：依 npc_drawn 快照
  // 結算實際損失，倖存者（含傷兵）回到 npc_armies；民兵補足部分解散不歸還。
  const npcRows = await tx
    .select({
      nationId: warCampaignLegionsTable.nationId,
      templateId: warCampaignLegionUnitsTable.templateId,
      npcDrawn: warCampaignLegionUnitsTable.npcDrawn,
      quantity: warCampaignLegionUnitsTable.quantity,
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
        gt(warCampaignLegionUnitsTable.npcDrawn, 0),
        eq(playerNationsTable.isNpc, true),
      ),
    );
  await returnNpcTroopsInTx(tx, npcRows);

  return row;
}

async function endCampaignById(
  campaignId: number,
  params: {
    reason: CampaignEndReason;
    winnerNationId: string | null;
    now: Date;
  },
): Promise<WarCampaign | null> {
  return db.transaction((tx) => endCampaignInTx(tx, campaignId, params));
}

export { endCampaignById };

export function notifyEndForBoth(params: {
  campaign: WarCampaign;
  attacker: PlayerNation | null;
  defender: PlayerNation | null;
  regionName: string;
  reason: CampaignEndReason;
  winnerNationId: string | null;
}): void {
  for (const side of [params.attacker, params.defender]) {
    if (!side?.discordUserId) continue;
    const outcome =
      params.reason === "ceasefire"
        ? "ceasefire"
        : params.winnerNationId
          ? params.winnerNationId === side.id
            ? "victory"
            : "defeat"
          : "ended";
    notifyCampaignEnded({
      discordUserId: side.discordUserId,
      regionName: params.regionName,
      campaignId: params.campaign.id,
      outcome,
    });
  }
}

/**
 * 停戰／戰爭結束：終止該戰爭下所有進行中的戰役並通知雙方。
 * 由外交路由（停戰成立）呼叫；結算迴圈也有兜底。
 */
export async function endCampaignsForWar(
  warId: number,
  reason: CampaignEndReason,
): Promise<void> {
  const now = new Date();
  // Task #453 — 此戰爭結束後，以它為參戰依據晚加入其他戰役的國家自動退出
  //（軍團與傷兵返還）。失敗不阻斷戰役終止流程。
  try {
    const { removeJoinersForEndedWar } = await import("./participants");
    await removeJoinersForEndedWar(warId);
  } catch (err) {
    logger.error({ err, warId }, "remove campaign joiners for ended war failed");
  }
  const campaigns = await db
    .select()
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.warId, warId),
        eq(warCampaignsTable.status, "active"),
      ),
    );
  for (const campaign of campaigns) {
    const ended = await endCampaignById(campaign.id, {
      reason,
      winnerNationId: null,
      now,
    });
    if (!ended) continue;
    const [attacker] = await db
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, campaign.attackerNationId))
      .limit(1);
    const [defender] = await db
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, campaign.defenderNationId))
      .limit(1);
    const [region] = await db
      .select()
      .from(mapRegionsTable)
      .where(eq(mapRegionsTable.id, campaign.defenderRegionId))
      .limit(1);
    notifyEndForBoth({
      campaign: ended,
      attacker: attacker ?? null,
      defender: defender ?? null,
      regionName: region?.name ?? "未知地區",
      reason,
      winnerNationId: null,
    });
  }
}

/**
 * 管理端強制結束單一戰役：以指定 endReason 安全收尾一場進行中的戰役，
 * 重用 endCampaignInTx 的收尾邏輯（釋放地區交戰鎖、寫入冷卻、回收傷兵），
 * 並通知雙方。若戰役不存在或已結束回傳 null。由戰役管理頁呼叫。
 */
export async function forceEndCampaign(
  campaignId: number,
  reason: CampaignEndReason,
): Promise<WarCampaign | null> {
  const now = new Date();
  const ended = await endCampaignById(campaignId, {
    reason,
    winnerNationId: null,
    now,
  });
  if (!ended) return null;
  const [attacker] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, ended.attackerNationId))
    .limit(1);
  const [defender] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, ended.defenderNationId))
    .limit(1);
  const [region] = await db
    .select()
    .from(mapRegionsTable)
    .where(eq(mapRegionsTable.id, ended.defenderRegionId))
    .limit(1);
  notifyEndForBoth({
    campaign: ended,
    attacker: attacker ?? null,
    defender: defender ?? null,
    regionName: region?.name ?? "未知地區",
    reason,
    winnerNationId: null,
  });
  return ended;
}

/**
 * 國家退出／刪除：終止該國參與的所有進行中戰役（對方視為戰役結束，
 * 不判勝負）。由玩家路由（quit／DELETE nation）呼叫。
 */
export async function endCampaignsForNation(nationId: string): Promise<void> {
  const now = new Date();
  const campaigns = await db
    .select()
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.status, "active"),
        or(
          eq(warCampaignsTable.attackerNationId, nationId),
          eq(warCampaignsTable.defenderNationId, nationId),
        ),
      ),
    );
  for (const campaign of campaigns) {
    const ended = await endCampaignById(campaign.id, {
      reason: "nation_removed",
      winnerNationId: null,
      now,
    });
    if (!ended) continue;
    const opponentId =
      campaign.attackerNationId === nationId
        ? campaign.defenderNationId
        : campaign.attackerNationId;
    const [opponent] = await db
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, opponentId))
      .limit(1);
    const [region] = await db
      .select()
      .from(mapRegionsTable)
      .where(eq(mapRegionsTable.id, campaign.defenderRegionId))
      .limit(1);
    if (opponent?.discordUserId) {
      notifyCampaignEnded({
        discordUserId: opponent.discordUserId,
        regionName: region?.name ?? "未知地區",
        campaignId: campaign.id,
        outcome: "ended",
      });
    }
  }
}
