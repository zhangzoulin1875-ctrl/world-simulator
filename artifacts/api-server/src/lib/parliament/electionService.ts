import { and, eq, gte, sql } from "drizzle-orm";
import {
  db, playerNationsTable, parliamentStateTable, parliamentPartiesTable, parliamentLogTable,
  parliamentCampaignActionsTable,
} from "@workspace/db";
import { logger } from "../logger";
import { loadPenaltyScale } from "../penaltyScaleLoad";
import { clampSat, type ParliamentStance, type ParliamentTier, type SeatedParty } from "./core";
import {
  ELECTION_INTERVAL, CAMPAIGN_TURNS, ACTION_LABELS, CAUGHT_SAT_PENALTY,
  actionCost, caughtChance, checkActionAllowed, electionPhase, hasElections, holdElection,
  nextElectionTick, rollCaught, rollOpinionNoise,
  type CampaignAction, type ElectionAction, type ElectionPhase, type Rng,
} from "./election";

type Nation = typeof playerNationsTable.$inferSelect;

export interface CampaignActionRow { id: number; partyId: string; action: ElectionAction; caught: boolean; cost: number }

/** 給 API / 前端的選舉視圖。 */
export interface ElectionView {
  enabled: boolean;
  phase: ElectionPhase;
  /** 距離大選還有幾個議會回合(已到期為 0)。 */
  turnsUntil: number;
  nextElectionTick: number;
  interval: number;
  campaignTurns: number;
  actions: CampaignActionRow[];
  /** 每種操作目前的花費與被抓機率,前端顯示用(不含擲骰結果)。 */
  prices: Record<ElectionAction, { label: string; cost: number; caughtChance: number }>;
}

function toAction(r: typeof parliamentCampaignActionsTable.$inferSelect): CampaignActionRow {
  return { id: r.id, partyId: r.partyId, action: r.action as ElectionAction, caught: r.caught, cost: Number(r.cost) };
}

async function loadActions(nationId: string, electionTick: number): Promise<CampaignActionRow[]> {
  const rows = await db.select().from(parliamentCampaignActionsTable).where(and(
    eq(parliamentCampaignActionsTable.nationId, nationId),
    eq(parliamentCampaignActionsTable.electionTick, electionTick),
  ));
  return rows.map(toAction);
}

export async function buildElectionView(nation: Nation, tier: ParliamentTier): Promise<ElectionView> {
  const [st] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nation.id));
  const tick = st?.tick ?? 0;
  const last = st?.lastElectionTick ?? null;
  const due = nextElectionTick(last);
  const scale = await loadPenaltyScale(nation.id).catch(() => 1);
  const acts: ElectionAction[] = ["canvass", "bribe", "suppress"];
  const prices = Object.fromEntries(acts.map((a) => [a, {
    label: ACTION_LABELS[a], cost: actionCost(a, tier, scale), caughtChance: caughtChance(a, tier),
  }])) as ElectionView["prices"];
  return {
    enabled: hasElections(tier),
    phase: electionPhase(tier, tick, last),
    turnsUntil: Math.max(0, due - tick),
    nextElectionTick: due,
    interval: ELECTION_INTERVAL,
    campaignTurns: CAMPAIGN_TURNS,
    actions: hasElections(tier) ? await loadActions(nation.id, due) : [],
    prices,
  };
}

export type CampaignResult =
  | { ok: true; caught: boolean; cost: number; satisfactionAfter: number | null; action: ElectionAction; partyName: string }
  | { ok: false; status: number; error: string };

/**
 * 競選期對某黨做一次操作。扣款、記錄、(被抓時)扣議會滿意度全在同一個交易:
 * 錢不夠 → 整筆回滾;並發重複點擊由「同黨同招」檢查與交易內重查擋住。
 */
export async function performCampaignAction(
  nation: Nation, tier: ParliamentTier, partyId: string, action: ElectionAction, rng: Rng = Math.random,
): Promise<CampaignResult> {
  if (!hasElections(tier)) return { ok: false, status: 403, error: "專制政體沒有選舉" };
  const [st] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nation.id));
  if (!st) return { ok: false, status: 404, error: "議會尚未建立" };
  const phase = electionPhase(tier, st.tick, st.lastElectionTick);
  if (phase !== "campaign") {
    return { ok: false, status: 409, error: phase === "polling" ? "選舉即將開票,已不能再操作" : "目前不在競選期" };
  }
  const due = nextElectionTick(st.lastElectionTick);
  const party = (await db.select().from(parliamentPartiesTable).where(and(
    eq(parliamentPartiesTable.nationId, nation.id), eq(parliamentPartiesTable.id, Number(partyId) || -1),
  )))[0];
  if (!party) return { ok: false, status: 404, error: "找不到這個政黨" };

  const scale = await loadPenaltyScale(nation.id).catch(() => 1);
  const cost = actionCost(action, tier, scale);
  const caught = rollCaught(action, tier, rng);
  const penalty = caught ? CAUGHT_SAT_PENALTY[action] : 0;

  const outcome = await db.transaction(async (tx) => {
    // 交易內重查,擋住大部分重複操作(次數上限、同黨同招)。
    const existing = (await tx.select().from(parliamentCampaignActionsTable).where(and(
      eq(parliamentCampaignActionsTable.nationId, nation.id), eq(parliamentCampaignActionsTable.electionTick, due),
    ))).map(toAction);
    const refuse = checkActionAllowed(existing, partyId, action);
    if (refuse) return { kind: "refused" as const, error: refuse };
    // 先搶佔唯一索引(ON CONFLICT DO NOTHING 不會讓交易進入錯誤狀態):
    // 並發的第二個請求會在這裡等第一個提交,然後乾淨地得到 0 筆。
    const claimed = await tx.insert(parliamentCampaignActionsTable).values({
      nationId: nation.id, electionTick: due, partyId, action, caught, cost,
    }).onConflictDoNothing().returning({ id: parliamentCampaignActionsTable.id });
    if (claimed.length === 0) return { kind: "refused" as const, error: `這個黨本屆已經${ACTION_LABELS[action]}過了` };
    const paid = await tx.update(playerNationsTable)
      .set({ money: sql`${playerNationsTable.money} - ${cost}` })
      .where(and(eq(playerNationsTable.id, nation.id), gte(playerNationsTable.money, cost)))
      .returning({ id: playerNationsTable.id });
    if (paid.length === 0) {
      // 錢不夠:把剛搶到的記錄一起撤掉(同一交易,等同沒發生過)。
      await tx.delete(parliamentCampaignActionsTable).where(eq(parliamentCampaignActionsTable.id, claimed[0]!.id));
      return { kind: "broke" as const };
    }
    let satAfter: number | null = null;
    if (penalty > 0) {
      satAfter = clampSat(st.satisfaction - penalty);
      await tx.update(parliamentStateTable).set({ satisfaction: satAfter }).where(eq(parliamentStateTable.nationId, nation.id));
      await tx.insert(parliamentLogTable).values({
        nationId: nation.id, tick: st.tick, kind: "election",
        summary: `${ACTION_LABELS[action]}「${party.name}」的行動敗露,議會譁然。`, satDelta: -penalty,
      });
    }
    return { kind: "ok" as const, satAfter };
  });

  if (outcome.kind === "refused") return { ok: false, status: 409, error: outcome.error };
  if (outcome.kind === "broke") return { ok: false, status: 402, error: `國庫不足,${ACTION_LABELS[action]}需要 ${cost.toLocaleString("en-US")} 金錢` };
  return { ok: true, caught, cost, satisfactionAfter: outcome.satAfter, action, partyName: party.name };
}

export interface ElectionOutcome {
  held: boolean;
  turnover: boolean;
  newRulingName: string | null;
}

/**
 * 結算中呼叫:若本屆大選已到期就開票。回傳是否有舉行。
 * 開票結果寫回政黨表(席次、執政旗標),整批競選操作清除,並寫議會紀錄。
 * 全在同一個交易;期間政黨若被別處重組(id 對不上),寧可略過這屆也不寫壞資料。
 */
export async function runElectionIfDue(
  nation: Nation, tier: ParliamentTier, tickAfter: number, rng: Rng = Math.random,
): Promise<ElectionOutcome> {
  const none: ElectionOutcome = { held: false, turnover: false, newRulingName: null };
  if (!hasElections(tier)) return none;
  const [st] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nation.id));
  if (!st) return none;
  if (electionPhase(tier, tickAfter, st.lastElectionTick) !== "polling") return none;
  const due = nextElectionTick(st.lastElectionTick);

  return db.transaction(async (tx) => {
    const rows = await tx.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nation.id));
    if (rows.length < 2) return none;
    const parties: SeatedParty[] = rows.map((r) => ({
      id: String(r.id), name: r.name, stance: r.stance as ParliamentStance, weight: r.weight, seats: r.seats,
    }));
    const acts = (await tx.select().from(parliamentCampaignActionsTable).where(and(
      eq(parliamentCampaignActionsTable.nationId, nation.id), eq(parliamentCampaignActionsTable.electionTick, due),
    ))).map(toAction);
    const known = new Set(parties.map((p) => p.id));
    const valid: CampaignAction[] = acts.filter((a) => known.has(a.partyId))
      .map((a) => ({ partyId: a.partyId, action: a.action, caught: a.caught }));
    const result = holdElection(parties, valid, tier, rollOpinionNoise(parties.map((p) => p.id), 10, rng));

    for (const p of result.parties) {
      await tx.update(parliamentPartiesTable)
        .set({ seats: p.seats, weight: p.weight, isRuling: p.id === result.rulingId })
        .where(and(eq(parliamentPartiesTable.id, Number(p.id)), eq(parliamentPartiesTable.nationId, nation.id)));
    }
    await tx.delete(parliamentCampaignActionsTable).where(and(
      eq(parliamentCampaignActionsTable.nationId, nation.id), eq(parliamentCampaignActionsTable.electionTick, due),
    ));
    // 選舉就是這一輪的重組:把重組計時器一併重設,避免開完票馬上又被洗牌。
    await tx.update(parliamentStateTable).set({ lastElectionTick: tickAfter, lastPartiesTick: tickAfter })
      .where(eq(parliamentStateTable.nationId, nation.id));

    const ruling = result.parties.find((p) => p.id === result.rulingId) ?? null;
    const swingText = result.swings.map((s) => `${s.name} ${s.before}→${s.after}`).join("、");
    await tx.insert(parliamentLogTable).values({
      nationId: nation.id, tick: tickAfter, kind: "election", satDelta: 0,
      summary: `大選開票:${swingText}。${result.turnover && ruling ? `政權輪替,${ruling.name}成為新的執政黨。` : `${ruling?.name ?? "原執政黨"}繼續執政。`}`,
    });
    logger.info({ nationId: nation.id, tickAfter, turnover: result.turnover }, "parliament: election held");
    return { held: true, turnover: result.turnover, newRulingName: ruling?.name ?? null };
  });
}
