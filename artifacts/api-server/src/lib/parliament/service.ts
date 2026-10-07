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
import { endCampaignsForNation } from "../warEngine/endCampaign";
import {
  allocateSeats, rubberStampParliament, parliamentTier, effectiveParliamentTier, planRevolutionSplit, rulingParty,
  PARLIAMENT_SATISFACTION_START, type ComplianceSnapshot, type SeatedParty,
  type ParliamentStance, type ParliamentTier,
} from "./core";
import { planParliamentTurn } from "./plan";
import { hasElections } from "./election";
import { runElectionIfDue } from "./electionService";
import { reformGovernment, tickGovernment } from "./coalitionService";
import { buildParties, partyColor, type NationFacts } from "./parties";
import { generateParliamentMessage } from "./messageAi";
import { generatePartyNames, isTemplateName } from "./partyNames";
import { buildNationContext } from "../nationContext";
import { getCurrentEraSlug } from "../nationStats";
import { isDemandDue, rulingParty as rulingPartyOf } from "./core";
import { SOCIALIST_PARTY_NAME } from "../domesticEvents/parliamentShift";
import { noConstitutionPenalty } from "../constitution/core";
import { loadConstitution, statusOf } from "../constitution/service";

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

/** 國際局勢摘要：世界上其他國家的戰事與強弱，讓議會意見反映外部環境。 */
async function buildWorldSituation(selfId: string): Promise<string> {
  try {
    const wars = await db.select().from(diplomacyWarsTable).where(isNull(diplomacyWarsTable.endedAt));
    const involvesMe = (w: (typeof wars)[number]) => w.nationAId === selfId || w.nationBId === selfId;
    const others = wars.filter((w) => !involvesMe(w));
    const mine = wars.filter(involvesMe);
    const parts: string[] = [];
    parts.push(others.length > 0 ? `世界上另有 ${others.length} 場戰爭正在進行` : "世界大致承平，沒有其他大型戰事");
    if (mine.length === 0 && others.length > 0) parts.push("本國暫未捲入");
    return parts.join("；");
  } catch {
    return "";
  }
}

export async function rebuildParties(nation: Nation, state: { tick: number }, facts: NationFacts): Promise<SeatedParty[]> {
  // 重組前先讀舊黨：同立場的黨沿用原名與黨綱，議會洗牌不會讓黨名跟著全換。
  const prev = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nation.id));
  const prevByStance = new Map<string, { name: string; description: string }>();
  for (const r of prev) if (!prevByStance.has(r.stance)) prevByStance.set(r.stance, { name: r.name, description: r.description });
  const seated = facts.tier === "autocracy"
    ? rubberStampParliament({ id: "p0", name: `${facts.nationName}愛國黨` })
    : allocateSeats(buildParties(facts)).map((p) => {
        const old = prevByStance.get(p.stance);
        return old && old.name !== SOCIALIST_PARTY_NAME ? { ...p, name: old.name } : p;
      });
  const descByStance = new Map<string, string>();
  for (const [stance, v] of prevByStance) descByStance.set(stance, v.description);
  const ruling = rulingParty(seated);
  await db.transaction(async (tx) => {
    await tx.delete(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nation.id));
    if (seated.length > 0) {
      await tx.insert(parliamentPartiesTable).values(seated.map((p, i) => ({
        nationId: nation.id, name: p.name, stance: p.stance, weight: Math.max(1, Math.round(p.weight)),
        seats: p.seats, color: partyColor(i), isRuling: ruling?.id === p.id,
        description: prevByStance.get(p.stance)?.name === p.name ? (descByStance.get(p.stance) ?? "") : "",
      })));
    }
    await tx.update(parliamentStateTable).set({ lastPartiesTick: state.tick }).where(eq(parliamentStateTable.nationId, nation.id));
  });
  // 新一批政黨 → 由議會重新組閣(專制會清掉聯合旗標)。失敗不影響重組本身。
  try { await reformGovernment(nation.id, facts.tier, state.tick); }
  catch (err) { logger.warn({ err, nationId: nation.id }, "parliament: coalition formation after rebuild failed"); }
  // AI 命名在背景補上，不阻塞玩家請求或回合結算；失敗就保留模板名。
  if (facts.tier !== "autocracy") {
    void nameUnnamedParties(nation, prev.map((r) => r.name)).catch((err) =>
      logger.warn({ err, nationId: nation.id }, "parliament: background party naming failed"));
  }
  return seated;
}

/** 黨名等於「立場標籤+黨」模板的黨，背景請 AI 取名並寫回（只改 name/description，不動立場與席次）。 */
export async function nameUnnamedParties(nation: Nation, previousNames: readonly string[] = []): Promise<number> {
  const rows = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nation.id));
  const todo = rows.filter((r) => r.stance !== "loyalist" && r.name !== SOCIALIST_PARTY_NAME
    && isTemplateName(r.name, r.stance as ParliamentStance));
  if (todo.length === 0) return 0;
  const eraSlug = await getCurrentEraSlug();
  const context = await buildNationContext(nation, eraSlug);
  const named = await generatePartyNames({
    eraSlug, context, previousNames,
    // AI 看的 id 用資料表 id，寫回時直接對得上。
    parties: todo.map((r) => ({ id: String(r.id), stance: r.stance as ParliamentStance, seats: r.seats })),
  });
  if (!named) return 0;
  // 與同國其他已命名的黨不得重名。
  const taken = new Set(rows.filter((r) => !todo.includes(r)).map((r) => r.name));
  let n = 0;
  for (const r of named) {
    if (taken.has(r.name)) continue;
    taken.add(r.name);
    // 條件式更新：期間若黨已被重組（id 不存在）或被改名，就不覆蓋。
    const res = await db.update(parliamentPartiesTable)
      .set({ name: r.name, description: r.description })
      .where(and(eq(parliamentPartiesTable.id, Number(r.id)), eq(parliamentPartiesTable.nationId, nation.id)))
      .returning({ id: parliamentPartiesTable.id });
    n += res.length;
  }
  return n;
}

async function loadParties(nationId: string): Promise<SeatedParty[]> {
  const rows = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  return rows.map((r) => ({ id: String(r.id), name: r.name, stance: r.stance as ParliamentStance, weight: r.weight, seats: r.seats }));
}

/**
 * 確保該國已有議會狀態與政黨。新建國後議會黨要等下一個回合結算才會建立,
 * 這段空窗期議會頁會顯示 0 席。讀取議會時若沒有政黨,就當場用與回合結算相同的
 * 規則式邏輯補建(冪等:已有政黨就什麼都不做)。回傳是否有補建。
 */
export async function ensureParliamentSeeded(nation: Nation): Promise<boolean> {
  const existing = await db.select({ id: parliamentPartiesTable.id }).from(parliamentPartiesTable)
    .where(eq(parliamentPartiesTable.nationId, nation.id)).limit(1);
  if (existing.length > 0) return false;
  const { tier, slug } = await tierOfNation(nation);
  const state = await ensureState(nation.id);
  const war = await atWarFlag(nation.id);
  const facts: NationFacts = {
    nationName: nation.name ?? "本國", tier, stability: nation.stability, warWeariness: nation.warWeariness,
    militarySatisfaction: nation.satisfactionMilitary, atWar: war.atWar, taxRatePct: nation.taxRatePct,
    governmentSlug: slug,
  };
  await rebuildParties(nation, state, facts);
  return true;
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
  // 專制政體但議會被事件改成非忠誠黨過半(社會黨取得多數)時,這不是「層級變了」,
  // 而是事件造成的議會結構,不能被重建成橡皮圖章。以有效層級判斷,真正換政體才重建。
  const effTier = effectiveParliamentTier(tier, parties);
  const tierChanged = (effTier === "autocracy") !== (parties.length === 1 && parties[0]?.stance === "loyalist");
  // 有選舉的政體(民主/半專制),黨的洗牌改由大選決定,不再每 12 回合憑空重組;
  // 專制只有一個橡皮圖章黨,維持原本的定期重建。
  const stale = !hasElections(effTier)
    && (state.lastPartiesTick === null || state.tick - state.lastPartiesTick >= PARTY_REFRESH_EVERY_TICKS);
  if (parties.length === 0 || tierChanged || stale) {
    // 國內事件(社會黨取得多數)造成的議會結構要延續:定期重建時不能把它洗掉。
    // 政體層級沒變、且議會裡有事件插入的社會黨時,只重設計時器,保留現有席次。
    const keepEventParliament = !tierChanged && parties.length > 0 && parties.some((p) => p.name === SOCIALIST_PARTY_NAME);
    if (keepEventParliament) {
      await db.update(parliamentStateTable).set({ lastPartiesTick: state.tick }).where(eq(parliamentStateTable.nationId, nation.id));
    } else {
      parties = await rebuildParties(nation, state, facts);
    }
  }

  const prevArmy = state.prevArmyPop === null ? null : Number(state.prevArmyPop);
  const curArmy = armyPop === null ? null : Number(armyPop);
  const armyChange = prevArmy !== null && curArmy !== null && prevArmy > 0 ? (curArmy - prevArmy) / prevArmy : 0;
  const snapshot: ComplianceSnapshot = {
    atWar: war.aggressor,
    militarySpendChange: Number.isFinite(armyChange) ? armyChange : 0,
    taxChange: state.prevTaxRate === null ? 0 : nation.taxRatePct - state.prevTaxRate,
    religionLean: 0,
    commerceUp: false,
  };

  // 專制下若議會被事件(社會黨取得多數)改成非忠誠黨過半,橡皮圖章失效,改以「半專制」規則問政。
  const planTier = effectiveParliamentTier(tier, parties);
  // 本回合若會出新要求：先請 AI 依國情與國際局勢寫抗議／要求文字（失敗就退回模板）。
  // 只在「真的要提新要求」時呼叫，避免每回合都花 AI 額度。
  let aiMessage: { protest: string; demandText: string | null } | null = null;
  const nextTick = state.tick + 1;
  if (planTier !== "autocracy" && !state.activeDemand && isDemandDue(nextTick, state.lastDemandTick)) {
    const ruling = rulingPartyOf(parties);
    if (ruling) {
      try {
        const eraSlug = await getCurrentEraSlug();
        const [ctx, worldSituation] = await Promise.all([
          buildNationContext(nation, eraSlug),
          buildWorldSituation(nation.id),
        ]);
        aiMessage = await generateParliamentMessage({
          eraSlug, stance: ruling.stance, partyName: ruling.name, wantsDemand: true,
          context: ctx, worldSituation, satisfaction: state.satisfaction,
        });
      } catch (err) {
        logger.warn({ err, nationId: nation.id }, "parliament ai message context failed — template");
      }
    }
  }

  const plan = planParliamentTurn({
    aiMessage,
    tier: planTier, tick: state.tick, satisfaction: state.satisfaction, lastDemandTick: state.lastDemandTick,
    activeDemand: state.activeDemand as any, parties, snapshot, militarySatisfaction: nation.satisfactionMilitary,
    atWar: war.atWar,
  });

  // 沒有通過憲法 → 議會滿意度每回合小扣(有下限,單憑此事不會逼出革命;專制橡皮圖章不罰)。
  // 革命回合不再扣,避免剛重置的 40 又被打折。
  let satisfactionAfter = plan.satisfaction;
  if (!plan.revolt) {
    const con = await loadConstitution(nation.id);
    const pen = noConstitutionPenalty(planTier, statusOf(con), plan.satisfaction);
    if (pen.delta < 0) {
      satisfactionAfter = pen.satisfaction;
      plan.logs.push({ kind: "constitution", summary: "國家至今沒有憲法,議會對領袖遲遲不制憲越來越不滿。", satDelta: pen.delta });
    }
  }

  await db.transaction(async (tx) => {
    await tx.update(parliamentStateTable).set({
      tick: plan.tick, satisfaction: satisfactionAfter, lastDemandTick: plan.lastDemandTick,
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

  if (plan.revolt) {
    await applyRevolution(nation, plan.tick);
    return { revolt: true };
  }
  // 大選:本回合結算完、議會 tick 推進之後,若已到大選日就開票(革命回合不選,國都在打內戰)。
  try {
    await runElectionIfDue(nation, planTier, plan.tick);
  } catch (err) {
    logger.error({ err, nationId: nation.id }, "parliament: election failed — skipped this round");
  }
  // 聯合政府:看守政府的扣分與重試、聯合夥伴的裂解與倒閣。失敗只記錄,不影響結算。
  try {
    await tickGovernment(nation.id, planTier, plan.tick);
  } catch (err) {
    logger.error({ err, nationId: nation.id }, "parliament: coalition tick failed — skipped");
  }
  return { revolt: false };
}

/** 革命落地：割 40% 控制度給新建的 NPC 分裂政權並宣戰；沒有土地則改政體。 */
export async function applyRevolution(
  nation: Nation, tick: number, cause: "parliament" | "military" = "parliament",
): Promise<void> {
  // 議會革命 = 議會式內戰;軍方叛變 = 黑線內戰。都是「打到一方被消滅」的奪權內戰。
  const ideology = cause === "military" ? "black" : "parliament";
  const label = cause === "military" ? "軍閥叛變" : "議會革命";
  let landSplit = false;
  await db.transaction(async (tx) => {
    const r = await startCivilWar(tx, nation, ideology, tick, label);
    if (r.started) landSplit = true;
    if (r.started || r.reason === "already_civil_war") return;
    // 沒有土地可切:後備處置 = 直接更替政體(維持原本行為)
    await tx.update(playerNationsTable)
      .set({ government: governmentLabel(DEFAULT_GOVERNMENT_SLUG) }).where(eq(playerNationsTable.id, nation.id));
    await tx.insert(parliamentLogTable).values({ nationId: nation.id, tick, kind: "revolution", summary: cause === "military" ? "軍方叛變奪權,政體被迫更替。" : "革命推翻舊政權,政體被迫更替。", satDelta: 0 });
  });
  if (landSplit) {
    // 國土被切走,進行中的戰役可能指向已不屬於該國的地區:提交後統一終止(有外部副作用,不能放交易內)
    try {
      await endCampaignsForNation(nation.id);
    } catch (err) {
      logger.error({ err, nationId: nation.id }, "revolution: failed to end campaigns after land split");
    }
  }
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

