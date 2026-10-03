import {
  db,
  mapRegionsTable,
  playerNationsTable,
  regionControlsTable,
  warCampaignsTable,
} from "@workspace/db";
import { and, eq, gt, inArray } from "drizzle-orm";
import { endCampaignById, notifyEndForBoth } from "./endCampaign";
import { logger } from "../logger";

export interface NpcLocalCollapseSummary {
  /** 本回合因 NPC 一方在戰役地區已無任何領土而被結束的戰役數。 */
  endedCount: number;
}

/**
 * 每回合偵測「NPC 主帥在戰役地區已無任何領土」的進行中戰役並結束之。
 *
 * 背景：戰役的正常勝負判定（determineCampaignOutcome）只在結算當下檢查
 * 主帥兩區持分＋城市陷落；但 NPC 在當地的 region_controls 可能被外部途徑
 * 清空（管理員編輯、其他戰役移轉、條約割讓等），戰役卻仍掛著進行中、
 * 鎖住地區交戰鎖。此檢查每回合掃描補救：
 *   - 僅檢查「主帥」（attacker/defender 欄位；Task #579 鐵則——勝負以主帥
 *     持分計，晚加入者殘餘持分不影響）。
 *   - 僅自動結束 NPC 一方（玩家與無主國家不自動判負）。
 *   - NPC 在戰役涉及的地區（出發＋目標，同區爭奪去重）完全沒有
 *     region_controls 列（percent CHECK 1–100，歸零列已刪）→ 對方獲勝，
 *     endReason = "territory"，經 endCampaignById 完整收尾（釋放交戰鎖、
 *     寫冷卻、歸還傷兵與 NPC 常備軍）並通知雙方。
 *   - 不動 diplomacy_wars 列：NPC 全域歸零由 runNpcExtinctionCheck 處理，
 *     否則交由停戰／既有戰爭結束路徑。
 * 每場戰役各自 try/catch，單一失敗不阻斷回合；偵測每回合重跑＝自癒。
 */
export async function endCampaignsForLocallyEliminatedNpcs(): Promise<NpcLocalCollapseSummary> {
  const now = new Date();
  const campaigns = await db
    .select()
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.status, "active"));
  if (campaigns.length === 0) return { endedCount: 0 };

  const nationIds = [
    ...new Set(
      campaigns.flatMap((c) => [c.attackerNationId, c.defenderNationId]),
    ),
  ];
  const nations = await db
    .select()
    .from(playerNationsTable)
    .where(inArray(playerNationsTable.id, nationIds));
  const nationById = new Map(nations.map((n) => [n.id, n]));

  let endedCount = 0;
  for (const campaign of campaigns) {
    try {
      const attacker = nationById.get(campaign.attackerNationId) ?? null;
      const defender = nationById.get(campaign.defenderNationId) ?? null;
      const regionIds =
        campaign.attackerRegionId === campaign.defenderRegionId
          ? [campaign.defenderRegionId]
          : [campaign.attackerRegionId, campaign.defenderRegionId];

      // 找出本戰役中「在地領土歸零」的 NPC 主帥（一場最多一個——NPC↔NPC
      // 戰爭列不存在，鐵則）。
      let collapsedSide: "attacker" | "defender" | null = null;
      for (const side of ["attacker", "defender"] as const) {
        const nation = side === "attacker" ? attacker : defender;
        if (!nation?.isNpc) continue;
        const [control] = await db
          .select({ id: regionControlsTable.id })
          .from(regionControlsTable)
          .where(
            and(
              eq(regionControlsTable.nationId, nation.id),
              inArray(regionControlsTable.regionId, regionIds),
              gt(regionControlsTable.percent, 0),
            ),
          )
          .limit(1);
        if (!control) {
          collapsedSide = side;
          break;
        }
      }
      if (!collapsedSide) continue;

      const winnerNationId =
        collapsedSide === "attacker"
          ? campaign.defenderNationId
          : campaign.attackerNationId;
      const ended = await endCampaignById(campaign.id, {
        reason: "territory",
        winnerNationId,
        now,
      });
      if (!ended) continue;
      endedCount += 1;

      const [region] = await db
        .select({ name: mapRegionsTable.name })
        .from(mapRegionsTable)
        .where(eq(mapRegionsTable.id, campaign.defenderRegionId))
        .limit(1);
      notifyEndForBoth({
        campaign: ended,
        attacker,
        defender,
        regionName: region?.name ?? "未知地區",
        reason: "territory",
        winnerNationId,
      });
      logger.info(
        {
          campaignId: campaign.id,
          collapsedSide,
          collapsedNationId:
            collapsedSide === "attacker"
              ? campaign.attackerNationId
              : campaign.defenderNationId,
          winnerNationId,
        },
        "turn engine: campaign ended, NPC side has no local territory",
      );
    } catch (err) {
      logger.error(
        { err, campaignId: campaign.id },
        "npc local collapse check failed for campaign",
      );
    }
  }
  return { endedCount };
}
