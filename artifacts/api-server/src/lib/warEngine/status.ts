import {
  db,
  playerNationsTable,
  playerResearchedTreeNodesTable,
  techTreeNodesTable,
  playerWoundedUnitsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignsTable,
  type MilitaryTechBonus,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { sumNationalBonusPct } from "../war";
import { SEA_LANDING_KEY_SLUG } from "../military";
import {
  effectiveLandingAttackReductionPct,
  effectiveSeaLandingCapacity,
} from "../navalLanding";
import { getRecoveryBonuses } from "./shared";

// ── 海上登陸能力（Task #152） ──────────────────────────────────

export interface NavalLandingProfile {
  /** 已研發「海戰」→ 可對近海相鄰地區登陸。 */
  naval: boolean;
  /** 已研發「指南針」→ 可無視距離跨洋登陸、容許量 ×10。 */
  compass: boolean;
  /** 有效海上登陸容許量（單場兵力上限；已含指南針 ×10）。 */
  troopCapacity: number;
  /** 有效登陸攻擊力減損百分比（愈低愈好）。 */
  attackReductionPct: number;
}

/**
 * 讀取國家的海上登陸能力。玩家依已研發關鍵技術與加成計算；NPC（無 discord
 * 綁定）視為具備海戰、但無指南針（可近海登陸、不可跨洋）。
 */
export async function getNavalLandingProfile(
  discordUserId: string | null,
): Promise<NavalLandingProfile> {
  if (!discordUserId) {
    return {
      naval: true,
      compass: false,
      troopCapacity: effectiveSeaLandingCapacity(0, false),
      attackReductionPct: effectiveLandingAttackReductionPct(0),
    };
  }
  const rows = await db
    .select({
      keySlug: techTreeNodesTable.keySlug,
      effects: techTreeNodesTable.effects,
    })
    .from(playerResearchedTreeNodesTable)
    .innerJoin(
      techTreeNodesTable,
      eq(techTreeNodesTable.id, playerResearchedTreeNodesTable.nodeId),
    )
    .innerJoin(
      playerNationsTable,
      eq(playerNationsTable.id, playerResearchedTreeNodesTable.nationId),
    )
    .where(
      and(
        eq(playerNationsTable.discordUserId, discordUserId),
        eq(techTreeNodesTable.domain, "military"),
      ),
    );
  const keySlugs = new Set(
    rows.map((r) => r.keySlug).filter((s): s is string => !!s),
  );
  const techs = rows.map((r) => ({
    bonuses: (r.effects ?? []) as MilitaryTechBonus[],
  }));
  const compass = keySlugs.has(SEA_LANDING_KEY_SLUG);
  const capacityBonusPct = sumNationalBonusPct(techs, "seaLandingCapacity");
  const reductionBonusPct = sumNationalBonusPct(techs, "landingAttackReduction");
  return {
    naval: keySlugs.has("naval_warfare"),
    compass,
    troopCapacity: effectiveSeaLandingCapacity(capacityBonusPct, compass),
    attackReductionPct: effectiveLandingAttackReductionPct(reductionBonusPct),
  };
}

/**
 * 傷兵狀態總覽（Task #105 T009）：全國傷兵池 + 進行中戰役前線傷兵，
 * 加上科技復原加成 — 供軍事總覽與玩家國家資料顯示用。
 */
export async function getWoundedStatus(
  discordUserId: string | null,
  nationId: string,
): Promise<{
  woundedTotal: number;
  recoverySpeedPct: number;
  recoveryRatePct: number;
}> {
  const [poolRows, frontRows, bonuses] = await Promise.all([
    discordUserId
      ? db
          .select({
            total: sql<string>`COALESCE(SUM(${playerWoundedUnitsTable.wounded}), 0)::bigint`,
          })
          .from(playerWoundedUnitsTable)
          .where(eq(playerWoundedUnitsTable.discordUserId, discordUserId))
      : Promise.resolve([{ total: "0" }]),
    db
      .select({
        total: sql<string>`COALESCE(SUM(${warCampaignLegionUnitsTable.wounded}), 0)::bigint`,
      })
      .from(warCampaignLegionUnitsTable)
      .innerJoin(
        warCampaignLegionsTable,
        eq(warCampaignLegionsTable.id, warCampaignLegionUnitsTable.legionId),
      )
      .innerJoin(
        warCampaignsTable,
        eq(warCampaignsTable.id, warCampaignLegionsTable.campaignId),
      )
      .where(
        and(
          eq(warCampaignLegionsTable.nationId, nationId),
          eq(warCampaignsTable.status, "active"),
        ),
      ),
    getRecoveryBonuses(discordUserId),
  ]);
  const woundedTotal =
    Number(poolRows[0]?.total ?? 0) + Number(frontRows[0]?.total ?? 0);
  return {
    woundedTotal,
    recoverySpeedPct: bonuses.speedPct,
    recoveryRatePct: bonuses.ratePct,
  };
}
