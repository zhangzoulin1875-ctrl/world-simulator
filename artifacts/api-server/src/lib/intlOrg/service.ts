/**
 * 國際組織服務(DB 層)。規則見 core.ts;這裡負責:
 *  讀世界局勢 → 影響力成長 → 到期預告執行 → 決策日寫新預告。
 *
 * 全部以「預告先寫入、到期才執行」為原則;單一預告的執行包在交易裡,先以 planned→executed 條件更新搶占,
 * 並行/重跑都不會重複套用。任何一步失敗只記 log,不中斷回合。
 */
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  db, intlOrgsTable, intlOrgPlansTable, playerNationsTable, parliamentStateTable, parliamentPartiesTable,
  parliamentLogTable, diplomacyWarsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { governmentSlugByLabel } from "../governments";
import { getCurrentEraSlug } from "../nationStats";
import { persistNotificationInBackground } from "../playerNotify";
import { tierOfNation } from "../parliament/service";
import { createEvent } from "../domesticEvents/service";
import { getEventDef } from "../domesticEvents/core";
import { startCivilWar } from "../civilWarEngine";
import {
  ACTION_LABELS, ACTION_MIN_INFLUENCE, ORG_ACTIONS, DECISION_EVERY_TURNS, PLAN_LEAD_TURNS, SETBACK_WHEN_RECOVERED, actionEffect, attentionOf,
  fuzzyEta, nextInfluence, ruleBasedDecision, unrest, unlockedActions,
  type Attention, type Decision, type DecisionContext, type NationSituation, type OrgAction, type Rng,
} from "./core";

type Org = typeof intlOrgsTable.$inferSelect;
type Nation = typeof playerNationsTable.$inferSelect;

/** 罷工潮要建立的既有國內事件。 */
export const STRIKE_EVENT_KIND = "soc_labor_strike";

/** 該意識形態視為「同路人」的政體 slug:組織不干涉它們(共產國際 vs 委員會制/社會主義委員會)。 */
const ALIGNED_GOVERNMENTS: Record<string, readonly string[]> = { red: ["council_system", "socialist_council"] };

/**
 * 該意識形態對應的「極端黨」立場。紅線 = 民生福利派:黨名由 AI 動態生成(或國內事件的「社會黨」),
 * 所以用立場(而非黨名)辨認,才不會因為改名而失效。
 */
const RADICAL_STANCE: Record<string, string> = { red: "welfare" };

// ── 讀世界局勢 ─────────────────────────────────────────────────────────
/** 蒐集所有國家的局勢摘要(只有數值,沒有名稱,供公式與日後 AI 使用)。 */
export async function loadSituations(ideology: string): Promise<NationSituation[]> {
  const nations = await db.select().from(playerNationsTable);
  if (nations.length === 0) return [];
  const ids = nations.map((n) => n.id);
  const [states, parties, wars] = await Promise.all([
    db.select().from(parliamentStateTable).where(inArray(parliamentStateTable.nationId, ids)),
    db.select().from(parliamentPartiesTable).where(inArray(parliamentPartiesTable.nationId, ids)),
    db.select({ a: diplomacyWarsTable.nationAId, b: diplomacyWarsTable.nationBId, civil: diplomacyWarsTable.isCivilWar })
      .from(diplomacyWarsTable).where(sql`${diplomacyWarsTable.endedAt} IS NULL`),
  ]);
  const stateBy = new Map(states.map((s) => [s.nationId, s]));
  const partiesBy = new Map<string, typeof parties>();
  for (const p of parties) { const l = partiesBy.get(p.nationId) ?? []; l.push(p); partiesBy.set(p.nationId, l); }
  const atWar = new Set<string>(); const civil = new Set<string>();
  for (const w of wars) {
    atWar.add(w.a); atWar.add(w.b);
    if (w.civil) { civil.add(w.a); civil.add(w.b); }
  }
  const radStance = RADICAL_STANCE[ideology];
  const alignedSlugs = ALIGNED_GOVERNMENTS[ideology] ?? [];
  return nations.map((n) => {
    const ps = partiesBy.get(n.id) ?? [];
    const total = ps.reduce((a, p) => a + p.seats, 0);
    const rad = radStance ? ps.filter((p) => p.stance === radStance).reduce((a, p) => a + p.seats, 0) : 0;
    const s = stateBy.get(n.id);
    return {
      nationId: n.id,
      parliamentSat: s ? s.satisfaction : null,
      radicalSeatShare: total > 0 ? rad / total : 0,
      stability: n.stability,
      atWar: atWar.has(n.id),
      inCivilWar: civil.has(n.id),
      isPlayer: !n.isNpc,
      aligned: alignedSlugs.includes(governmentSlugByLabel(n.government) ?? ""),
    };
  });
}

// ── 預告查詢 ───────────────────────────────────────────────────────────
type PlanRow = typeof intlOrgPlansTable.$inferSelect;
const plannedFor = (orgId: number) =>
  db.select().from(intlOrgPlansTable).where(and(eq(intlOrgPlansTable.orgId, orgId), eq(intlOrgPlansTable.status, "planned")));

/** 每國最近一次被這個組織針對(預告或已執行)的 tick,用於冷卻。 */
async function lastTargeted(orgId: number): Promise<Record<string, number>> {
  const rows = await db.select({ t: intlOrgPlansTable.targetNationId, e: intlOrgPlansTable.executeTick })
    .from(intlOrgPlansTable).where(and(eq(intlOrgPlansTable.orgId, orgId), sql`${intlOrgPlansTable.status} <> 'cancelled'`));
  const out: Record<string, number> = {};
  for (const r of rows) if (r.t && (out[r.t] === undefined || r.e > out[r.t]!)) out[r.t] = r.e;
  return out;
}

// ── 執行單一預告 ───────────────────────────────────────────────────────
export interface ExecResult { executed: boolean; summary: string; setback: boolean }

/**
 * 執行一筆到期預告。先以 planned → executed 條件更新搶占(搶不到 = 別處已處理,直接略過),
 * 再套用效果。效果全部走公式(core.actionEffect),目標國已消失/進入內戰則取消。
 */
export async function executePlan(org: Org, plan: PlanRow, tick: number, rand: Rng = Math.random): Promise<ExecResult> {
  const grabbed = await db.update(intlOrgPlansTable)
    .set({ status: "executed", executedAt: new Date() })
    .where(and(eq(intlOrgPlansTable.id, plan.id), eq(intlOrgPlansTable.status, "planned")))
    .returning({ id: intlOrgPlansTable.id });
  if (grabbed.length === 0) return { executed: false, summary: "已被處理", setback: false };

  const cancel = async (why: string): Promise<ExecResult> => {
    await db.update(intlOrgPlansTable).set({ status: "cancelled", resultSummary: why }).where(eq(intlOrgPlansTable.id, plan.id));
    return { executed: false, summary: why, setback: false };
  };
  if (!plan.targetNationId) return cancel("沒有目標");
  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, plan.targetNationId));
  if (!nation) return cancel("目標國已不存在");

  // 執行當下重新驗證:目標局勢好轉 → 預告落空,組織受挫(這就是玩家「應對」的回報)
  const sits = await loadSituations(org.ideology);
  const sit = sits.find((s) => s.nationId === nation.id);
  if (!sit || sit.inCivilWar) return cancel("目標國已陷入內戰,組織轉向");
  if (sit.aligned) return cancel("目標國已成為同路人,行動取消");
  const action = plan.action as OrgAction;
  if (action !== "idle" && unrest(sit) < 0.3) {
    await db.update(intlOrgPlansTable).set({ resultSummary: "目標國局勢好轉,行動落空" }).where(eq(intlOrgPlansTable.id, plan.id));
    notifyTarget(nation, org, "dodged", action);
    return { executed: true, summary: "目標國局勢好轉,行動落空", setback: true };
  }
  const eff = actionEffect(action, org.influence);
  let summary = `${org.name}對目標國執行「${ACTION_LABELS[action]}」`;
  let setback = false;

  const { tier } = await tierOfNation(nation);
  if (eff.parliamentSat !== 0 && tier !== "autocracy") {
    // 原子相對更新,夾在 0–100
    await db.update(parliamentStateTable)
      .set({ satisfaction: sql`LEAST(100, GREATEST(0, ${parliamentStateTable.satisfaction} + ${eff.parliamentSat}))` })
      .where(eq(parliamentStateTable.nationId, nation.id));
    summary += `,議會滿意度 ${eff.parliamentSat}`;
  }
  if (eff.stability !== 0) {
    await db.update(playerNationsTable)
      .set({ stability: sql`LEAST(100, GREATEST(0, ${playerNationsTable.stability} + ${eff.stability}))` })
      .where(eq(playerNationsTable.id, nation.id));
    summary += `,穩定度 ${eff.stability}`;
  }
  if (eff.radicalWeight > 0) {
    const stance = RADICAL_STANCE[org.ideology];
    if (stance) {
      const upd = await db.update(parliamentPartiesTable)
        .set({ weight: sql`${parliamentPartiesTable.weight} + ${eff.radicalWeight}` })
        .where(and(eq(parliamentPartiesTable.nationId, nation.id), eq(parliamentPartiesTable.stance, stance)))
        .returning({ id: parliamentPartiesTable.id });
      summary += upd.length > 0 ? `,左翼政黨民意 +${eff.radicalWeight}(下次大選生效)` : ",但該國沒有可資助的對象";
    }
  }
  if (eff.triggersEvent && !nation.isNpc) {
    const def = getEventDef(STRIKE_EVENT_KIND);
    if (def) {
      const tickNow = await nationTick(nation.id);
      const created = await createEvent(nation.id, def, tickNow); // 已有 pending 事件會被唯一索引擋下 → null
      summary += created ? ",引發全國性罷工事件" : ",罷工潮蔓延";
    }
  }
  if (eff.civilWar) {
    const started = await db.transaction((tx) =>
      startCivilWar(tx, nation, "red", tick, `${org.name}策反`, "incumbent"),
    );
    if (started.started) summary += ",共產革命爆發,國內陷入內戰!";
    else { summary += ",策反失敗"; setback = true; }
  }

  await db.update(intlOrgPlansTable).set({ resultSummary: summary }).where(eq(intlOrgPlansTable.id, plan.id));
  await db.insert(parliamentLogTable).values({
    nationId: nation.id, tick: await nationTick(nation.id), kind: "intl_org", satDelta: tier === "autocracy" ? 0 : eff.parliamentSat,
    summary: `${org.name}:${ACTION_LABELS[action]}。`,
  });
  notifyTarget(nation, org, "hit", action);
  return { executed: true, summary, setback };
}

async function nationTick(nationId: string): Promise<number> {
  const [s] = await db.select({ t: parliamentStateTable.tick }).from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
  return s?.t ?? 0;
}

function notifyTarget(nation: Nation, org: Org, kind: "planned" | "hit" | "dodged", action: OrgAction, eta?: string) {
  if (nation.isNpc || !nation.discordUserId) return;
  const label = ACTION_LABELS[action];
  const t = kind === "planned" ? `${org.name}動向:正關注你的國家`
    : kind === "hit" ? `${org.name}對你的國家採取了行動` : `${org.name}的行動落空了`;
  const b = kind === "planned" ? `預計 ${eta ?? "數回合內"} 對你的國家進行「${label}」。提高議會滿意度與穩定度可以讓它落空。`
    : kind === "hit" ? `${org.name}對你的國家執行了「${label}」。` : `你的國家局勢穩定,${org.name}的「${label}」沒有造成影響。`;
  persistNotificationInBackground({ discordUserId: nation.discordUserId, type: "intl_org", title: t, body: b, linkPath: "/game/politics?tab=orgs" });
}

// ── 寫預告 ─────────────────────────────────────────────────────────────
/** 把決策寫成預告(executeTick = tick + PLAN_LEAD_TURNS)。並行安全:同組織同國只會有一筆 planned。 */
export async function writePlans(org: Org, decisions: readonly Decision[], tick: number, source: "rule" | "ai"): Promise<number> {
  let n = 0;
  for (const d of decisions) {
    if (!d.targetNationId || d.action === "idle") continue;
    const ins = await db.insert(intlOrgPlansTable).values({
      orgId: org.id, targetNationId: d.targetNationId, action: d.action,
      plannedTick: tick, executeTick: tick + PLAN_LEAD_TURNS, source,
    }).onConflictDoNothing().returning({ id: intlOrgPlansTable.id });
    if (ins.length === 0) continue;
    n++;
    const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, d.targetNationId));
    if (nation) notifyTarget(nation, org, "planned", d.action, fuzzyEta(tick, tick + PLAN_LEAD_TURNS));
  }
  return n;
}

// ── 世界結算(每回合一次) ─────────────────────────────────────────────
export interface OrgSettlementSummary { orgs: number; executed: number; planned: number; failed: number }

/**
 * 每個組織:tick+1 → 影響力成長 → 執行到期預告 → 決策日寫新預告。
 * `decide` 預設用規則版;C2-b 之後由呼叫端換成 AI 決策(失敗退回規則版)。
 */
export async function runIntlOrgSettlement(
  opts: { rand?: Rng; decide?: (org: Org, ctx: DecisionContext) => Promise<{ decisions: Decision[]; source: "rule" | "ai" }> } = {},
): Promise<OrgSettlementSummary> {
  const sum: OrgSettlementSummary = { orgs: 0, executed: 0, planned: 0, failed: 0 };
  const orgs = await db.select().from(intlOrgsTable);
  const era = await getCurrentEraSlug();
  for (const org0 of orgs) {
    sum.orgs++;
    try {
      // 1) tick+1(原子,避免並行結算重複推進)
      const [org] = await db.update(intlOrgsTable)
        .set({ tick: sql`${intlOrgsTable.tick} + 1`, updatedAt: new Date() })
        .where(eq(intlOrgsTable.id, org0.id)).returning();
      if (!org) continue;
      const tick = org.tick;
      const sits = await loadSituations(org.ideology);

      // 2) 執行到期預告
      const due = (await plannedFor(org.id)).filter((p) => p.executeTick <= tick);
      let setbacks = org.setbacks;
      for (const p of due) {
        try {
          const r = await executePlan(org, p, tick, opts.rand);
          if (r.executed) sum.executed++;
          if (r.setback) setbacks += SETBACK_WHEN_RECOVERED;
        } catch (err) {
          sum.failed++; logger.error({ err, orgId: org.id, planId: p.id }, "intl org: plan execution failed");
        }
      }

      // 3) 影響力成長(世界平均動盪度;被打擊的挫折在此一次扣完)
      const avg = sits.length ? sits.reduce((a, s) => a + unrest(s), 0) / sits.length : 0;
      const influence = nextInfluence(org.influence, era, avg, setbacks);
      await db.update(intlOrgsTable).set({ influence, setbacks: 0 }).where(eq(intlOrgsTable.id, org.id));

      // 4) 決策日:寫新預告
      if (tick >= org.nextDecisionTick) {
        // 原子搶佔決策日:兩個實例/重試同時結算時,只有真的把 next_decision_tick 往後推的那一個
        // 會繼續決策,另一個拿到 0 筆就跳過,不會在同一個決策週期寫出兩批預告。
        const claimedDay = await db.update(intlOrgsTable).set({ nextDecisionTick: tick + DECISION_EVERY_TURNS })
          .where(and(eq(intlOrgsTable.id, org.id), lte(intlOrgsTable.nextDecisionTick, tick)))
          .returning({ id: intlOrgsTable.id });
        if (claimedDay.length === 0) continue;
        const ctx: DecisionContext = {
          influence, nations: sits, lastTargetedTick: await lastTargeted(org.id),
          alreadyPlanned: (await plannedFor(org.id)).map((p) => p.targetNationId).filter((x): x is string => !!x), tick,
        };
        const out = opts.decide ? await opts.decide({ ...org, influence }, ctx) : { decisions: ruleBasedDecision(ctx), source: "rule" as const };
        sum.planned += await writePlans({ ...org, influence }, out.decisions, tick, out.source);
      }
    } catch (err) {
      sum.failed++; logger.error({ err, orgId: org0.id }, "intl org: settlement failed");
    }
  }
  return sum;
}

// ── 給玩家看的視圖 ─────────────────────────────────────────────────────
export interface OrgView {
  slug: string; name: string; influence: number;
  /** 影響力等級:給玩家看的模糊描述,不給精確數字以外的細節。 */
  level: "weak" | "growing" | "strong";
  /** 這個組織目前能做的動作(玩家看得到它「有多大本事」)。 */
  capabilities: string[];
  /** 你的國家在組織眼中的位置。 */
  attention: Attention;
  /** 預告:針對你的國家(含模糊時間),以及針對其他國家的概況。 */
  forYou: { action: string; eta: string }[];
  elsewhere: { action: string; eta: string }[];
  /** 最近發生的事(已執行,最多 5 筆,只含針對你的)。 */
  recent: { action: string; summary: string }[];
}

export async function buildOrgViews(nationId: string): Promise<OrgView[]> {
  const orgs = await db.select().from(intlOrgsTable);
  const out: OrgView[] = [];
  for (const org of orgs) {
    const plans = await db.select().from(intlOrgPlansTable).where(eq(intlOrgPlansTable.orgId, org.id));
    const planned = plans.filter((p) => p.status === "planned");
    const sits = await loadSituations(org.ideology);
    const mine = sits.find((s) => s.nationId === nationId);
    const eta = (p: PlanRow) => fuzzyEta(org.tick, p.executeTick);
    out.push({
      slug: org.slug, name: org.name, influence: org.influence,
      level: org.influence >= 60 ? "strong" : org.influence >= 30 ? "growing" : "weak",
      capabilities: unlockedActions(org.influence).filter((a) => a !== "idle").map((a) => ACTION_LABELS[a]),
      attention: attentionOf(nationId, plans.map((p) => ({ targetNationId: p.targetNationId, status: p.status as any })), mine),
      forYou: planned.filter((p) => p.targetNationId === nationId).map((p) => ({ action: ACTION_LABELS[p.action as OrgAction], eta: eta(p) })),
      elsewhere: planned.filter((p) => p.targetNationId !== nationId).map((p) => ({ action: ACTION_LABELS[p.action as OrgAction], eta: eta(p) })),
      recent: plans.filter((p) => p.status === "executed" && p.targetNationId === nationId && p.resultSummary)
        .sort((a, b) => b.id - a.id).slice(0, 5).map((p) => ({ action: ACTION_LABELS[p.action as OrgAction], summary: p.resultSummary! })),
    });
  }
  return out;
}

// ── 國際組織子頁(完整視圖) ───────────────────────────────────────────
export interface OrgDetail extends OrgView {
  ideology: string;
  /** 影響力等級的下一道門檻(給玩家預判它何時變危險);已滿級為 null。 */
  nextUnlock: { action: string; at: number } | null;
  /** 全部動作與解鎖狀態。 */
  actions: { action: string; unlockAt: number; unlocked: boolean }[];
  /** 世界動態:最近幾筆已執行的行動(全球,不含國別;只有「針對你」的才在 recent 帶摘要)。 */
  worldRecent: { action: string; ago: string; onYou: boolean }[];
  /** 全球統計:不洩漏國別。 */
  stats: { plannedTotal: number; executedTotal: number; fizzled: number; targetingYou: number };
  /** 決策間隔(幾回合一次),讓玩家知道節奏。 */
  decisionEvery: number;
}

export async function buildOrgDetails(nationId: string): Promise<OrgDetail[]> {
  const views = await buildOrgViews(nationId);
  const orgs = await db.select().from(intlOrgsTable);
  const out: OrgDetail[] = [];
  for (const v of views) {
    const org = orgs.find((o) => o.slug === v.slug);
    if (!org) continue;
    const plans = await db.select().from(intlOrgPlansTable).where(eq(intlOrgPlansTable.orgId, org.id));
    const locked = ORG_ACTIONS.filter((a) => a !== "idle" && org.influence < ACTION_MIN_INFLUENCE[a])
      .sort((a, b) => ACTION_MIN_INFLUENCE[a] - ACTION_MIN_INFLUENCE[b]);
    const executed = plans.filter((p) => p.status === "executed");
    out.push({
      ...v,
      ideology: org.ideology,
      nextUnlock: locked[0] ? { action: ACTION_LABELS[locked[0]], at: ACTION_MIN_INFLUENCE[locked[0]] } : null,
      actions: ORG_ACTIONS.filter((a) => a !== "idle").map((a) => ({
        action: ACTION_LABELS[a], unlockAt: ACTION_MIN_INFLUENCE[a], unlocked: org.influence >= ACTION_MIN_INFLUENCE[a],
      })),
      worldRecent: [...executed].sort((a, b) => b.id - a.id).slice(0, 8).map((p) => ({
        action: ACTION_LABELS[p.action as OrgAction],
        ago: org.tick - p.executeTick <= 0 ? "剛剛" : `${org.tick - p.executeTick} 回合前`,
        onYou: p.targetNationId === nationId,
      })),
      stats: {
        plannedTotal: plans.filter((p) => p.status === "planned").length,
        executedTotal: executed.length,
        fizzled: executed.filter((p) => (p.resultSummary ?? "").includes("落空")).length,
        targetingYou: plans.filter((p) => p.status === "planned" && p.targetNationId === nationId).length,
      },
      decisionEvery: DECISION_EVERY_TURNS,
    });
  }
  return out;
}
