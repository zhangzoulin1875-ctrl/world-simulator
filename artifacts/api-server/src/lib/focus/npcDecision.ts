import type { FocusDef } from "./types";
import { firstFailedCondition, type ConditionFacts } from "./conditions";

/**
 * NPC 國策決策(2026-10-05 定案):NPC 偏向走穩定路線,黑/紅線奪權機率較低。
 *
 * 純邏輯,不碰資料庫:輸入「候選轉型國策 + 國家事實」,輸出要不要動、動哪一條。
 * 真正的啟動、扣點與條件驗證一律交給 startFocus(NPC 和玩家走同一套規則)。
 */

/** 每個 NPC 每回合「考慮要不要推動轉型」的機率。多數回合什麼都不做,也避免同回合齊發。 */
export const NPC_DECISION_CHANCE = 0.06;

/** 各路線的抽選權重:穩定/改革為主,黑紅線低,革命(開內戰)最低。 */
export const NPC_TRACK_WEIGHT: Readonly<Record<string, number>> = {
  stable: 10,
  reform: 10,
  black: 2,
  red: 2,
};
/** 革命邊(人民奪權,代價最高)的權重,覆蓋路線權重。 */
export const NPC_REVOLUTION_WEIGHT = 1;

/** 同時進行中的 NPC 奪權事件(黑/紅線轉型國策 + 內戰)上限 = max(1, NPC 總數 × 此比例)。 */
export const NPC_RADICAL_CAP_RATIO = 0.05;

export function npcRadicalCap(npcCount: number): number {
  return Math.max(1, Math.floor(npcCount * NPC_RADICAL_CAP_RATIO));
}

/** 這個國策算不算「奪權線」:黑/紅線或革命。受全域上限管。 */
export function isRadicalFocus(def: Pick<FocusDef, "track" | "id">, isRevolution: boolean): boolean {
  return isRevolution || def.track === "black" || def.track === "red";
}

export interface NpcCandidate {
  def: FocusDef;
  isRevolution: boolean;
}

export interface NpcDecisionInput {
  candidates: readonly NpcCandidate[];
  points: number;
  facts: ConditionFacts;
  /** 目前全域進行中的 NPC 奪權事件數(黑/紅線轉型國策 + NPC 內戰)。 */
  radicalInFlight: number;
  radicalCap: number;
  /** 該 NPC 是否正處於內戰(是的話不發動任何轉型)。 */
  inCivilWar: boolean;
  /** 該 NPC 是否已有進行中的轉型國策。 */
  hasActiveRegimeFocus: boolean;
  rand: () => number;
}

export function weightOf(c: NpcCandidate): number {
  if (c.isRevolution) return NPC_REVOLUTION_WEIGHT;
  return NPC_TRACK_WEIGHT[c.def.track] ?? 1;
}

/** 預篩:點數夠、條件全過、(若是奪權線)全域上限還有空位。 */
export function eligibleCandidates(i: NpcDecisionInput): NpcCandidate[] {
  return i.candidates.filter((c) => {
    if (c.def.cost > i.points) return false;
    if (firstFailedCondition(c.def.conditions, i.facts)) return false;
    if (isRadicalFocus(c.def, c.isRevolution) && i.radicalInFlight >= i.radicalCap) return false;
    return true;
  });
}

/**
 * 決定這個 NPC 這回合要推動哪條轉型國策;回傳 null = 維持現狀。
 * 擲骰順序固定(先問要不要考慮,再抽候選),方便用注入的 rand 做確定性測試。
 */
export function decideNpcFocus(i: NpcDecisionInput): FocusDef | null {
  if (i.inCivilWar || i.hasActiveRegimeFocus) return null;
  if (i.rand() >= NPC_DECISION_CHANCE) return null;
  const pool = eligibleCandidates(i);
  if (pool.length === 0) return null;
  const total = pool.reduce((s, c) => s + weightOf(c), 0);
  let r = i.rand() * total;
  for (const c of pool) {
    r -= weightOf(c);
    if (r < 0) return c.def;
  }
  return pool[pool.length - 1]!.def;
}
