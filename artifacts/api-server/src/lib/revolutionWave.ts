/**
 * 「革命浪潮」超事件(2026-10-06)。
 *
 * 一則革命浪潮事件會波及一批地區。每個受波及地區各自累積「革命壓力」(0~100):
 *   - 每回合依事件嚴重度與階段、該國穩定度/暴動度上升;
 *   - 玩家有提交應對且判定契合,就降低壓力(鎮壓、安撫、改革都算,看 AI 判定契合度);
 *   - 壓力達 100 的地區「脫離」(爆發革命),交給內戰引擎處理。
 *
 * 純函式、DB-free,所有旋鈕集中在這裡,方便單測與調整。
 */

export const REVOLUTION_CATEGORY = "革命浪潮";

/** 壓力上下限;達 REVOLT_AT 即爆發。 */
export const PRESSURE_MIN = 0;
export const PRESSURE_MAX = 100;
export const REVOLT_AT = 100;
/** 剛被波及的地區起始壓力(讓玩家有幾回合反應時間,不會一開場就爆)。 */
export const PRESSURE_START = 20;

/** 各階段對壓力的基礎推力(每回合,未乘嚴重度):消退期會自然回落。 */
const STAGE_PUSH: Record<string, number> = {
  outbreak: 6,
  spreading: 9,
  peak: 12,
  receding: -6,
  ended: 0,
};

export function clampPressure(v: number): number {
  if (!Number.isFinite(v)) return PRESSURE_MIN;
  return Math.max(PRESSURE_MIN, Math.min(PRESSURE_MAX, Math.round(v * 100) / 100));
}

/**
 * 該國的「不滿加成」:穩定度越低、暴動度越高,壓力漲得越快。
 * 穩定度 50、暴動度 0 為中性(加成 0);範圍夾在 -3 ~ +8。
 */
export function discontentBonus(stability: number, unrest: number): number {
  const s = Number.isFinite(stability) ? stability : 50;
  const u = Number.isFinite(unrest) ? unrest : 0;
  const v = (50 - s) * 0.12 + u * 0.08;
  return Math.max(-3, Math.min(8, Math.round(v * 100) / 100));
}

/**
 * 玩家應對對壓力的減免(每回合):契合度 fit(0~100)。
 *   fit < 30 視為無效(0);之後線性成長,滿分 -18(高峰期推力 12,契合 ≥ ~75 才壓得住;中等契合只能減緩)。
 * 沒有提交應對(fit = null/undefined)= 0 減免。
 */
export function responseRelief(fit: number | null | undefined): number {
  if (fit === null || fit === undefined || !Number.isFinite(fit)) return 0;
  if (fit < 30) return 0;
  return Math.round(((fit - 30) / 70) * 18 * 100) / 100;
}

export interface PressureStepInput {
  pressure: number;
  stage: string;
  /** 事件嚴重度 1~100。 */
  severity: number;
  /** 事件影響程度倍率 × 全域倍率(皆為 % 換算後的乘數,1 = 100%)。 */
  impactMult: number;
  stability: number;
  unrest: number;
  /** 本回合該國的應對契合度;沒有應對為 null。 */
  fit: number | null;
}

/** 單一地區單一回合的壓力更新(回傳新壓力,已夾在 0~100)。 */
export function nextPressure(i: PressureStepInput): number {
  const push = STAGE_PUSH[i.stage] ?? 0;
  const sev = Math.max(1, Math.min(100, i.severity)) / 50; // 50 = 1.0x
  const mult = Number.isFinite(i.impactMult) && i.impactMult > 0 ? i.impactMult : 1;
  // 消退期的回落不乘嚴重度(否則嚴重事件反而退得更快);其餘乘嚴重度與影響倍率。
  const stagePart = push >= 0 ? push * sev * mult : push;
  const bonus = push > 0 ? discontentBonus(i.stability, i.unrest) : 0;
  const delta = stagePart + bonus - responseRelief(i.fit);
  return clampPressure(i.pressure + delta);
}

/** 哪些地區已到爆發線。 */
export function regionsReadyToRevolt(
  pressures: readonly { regionId: number; pressure: number }[],
): number[] {
  return pressures.filter((p) => p.pressure >= REVOLT_AT).map((p) => p.regionId);
}

// ── 專屬觸發:各國不滿 → 額外誕生革命浪潮 ────────────────────────────────

/**
 * 國內條件夠糟時,每回合誕生革命浪潮的機率(%)。
 * 穩定度 >= 40 且暴動度 <= 20 完全不觸發;越糟機率越高,上限 12%。
 */
export function spawnChancePct(stability: number, unrest: number): number {
  const s = Number.isFinite(stability) ? stability : 50;
  const u = Number.isFinite(unrest) ? unrest : 0;
  if (s >= 40 && u <= 20) return 0;
  const raw = Math.max(0, 40 - s) * 0.25 + Math.max(0, u - 20) * 0.1;
  return Math.max(0, Math.min(12, Math.round(raw * 100) / 100));
}

/** 同一國同時只允許一則進行中的革命浪潮(避免連環疊加);冷卻回合數。 */
export const SPAWN_COOLDOWN_TURNS = 16;
