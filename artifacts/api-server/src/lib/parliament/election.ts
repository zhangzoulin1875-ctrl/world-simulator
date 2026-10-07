import { allocateSeats, type ParliamentTier, type PartyInput, type SeatedParty } from "./core";

/**
 * 選舉規則核心(純函式,無 DB、無 AI)。
 * 週期:每 ELECTION_INTERVAL 個議會回合一次大選,選前 CAMPAIGN_TURNS 回合為競選期。
 * 競選期玩家可對各黨「拉票/買票/打壓」;開票時民意 + 操作加成 → 權重 → 既有 allocateSeats 分配席次。
 * 專制沒有選舉;半專制有選舉但「不自由」:操縱便宜、被抓機率低,但結果偏向現任執政黨。
 */
export const ELECTION_INTERVAL = 12;
export const CAMPAIGN_TURNS = 3;

export type ElectionAction = "canvass" | "bribe" | "suppress";
export const ACTION_LABELS: Record<ElectionAction, string> = { canvass: "拉票", bribe: "買票", suppress: "打壓" };

/** 每國每次選舉、每黨最多可被操作幾次(含三種),以及整場選舉總次數上限,防止無限砸錢。 */
export const MAX_ACTIONS_PER_PARTY = 3;
export const MAX_ACTIONS_PER_ELECTION = 8;

/** 基礎花費(未乘國力係數)。半專制折半。 */
const BASE_COST: Record<ElectionAction, number> = { canvass: 1000, bribe: 3000, suppress: 2000 };
/** 單次操作對該黨「民意點」的改變量(民意點 = 權重的加減)。 */
const BASE_EFFECT: Record<ElectionAction, number> = { canvass: 8, bribe: 18, suppress: -14 };
/** 被抓機率(0~1)。半專制較低。拉票合法,永遠不會被抓。 */
const CAUGHT_CHANCE: Record<ParliamentTier, Record<ElectionAction, number>> = {
  autocracy: { canvass: 0, bribe: 0, suppress: 0 },
  semi: { canvass: 0, bribe: 0.15, suppress: 0.1 },
  democracy: { canvass: 0, bribe: 0.4, suppress: 0.3 },
};
/** 被抓時議會滿意度的扣分(買票比打壓重)。 */
export const CAUGHT_SAT_PENALTY: Record<ElectionAction, number> = { canvass: 0, bribe: 12, suppress: 8 };

export function hasElections(tier: ParliamentTier): boolean {
  return tier !== "autocracy";
}

/** 下一次大選發生在哪個議會 tick:以最近一次選舉(或起始 0)為基準。 */
export function nextElectionTick(lastElectionTick: number | null): number {
  return (lastElectionTick ?? 0) + ELECTION_INTERVAL;
}

export type ElectionPhase = "none" | "campaign" | "polling";

/**
 * 目前階段。tick 為「本次結算後」的議會 tick。
 * - polling:tick 已到大選日 → 本次結算要開票。
 * - campaign:距大選不到 CAMPAIGN_TURNS 回合 → 競選期(可操作)。
 */
export function electionPhase(tier: ParliamentTier, tick: number, lastElectionTick: number | null): ElectionPhase {
  if (!hasElections(tier)) return "none";
  const due = nextElectionTick(lastElectionTick);
  if (tick >= due) return "polling";
  if (due - tick <= CAMPAIGN_TURNS) return "campaign";
  return "none";
}

export function actionCost(action: ElectionAction, tier: ParliamentTier, costScale: number): number {
  const scale = Number.isFinite(costScale) && costScale > 0 ? costScale : 1;
  const tierMul = tier === "semi" ? 0.5 : 1;
  return Math.max(1, Math.round(BASE_COST[action] * scale * tierMul));
}

export function caughtChance(action: ElectionAction, tier: ParliamentTier): number {
  return CAUGHT_CHANCE[tier][action];
}

/** 一筆已執行的競選操作(存資料庫用的最小形狀)。 */
export interface CampaignAction {
  partyId: string;
  action: ElectionAction;
  /** 是否被抓。被抓的買票/打壓效果反轉(醜聞)。 */
  caught: boolean;
}

/** 操作對單一黨的民意點淨改變。被抓:買票 → 該黨反扣;打壓 → 被打壓黨反而同情票。 */
export function actionEffect(a: Pick<CampaignAction, "action" | "caught">): number {
  const e = BASE_EFFECT[a.action];
  return a.caught ? -Math.sign(e) * Math.abs(e) * 0.75 : e;
}

/** 檢查是否還能對某黨再做一次操作。回傳 null = 可以,否則是拒絕原因。 */
export function checkActionAllowed(
  existing: readonly CampaignAction[], partyId: string, action: ElectionAction,
): string | null {
  if (existing.length >= MAX_ACTIONS_PER_ELECTION) return `本屆選舉最多只能操作 ${MAX_ACTIONS_PER_ELECTION} 次`;
  const forParty = existing.filter((a) => a.partyId === partyId);
  if (forParty.length >= MAX_ACTIONS_PER_PARTY) return `對同一個黨最多操作 ${MAX_ACTIONS_PER_PARTY} 次`;
  if (forParty.some((a) => a.action === action)) return `這個黨本屆已經${ACTION_LABELS[action]}過了`;
  return null;
}

export type Rng = () => number;

/** 擲「是否被抓」。rng 可注入固定值以便測試。 */
export function rollCaught(action: ElectionAction, tier: ParliamentTier, rng: Rng = Math.random): boolean {
  const p = caughtChance(action, tier);
  return p > 0 && rng() < p;
}

export interface ElectionResult {
  parties: SeatedParty[];
  /** 每個黨「選前 → 選後」席次,給 UI 與紀錄用。 */
  swings: { partyId: string; name: string; before: number; after: number }[];
  /** 新執政黨 id(席次最多者),與是否輪替。 */
  rulingId: string | null;
  turnover: boolean;
}

/**
 * 開票。每黨新權重 = 舊權重 + 民意擾動 + 操作加成,下限 1;
 * 半專制再加「現任優勢」:現任執政黨權重 ×1.3(選舉不自由)。
 * 席次一律走 allocateSeats(總和 100、每黨至少 1 席)。
 */
export function holdElection(
  parties: readonly SeatedParty[],
  actions: readonly CampaignAction[],
  tier: ParliamentTier,
  opinionNoise: Readonly<Record<string, number>> = {},
): ElectionResult {
  const before = new Map(parties.map((p) => [p.id, p.seats]));
  const incumbent = [...parties].sort((a, b) => b.seats - a.seats || a.id.localeCompare(b.id))[0] ?? null;
  const inputs: PartyInput[] = parties.map((p) => {
    const bonus = actions.filter((a) => a.partyId === p.id).reduce((n, a) => n + actionEffect(a), 0);
    const noise = opinionNoise[p.id] ?? 0;
    let w = p.weight + noise + bonus;
    if (tier === "semi" && incumbent && p.id === incumbent.id) w *= 1.3;
    return { id: p.id, name: p.name, stance: p.stance, weight: Math.max(1, Math.round(w)) };
  });
  const seated = allocateSeats(inputs);
  const winner = [...seated].sort((a, b) => b.seats - a.seats || a.id.localeCompare(b.id))[0] ?? null;
  return {
    parties: seated,
    swings: seated.map((p) => ({ partyId: p.id, name: p.name, before: before.get(p.id) ?? 0, after: p.seats })),
    rulingId: winner?.id ?? null,
    turnover: !!(winner && incumbent && winner.id !== incumbent.id),
  };
}

/** 民意擾動:每黨 ±(0~spread) 的隨機漂移,讓不操作的選舉也有變數。rng 可注入。 */
export function rollOpinionNoise(partyIds: readonly string[], spread = 10, rng: Rng = Math.random): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of partyIds) out[id] = Math.round((rng() * 2 - 1) * spread);
  return out;
}
