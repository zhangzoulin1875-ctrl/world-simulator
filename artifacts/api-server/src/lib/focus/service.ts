import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  parliamentStateTable,
  focusStatesTable,
  focusActiveTable,
  focusCompletedTable,
  diplomacyWarsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { computeNationStats, getCurrentEraSlug } from "../nationStats";
import { parliamentTier } from "../parliament/core";
import { computeNationMilitaryAggregates } from "../militarySnapshots";
import { armyPopulationRatioPct } from "../militaryPolitics";
import { governmentLabel, governmentSlugByLabel } from "../governments";
import {
  advanceFocus,
  calculatePassiveLeanDeltas,
  checkStartFocus,
  pointsCap,
  politicalPointsPerTurn,
  START_BLOCK_TEXT,
  type FocusSlot,
  type StartBlockReason,
} from "./core";
import { getCatalog, getFocusDef } from "./catalog";
import type { FocusDef } from "./types";
import { summarizeEffects } from "./effects";
import { afterRegimeTransition, applyRegimeTransition, type RegimeTransitionResult } from "../politicsSettlement";
import { describeCondition, eraReached, firstFailedCondition, type ConditionFacts } from "./conditions";

type Nation = typeof playerNationsTable.$inferSelect;

/**
 * 以國家為單位的交易級 advisory lock:同一國家的啟動/取消/結算彼此序列化。
 * 不依賴任何資料列是否存在或可見,交易結束自動釋放(比鎖列可靠)。
 */
async function lockNationFocus(tx: Pick<typeof db, "execute">, nationId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"focus:" + nationId}, 0))`);
}

/** 取消進行中國策時退還的點數比例(避免零成本洗版,也不全沒收)。 */
export const CANCEL_REFUND_RATIO = 0.5;

async function ensureFocusState(nationId: string) {
  await db.insert(focusStatesTable).values({ nationId }).onConflictDoNothing();
  const [s] = await db.select().from(focusStatesTable).where(eq(focusStatesTable.nationId, nationId));
  return s!;
}

/** 議會滿意度;該國還沒有議會狀態列時用起始值 60(與議會系統一致)。 */
async function parliamentSatisfactionOf(nationId: string): Promise<number> {
  const [row] = await db
    .select({ s: parliamentStateTable.satisfaction })
    .from(parliamentStateTable)
    .where(eq(parliamentStateTable.nationId, nationId));
  return row?.s ?? 60;
}

export interface FocusSettleResult {
  pointsGained: number;
  completed: string[];
  stalled: boolean;
}

/**
 * 單一國家的國策結算:發點數 → 推進進行中的 → 完成者寫入並套用一次性效果。
 * 政變鎖定期間進度不動(與「鎖死政策」語意一致),但點數仍照發。
 */
/** 批次預先查好的事實(避免每國各查一次);單獨呼叫 settleNationFocus 時可省略。 */
export interface SettleBatchFacts {
  atWarNationIds?: ReadonlySet<string>;
  armyPopulationByNation?: ReadonlyMap<string, number>;
  rand?: () => number;
}

export async function settleNationFocus(
  nation: Nation,
  eraSlug: string,
  batch: SettleBatchFacts = {},
): Promise<FocusSettleResult> {
  const state = await ensureFocusState(nation.id);
  const sat = await parliamentSatisfactionOf(nation.id);
  const slug = governmentSlugByLabel(nation.government);
  const tier = parliamentTier(slug);
  const stats = await computeNationStats(nation.id, eraSlug).catch(() => ({ population: 0 }));

  const perTurn = politicalPointsPerTurn({ tier, population: stats.population, satisfaction: sat });
  const cap = pointsCap(perTurn);

  const result: FocusSettleResult = { pointsGained: 0, completed: [], stalled: false };
  // 交易提交後才執行的收尾(通知/筆記等外部副作用,失敗不回滾改制)
  const afterCommit: RegimeTransitionResult[] = [];

  await db.transaction(async (tx) => {
    await lockNationFocus(tx, nation.id);
    // 在鎖內以 SQL 原子遞增(不用先前讀到的舊值回寫,否則會蓋掉同時發生的啟動扣點)。
    // 已超過上限的庫存不砍,只是不再增加。
    const [before] = await tx
      .select({ points: focusStatesTable.points })
      .from(focusStatesTable)
      .where(eq(focusStatesTable.nationId, nation.id));
    const have = before?.points ?? 0;
    const gained = Math.max(0, Math.min(cap, have + perTurn) - have);
    result.pointsGained = gained;
    if (gained > 0) {
      await tx
        .update(focusStatesTable)
        .set({ points: sql`${focusStatesTable.points} + ${gained}`, updatedAt: new Date() })
        .where(eq(focusStatesTable.nationId, nation.id));
    }

    // 黑紅線傾向值的被動增長/衰減:與國策推進無關,政變鎖定期間照樣累積。
    // 在鎖內以 SQL 原子加減並夾在 [0,100],不會蓋掉國策完成的一次性 lean 效果。
    const [lean] = await tx
      .select({ black: focusStatesTable.blackLean, red: focusStatesTable.redLean })
      .from(focusStatesTable)
      .where(eq(focusStatesTable.nationId, nation.id));
    const passive = calculatePassiveLeanDeltas(
      {
        satisfactionMilitary: nation.satisfactionMilitary,
        atWar: batch.atWarNationIds?.has(nation.id) ?? false,
        armyRatioPct: armyPopulationRatioPct(batch.armyPopulationByNation?.get(nation.id) ?? 0, stats.population),
        tier,
        stability: nation.stability,
        politicalSupport: nation.politicalSupport,
        parliamentSatisfaction: sat,
        blackLean: lean?.black ?? 0,
        redLean: lean?.red ?? 0,
      },
      batch.rand,
    );
    if (passive.blackDelta !== 0 || passive.redDelta !== 0) {
      await tx
        .update(focusStatesTable)
        .set({
          blackLean: sql`LEAST(100, GREATEST(0, ${focusStatesTable.blackLean} + ${passive.blackDelta}))`,
          redLean: sql`LEAST(100, GREATEST(0, ${focusStatesTable.redLean} + ${passive.redDelta}))`,
        })
        .where(eq(focusStatesTable.nationId, nation.id));
    }

    if (nation.coupPolicyLockTurns > 0) return; // 鎖定期間:只發點數,不推進

    const actives = await tx.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, nation.id));
    for (const a of actives) {
      const adv = advanceFocus(a.progress, a.totalTurns, sat);
      if (adv.stalled) result.stalled = true;
      if (!adv.completed) {
        await tx.update(focusActiveTable).set({ progress: adv.progress }).where(eq(focusActiveTable.id, a.id));
        continue;
      }
      // 完成:刪進行中 + 寫已完成 + 套用一次性效果(同一交易,要嘛全成要嘛全回滾)
      const def = getFocusDef(a.focusId);
      await tx.delete(focusActiveTable).where(eq(focusActiveTable.id, a.id));
      await tx
        .insert(focusCompletedTable)
        .values({ nationId: nation.id, focusId: a.focusId, eraSlug })
        .onConflictDoNothing();
      result.completed.push(a.focusId);

      if (!def) {
        // 目錄已移除該國策:仍記為完成(保留歷史),但沒有可套用的效果
        logger.warn({ nationId: nation.id, focusId: a.focusId }, "focus completed but missing from catalog");
        continue;
      }
      const [fresh] = await tx.select().from(playerNationsTable).where(eq(playerNationsTable.id, nation.id));
      const eff = summarizeEffects(def.effects, {
        money: fresh!.money,
        techPoints: fresh!.techPoints,
        stability: fresh!.stability,
        politicalSupport: fresh!.politicalSupport,
        satisfactionMilitary: fresh!.satisfactionMilitary,
      });
      if (eff.transitionTo) {
        // 起點政體必須仍是目錄指定的那個(啟動後可能因革命等被改掉)
        const fromOk = !def.governments || def.governments.includes(governmentSlugByLabel(fresh!.government) ?? "");
        const targetLabel = governmentLabel(eff.transitionTo);
        if (!fromOk || !targetLabel) {
          // 不轉型:退還預扣點數,並記 log,讓玩家能重新選擇
          await tx
            .update(focusStatesTable)
            .set({ points: sql`${focusStatesTable.points} + ${a.spentPoints}` })
            .where(eq(focusStatesTable.nationId, nation.id));
          await tx.delete(focusCompletedTable).where(and(eq(focusCompletedTable.nationId, nation.id), eq(focusCompletedTable.focusId, a.focusId)));
          result.completed.pop();
          logger.warn({ nationId: nation.id, focusId: a.focusId, government: fresh!.government }, "regime transition skipped: origin government changed");
          continue;
        }
        const tr = await applyRegimeTransition(tx, fresh!, targetLabel, def.title);
        afterCommit.push(tr);
        // 政體變了:其他進行中的轉型國策(起點已不成立)一併作廢並退點
        const others = await tx.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, nation.id));
        for (const o of others) {
          const od = getFocusDef(o.focusId);
          if (od && od.domain === "regime" && od.id !== def.id) {
            await tx.delete(focusActiveTable).where(eq(focusActiveTable.id, o.id));
            await tx
              .update(focusStatesTable)
              .set({ points: sql`${focusStatesTable.points} + ${o.spentPoints}` })
              .where(eq(focusStatesTable.nationId, nation.id));
          }
        }
      }
      if (Object.keys(eff.patch).length > 0) {
        await tx.update(playerNationsTable).set(eff.patch).where(eq(playerNationsTable.id, nation.id));
      }
      if (eff.blackLeanDelta !== 0 || eff.redLeanDelta !== 0) {
        await tx
          .update(focusStatesTable)
          .set({
            blackLean: sql`LEAST(100, GREATEST(0, ${focusStatesTable.blackLean} + ${eff.blackLeanDelta}))`,
            redLean: sql`LEAST(100, GREATEST(0, ${focusStatesTable.redLean} + ${eff.redLeanDelta}))`,
          })
          .where(eq(focusStatesTable.nationId, nation.id));
      }
      if (eff.parliamentDelta !== 0) {
        await tx
          .update(parliamentStateTable)
          .set({ satisfaction: sql`LEAST(100, GREATEST(0, ${parliamentStateTable.satisfaction} + ${eff.parliamentDelta}))` })
          .where(eq(parliamentStateTable.nationId, nation.id));
      }
      if (eff.unwired.length > 0) {
        logger.info({ nationId: nation.id, focusId: a.focusId, unwired: eff.unwired.length }, "focus effects not wired yet (recorded only)");
      }
    }
  });
  for (const tr of afterCommit) await afterRegimeTransition(nation, tr);
  return result;
}

/** 全部國家(含 NPC)的國策結算;單國失敗不影響其他國家。 */
export async function runFocusSettlement(): Promise<{ nations: number; completed: number; failed: number }> {
  const nations = await db.select().from(playerNationsTable);
  const eraSlug = await getCurrentEraSlug();
  // 批次查一次:戰爭中的國家 + 各國軍隊人口(傾向值被動增長要用)
  const wars = await db
    .select({ a: diplomacyWarsTable.nationAId, b: diplomacyWarsTable.nationBId })
    .from(diplomacyWarsTable)
    .where(isNull(diplomacyWarsTable.endedAt));
  const atWarNationIds = new Set<string>();
  for (const w of wars) { atWarNationIds.add(w.a); atWarNationIds.add(w.b); }
  const aggs = await computeNationMilitaryAggregates().catch(() => new Map<string, { armyPopulation: number }>());
  const armyPopulationByNation = new Map<string, number>();
  for (const [id, v] of aggs) armyPopulationByNation.set(id, v.armyPopulation ?? 0);
  let completed = 0;
  let failed = 0;
  for (const n of nations) {
    try {
      const r = await settleNationFocus(n, eraSlug, { atWarNationIds, armyPopulationByNation });
      completed += r.completed.length;
    } catch (err) {
      failed++;
      logger.error({ err, nationId: n.id }, "focus settlement failed for nation");
    }
  }
  return { nations: nations.length, completed, failed };
}

export type StartResult =
  | { ok: true; focusId: string; slot: FocusSlot; spent: number; totalTurns: number }
  | { ok: false; reason: StartBlockReason | "unknown_focus" | "government_not_allowed" | "era_locked" | "condition_failed" | "not_yet_available"; message: string };

/** 玩家啟動國策:檢查全部條件後預扣點數並建立進行中紀錄(交易內搶占,避免競態)。 */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

export async function startFocus(nation: Nation, focusId: string): Promise<StartResult> {
  try {
    return await startFocusInner(nation, focusId);
  } catch (err) {
    // 縱深防禦:即使併發穿透了檢查,資料庫唯一索引(每槽位一條/同國策一次)仍會擋下,
    // 這裡把衝突轉成明確的業務訊息,而不是讓玩家看到 500。
    if (isUniqueViolation(err)) {
      return { ok: false, reason: "slot_busy", message: "該槽位或此國策剛被其他操作佔用,請重新整理" };
    }
    throw err;
  }
}

/** 判斷一個國策「現在能不能啟動」所需的全部事實(由呼叫端讀 DB 後傳入)。 */
export interface StartFacts {
  governmentLabel: string | null;
  eraSlug: string;
  completed: ReadonlySet<string>;
  active: ReadonlyMap<FocusSlot, string>;
  points: number;
  coupPolicyLockTurns: number;
  conditionFacts: ConditionFacts;
}

export type StartVerdict =
  | { ok: true }
  | { ok: false; reason: StartBlockReason | "unknown_focus" | "government_not_allowed" | "era_locked" | "condition_failed" | "not_yet_available"; message: string };

/**
 * 啟動判斷的唯一真相來源:startFocus(真的扣點)與畫面清單(唯讀)共用,
 * 兩邊規則不可能分叉。順序:政體 → 時代 → 基礎檢查 → 客觀條件。
 */
export function evaluateStart(def: FocusDef, f: StartFacts): StartVerdict {
  const slug = governmentSlugByLabel(f.governmentLabel);
  if (def.governments && def.governments.length > 0 && (!slug || !def.governments.includes(slug))) {
    return { ok: false, reason: "government_not_allowed", message: "目前政體無法推行此國策" };
  }
  if (!eraReached(f.eraSlug, def.minEra)) {
    return { ok: false, reason: "era_locked", message: "世界尚未進入可推行此國策的時代" };
  }
  if (def.unavailableReason) return { ok: false, reason: "not_yet_available", message: def.unavailableReason };
  const siblingIds = new Set<string>(def.excludes ?? []);
  if (def.exclusiveGroup) {
    for (const d of getCatalog()) if (d.exclusiveGroup === def.exclusiveGroup && d.id !== def.id) siblingIds.add(d.id);
  }
  const block = checkStartFocus({
    focusId: def.id,
    cost: def.cost,
    slot: def.slot,
    requires: def.requires,
    requiresAny: def.requiresAny,
    excludes: [...siblingIds],
    completed: f.completed,
    active: f.active,
    points: f.points,
    coupPolicyLockTurns: f.coupPolicyLockTurns,
  });
  if (block) return { ok: false, reason: block, message: START_BLOCK_TEXT[block] };
  const failed = firstFailedCondition(def.conditions, f.conditionFacts);
  if (failed) return { ok: false, reason: "condition_failed", message: `條件未滿足:${describeCondition(failed)}` };
  return { ok: true };
}

async function startFocusInner(nation: Nation, focusId: string): Promise<StartResult> {
  const def = getFocusDef(focusId);
  if (!def) return { ok: false, reason: "unknown_focus", message: "找不到此國策" };
  const eraSlug = await getCurrentEraSlug();

  return db.transaction(async (tx) => {
    await lockNationFocus(tx, nation.id);
    const [fresh] = await tx.select().from(playerNationsTable).where(eq(playerNationsTable.id, nation.id));
    await tx.insert(focusStatesTable).values({ nationId: nation.id }).onConflictDoNothing();
    const [state] = await tx.select().from(focusStatesTable).where(eq(focusStatesTable.nationId, nation.id));
    const actives = await tx.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, nation.id));
    const done = await tx
      .select({ id: focusCompletedTable.focusId })
      .from(focusCompletedTable)
      .where(eq(focusCompletedTable.nationId, nation.id));
    const [par] = await tx
      .select({ s: parliamentStateTable.satisfaction })
      .from(parliamentStateTable)
      .where(eq(parliamentStateTable.nationId, nation.id));

    const verdict = evaluateStart(def, {
      governmentLabel: fresh!.government,
      eraSlug,
      completed: new Set(done.map((d) => d.id)),
      active: new Map<FocusSlot, string>(actives.map((a) => [a.slot as FocusSlot, a.focusId])),
      points: state!.points,
      coupPolicyLockTurns: fresh!.coupPolicyLockTurns,
      conditionFacts: {
        politicalSupport: fresh!.politicalSupport,
        stability: fresh!.stability,
        militarySatisfaction: fresh!.satisfactionMilitary,
        parliamentSatisfaction: par?.s ?? 60,
        blackLean: state!.blackLean,
        redLean: state!.redLean,
      },
    });
    if (!verdict.ok) return verdict;

    await tx
      .update(focusStatesTable)
      .set({ points: sql`${focusStatesTable.points} - ${def.cost}`, updatedAt: new Date() })
      .where(eq(focusStatesTable.nationId, nation.id));
    await tx.insert(focusActiveTable).values({
      nationId: nation.id,
      focusId: def.id,
      slot: def.slot,
      totalTurns: def.turns,
      spentPoints: def.cost,
    });
    return { ok: true as const, focusId: def.id, slot: def.slot, spent: def.cost, totalTurns: def.turns };
  });
}

/** 取消進行中的國策:退還 50% 預扣點數(無條件捨去)。 */
export async function cancelFocus(
  nation: Nation,
  focusId: string,
): Promise<{ ok: true; refunded: number } | { ok: false; message: string }> {
  return db.transaction(async (tx) => {
    await lockNationFocus(tx, nation.id);
    const [a] = await tx
      .select()
      .from(focusActiveTable)
      .where(and(eq(focusActiveTable.nationId, nation.id), eq(focusActiveTable.focusId, focusId)))
      .for("update");
    if (!a) return { ok: false as const, message: "此國策不在進行中" };
    const refund = Math.floor(a.spentPoints * CANCEL_REFUND_RATIO);
    await tx.delete(focusActiveTable).where(eq(focusActiveTable.id, a.id));
    await tx
      .update(focusStatesTable)
      .set({ points: sql`${focusStatesTable.points} + ${refund}`, updatedAt: new Date() })
      .where(eq(focusStatesTable.nationId, nation.id));
    return { ok: true as const, refunded: refund };
  });
}
