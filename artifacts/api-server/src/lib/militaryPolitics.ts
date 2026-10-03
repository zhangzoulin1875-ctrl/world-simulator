import { clampPct } from "./politics";

/**
 * Task #402 — 軍方面向的純函式（占人口比、越權/暴動機率、逃兵比例、
 * 軍事政變條件、初始士氣推導、維護費缺口懲罰、和平回升）。
 * 鐵則：逃兵/暴動的數量與機率全部由伺服器端純函式決定，AI 只提供敘事。
 * 與 DB / Express / AI 無耦合，方便單元測試。
 */

// ── 常數（設計參數；如需管理端可調再搬進 politicsSettings） ──

/** 軍隊占人口比的越權門檻（%）：超過才可能觸發軍隊越權/暴動。 */
export const MILITARY_OVERREACH_THRESHOLD_PCT = 10;
/** 越權機率：每超出門檻 1 個百分點 +8% 機率。 */
export const OVERREACH_CHANCE_PER_PCT = 8;
/** 越權機率上限（%）。 */
export const OVERREACH_CHANCE_MAX_PCT = 80;
/** 越權事件效果：各項滿意度 −5、暴動度 +10。 */
export const OVERREACH_SATISFACTION_PENALTY = 5;
export const OVERREACH_UNREST_INCREASE = 10;
/** 低軍方滿意/服從門檻：兩者皆低於此值才可能逃兵/政變。 */
export const MILITARY_LOW_THRESHOLD = 30;
/** 軍事政變門檻：滿意度與服從度皆低於此值時，事件升級為政變。 */
export const MILITARY_COUP_THRESHOLD = 15;
/** 逃兵/政變事件機率上限（%）。 */
export const MILITARY_UNREST_CHANCE_MAX_PCT = 60;
/** 逃兵比例範圍（%，占各兵種現役數量）。 */
export const DESERTION_RATIO_MIN_PCT = 5;
export const DESERTION_RATIO_MAX_PCT = 20;
/** 維護費缺口的軍方滿意度懲罰範圍。 */
export const UPKEEP_PENALTY_MIN = 5;
export const UPKEEP_PENALTY_MAX = 15;
/** 和平且無軍方事件時，兩數值每回合回升量。 */
export const MILITARY_RECOVERY_DELTA = 2;

// ── 純函式 ─────────────────────────────────────────────

/**
 * 軍隊占人口比（%）＝（現役＋前線＋傷兵）÷ 即時計算人口 × 100。
 * 人口 ≤ 0 且有軍隊 → 視為 100%；無軍隊 → 0。不在此捨入（顯示時才捨入）。
 */
export function armyPopulationRatioPct(
  armyPopulation: number,
  population: number,
): number {
  if (armyPopulation <= 0) return 0;
  if (population <= 0) return 100;
  return (armyPopulation / population) * 100;
}

/**
 * 軍隊越權/暴動機率（%）：占比 ≤ 門檻 → 0；超出後每 1 個百分點 +8%，
 * 上限 80%。
 */
export function overreachChancePct(ratioPct: number): number {
  const excess = ratioPct - MILITARY_OVERREACH_THRESHOLD_PCT;
  if (excess <= 0) return 0;
  return Math.min(OVERREACH_CHANCE_MAX_PCT, excess * OVERREACH_CHANCE_PER_PCT);
}

/**
 * 逃兵/政變事件機率（%）：軍方滿意度與服從度皆 < 30 才可能觸發，
 * 機率 = (30 − 滿意度) + (30 − 服從度)，上限 60%。
 */
export function militaryUnrestChancePct(
  satisfaction: number,
  obedience: number,
): number {
  if (
    satisfaction >= MILITARY_LOW_THRESHOLD ||
    obedience >= MILITARY_LOW_THRESHOLD
  ) {
    return 0;
  }
  const raw =
    MILITARY_LOW_THRESHOLD -
    satisfaction +
    (MILITARY_LOW_THRESHOLD - obedience);
  return Math.min(MILITARY_UNREST_CHANCE_MAX_PCT, Math.max(0, raw));
}

/** 事件是否升級為軍事政變：滿意度與服從度皆 < 15。否則為逃兵。 */
export function isMilitaryCoup(satisfaction: number, obedience: number): boolean {
  return (
    satisfaction < MILITARY_COUP_THRESHOLD && obedience < MILITARY_COUP_THRESHOLD
  );
}

/**
 * 逃兵比例（%）：兩數值越低逃兵越多。以較低者計算：
 * ratio = 5 + (30 − min(滿意度, 服從度)) / 2，夾 5–20，取整。
 */
export function desertionRatioPct(
  satisfaction: number,
  obedience: number,
): number {
  const low = Math.min(satisfaction, obedience);
  const raw =
    DESERTION_RATIO_MIN_PCT + (MILITARY_LOW_THRESHOLD - low) / 2;
  return Math.round(
    Math.min(DESERTION_RATIO_MAX_PCT, Math.max(DESERTION_RATIO_MIN_PCT, raw)),
  );
}

/** 單一兵種的逃兵數量 = floor(數量 × 比例%)；數量 ≤ 0 → 0。 */
export function desertionAmount(quantity: number, ratioPct: number): number {
  if (quantity <= 0 || ratioPct <= 0) return 0;
  return Math.floor((quantity * ratioPct) / 100);
}

/**
 * 新建軍團初始士氣 = 軍方服從度（取代固定 80；服從度 40 → 初始士氣 40）。
 * 夾 0–100 取整。僅適用真人玩家；NPC 維持 80。
 */
export function legionInitialMorale(obedience: number): number {
  return clampPct(Math.round(obedience));
}

/**
 * 維護費缺口的軍方滿意度懲罰：缺口占維護費比例越大懲罰越重，
 * penalty = 5 + floor(10 × 缺口/維護費)，夾 5–15。缺口 ≤ 0 → 0。
 */
export function upkeepShortfallMilitaryPenalty(
  shortfall: number,
  upkeepCharged: number,
): number {
  if (shortfall <= 0) return 0;
  const frac = upkeepCharged > 0 ? Math.min(1, shortfall / upkeepCharged) : 1;
  return Math.min(
    UPKEEP_PENALTY_MAX,
    UPKEEP_PENALTY_MIN + Math.floor(10 * frac),
  );
}

/** 風險等級（UI 提示用）。 */
export type MilitaryRiskLevel = "low" | "medium" | "high";

/**
 * 軍方風險等級：占比超門檻或可能逃兵/政變 → high；接近門檻（>7%）或
 * 任一數值 < 40 → medium；其餘 low。
 */
export function militaryRiskLevel(
  ratioPct: number,
  satisfaction: number,
  obedience: number,
): MilitaryRiskLevel {
  if (
    overreachChancePct(ratioPct) > 0 ||
    militaryUnrestChancePct(satisfaction, obedience) > 0
  ) {
    return "high";
  }
  if (
    ratioPct > MILITARY_OVERREACH_THRESHOLD_PCT * 0.7 ||
    satisfaction < 40 ||
    obedience < 40
  ) {
    return "medium";
  }
  return "low";
}

export const MILITARY_RISK_LABELS: Record<MilitaryRiskLevel, string> = {
  low: "低風險",
  medium: "中度風險",
  high: "高風險",
};
