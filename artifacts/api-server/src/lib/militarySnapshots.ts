import {
  db,
  militaryUnitTemplatesTable,
  nationMilitarySnapshotsTable,
  npcArmiesTable,
  playerArmiesTable,
  playerNationsTable,
  playerWoundedUnitsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Task #400 — 每日全國軍力快照。
 *
 * 回合結算時為每個國家寫入一列（nation × 遊戲日期 upsert），只存三個聚合
 * 人口值（popCostPerUnit 口徑，與 /api/map/political 的軍隊人口一致）：
 * - armyPopulation：軍隊總人口（現役＋傷兵；NPC 的 quantity 已含前線抽調）。
 * - woundedPopulation：傷兵占用人口（玩家全國傷兵池＋NPC wounded 池）。
 * - committedPopulation：前線占用人口（玩家＝軍團配置列、NPC＝committed）。
 * 刻意不存任何兵種編制細節，公開 API 只回聚合值。
 */

export interface NationMilitaryAggregate {
  armyPopulation: number;
  woundedPopulation: number;
  committedPopulation: number;
}

/** 每國快照保留上限（超過依日期由舊到新刪除）。 */
export const MILITARY_SNAPSHOT_KEEP_PER_NATION = 30;

/**
 * 計算所有國家目前的軍力聚合值（人口口徑）。
 * 玩家：player_armies（quantity 含前線，死亡才扣）＋ player_wounded_units；
 * 前線 = 該國軍團兵種列（quantity + wounded）。NPC：npc_armies（quantity 含
 * 前線、wounded 恢復池、committed = 前線抽調）；NPC 的軍團列以民兵補足，
 * 不重複計入。
 */
export async function computeNationMilitaryAggregates(): Promise<
  Map<string, NationMilitaryAggregate>
> {
  const [armyRows, woundedRows, npcRows, frontlineRows] = await Promise.all([
    db
      .select({
        nationId: playerNationsTable.id,
        pop: sql<string>`COALESCE(SUM(${playerArmiesTable.quantity}::bigint * ${militaryUnitTemplatesTable.popCostPerUnit}::bigint), 0)`,
      })
      .from(playerArmiesTable)
      .innerJoin(
        playerNationsTable,
        eq(playerNationsTable.discordUserId, playerArmiesTable.discordUserId),
      )
      .innerJoin(
        militaryUnitTemplatesTable,
        eq(militaryUnitTemplatesTable.id, playerArmiesTable.templateId),
      )
      .groupBy(playerNationsTable.id),
    db
      .select({
        nationId: playerNationsTable.id,
        pop: sql<string>`COALESCE(SUM(${playerWoundedUnitsTable.wounded}::bigint * ${militaryUnitTemplatesTable.popCostPerUnit}::bigint), 0)`,
      })
      .from(playerWoundedUnitsTable)
      .innerJoin(
        playerNationsTable,
        eq(
          playerNationsTable.discordUserId,
          playerWoundedUnitsTable.discordUserId,
        ),
      )
      .innerJoin(
        militaryUnitTemplatesTable,
        eq(militaryUnitTemplatesTable.id, playerWoundedUnitsTable.templateId),
      )
      .groupBy(playerNationsTable.id),
    db
      .select({
        nationId: npcArmiesTable.nationId,
        armyPop: sql<string>`COALESCE(SUM((${npcArmiesTable.quantity}::bigint + ${npcArmiesTable.wounded}::bigint) * ${militaryUnitTemplatesTable.popCostPerUnit}::bigint), 0)`,
        woundedPop: sql<string>`COALESCE(SUM(${npcArmiesTable.wounded}::bigint * ${militaryUnitTemplatesTable.popCostPerUnit}::bigint), 0)`,
        committedPop: sql<string>`COALESCE(SUM(${npcArmiesTable.committed}::bigint * ${militaryUnitTemplatesTable.popCostPerUnit}::bigint), 0)`,
      })
      .from(npcArmiesTable)
      .innerJoin(
        militaryUnitTemplatesTable,
        eq(militaryUnitTemplatesTable.id, npcArmiesTable.templateId),
      )
      .groupBy(npcArmiesTable.nationId),
    // 玩家前線：軍團兵種列（quantity + wounded 皆占用），排除 NPC 國家的
    // 軍團（NPC 前線由 committed 表示；軍團列含民兵補足，不能混算）。
    db
      .select({
        nationId: warCampaignLegionsTable.nationId,
        pop: sql<string>`COALESCE(SUM((${warCampaignLegionUnitsTable.quantity}::bigint + ${warCampaignLegionUnitsTable.wounded}::bigint) * ${militaryUnitTemplatesTable.popCostPerUnit}::bigint), 0)`,
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
      .innerJoin(
        militaryUnitTemplatesTable,
        eq(
          militaryUnitTemplatesTable.id,
          warCampaignLegionUnitsTable.templateId,
        ),
      )
      .where(eq(playerNationsTable.isNpc, false))
      .groupBy(warCampaignLegionsTable.nationId),
  ]);

  const out = new Map<string, NationMilitaryAggregate>();
  const get = (id: string): NationMilitaryAggregate => {
    let v = out.get(id);
    if (!v) {
      v = { armyPopulation: 0, woundedPopulation: 0, committedPopulation: 0 };
      out.set(id, v);
    }
    return v;
  };
  for (const r of armyRows) get(r.nationId).armyPopulation += Number(r.pop);
  for (const r of woundedRows) {
    const v = get(r.nationId);
    v.armyPopulation += Number(r.pop);
    v.woundedPopulation += Number(r.pop);
  }
  for (const r of npcRows) {
    const v = get(r.nationId);
    v.armyPopulation += Number(r.armyPop);
    v.woundedPopulation += Number(r.woundedPop);
    v.committedPopulation += Number(r.committedPop);
  }
  for (const r of frontlineRows) {
    get(r.nationId).committedPopulation += Number(r.pop);
  }
  return out;
}

/**
 * 寫入所有國家在某遊戲日期的軍力快照（upsert，重跑回合會覆寫同日值），
 * 並修剪每國最舊的快照（每國保留最新 MILITARY_SNAPSHOT_KEEP_PER_NATION 列）。
 * 無任何軍力聚合列的國家也寫 0 值列，讓趨勢能呈現「從無到有」。
 */
export async function recordNationMilitarySnapshots(
  gameDate: string,
): Promise<number> {
  const [aggregates, nations] = await Promise.all([
    computeNationMilitaryAggregates(),
    db.select({ id: playerNationsTable.id }).from(playerNationsTable),
  ]);

  let written = 0;
  for (const n of nations) {
    const agg = aggregates.get(n.id) ?? {
      armyPopulation: 0,
      woundedPopulation: 0,
      committedPopulation: 0,
    };
    await db
      .insert(nationMilitarySnapshotsTable)
      .values({
        nationId: n.id,
        snapshotDate: gameDate,
        armyPopulation: Math.max(0, Math.round(agg.armyPopulation)),
        woundedPopulation: Math.max(0, Math.round(agg.woundedPopulation)),
        committedPopulation: Math.max(0, Math.round(agg.committedPopulation)),
      })
      .onConflictDoUpdate({
        target: [
          nationMilitarySnapshotsTable.nationId,
          nationMilitarySnapshotsTable.snapshotDate,
        ],
        set: {
          armyPopulation: Math.max(0, Math.round(agg.armyPopulation)),
          woundedPopulation: Math.max(0, Math.round(agg.woundedPopulation)),
          committedPopulation: Math.max(
            0,
            Math.round(agg.committedPopulation),
          ),
        },
      });
    written++;
  }

  // 修剪：每國只留最新 N 列（依日期新→舊）。
  await db.execute(sql`
    DELETE FROM nation_military_snapshots
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY nation_id ORDER BY snapshot_date DESC
               ) AS rn
        FROM nation_military_snapshots
      ) ranked
      WHERE rn > ${MILITARY_SNAPSHOT_KEEP_PER_NATION}
    )
  `);

  logger.info({ written, gameDate }, "nation military snapshots recorded");
  return written;
}
