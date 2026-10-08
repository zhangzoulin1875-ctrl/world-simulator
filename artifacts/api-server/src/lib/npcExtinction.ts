import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  playerNationsTable,
  regionControlsTable,
} from "@workspace/db";
import { endCampaignsForNation } from "./warEngine";
import { notifyWarEndedByElimination } from "./diplomacyNotify";
import { logger } from "./logger";

export interface NpcExtinctionSummary {
  /** 本回合被自動除名（領土歸零）的 NPC 國家數。 */
  deletedCount: number;
  /** 被除名的 NPC 國家（id + 名稱），供 log／新聞使用。 */
  deletedNations: { id: string; name: string | null }[];
}

/**
 * 每回合偵測「領土歸零」（被完全征服）的 NPC 國家並自動除名：
 *   1. 找出 is_npc = true 且完全沒有任何 region_controls 掌控的國家。
 *   2. 對每個歸零 NPC：
 *      a. 通知所有交戰中的真人對手——戰爭因對方滅亡而自動結束。
 *      b. 呼叫 endCampaignsForNation 優雅結束其進行中戰役
 *         （釋放地區交戰鎖／寫冷卻／歸還 NPC 兵／通知戰役對手）。
 *      c. 硬刪該國家；diplomacy_wars／treaties／alliances／campaigns／
 *         tech state 等全部 ON DELETE CASCADE 一併清除（＝與各國停戰）。
 *   每個 NPC 各自 try/catch，單一失敗不影響其餘除名，也不阻斷回合。
 *
 * 領土歸零判定：region_controls.percent CHECK 為 1–100，故完全失去掌控時
 * 該列會被刪除 → 沒有任何 region_controls 列即代表領土歸零。
 *
 * 範圍限定 is_npc = true：無主國家（is_npc = false、discord_user_id NULL）
 * 即使零領土也保留（可被接手），玩家國家則永不自動除名。
 * NPC↔NPC 戰爭列不應存在（鐵則），故對手通知只會發給真人。
 */
export async function runNpcExtinctionCheck(): Promise<NpcExtinctionSummary> {
  const extinct = await db
    .select({ id: playerNationsTable.id, name: playerNationsTable.name })
    .from(playerNationsTable)
    .where(
      and(
        eq(playerNationsTable.isNpc, true),
        sql`NOT EXISTS (
          SELECT 1 FROM ${regionControlsTable}
          WHERE ${regionControlsTable.nationId} = ${playerNationsTable.id}
            AND ${regionControlsTable.percent} > 0
        )`,
      ),
    );

  const deletedNations: NpcExtinctionSummary["deletedNations"] = [];
  for (const npc of extinct) {
    try {
      // (a) 通知交戰中的真人對手：戰爭因對方滅亡而結束。
      const wars = await db
        .select({
          nationAId: diplomacyWarsTable.nationAId,
          nationBId: diplomacyWarsTable.nationBId,
        })
        .from(diplomacyWarsTable)
        .where(
          and(
            isNull(diplomacyWarsTable.endedAt),
            or(
              eq(diplomacyWarsTable.nationAId, npc.id),
              eq(diplomacyWarsTable.nationBId, npc.id),
            ),
          ),
        );
      const opponentIds = wars.map((w) =>
        w.nationAId === npc.id ? w.nationBId : w.nationAId,
      );
      if (opponentIds.length > 0) {
        const opponents = await db
          .select({ discordUserId: playerNationsTable.discordUserId })
          .from(playerNationsTable)
          .where(inArray(playerNationsTable.id, opponentIds));
        for (const opp of opponents) {
          if (!opp.discordUserId) continue;
          notifyWarEndedByElimination({
            recipientDiscordUserId: opp.discordUserId,
            eliminatedNationName: npc.name,
          });
        }
      }

      // (b) 優雅結束進行中戰役（釋放地區交戰鎖、歸還傷兵、通知戰役對手）。
      await endCampaignsForNation(npc.id);

      // (c) 與各國停戰並硬刪該 NPC。
      //     diplomacy_wars／diplomacy_treaties 的 nation 欄位在實際 DB 中
      //     **不是** ON DELETE CASCADE（drizzle schema 雖宣告 cascade，但手寫
      //     啟動遷移建表時只有 diplomacy_wars.ceasefire_proposed_by 帶 SET NULL），
      //     故必須顯式刪除這兩表中該 NPC 的列，否則會殘留「進行中」孤兒戰爭列
      //     → 凍結真人對手的外交（見 NPC↔NPC inert-war 鐵則）。其餘子表
      //     （region_controls／war_campaigns／alliance_members／tech state…）
      //     皆有真正的 CASCADE，隨國家刪除一併清除。三步同交易確保原子性。
      const deleted = await db.transaction(async (tx) => {
        await tx
          .delete(diplomacyWarsTable)
          .where(
            or(
              eq(diplomacyWarsTable.nationAId, npc.id),
              eq(diplomacyWarsTable.nationBId, npc.id),
            ),
          );
        await tx
          .delete(diplomacyTreatiesTable)
          .where(
            or(
              eq(diplomacyTreatiesTable.proposerNationId, npc.id),
              eq(diplomacyTreatiesTable.targetNationId, npc.id),
            ),
          );
        return tx
          .delete(playerNationsTable)
          .where(
            and(
              eq(playerNationsTable.id, npc.id),
              eq(playerNationsTable.isNpc, true),
            ),
          )
          .returning({ id: playerNationsTable.id });
      });
      if (deleted.length > 0) {
        deletedNations.push({ id: npc.id, name: npc.name });
        logger.info(
          { npcId: npc.id, npcName: npc.name },
          "turn engine: extinct NPC nation removed (zero territory)",
        );
      }
    } catch (err) {
      logger.error(
        { err, npcId: npc.id },
        "turn engine: extinct NPC removal failed",
      );
    }
  }

  return { deletedCount: deletedNations.length, deletedNations };
}

/** 孤兒野生 NPC 的寬限時間：新建未滿此時間者不碰（避免誤刪正在開戰途中的 NPC）。 */
export const ORPHAN_WILD_NPC_GRACE_MINUTES = 10;

/**
 * 清除「孤兒野生 NPC」：攻打無人領土／就地爭奪空白時即時建立的 NPC
 * （npc_origin = 'wild'），若開戰後續步驟失敗（舊版 AI 兵種設計 409 不回收），
 * 會殘留佔住剩餘空白、卻沒有任何進行中戰爭或戰役。玩家那塊地合計變 100%、
 * 持有者是沒有戰爭的 NPC，無法再發起戰役（「只佔部分土地卻拿不到剩下的」）。
 *
 * 判定（全部成立才刪）：is_npc、npc_origin='wild'、建立超過寬限時間、
 * 沒有未結束的 diplomacy_wars、沒有 active 的 war_campaigns。
 * 刪除沿用 runNpcExtinctionCheck 的做法：顯式清 diplomacy_wars／treaties，
 * 其餘子表 CASCADE；控制列隨之消失，空白還給玩家可再次就地爭奪。
 * 不碰玩家國家、自然（natural）NPC 與無主國家。
 */
export async function cleanupOrphanWildNpcs(): Promise<{
  deletedCount: number;
  deletedIds: string[];
}> {
  const orphans = await db
    .select({ id: playerNationsTable.id, name: playerNationsTable.name })
    .from(playerNationsTable)
    .where(
      and(
        eq(playerNationsTable.isNpc, true),
        eq(playerNationsTable.npcOrigin, "wild"),
        sql`${playerNationsTable.createdAt} < now() - make_interval(mins => ${ORPHAN_WILD_NPC_GRACE_MINUTES})`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${diplomacyWarsTable} w
          WHERE w.ended_at IS NULL
            AND (w.nation_a_id = ${playerNationsTable.id} OR w.nation_b_id = ${playerNationsTable.id})
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM war_campaigns c
          WHERE c.status = 'active'
            AND (c.attacker_nation_id = ${playerNationsTable.id} OR c.defender_nation_id = ${playerNationsTable.id})
        )`,
      ),
    );

  const deletedIds: string[] = [];
  for (const npc of orphans) {
    try {
      const deleted = await db.transaction(async (tx) => {
        await tx
          .delete(diplomacyWarsTable)
          .where(
            or(
              eq(diplomacyWarsTable.nationAId, npc.id),
              eq(diplomacyWarsTable.nationBId, npc.id),
            ),
          );
        await tx
          .delete(diplomacyTreatiesTable)
          .where(
            or(
              eq(diplomacyTreatiesTable.proposerNationId, npc.id),
              eq(diplomacyTreatiesTable.targetNationId, npc.id),
            ),
          );
        return tx
          .delete(playerNationsTable)
          .where(
            and(
              eq(playerNationsTable.id, npc.id),
              eq(playerNationsTable.isNpc, true),
              eq(playerNationsTable.npcOrigin, "wild"),
            ),
          )
          .returning({ id: playerNationsTable.id });
      });
      if (deleted.length > 0) {
        deletedIds.push(npc.id);
        logger.info(
          { npcId: npc.id, npcName: npc.name },
          "turn engine: orphan wild NPC removed (no war, no campaign)",
        );
      }
    } catch (err) {
      logger.error({ err, npcId: npc.id }, "orphan wild NPC removal failed");
    }
  }
  return { deletedCount: deletedIds.length, deletedIds };
}
