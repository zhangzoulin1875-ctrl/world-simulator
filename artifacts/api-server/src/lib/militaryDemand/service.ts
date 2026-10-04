import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  db, playerNationsTable, regionControlsTable, mapRegionsTable, mapRegionAdjacenciesTable,
  diplomacyRelationsTable, diplomacyTreatiesTable, diplomacyWarsTable, militaryDemandsTable,
  type PlayerNation, type MilitaryDemand,
} from "@workspace/db";
import { logger } from "../logger";
import { canonicalPair, findWarBlockingTreatyType, type TreatyEffectView } from "../diplomacy";
import { nationsInSameAlliance } from "../alliances";
import { declareWarByNpc, hasRecentEndedWar } from "../treatyPropose";
import { initiateCampaign } from "../warEngine/initiate";
import { WarActionError } from "../warEngine/shared";
import { computeNationMilitaryAggregates } from "../militarySnapshots";
import { tierOfNation } from "../parliament/service";
import { applyRevolution } from "../parliament/service";
import { persistNotificationInBackground } from "../playerNotify";
import {
  decideMilitaryAction, afterRefuse, pickTarget, type MilitaryTier, type TargetCandidate,
} from "./core";

type Nation = PlayerNation;

const TIER_MAP: Record<string, MilitaryTier> = { autocracy: "autocracy", semi: "semi", democracy: "democracy" };

function notify(nation: Nation, title: string, body: string): void {
  if (!nation.discordUserId) return;
  persistNotificationInBackground({
    discordUserId: nation.discordUserId, type: "politics", title, body, linkPath: "/game/politics",
  });
}

async function setMilitarySatisfaction(nationId: string, value: number): Promise<void> {
  await db.update(playerNationsTable)
    .set({ satisfactionMilitary: Math.max(0, Math.min(100, Math.round(value))) })
    .where(eq(playerNationsTable.id, nationId));
}

export async function getPendingDemand(nationId: string): Promise<MilitaryDemand | null> {
  const [row] = await db.select().from(militaryDemandsTable)
    .where(and(eq(militaryDemandsTable.nationId, nationId), eq(militaryDemandsTable.status, "pending"))).limit(1);
  return row ?? null;
}

/**
 * 蒐集候選目標:與我方任一控制地區相鄰的地區。
 *  - 該地區已有我方控制 100% → 跳過(沒有東西可打)
 *  - 無主地:沒有任何國家控制
 *  - 否則以控制比例最高的他國為目標
 */
export async function collectCandidates(nation: Nation, myArmy: number, armies: Map<string, { armyPopulation: number }>): Promise<TargetCandidate[]> {
  void myArmy;
  const mine = await db.select({ regionId: regionControlsTable.regionId }).from(regionControlsTable)
    .where(eq(regionControlsTable.nationId, nation.id));
  if (mine.length === 0) return [];
  const mineIds = mine.map((m) => m.regionId);

  const adj = await db.select({ id: mapRegionAdjacenciesTable.adjacentRegionId }).from(mapRegionAdjacenciesTable)
    .where(inArray(mapRegionAdjacenciesTable.regionId, mineIds));
  const targetRegionIds = [...new Set(adj.map((a) => a.id))].filter((id) => !mineIds.includes(id));
  if (targetRegionIds.length === 0) return [];

  const [regions, controls] = await Promise.all([
    db.select({ id: mapRegionsTable.id, name: mapRegionsTable.name }).from(mapRegionsTable)
      .where(inArray(mapRegionsTable.id, targetRegionIds)),
    db.select({ regionId: regionControlsTable.regionId, nationId: regionControlsTable.nationId, percent: regionControlsTable.percent })
      .from(regionControlsTable)
      .where(and(inArray(regionControlsTable.regionId, targetRegionIds), ne(regionControlsTable.nationId, nation.id))),
  ]);

  const ownerOf = new Map<number, string>();
  for (const c of controls) {
    const cur = ownerOf.get(c.regionId);
    const curPct = cur ? controls.find((x) => x.regionId === c.regionId && x.nationId === cur)!.percent : -1;
    if (c.percent > curPct) ownerOf.set(c.regionId, c.nationId);
  }
  const ownerIds = [...new Set(ownerOf.values())];

  const [relations, treaties, wars] = ownerIds.length === 0 ? [[], [], []] : await Promise.all([
    db.select().from(diplomacyRelationsTable),
    db.select({
      type: diplomacyTreatiesTable.type, proposerNationId: diplomacyTreatiesTable.proposerNationId,
      targetNationId: diplomacyTreatiesTable.targetNationId, status: diplomacyTreatiesTable.status,
      expiresAt: diplomacyTreatiesTable.expiresAt, proposerIsVassal: diplomacyTreatiesTable.proposerIsVassal,
    }).from(diplomacyTreatiesTable).where(eq(diplomacyTreatiesTable.status, "active")),
    db.select().from(diplomacyWarsTable),
  ]);

  const now = new Date();
  const out: TargetCandidate[] = [];
  for (const r of regions) {
    const owner = ownerOf.get(r.id) ?? null;
    if (owner === null) {
      out.push({ regionId: r.id, regionName: r.name, ownerNationId: null, relationScore: 0, ownerArmy: 0, isAlly: false, warBlocked: false, recentWar: false });
      continue;
    }
    const { low, high } = canonicalPair(nation.id, owner);
    const rel = relations.find((x) => x.nationAId === low && x.nationBId === high);
    const pairWars = wars.filter((w) => w.nationAId === low && w.nationBId === high);
    const alreadyAtWar = pairWars.some((w) => w.endedAt === null);
    out.push({
      regionId: r.id, regionName: r.name, ownerNationId: owner,
      relationScore: rel?.score ?? 0,
      ownerArmy: armies.get(owner)?.armyPopulation ?? 0,
      isAlly: await nationsInSameAlliance(nation.id, owner),
      warBlocked: findWarBlockingTreatyType(treaties as TreatyEffectView[], nation.id, owner, now) !== null || alreadyAtWar,
      recentWar: hasRecentEndedWar(pairWars.map((w) => w.endedAt), now),
    });
  }
  return out;
}

/**
 * 對目標地區發動進攻:走正式戰役流程 initiateCampaign。
 *  - 他國領土:defenderNationId 指定為該國(條約/冷卻/同盟由戰役系統把關)
 *  - 無主地:defenderNationId=null → 戰役系統自動成立 NPC 守軍對抗
 * 出發地取「與目標相鄰的我方地區」(優先控制比例最高者)。
 */
async function launchAttack(nation: Nation, cand: TargetCandidate): Promise<{ ok: boolean; reason?: string }> {
  const mine = await db.select({ regionId: regionControlsTable.regionId, percent: regionControlsTable.percent })
    .from(regionControlsTable).where(eq(regionControlsTable.nationId, nation.id));
  if (mine.length === 0) return { ok: false, reason: "no_region" };
  const adj = await db.select({ id: mapRegionAdjacenciesTable.regionId }).from(mapRegionAdjacenciesTable)
    .where(and(eq(mapRegionAdjacenciesTable.adjacentRegionId, cand.regionId),
      inArray(mapRegionAdjacenciesTable.regionId, mine.map((m) => m.regionId))));
  const adjIds = new Set(adj.map((a) => a.id));
  const origin = mine.filter((m) => adjIds.has(m.regionId)).sort((x, y) => y.percent - x.percent)[0];
  if (!origin) return { ok: false, reason: "no_origin" };
  // 他國領土:戰役系統要求雙方已交戰 → 先走外交宣戰(條約/同盟/冷卻在此把關);已在交戰中直接繼續
  if (cand.ownerNationId !== null) {
    const [target] = await db.select({ id: playerNationsTable.id, name: playerNationsTable.name, discordUserId: playerNationsTable.discordUserId })
      .from(playerNationsTable).where(eq(playerNationsTable.id, cand.ownerNationId)).limit(1);
    if (!target) return { ok: false, reason: "target_missing" };
    const war = await declareWarByNpc({ declarerNationId: nation.id, declarerName: nation.name, target, ignoreRelation: true });
    if (!war.declared && war.reason !== "already_at_war") return { ok: false, reason: war.reason ?? "declare_failed" };
  }
  try {
    await initiateCampaign({
      attackerNationId: nation.id,
      attackerRegionId: origin.regionId,
      defenderRegionId: cand.regionId,
      defenderNationId: cand.ownerNationId, // null = 無主地,自動生成 NPC 守軍
      initiatedByNpc: true,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof WarActionError) return { ok: false, reason: err.message };
    throw err;
  }
}

export interface MilitaryTurnResult {
  action: "none" | "demand" | "auto_war" | "coup_classic" | "coup_warlord";
  detail?: string;
}

/**
 * 每回合結算單一國家的軍方要求。
 * coupClassic:呼叫端傳入既有的軍方政變(applyCoup),讓本模組不依賴政治結算內部。
 */
export async function settleNationMilitaryDemand(
  nation: Nation,
  armies: Map<string, { armyPopulation: number }>,
  coupClassic: () => Promise<void>,
  rand: () => number = Math.random,
): Promise<MilitaryTurnResult> {
  if (nation.isNpc || !nation.discordUserId) return { action: "none" };
  const { tier: rawTier } = await tierOfNation(nation);
  const tier = TIER_MAP[rawTier] ?? "semi";
  const pending = await getPendingDemand(nation.id);

  const action = decideMilitaryAction({
    tier, satisfaction: nation.satisfactionMilitary, hasPendingDemand: pending !== null, rand,
  });

  if (action.kind === "coup") {
    if (pending) await db.update(militaryDemandsTable).set({ status: "expired", resolvedAt: new Date() }).where(eq(militaryDemandsTable.id, pending.id));
    if (action.variant === "classic") {
      await coupClassic();
      return { action: "coup_classic" };
    }
    await applyRevolution(nation, 0, "military");
    notify(nation, "軍閥叛變", "軍方對你徹底失望,一支軍閥部隊帶走部分領土自立,並向你宣戰。");
    return { action: "coup_warlord" };
  }

  if (action.kind === "none") return { action: "none" };

  const myArmy = armies.get(nation.id)?.armyPopulation ?? 0;
  const cands = await collectCandidates(nation, myArmy, armies);
  const target = pickTarget(cands, myArmy);
  if (!target) return { action: "none", detail: "no_target" };

  if (action.kind === "auto_war") {
    if (pending) await db.update(militaryDemandsTable).set({ status: "expired", resolvedAt: new Date() }).where(eq(militaryDemandsTable.id, pending.id));
    const atk = await launchAttack(nation, target);
    if (!atk.ok) return { action: "none", detail: atk.reason ?? "attack_blocked" };
    await db.insert(militaryDemandsTable).values({
      nationId: nation.id, regionId: target.regionId, regionName: target.regionName,
      targetNationId: target.ownerNationId, status: "auto_war", resolvedAt: new Date(),
    });
    notify(nation, "軍方擅自開戰", `軍方對你的指揮不滿,未經請示便對目標地區「${target.regionName}」的控制國發動戰爭。`);
    return { action: "auto_war", detail: target.regionName };
  }

  // demand
  const [targetNation] = target.ownerNationId
    ? await db.select({ name: playerNationsTable.name }).from(playerNationsTable).where(eq(playerNationsTable.id, target.ownerNationId)).limit(1)
    : [];
  try {
    await db.insert(militaryDemandsTable).values({
      nationId: nation.id, regionId: target.regionId, regionName: target.regionName,
      targetNationId: target.ownerNationId, targetNationName: targetNation?.name ?? null, status: "pending",
    });
  } catch (err) {
    logger.warn({ err, nationId: nation.id }, "military demand insert skipped (pending exists)");
    return { action: "none" };
  }
  notify(nation, "軍方要求進攻", `軍方要求進攻「${target.regionName}」。拒絕將大幅降低軍方滿意度。`);
  return { action: "demand", detail: target.regionName };
}

/** 玩家回應要求。accept:開戰;refuse:軍方滿意度 -15。 */
export async function respondToDemand(
  nation: Nation, demandId: number, accept: boolean,
): Promise<{ ok: boolean; error?: string; warStarted?: boolean; newSatisfaction?: number }> {
  const [d] = await db.select().from(militaryDemandsTable)
    .where(and(eq(militaryDemandsTable.id, demandId), eq(militaryDemandsTable.nationId, nation.id))).limit(1);
  if (!d) return { ok: false, error: "找不到這項要求" };
  if (d.status !== "pending") return { ok: false, error: "這項要求已處理" };

  // 樂觀鎖:先搶占狀態,避免雙擊重複扣分
  const claimed = await db.update(militaryDemandsTable)
    .set({ status: accept ? "accepted" : "refused", resolvedAt: new Date() })
    .where(and(eq(militaryDemandsTable.id, d.id), eq(militaryDemandsTable.status, "pending")))
    .returning({ id: militaryDemandsTable.id });
  if (claimed.length === 0) return { ok: false, error: "這項要求已處理" };

  if (!accept) {
    const [fresh] = await db.select({ s: playerNationsTable.satisfactionMilitary }).from(playerNationsTable).where(eq(playerNationsTable.id, nation.id));
    const next = afterRefuse(fresh?.s ?? nation.satisfactionMilitary);
    await setMilitarySatisfaction(nation.id, next);
    return { ok: true, warStarted: false, newSatisfaction: next };
  }

  // 同意:走正式戰役流程(他國領土或無主地皆可;無主地會自動生成 NPC 守軍)
  const atk = await launchAttack(nation, {
    regionId: d.regionId, regionName: d.regionName, ownerNationId: d.targetNationId,
    relationScore: 0, ownerArmy: 0, isAlly: false, warBlocked: false, recentWar: false,
  });
  if (!atk.ok) {
    // 開戰被擋(條約/同盟/冷卻/不再相鄰):還原為 expired,不扣分
    await db.update(militaryDemandsTable).set({ status: "expired" }).where(eq(militaryDemandsTable.id, d.id));
    return { ok: false, error: `目前無法發動進攻:${atk.reason ?? "條件不符"}` };
  }
  return { ok: true, warStarted: true };
}

export async function runMilitaryDemandSettlement(
  coupClassicFor: (n: Nation) => () => Promise<void>,
): Promise<{ nations: number; demands: number; autoWars: number; coups: number; failed: number }> {
  const nations = await db.select().from(playerNationsTable).where(eq(playerNationsTable.isNpc, false));
  const armies = await computeNationMilitaryAggregates().catch(() => new Map());
  const out = { nations: nations.length, demands: 0, autoWars: 0, coups: 0, failed: 0 };
  for (const n of nations) {
    try {
      const r = await settleNationMilitaryDemand(n, armies, coupClassicFor(n));
      if (r.action === "demand") out.demands++;
      else if (r.action === "auto_war") out.autoWars++;
      else if (r.action === "coup_classic" || r.action === "coup_warlord") out.coups++;
    } catch (err) {
      out.failed++;
      logger.error({ err, nationId: n.id }, "military demand settlement failed for nation");
    }
  }
  return out;
}
