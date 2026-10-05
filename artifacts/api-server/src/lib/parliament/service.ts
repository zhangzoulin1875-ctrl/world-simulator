import { and, eq, isNull, or, sql } from "drizzle-orm";
import {
  db, playerNationsTable, regionControlsTable, mapRegionsTable, diplomacyWarsTable,
  diplomacyRelationsTable, politicsEntriesTable, parliamentStateTable,
  parliamentPartiesTable, parliamentLogTable,
} from "@workspace/db";
import { logger } from "../logger";
import { canonicalPair } from "../diplomacy";
import { recordTerritoryChanges } from "../territoryHistory";
import { governmentLabel, DEFAULT_GOVERNMENT_SLUG } from "../governments";
import { computeNationMilitaryAggregates } from "../militarySnapshots";
import { startCivilWar } from "../civilWarEngine";
import {
  allocateSeats, rubberStampParliament, parliamentTier, planRevolutionSplit, rulingParty,
  PARLIAMENT_SATISFACTION_START, type ComplianceSnapshot, type SeatedParty,
  type ParliamentStance, type ParliamentTier,
} from "./core";
import { planParliamentTurn } from "./plan";
import { buildParties, partyColor, type NationFacts } from "./parties";

type Nation = typeof playerNationsTable.$inferSelect;
export const PARTY_REFRESH_EVERY_TICKS = 12;

/** 把政體 label（DB 存中文）轉回 slug 以判定檔位。 */
export async function tierOfNation(n: Pick<Nation, "government">): Promise<{ tier: ParliamentTier; slug: string | null }> {
  const { GOVERNMENTS } = await import("../governments");
  const hit = (GOVERNMENTS as readonly { slug: string; label: string }[]).find((g) => g.label === n.government || g.slug === n.government);
  if (!hit) logger.warn({ government: n.government }, "parliament: unknown government label, treated as semi-autocracy");
  return { tier: parliamentTier(hit?.slug), slug: hit?.slug ?? null };
}

async function ensureState(nationId: string) {
  await db.insert(parliamentStateTable).values({ nationId, satisfaction: PARLIAMENT_SATISFACTION_START }).onConflictDoNothing();
  const [s] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
  return s!;
}

async function atWarFlag(nationId: string): Promise<{ atWar: boolean; aggressor: boolean }> {
  const rows = await db.select({ declaredBy: diplomacyWarsTable.declaredByNationId })
    .from(diplomacyWarsTable)
    .where(and(isNull(diplomacyWarsTable.endedAt), or(eq(diplomacyWarsTable.nationAId, nationId), eq(diplomacyWarsTable.nationBId, nationId))));
  return { atWar: rows.length > 0, aggressor: rows.some((r) => r.declaredBy === nationId) };
}

/** 重新組黨並寫入資料庫（規則式；席次由公式算）。 */
export async function rebuildParties(nation: Nation, state: { tick: number }, facts: NationFacts): Promise<SeatedParty[]> {
  const seated = facts.tier === "autocracy"
    ? rubberStampParliament({ id: "p0", name: `${facts.nationName}愛國黨` })
    : allocateSeats(buildParties(facts));
  const ruling = rulingParty(seated);
  await db.transaction(async (tx) => {
    await tx.delete(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nation.id));
    if (seated.length > 0) {
      await tx.insert(parliamentPartiesTable).values(seated.map((p, i) => ({
        nationId: nation.id, name: p.name, stance: p.stance, weight: Math.max(1, Math.round(p.weight)),
        seats: p.seats, color: partyColor(i), isRuling: ruling?.id === p.id,
        description: "",
      })));
    }
    await tx.update(parliamentStateTable).set({ lastPartiesTick: state.tick }).where(eq(parliamentStateTable.nationId, nation.id));
  });
  return seated;
}

async function loadParties(nationId: string): Promise<SeatedParty[]> {
  const rows = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  return rows.map((r) => ({ id: String(r.id), name: r.name, stance: r.stance as ParliamentStance, weight: r.weight, seats: r.seats }));
}

/** 單國單回合結算。回傳是否發生革命。 */
export async function settleNationParliament(
  nation: Nation,
  armyPop: bigint | number | null,
  policyCount: number,
): Promise<{ revolt: boolean }> {
  const { tier, slug } = await tierOfNation(nation);
  const state = await ensureState(nation.id);
  const war = await atWarFlag(nation.id);

  const facts: NationFacts = {
    nationName: nation.name ?? "本國", tier, stability: nation.stability, warWeariness: nation.warWeariness,
    militarySatisfaction: nation.satisfactionMilitary, atWar: war.atWar, taxRatePct: nation.taxRatePct,
    governmentSlug: slug,
  };

  let parties = await loadParties(nation.id);
  const tierChanged = (tier === "autocracy") !== (parties.length === 1 && parties[0]?.stance === "loyalist");
  const stale = state.lastPartiesTick === null || state.tick - state.lastPartiesTick >= PARTY_REFRESH_EVERY_TICKS;
  if (parties.length === 0 || tierChanged || stale) parties = await rebuildParties(nation, state, facts);

  const prevArmy = state.prevArmyPop === null ? null : Number(state.prevArmyPop);
  const curArmy = armyPop === null ? null : Number(armyPop);
  const armyChange = prevArmy !== null && curArmy !== null && prevArmy > 0 ? (curArmy - prevArmy) / prevArmy : 0;
  const snapshot: ComplianceSnapshot = {
    atWar: war.aggressor,
    militarySpendChange: Number.isFinite(armyChange) ? armyChange : 0,
    taxChange: state.prevTaxRate === null ? 0 : nation.taxRatePct - state.prevTaxRate,
    wrotePolicy: state.prevPolicyCount === null ? true : policyCount > state.prevPolicyCount,
    religionLean: 0,
    commerceUp: false,
  };

  const plan = planParliamentTurn({
    tier, tick: state.tick, satisfaction: state.satisfaction, lastDemandTick: state.lastDemandTick,
    activeDemand: state.activeDemand as any, parties, snapshot, militarySatisfaction: nation.satisfactionMilitary,
  });

  await db.transaction(async (tx) => {
    await tx.update(parliamentStateTable).set({
      tick: plan.tick, satisfaction: plan.satisfaction, lastDemandTick: plan.lastDemandTick,
      activeDemand: plan.activeDemand as any,
      protestText: plan.protestText ?? state.protestText,
      prevTaxRate: nation.taxRatePct, prevArmyPop: curArmy === null ? null : String(Math.round(curArmy)),
      prevPolicyCount: policyCount,
      revolutions: plan.revolt ? state.revolutions + 1 : state.revolutions,
    }).where(eq(parliamentStateTable.nationId, nation.id));
    if (plan.logs.length > 0) {
      await tx.insert(parliamentLogTable).values(plan.logs.map((l) => ({
        nationId: nation.id, tick: plan.tick, kind: l.kind, summary: l.summary, satDelta: l.satDelta,
      })));
    }
  });

  if (plan.revolt) await applyRevolution(nation, plan.tick);
  return { revolt: plan.revolt };
}

/** 革命落地：割 40% 控制度給新建的 NPC 分裂政權並宣戰；沒有土地則改政體。 */
export async function applyRevolution(
  nation: Nation, tick: number, cause: "parliament" | "military" = "parliament",
): Promise<void> {
  // 議會革命 = 議會式內戰;軍方叛變 = 黑線內戰。都是「打到一方被消滅」的奪權內戰。
  const ideology = cause === "military" ? "black" : "parliament";
  const label = cause === "military" ? "軍閥叛變" : "議會革命";
  await db.transaction(async (tx) => {
    const r = await startCivilWar(tx, nation, ideology, tick, label);
    if (r.started || r.reason === "already_civil_war") return;
    // 沒有土地可切:後備處置 = 直接更替政體(維持原本行為)
    await tx.update(playerNationsTable)
      .set({ government: governmentLabel(DEFAULT_GOVERNMENT_SLUG) }).where(eq(playerNationsTable.id, nation.id));
    await tx.insert(parliamentLogTable).values({ nationId: nation.id, tick, kind: "revolution", summary: cause === "military" ? "軍方叛變奪權,政體被迫更替。" : "革命推翻舊政權,政體被迫更替。", satDelta: 0 });
  });
}

/** 全體結算入口：給回合引擎呼叫。單國失敗不影響其他國。 */
export async function runParliamentSettlement(): Promise<{ nations: number; revolts: number; failed: number }> {
  const nations = await db.select().from(playerNationsTable).where(eq(playerNationsTable.isNpc, false));
  const armies = await computeNationMilitaryAggregates().catch(() => new Map());
  const counts = await db.select({ nationId: politicsEntriesTable.nationId, n: sql<number>`count(*)::int` })
    .from(politicsEntriesTable).groupBy(politicsEntriesTable.nationId);
  const policyCount = new Map(counts.map((c) => [c.nationId, c.n]));
  let revolts = 0, failed = 0;
  for (const n of nations) {
    try {
      const r = await settleNationParliament(n, armies.get(n.id)?.armyPopulation ?? null, policyCount.get(n.id) ?? 0);
      if (r.revolt) revolts++;
    } catch (err) {
      failed++;
      logger.error({ err, nationId: n.id }, "parliament settlement failed for nation");
    }
  }
  return { nations: nations.length, revolts, failed };
}

