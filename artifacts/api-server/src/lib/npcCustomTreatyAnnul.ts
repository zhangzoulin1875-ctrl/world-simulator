import { and, eq } from "drizzle-orm";
import {
  db,
  diplomacyTreatiesTable,
  diplomacyRelationsTable,
  diplomacyRelationEventsTable,
  playerNationsTable,
} from "@workspace/db";
import {
  canonicalPair,
  clampRelationScore,
  isTreatyInEffect,
  TREATY_ANNUL_RELATION_PENALTY,
} from "./diplomacy";
import { notifyTreatyAnnulled } from "./diplomacyNotify";
import { logger } from "./logger";

/**
 * Task #214 — NPC 主動廢除自訂條約（記得生效中協議 → 關係惡化時毀約）。
 *
 * 既有 NPC 外交只處理「回覆玩家提案」與「主動發起提案／宣戰」，沒有任何流程會讓
 * NPC 退出已生效的長期協議。自訂條約帶有每回合經常性資源轉移，若 NPC 與對方關係
 * 惡化卻仍被綁在協議裡並不合理；故新增這一層：關係值跌破門檻時，NPC 主動廢除與該
 * 對象之間生效中的自訂條約（與玩家廢約相同代價：關係 −TREATY_ANNUL_RELATION_PENALTY、
 * 留下 annul_treaty 互動紀錄、私訊另一方）。
 *
 * 只針對 type="custom" 的生效中條約，且只在 NPC 為當事國之一時；不動其他 4 種條約
 * 與戰爭機制。純規劃函式（planNpcCustomTreatyAnnulments）可單元測試，DB 執行與扣分
 * 走 tx + FOR UPDATE，與玩家廢約同一套競態防護。
 */

/** 低於此關係值時，NPC 會主動廢除與該對象之間生效中的自訂條約。 */
export const NPC_CUSTOM_ANNUL_RELATION_THRESHOLD = -40;

export interface ActiveCustomTreatyRef {
  id: number;
  proposerNationId: string;
  targetNationId: string;
}

export interface PlanNpcCustomAnnulContext {
  /** NPC（is_npc=true）國家 id。 */
  npcIds: ReadonlySet<string>;
  /** canonical pair 鍵（`low:high`）→ 關係值。 */
  relationScores: ReadonlyMap<string, number>;
  /** 關係門檻（預設 NPC_CUSTOM_ANNUL_RELATION_THRESHOLD）。 */
  threshold?: number;
}

export interface PlannedNpcAnnul {
  treatyId: number;
  /** 主動廢約的 NPC id（當事雙方皆為 NPC 時取 proposer）。 */
  annullerNationId: string;
}

/**
 * 純函式：挑出應由 NPC 主動廢除的生效中自訂條約。
 * 規則：條約至少有一方為 NPC，且該對 pair 的關係值 < threshold。廢約方取「身為 NPC
 * 的當事國」；若雙方皆為 NPC，取 proposer（NPC↔NPC 也僅廢一次，避免重複結算）。
 */
export function planNpcCustomTreatyAnnulments(
  treaties: readonly ActiveCustomTreatyRef[],
  ctx: PlanNpcCustomAnnulContext,
): PlannedNpcAnnul[] {
  const threshold = ctx.threshold ?? NPC_CUSTOM_ANNUL_RELATION_THRESHOLD;
  const planned: PlannedNpcAnnul[] = [];
  for (const t of treaties) {
    const proposerIsNpc = ctx.npcIds.has(t.proposerNationId);
    const targetIsNpc = ctx.npcIds.has(t.targetNationId);
    if (!proposerIsNpc && !targetIsNpc) continue;
    const { low, high } = canonicalPair(t.proposerNationId, t.targetNationId);
    const score = ctx.relationScores.get(`${low}:${high}`) ?? 0;
    if (score >= threshold) continue;
    const annullerNationId = proposerIsNpc
      ? t.proposerNationId
      : t.targetNationId;
    planned.push({ treatyId: t.id, annullerNationId });
  }
  return planned;
}

/**
 * DB 執行：以 tx + FOR UPDATE 廢除單一條約（NPC 主動）。與玩家廢約相同代價與競態防護：
 * 重讀條約需仍在生效中（否則視為已被他流程處理，回傳 null），扣關係值並留互動紀錄。
 */
async function annulActiveCustomTreatyByNpc(
  treatyId: number,
  annullerNationId: string,
): Promise<{
  treaty: typeof diplomacyTreatiesTable.$inferSelect;
  annullerName: string | null;
} | null> {
  return db.transaction(async (tx) => {
    const [treaty] = await tx
      .select()
      .from(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.id, treatyId))
      .for("update");
    if (!treaty) return null;
    if (treaty.type !== "custom") return null;
    if (!isTreatyInEffect(treaty)) return null;
    if (
      treaty.proposerNationId !== annullerNationId &&
      treaty.targetNationId !== annullerNationId
    ) {
      return null;
    }

    const [updated] = await tx
      .update(diplomacyTreatiesTable)
      .set({ status: "annulled", updatedAt: new Date() })
      .where(eq(diplomacyTreatiesTable.id, treaty.id))
      .returning();

    const otherId =
      treaty.proposerNationId === annullerNationId
        ? treaty.targetNationId
        : treaty.proposerNationId;
    const { low, high } = canonicalPair(annullerNationId, otherId);
    await tx
      .insert(diplomacyRelationsTable)
      .values({ nationAId: low, nationBId: high })
      .onConflictDoNothing();
    const [relation] = await tx
      .select()
      .from(diplomacyRelationsTable)
      .where(
        and(
          eq(diplomacyRelationsTable.nationAId, low),
          eq(diplomacyRelationsTable.nationBId, high),
        ),
      )
      .for("update");
    if (relation) {
      await tx
        .update(diplomacyRelationsTable)
        .set({
          score: clampRelationScore(
            relation.score - TREATY_ANNUL_RELATION_PENALTY,
          ),
        })
        .where(eq(diplomacyRelationsTable.id, relation.id));
    }

    await tx.insert(diplomacyRelationEventsTable).values({
      actorNationId: annullerNationId,
      targetNationId: otherId,
      action: "annul_treaty",
    });

    const [annuller] = await tx
      .select({ name: playerNationsTable.name })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, annullerNationId))
      .limit(1);

    return { treaty: updated!, annullerName: annuller?.name ?? null };
  });
}

export interface NpcCustomAnnulResult {
  annulled: number;
}

/**
 * 每回合協調器：NPC 主動廢除與已惡化對象之間生效中的自訂條約。包在獨立 try/catch
 * 中由回合引擎呼叫，失敗不阻斷其他結算。
 */
export async function runNpcCustomTreatyAnnulments(): Promise<NpcCustomAnnulResult> {
  const nations = await db
    .select({ id: playerNationsTable.id, isNpc: playerNationsTable.isNpc })
    .from(playerNationsTable);
  const npcIds = new Set<string>();
  for (const n of nations) if (n.isNpc) npcIds.add(n.id);
  if (npcIds.size === 0) return { annulled: 0 };

  const activeCustomRows = await db
    .select({
      id: diplomacyTreatiesTable.id,
      proposerNationId: diplomacyTreatiesTable.proposerNationId,
      targetNationId: diplomacyTreatiesTable.targetNationId,
      expiresAt: diplomacyTreatiesTable.expiresAt,
    })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        eq(diplomacyTreatiesTable.type, "custom"),
        eq(diplomacyTreatiesTable.status, "active"),
      ),
    );
  const now = Date.now();
  const effective: ActiveCustomTreatyRef[] = activeCustomRows
    .filter((t) => t.expiresAt === null || t.expiresAt.getTime() > now)
    .map((t) => ({
      id: t.id,
      proposerNationId: t.proposerNationId,
      targetNationId: t.targetNationId,
    }));

  const relations = await db
    .select({
      a: diplomacyRelationsTable.nationAId,
      b: diplomacyRelationsTable.nationBId,
      score: diplomacyRelationsTable.score,
    })
    .from(diplomacyRelationsTable);
  const relationScores = new Map<string, number>();
  for (const r of relations) relationScores.set(`${r.a}:${r.b}`, r.score);

  const planned = planNpcCustomTreatyAnnulments(effective, {
    npcIds,
    relationScores,
  });

  let annulled = 0;
  for (const p of planned) {
    try {
      const result = await annulActiveCustomTreatyByNpc(
        p.treatyId,
        p.annullerNationId,
      );
      if (!result) continue;
      annulled++;
      notifyTreatyAnnulled({
        treaty: result.treaty,
        annullerNationId: p.annullerNationId,
        annullerNationName: result.annullerName,
      });
    } catch (err) {
      logger.error(
        { err, treatyId: p.treatyId },
        "npc custom treaty annul failed",
      );
    }
  }

  return { annulled };
}
