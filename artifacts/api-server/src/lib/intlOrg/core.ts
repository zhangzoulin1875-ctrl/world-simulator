/**
 * 國際組織 — 純邏輯核心(無 DB / Express / AI 依賴)。
 *
 * 設計決定(2026-10-07,使用者確認):
 *  - 組織是世界級 NPC 行為者:玩家不能操作、結盟、收買;只有決策層(規則或 AI)決定它做什麼。
 *  - 玩家看得到「預告」:動作在 tick T 執行,最晚 T-2 寫入並顯示。
 *  - 共產國際開局就存在,影響力低(10),隨世界局勢成長;動作由影響力解鎖。
 *  - AI 只能從固定動作清單挑「動作+目標」,效果數字全部用本檔公式,AI 輸出一律驗證、不合法退回按兵不動。
 *  - 後續組織(法西斯國際…)同一套框架,只換意識形態與動作權重。
 */

export type OrgAction = "idle" | "propaganda" | "funding" | "strikes" | "subvert";
export const ORG_ACTIONS: readonly OrgAction[] = ["idle", "propaganda", "funding", "strikes", "subvert"];

export const ACTION_LABELS: Record<OrgAction, string> = {
  idle: "按兵不動", propaganda: "宣傳", funding: "資助", strikes: "罷工潮", subvert: "策反",
};

/** 預告提前量:動作在 T 執行,最晚 T-PLAN_LEAD 就要寫入並對玩家顯示。 */
export const PLAN_LEAD_TURNS = 2;
/** 每隔幾個世界 tick 組織做一次決策。 */
export const DECISION_EVERY_TURNS = 4;
/** 同一國 N 個 tick 內最多被同一組織針對 1 次。 */
export const TARGET_COOLDOWN_TURNS = 3;
/** 每次決策全球最多幾個目標。 */
export const MAX_TARGETS_PER_DECISION = 2;

export const INFLUENCE_START = 10;
export const INFLUENCE_MIN = 0;
export const INFLUENCE_MAX = 100;

/** 動作解鎖所需影響力(含)。 */
export const ACTION_MIN_INFLUENCE: Record<OrgAction, number> = {
  idle: 0, propaganda: 0, funding: 30, strikes: 50, subvert: 70,
};

export const clampInfluence = (v: number) => Math.max(INFLUENCE_MIN, Math.min(INFLUENCE_MAX, Math.round(v)));

/** 影響力目前能做哪些動作。 */
export function unlockedActions(influence: number): OrgAction[] {
  return ORG_ACTIONS.filter((a) => influence >= ACTION_MIN_INFLUENCE[a]);
}

/** 動作強度(0.2–1):影響力越高越強。宣傳等小動作不需要太高影響力就能用,但強度仍隨影響力成長。 */
export function actionPower(influence: number): number {
  return Math.max(0.2, Math.min(1, 0.2 + (clampInfluence(influence) / 100) * 0.8));
}

// ── 世界局勢 → 影響力 ──────────────────────────────────────────────────
/** 時代對影響力的「自然上限」:古代很低,工業之後才可能衝高。未知時代給中間值。 */
export const ERA_INFLUENCE_CAP: Readonly<Record<string, number>> = {
  ancient: 20, classical: 30, medieval: 40, renaissance: 55, industrial: 85, modern: 100,
};
export function eraCap(eraSlug: string): number {
  return ERA_INFLUENCE_CAP[eraSlug] ?? 50;
}

/** 單一國家對組織的「可乘之機」摘要(公式輸入,不含任何名稱)。 */
export interface NationSituation {
  nationId: string;
  /** 議會滿意度 0–100(沒有議會的國家給 null)。 */
  parliamentSat: number | null;
  /** 目標意識形態(紅線)黨的席次占比 0–1。 */
  radicalSeatShare: number;
  stability: number;
  atWar: boolean;
  /** 是否已在內戰中。 */
  inCivilWar: boolean;
  isPlayer: boolean;
}

/** 國家的「動盪度」0–1:議會越不滿、穩定度越低、極端黨越強、打仗,越高。 */
export function unrest(n: NationSituation): number {
  const sat = n.parliamentSat === null ? 0.3 : (100 - clampPct(n.parliamentSat)) / 100;
  const stab = (100 - clampPct(n.stability)) / 100;
  const base = sat * 0.4 + stab * 0.3 + Math.min(1, n.radicalSeatShare * 2) * 0.2 + (n.atWar ? 0.1 : 0);
  return Math.max(0, Math.min(1, Math.round(base * 100) / 100));
}
const clampPct = (v: number) => Math.max(0, Math.min(100, v));

/**
 * 影響力的下一步:往「目標值」每次移動最多 ±3。
 * 目標值 = 時代上限 × 世界平均動盪度(動盪的世界組織才有空間),被打擊(failures)時再扣。
 */
export function nextInfluence(current: number, eraSlug: string, avgUnrest: number, setbacks = 0): number {
  const target = Math.max(INFLUENCE_START, eraCap(eraSlug) * (0.4 + 0.6 * Math.max(0, Math.min(1, avgUnrest))));
  const step = Math.max(-3, Math.min(3, target - current));
  return clampInfluence(current + step - setbacks);
}

// ── 目標資格與效果(全部公式) ────────────────────────────────────────
export const SUBVERT_MAX_PARLIAMENT_SAT = 25;
export const SUBVERT_MIN_RADICAL_SEATS = 0.1;

/** 動作對這個國家是否合法(門檻)。AI 輸出與規則版決策都用這一條驗證。 */
export function actionAllowedOn(action: OrgAction, n: NationSituation, influence: number): boolean {
  if (action === "idle") return true;
  if (influence < ACTION_MIN_INFLUENCE[action]) return false;
  if (n.inCivilWar) return false; // 已在內戰的國家不再被干涉
  if (action === "subvert") {
    return n.parliamentSat !== null && n.parliamentSat <= SUBVERT_MAX_PARLIAMENT_SAT && n.radicalSeatShare >= SUBVERT_MIN_RADICAL_SEATS;
  }
  return true;
}

export interface ActionEffect {
  /** 議會滿意度變化(負 = 變差)。 */
  parliamentSat: number;
  /** 穩定度變化。 */
  stability: number;
  /** 目標國紅線黨的權重加成(下次大選用)。 */
  radicalWeight: number;
  /** 是否觸發一次「國內事件」(罷工)。 */
  triggersEvent: boolean;
  /** 是否引爆內戰。 */
  civilWar: boolean;
}
const NONE: ActionEffect = { parliamentSat: 0, stability: 0, radicalWeight: 0, triggersEvent: false, civilWar: false };

/** 效果數字:全由動作與影響力決定,AI 無法左右。 */
export function actionEffect(action: OrgAction, influence: number): ActionEffect {
  const p = actionPower(influence);
  switch (action) {
    case "propaganda": return { ...NONE, parliamentSat: -Math.round(2 + 4 * p) };
    case "funding": return { ...NONE, radicalWeight: Math.round(3 + 7 * p) };
    case "strikes": return { ...NONE, stability: -Math.round(3 + 7 * p), triggersEvent: true };
    case "subvert": return { ...NONE, civilWar: true };
    default: return NONE;
  }
}

/** 策反失敗/成功後對組織影響力的回饋:被干涉國局勢好轉 → 扣分。 */
export const SETBACK_WHEN_RECOVERED = 2;

// ── 預告 ───────────────────────────────────────────────────────────────
export type PlanStatus = "planned" | "executed" | "cancelled";

export interface Plan {
  id?: number;
  orgId: string;
  targetNationId: string | null;
  action: OrgAction;
  /** 預計執行的世界 tick。 */
  executeTick: number;
  /** 寫入預告時的世界 tick。 */
  plannedTick: number;
  status: PlanStatus;
}

/** 預告提前量是否足夠(玩家有時間應對)。 */
export function leadIsEnough(plannedTick: number, executeTick: number): boolean {
  return executeTick - plannedTick >= PLAN_LEAD_TURNS;
}

/** 玩家看的模糊時間:「2~3 回合內」,不給精確數字。 */
export function fuzzyEta(currentTick: number, executeTick: number): string {
  const d = Math.max(0, executeTick - currentTick);
  if (d <= 0) return "本回合";
  if (d === 1) return "1~2 回合內";
  return `${d}~${d + 1} 回合內`;
}

/** 這個預告現在到期了嗎? */
export function isDue(plan: Pick<Plan, "executeTick" | "status">, currentTick: number): boolean {
  return plan.status === "planned" && plan.executeTick <= currentTick;
}

// ── 決策 ───────────────────────────────────────────────────────────────
export interface Decision { targetNationId: string | null; action: OrgAction }

export type Rng = () => number;

export interface DecisionContext {
  influence: number;
  nations: readonly NationSituation[];
  /** 各國最近一次被這個組織針對的 tick(沒有就不在表內)。 */
  lastTargetedTick: Readonly<Record<string, number>>;
  /** 這個組織已有、尚未執行的預告所針對的國家(不重複預告同一國)。 */
  alreadyPlanned: readonly string[];
  tick: number;
}

/** 決策輸出驗證:不合法的項目被剔除;全被剔除 → 空陣列(= 按兵不動)。AI 與規則版共用。 */
export function validateDecisions(raw: readonly Decision[], ctx: DecisionContext): Decision[] {
  const byId = new Map(ctx.nations.map((n) => [n.nationId, n]));
  const seen = new Set<string>();
  const out: Decision[] = [];
  for (const d of raw) {
    if (!d || !ORG_ACTIONS.includes(d.action) || d.action === "idle") continue;
    if (!d.targetNationId) continue;
    const n = byId.get(d.targetNationId);
    if (!n) continue;
    if (seen.has(n.nationId) || ctx.alreadyPlanned.includes(n.nationId)) continue;
    const last = ctx.lastTargetedTick[n.nationId];
    if (last !== undefined && ctx.tick - last < TARGET_COOLDOWN_TURNS) continue;
    if (!actionAllowedOn(d.action, n, ctx.influence)) continue;
    seen.add(n.nationId);
    out.push({ targetNationId: n.nationId, action: d.action });
    if (out.length >= MAX_TARGETS_PER_DECISION) break;
  }
  return out;
}

/**
 * 規則版決策(AI 的後備,也是 AI 失敗時的行為):
 * 只對「動盪度夠高」的國家出手;動作依動盪度與影響力挑最強的合法動作;
 * 動盪度相同以 nationId 決勝,確保確定性。
 */
export const RULE_UNREST_THRESHOLD = 0.45;
export function ruleBasedDecision(ctx: DecisionContext): Decision[] {
  const ranked = [...ctx.nations]
    .map((n) => ({ n, u: unrest(n) }))
    .filter((x) => x.u >= RULE_UNREST_THRESHOLD && !x.n.inCivilWar)
    .sort((a, b) => b.u - a.u || a.n.nationId.localeCompare(b.n.nationId));
  const order: OrgAction[] = ["subvert", "strikes", "funding", "propaganda"];
  const raw: Decision[] = [];
  for (const { n } of ranked) {
    const a = order.find((act) => actionAllowedOn(act, n, ctx.influence));
    if (a) raw.push({ targetNationId: n.nationId, action: a });
  }
  return validateDecisions(raw, ctx);
}

/** 預告要給玩家看的「關注程度」:這個國家在組織眼中的位置。 */
export type Attention = "high" | "watched" | "none";
export function attentionOf(nationId: string, plans: readonly Pick<Plan, "targetNationId" | "status">[], n: NationSituation | undefined): Attention {
  if (plans.some((p) => p.status === "planned" && p.targetNationId === nationId)) return "high";
  if (n && unrest(n) >= RULE_UNREST_THRESHOLD) return "watched";
  return "none";
}
