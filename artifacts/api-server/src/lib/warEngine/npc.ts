import {
  db,
  diplomacyWarsTable,
  mapRegionAdjacenciesTable,
  playerNationsTable,
  regionControlsTable,
  warCampaignsTable,
  warRegionCooldownsTable,
  warRegionEngagementsTable,
} from "@workspace/db";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { logger } from "../logger";
import {
  NPC_INITIATE_CHANCE,
  NPC_INITIATE_COOLDOWN_HOURS,
  NPC_TROOP_MIN,
  WarActionError,
} from "./shared";
import { npcAvailableTroops } from "../npcMilitary";
import { initiateCampaign } from "./initiate";

// ── NPC 主動開戰 ───────────────────────────────────────────────

let npcTickRunning = false;

export async function npcWarTick(now = new Date()): Promise<void> {
  if (npcTickRunning) return;
  npcTickRunning = true;
  try {
    const nationA = alias(playerNationsTable, "war_nation_a");
    const nationB = alias(playerNationsTable, "war_nation_b");
    const wars = await db
      .select({
        war: diplomacyWarsTable,
        a: {
          id: nationA.id,
          isNpc: nationA.isNpc,
          discordUserId: nationA.discordUserId,
        },
        b: {
          id: nationB.id,
          isNpc: nationB.isNpc,
          discordUserId: nationB.discordUserId,
        },
      })
      .from(diplomacyWarsTable)
      .innerJoin(nationA, eq(nationA.id, diplomacyWarsTable.nationAId))
      .innerJoin(nationB, eq(nationB.id, diplomacyWarsTable.nationBId))
      .where(isNull(diplomacyWarsTable.endedAt));

    const cutoff = new Date(
      now.getTime() - NPC_INITIATE_COOLDOWN_HOURS * 3_600_000,
    );
    for (const row of wars) {
      const npc = row.a.isNpc ? row.a : row.b.isNpc ? row.b : null;
      const enemy = npc === row.a ? row.b : row.a;
      if (!npc || enemy.isNpc || !enemy.discordUserId) continue;

      // 節奏限制：每 NPC 同時最多一場主動戰役、兩次主動開戰間有冷卻。
      const [activeInitiated] = await db
        .select({ id: warCampaignsTable.id })
        .from(warCampaignsTable)
        .where(
          and(
            eq(warCampaignsTable.attackerNationId, npc.id),
            eq(warCampaignsTable.initiatedByNpc, true),
            eq(warCampaignsTable.status, "active"),
          ),
        )
        .limit(1);
      if (activeInitiated) continue;
      const [recentInitiated] = await db
        .select({ id: warCampaignsTable.id })
        .from(warCampaignsTable)
        .where(
          and(
            eq(warCampaignsTable.attackerNationId, npc.id),
            eq(warCampaignsTable.initiatedByNpc, true),
            gt(warCampaignsTable.createdAt, cutoff),
          ),
        )
        .limit(1);
      if (recentInitiated) continue;

      if (Math.random() >= NPC_INITIATE_CHANCE) continue;

      // Task #389 — NPC 主動進攻只用常備軍：可抽調兵力不足最低編制門檻時，
      // 本輪不開戰（剛打完大戰的 NPC 需數個回合生產恢復軍力）。
      const available = await npcAvailableTroops(npc.id);
      if (available < NPC_TROOP_MIN) {
        logger.info(
          { npcNationId: npc.id, available },
          "NPC standing army below minimum; skipping initiation",
        );
        continue;
      }

      // 找可開戰的地區組合：NPC 控制地區 → 相鄰的敵方控制地區。
      const npcRegions = await db
        .select({ regionId: regionControlsTable.regionId })
        .from(regionControlsTable)
        .where(
          and(
            eq(regionControlsTable.nationId, npc.id),
            gt(regionControlsTable.percent, 0),
          ),
        );
      const enemyRegions = await db
        .select({ regionId: regionControlsTable.regionId })
        .from(regionControlsTable)
        .where(
          and(
            eq(regionControlsTable.nationId, enemy.id),
            gt(regionControlsTable.percent, 0),
          ),
        );
      if (npcRegions.length === 0 || enemyRegions.length === 0) continue;

      const engaged = await db
        .select({ regionId: warRegionEngagementsTable.regionId })
        .from(warRegionEngagementsTable);
      const cooling = await db
        .select({ regionId: warRegionCooldownsTable.regionId })
        .from(warRegionCooldownsTable)
        .where(gt(warRegionCooldownsTable.expiresAt, now));
      const blocked = new Set<number>([
        ...engaged.map((r) => r.regionId),
        ...cooling.map((r) => r.regionId),
      ]);

      const adjacencies = await db
        .select()
        .from(mapRegionAdjacenciesTable)
        .where(
          and(
            inArray(
              mapRegionAdjacenciesTable.regionId,
              npcRegions.map((r) => r.regionId),
            ),
            inArray(
              mapRegionAdjacenciesTable.adjacentRegionId,
              enemyRegions.map((r) => r.regionId),
            ),
          ),
        );
      const pick = adjacencies.find(
        (a) => !blocked.has(a.regionId) && !blocked.has(a.adjacentRegionId),
      );
      if (!pick) continue;

      try {
        const campaign = await initiateCampaign({
          attackerNationId: npc.id,
          attackerRegionId: pick.regionId,
          defenderRegionId: pick.adjacentRegionId,
          initiatedByNpc: true,
        });
        logger.info(
          { campaignId: campaign.id, npcNationId: npc.id },
          "NPC initiated war campaign",
        );
      } catch (err) {
        if (err instanceof WarActionError) {
          logger.warn(
            { npcNationId: npc.id, message: err.message },
            "NPC campaign initiation rejected",
          );
        } else {
          logger.error({ err, npcNationId: npc.id }, "NPC campaign initiation failed");
        }
      }
    }
  } finally {
    npcTickRunning = false;
  }
}
