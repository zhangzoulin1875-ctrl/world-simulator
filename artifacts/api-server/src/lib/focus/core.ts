/**
 * 國策樹 核心規則(純函式,無 DB,可單元測試)。
 *
 * 設計(2026-10-05 定案):
 *  - 花「政治點數」啟動國策,需 N 回合完成。
 *  - 完成速度 = 基礎 1 回合 × 議會滿意度係數:高滿意度加快、低滿意度減慢、過低停擺。
 *  - 同時進行上限 2 條(主線 main / 支線 side)。
 *  - 國策依「路線 track」分群:stable 穩定 / black 黑線 / red 紅線 / reform 民主化或世襲化。
 *    黑紅線累積「傾向值」,達門檻且社會條件惡化才會爆發奪權(見後續階段)。
 */

export const FOCUS_TRACKS = ["stable", "black", "red", "reform"] as const;
export type FocusTrack = (typeof FOCUS_TRACKS)[number];

export const FOCUS_SLOTS = ["main", "side"] as const;
export type FocusSlot = (typeof FOCUS_SLOTS)[number];

/** 同時進行的國策上限(每個槽位各 1 條)。 */
export const MAX_ACTIVE_FOCUSES = FOCUS_SLOTS.length;

/** 議會滿意度區間對應的完成速度係數(每回合推進量)。 */
export const SPEED_AT_HIGH = 1.3; // 滿意度 >= HIGH_SAT
export const SPEED_AT_LOW = 0.7; // 滿意度 <= LOW_SAT(但 > STALL_SAT)
export const HIGH_SAT = 80;
export const LOW_SAT = 50;
/** 議會滿意度 <= 此值:國策停擺(進度不動)。 */
export const STALL_SAT = 15;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * 每回合進度係數。
 *  - sat <= STALL_SAT        → 0(停擺)
 *  - STALL_SAT < sat <= 50   → 0.7(慢 30%)
 *  - 50 < sat < 80           → 0.7 到 1.3 線性插值(無斷點)
 *  - sat >= 80               → 1.3(快 30%)
 */
export function focusSpeedMultiplier(satisfaction: number): number {
  const sat = clamp(Number.isFinite(satisfaction) ? satisfaction : 0, 0, 100);
  if (sat <= STALL_SAT) return 0;
  if (sat <= LOW_SAT) return SPEED_AT_LOW;
  if (sat >= HIGH_SAT) return SPEED_AT_HIGH;
  const t = (sat - LOW_SAT) / (HIGH_SAT - LOW_SAT);
  return SPEED_AT_LOW + t * (SPEED_AT_HIGH - SPEED_AT_LOW);
}

/**
 * 推進一條國策一回合。進度以「回合當量」累積(浮點,保留 4 位避免漂移),
 * 達到 totalTurns 即完成。
 */
export function advanceFocus(
  progress: number,
  totalTurns: number,
  satisfaction: number,
): { progress: number; completed: boolean; stalled: boolean } {
  const total = Math.max(1, Math.floor(totalTurns));
  const mult = focusSpeedMultiplier(satisfaction);
  const next = Math.round(clamp(progress + mult, 0, total) * 10_000) / 10_000;
  return { progress: next, completed: next >= total, stalled: mult === 0 };
}

/** 預估剩餘回合(以目前滿意度持平估算);停擺回傳 null。 */
export function estimateRemainingTurns(
  progress: number,
  totalTurns: number,
  satisfaction: number,
): number | null {
  const mult = focusSpeedMultiplier(satisfaction);
  if (mult <= 0) return null;
  const left = Math.max(0, Math.max(1, Math.floor(totalTurns)) - progress);
  return Math.ceil(left / mult);
}

// ── 政治點數 ────────────────────────────────────────────────

/** 政體檔位基礎每回合政治點數(專制集權效率高、民主需協商較低但議會加成)。 */
export const BASE_POINTS_BY_TIER = { autocracy: 3, semi: 3, democracy: 2 } as const;

/**
 * 每回合政治點數產出:
 *   基礎(依議會檔位) + 人口規模(每 500 萬人 +1,上限 +4) + 議會滿意度加成(>=70 +1,>=90 +2)
 * 至少 1(避免完全卡死)。
 */
export function politicalPointsPerTurn(input: {
  tier: "autocracy" | "semi" | "democracy";
  population: number;
  satisfaction: number;
}): number {
  const base = BASE_POINTS_BY_TIER[input.tier] ?? 2;
  const pop = Math.max(0, Number.isFinite(input.population) ? input.population : 0);
  const popBonus = Math.min(4, Math.floor(pop / 5_000_000));
  const sat = clamp(input.satisfaction, 0, 100);
  const satBonus = sat >= 90 ? 2 : sat >= 70 ? 1 : 0;
  return Math.max(1, base + popBonus + satBonus);
}

/** 政治點數庫存上限(避免無限囤積)= 每回合產出 × 此倍數。 */
export const POINTS_CAP_TURNS = 20;

export function pointsCap(perTurn: number): number {
  return Math.max(1, Math.floor(perTurn)) * POINTS_CAP_TURNS;
}

// ── 啟動條件檢查(純函式;前置關係由呼叫端查 DB 後傳入) ──────────────

export type StartBlockReason =
  | "already_completed"
  | "already_active"
  | "slot_busy"
  | "slot_limit"
  | "prereq_missing"
  | "excluded_by_completed"
  | "insufficient_points"
  | "policy_locked";

export interface StartCheckInput {
  focusId: string;
  cost: number;
  slot: FocusSlot;
  requires: readonly string[]; // 全部需已完成
  requiresAny?: readonly string[]; // 其中至少一項已完成(空陣列=不限制)
  excludes: readonly string[]; // 任一已完成/進行中則不可啟動(互斥分岔)
  completed: ReadonlySet<string>;
  active: ReadonlyMap<FocusSlot, string>; // slot → focusId
  points: number;
  /** 政變鎖定期間(coupPolicyLockTurns > 0)不可啟動國策 */
  coupPolicyLockTurns: number;
}

export function checkStartFocus(i: StartCheckInput): StartBlockReason | null {
  if (i.completed.has(i.focusId)) return "already_completed";
  for (const id of i.active.values()) if (id === i.focusId) return "already_active";
  if (i.coupPolicyLockTurns > 0) return "policy_locked";
  if (i.active.has(i.slot)) return "slot_busy";
  if (i.active.size >= MAX_ACTIVE_FOCUSES) return "slot_limit";
  if (i.requires.some((r) => !i.completed.has(r))) return "prereq_missing";
  if (
    i.requiresAny &&
    i.requiresAny.length > 0 &&
    !i.requiresAny.some((r) => i.completed.has(r))
  ) {
    return "prereq_missing";
  }
  const activeIds = new Set(i.active.values());
  if (i.excludes.some((e) => i.completed.has(e) || activeIds.has(e))) {
    return "excluded_by_completed";
  }
  if (i.points < i.cost) return "insufficient_points";
  return null;
}

export const START_BLOCK_TEXT: Record<StartBlockReason, string> = {
  already_completed: "此國策已完成",
  already_active: "此國策已在進行中",
  slot_busy: "該槽位已有進行中的國策",
  slot_limit: "進行中的國策已達上限",
  prereq_missing: "尚未滿足前置國策",
  excluded_by_completed: "已選擇互斥的另一條路線,此國策永久鎖定",
  insufficient_points: "政治點數不足",
  policy_locked: "政變後政策鎖定期間無法啟動國策",
};

// ── 黑紅線傾向值:被動增長與衰減(每回合,NPC 與玩家一視同仁)─────────────
// 目標節奏:長期不滿/軍國化要累積「數天到一週以上」(一天 8 回合)才摸到轉型門檻。

export interface PassiveLeanInput {
  satisfactionMilitary: number;
  atWar: boolean;
  /** 軍隊占人口百分比 */
  armyRatioPct: number;
  tier: "autocracy" | "semi" | "democracy";
  stability: number;
  politicalSupport: number;
  parliamentSatisfaction: number;
  blackLean: number;
  redLean: number;
}

/** 單回合期望變動量(小數,尚未進位),上下限 ±2。 */
export function passiveLeanRates(i: PassiveLeanInput): { black: number; red: number } {
  let bg = 0;
  if (i.satisfactionMilitary >= 60) bg += (i.satisfactionMilitary - 60) * 0.04;
  if (i.atWar) bg += 0.5;
  if (i.armyRatioPct >= 8) bg += 0.5;
  bg = Math.min(2, bg);
  let bd = 0;
  if (i.tier === "democracy") bd += 1.0;
  else if (i.tier === "semi") bd += 0.3;
  if (!i.atWar && i.satisfactionMilitary < 60 && i.blackLean > 0) bd += 0.3;

  let rg = 0;
  if (i.stability < 40) rg += (40 - i.stability) * 0.04;
  if (i.politicalSupport < 40) rg += (40 - i.politicalSupport) * 0.03;
  if (i.parliamentSatisfaction < 40) rg += (40 - i.parliamentSatisfaction) * 0.03;
  rg = Math.min(2, rg);
  let rd = 0;
  if (i.stability >= 60) rd += (i.stability - 50) * 0.03;
  if (i.stability >= 50 && i.redLean > 0) rd += 0.3;

  return { black: clamp(bg - bd, -2, 2), red: clamp(rg - rd, -2, 2) };
}

/**
 * 小數變動量 → 整數(欄位是整數):機率進位,期望值等於原值。
 * 例 +0.4 有 40% 機率 +1、60% 機率 0;-1.3 有 70% 機率 -1、30% 機率 -2。
 * rand 預設 Math.random,測試時可注入。
 */
export function stochasticRound(x: number, rand: () => number = Math.random): number {
  const base = Math.trunc(x);
  const frac = Math.abs(x - base);
  if (frac === 0) return base;
  return base + (rand() < frac ? Math.sign(x) : 0);
}

export function calculatePassiveLeanDeltas(
  i: PassiveLeanInput,
  rand: () => number = Math.random,
): { blackDelta: number; redDelta: number } {
  const r = passiveLeanRates(i);
  let blackDelta = stochasticRound(r.black, rand);
  let redDelta = stochasticRound(r.red, rand);
  // 不會把值推出 [0,100](SQL 也會夾,這裡讓回傳值如實反映)
  blackDelta = clamp(blackDelta, -i.blackLean, 100 - i.blackLean);
  redDelta = clamp(redDelta, -i.redLean, 100 - i.redLean);
  return { blackDelta: blackDelta + 0, redDelta: redDelta + 0 }; // +0 把 -0 正規化成 0
}
