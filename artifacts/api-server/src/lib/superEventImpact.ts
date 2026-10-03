import type { SuperEventKind, SuperEventStage } from "@workspace/db";
import { governmentDecisionDifficulty } from "./governments";
import type { SuperEventEffect } from "./superEventAi";

/**
 * Task #356 — 超事件「差異化影響／分階段演變／傳染擴散」的純函式。
 *
 * 這裡只放無副作用、可單元測試的計算；不 import ../index、不碰 DB。與既有原則
 * 一致：AI 只給敘事與幅度，這些純函式決定伺服器如何依「暴露程度／政體／應對／
 * 階段」把幅度差異化，實際套用與夾限仍由 superEventSettlement 負責。
 */

export interface StageDef {
  slug: SuperEventStage;
  label: string;
  /** 該階段的嚴重度倍率（乘上事件的整體 mult）。 */
  severityFactor: number;
  /** 該階段的蔓延力度倍率（消退／落幕為 0＝停止擴散）。 */
  spreadFactor: number;
  order: number;
}

/** 階段：爆發→擴散→高峰→消退→落幕。 */
export const STAGES: readonly StageDef[] = [
  { slug: "outbreak", label: "爆發", severityFactor: 0.8, spreadFactor: 0.5, order: 0 },
  { slug: "spreading", label: "擴散", severityFactor: 1.0, spreadFactor: 1.0, order: 1 },
  { slug: "peak", label: "高峰", severityFactor: 1.3, spreadFactor: 0.8, order: 2 },
  { slug: "receding", label: "消退", severityFactor: 0.6, spreadFactor: 0, order: 3 },
  { slug: "ended", label: "落幕", severityFactor: 0.2, spreadFactor: 0, order: 4 },
];

const STAGE_BY_SLUG = new Map(STAGES.map((s) => [s.slug, s]));

export function isSuperEventStage(v: string): v is SuperEventStage {
  return STAGE_BY_SLUG.has(v as SuperEventStage);
}

export function stageDef(stage: string): StageDef {
  return STAGE_BY_SLUG.get(stage as SuperEventStage) ?? STAGES[0]!;
}

export function stageLabel(stage: string): string {
  return stageDef(stage).label;
}

/** 階段嚴重度倍率（乘上事件整體 mult）。 */
export function stageSeverityFactor(stage: string): number {
  return stageDef(stage).severityFactor;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/**
 * 政體修正：集權政體（低決策難度）動員快、對災難抗性高（幅度較小）；開放政體
 * （高決策難度）較能把握機會（機會幅度較大）。輸入為政體 label 或 slug。
 */
export function governmentResistanceFactor(
  governmentLabelOrSlug: string | null,
  kind: SuperEventKind,
): number {
  const d = governmentDecisionDifficulty(governmentLabelOrSlug); // 0–100
  if (kind === "opportunity") {
    // 開放社會較能把握機會：0.85–1.25。
    return round2(0.85 + (d / 100) * 0.4);
  }
  // 災難：集權政體抗性高（幅度小）：0.8–1.3。
  return round2(0.8 + (d / 100) * 0.5);
}

/**
 * 應對契合度修正：得當（高 fitScore）緩解災難／放大機會；不當（低 fitScore）反之。
 * 無應對（null）回 1。此為對「本回合基礎影響」的差異化，與應對本身「額外」帶來
 * 的 effect（judgeSuperEventResponse）分開，不重複計算。
 */
export function responseFitFactor(
  fitScore: number | null,
  kind: SuperEventKind,
): number {
  if (fitScore === null || !Number.isFinite(fitScore)) return 1;
  const centered = (clamp(fitScore, 0, 100) - 50) / 50; // -1..1
  if (kind === "opportunity") {
    return round2(clamp(1 + centered * 0.4, 0.6, 1.4));
  }
  // 災難：高契合＝幅度小（緩解）；低契合＝幅度大（惡化）。
  return round2(clamp(1 - centered * 0.4, 0.6, 1.4));
}

/**
 * 暴露比例：僅 regional 事件依「受影響地區人口占全國比例」縮放齊頭欄位（滿意度／
 * 穩定度／暴動度）。global／targeted 視為整國暴露（回 1）。
 */
export function computeExposureRatio(
  scopedPopBase: number,
  totalPopBase: number,
  scope: string,
): number {
  if (scope !== "regional") return 1;
  if (totalPopBase <= 0) return 1;
  return round2(clamp(scopedPopBase / totalPopBase, 0, 1));
}

/** 蔓延機率（0..1）：依嚴重度與階段。消退／落幕為 0。 */
export function contagionSpreadChance(
  severity: number,
  stage: string,
): number {
  const base = clamp(severity / 100, 0, 1) * 0.4; // 最多 0.4
  return round2(clamp(base * stageDef(stage).spreadFactor, 0, 1));
}

/* ------------------------------------------------------------------ *
 * 目標數據（管理員指定要打擊／提升的數據欄位）
 * ------------------------------------------------------------------ */

/** 目標數據 key → effect 欄位與 zh-TW 標籤（順序即 UI 顯示順序）。 */
export const SUPER_EVENT_TARGET_STATS = [
  { key: "population", effectField: "populationDeltaPct", label: "人口" },
  { key: "production", effectField: "productivityDeltaPct", label: "生產素質" },
  { key: "satisfactionFarmers", effectField: "satisfactionFarmersDelta", label: "農民滿意度" },
  { key: "satisfactionWorkers", effectField: "satisfactionWorkersDelta", label: "工人滿意度" },
  { key: "satisfactionNobles", effectField: "satisfactionNoblesDelta", label: "貴族(資本家)滿意度" },
  { key: "satisfactionClergy", effectField: "satisfactionClergyDelta", label: "教士滿意度" },
  { key: "stability", effectField: "stabilityDelta", label: "安定度" },
  { key: "unrest", effectField: "unrestDelta", label: "動亂度" },
] as const;

export type SuperEventTargetStat =
  (typeof SUPER_EVENT_TARGET_STATS)[number]["key"];

const TARGET_STAT_BY_KEY = new Map(
  SUPER_EVENT_TARGET_STATS.map((s) => [s.key as string, s]),
);

export function isSuperEventTargetStat(v: string): v is SuperEventTargetStat {
  return TARGET_STAT_BY_KEY.has(v);
}

/** 目標數據的 zh-TW 標籤（未知 key 原樣返回，僅供顯示）。 */
export function targetStatLabel(key: string): string {
  return TARGET_STAT_BY_KEY.get(key)?.label ?? key;
}

/**
 * 依管理員指定的目標數據，把 effect 中「非目標」欄位強制歸零（雙重防護：
 * 提示詞已要求 AI 只動目標欄位，這裡再由伺服器硬性保證）。
 * targetStats null／空／全為未知 key 時視為不限，原樣返回。
 */
export function restrictEffectToTargetStats(
  effect: SuperEventEffect,
  targetStats: readonly string[] | null | undefined,
): SuperEventEffect {
  const valid = (targetStats ?? []).filter(isSuperEventTargetStat);
  if (valid.length === 0) return effect;
  const allowed = new Set<string>(
    valid.map((k) => TARGET_STAT_BY_KEY.get(k)!.effectField),
  );
  const restricted = { ...effect };
  for (const s of SUPER_EVENT_TARGET_STATS) {
    if (!allowed.has(s.effectField)) {
      restricted[s.effectField] = 0;
    }
  }
  return restricted;
}

/**
 * 產生給 AI 提示詞的目標數據限制段（無指定時回空字串）。列出允許欄位並要求
 * 其餘一律填 0；方向仍依事件屬性（災難＝打擊、機會＝提升）。
 */
export function buildTargetStatsGuidance(
  targetStats: readonly string[] | null | undefined,
): string {
  const valid = (targetStats ?? []).filter(isSuperEventTargetStat);
  if (valid.length === 0) return "";
  const fields = valid
    .map((k) => {
      const s = TARGET_STAT_BY_KEY.get(k)!;
      return `${s.effectField}（${s.label}）`;
    })
    .join("、");
  return `【目標數據限制】本事件僅影響以下數據欄位：${fields}；effect 其餘欄位一律填 0（伺服器會強制歸零）。敘事與影響聚焦這些面向。`;
}

/* ------------------------------------------------------------------ *
 * 損失上下限（管理員旋鈕）——每回合負面影響的最低／最高幅度
 * ------------------------------------------------------------------ */

/**
 * 每回合負面影響（損失）的上下限（0–100）。百分比類（人口％／生產素質％）與
 * 點數類（滿意度／安定度／暴動度，0–100 量表）共用同一組界限：點數視同百分點。
 */
export interface SuperEventLossBounds {
  minPct: number;
  maxPct: number;
}

/** 預設＝不設限（下限 0、上限 100），維持既有行為。 */
export const DEFAULT_LOSS_BOUNDS: SuperEventLossBounds = {
  minPct: 0,
  maxPct: 100,
};

/** 正規化管理員輸入：各夾 0–100 取整；下限大於上限時以上限為準。 */
export function normalizeLossBounds(
  minPct: number,
  maxPct: number,
): SuperEventLossBounds {
  const max = Math.round(clamp(Number.isFinite(maxPct) ? maxPct : 100, 0, 100));
  const min = Math.round(clamp(Number.isFinite(minPct) ? minPct : 0, 0, 100));
  return { minPct: Math.min(min, max), maxPct: max };
}

/**
 * 夾限「有害方向」的變動值。有害方向＝人口％／生產％／滿意度／安定度的負值
 * （harmfulSign = -1），或暴動度的正值（harmfulSign = 1）。
 *
 * 只在事件本就造成該項損失時夾限（value 為 0 或有利方向原樣返回，絕不無中
 * 生有）；上限 0 ＝ 取消所有損失。有利方向（機會事件的增益）不受影響。
 */
export function clampHarmfulDelta(
  value: number,
  harmfulSign: 1 | -1,
  bounds: SuperEventLossBounds,
): number {
  if (!Number.isFinite(value) || value === 0) return value;
  const harmful = harmfulSign === 1 ? value > 0 : value < 0;
  if (!harmful) return value;
  const magnitude = clamp(Math.abs(value), bounds.minPct, bounds.maxPct);
  return harmfulSign === 1 ? magnitude : -magnitude;
}

/**
 * 超事件人口變動＝「直接增減幾 % 的人口」：scopedPopBase × pct%，只乘管理員的
 * 明確倍率旋鈕 popMult（事件 impactPct × 全域倍率；預設皆 100% ＝原值直套），
 * 不乘政體抗性／應對契合／階段嚴重度等差異化修正，也與人口增長率機制無關。
 * 有帶 bounds 時，人口「損失」的有效 % 依管理員上下限夾限（增益不受影響）。
 */
export function computeDirectPopulationDelta(
  scopedPopBase: number,
  populationDeltaPct: number,
  popMult: number,
  bounds?: SuperEventLossBounds,
): number {
  if (!Number.isFinite(scopedPopBase) || scopedPopBase <= 0) return 0;
  if (!Number.isFinite(populationDeltaPct) || populationDeltaPct === 0)
    return 0;
  const mult = Number.isFinite(popMult) ? Math.max(0, popMult) : 1;
  let effectivePct = populationDeltaPct * mult;
  if (bounds) effectivePct = clampHarmfulDelta(effectivePct, -1, bounds);
  const delta = Math.round(scopedPopBase * (effectivePct / 100));
  return delta === 0 ? 0 : delta; // 正規化 -0 → 0
}

/**
 * 選出本回合要新納入的相鄰地區（純函式，rng 可注入以利測試）。候選 = 現有地區
 * 的相鄰地區中尚未納入者；每個候選以 spreadChance 擲骰。回傳去重後的新地區 id。
 */
export function selectContagionTargets(params: {
  currentRegionIds: readonly number[];
  adjacency: ReadonlyMap<number, readonly number[]>;
  spreadChance: number;
  rng?: () => number;
}): number[] {
  const { currentRegionIds, adjacency, spreadChance } = params;
  const rng = params.rng ?? Math.random;
  if (spreadChance <= 0) return [];
  const current = new Set(currentRegionIds);
  const candidates = new Set<number>();
  for (const rid of currentRegionIds) {
    for (const nb of adjacency.get(rid) ?? []) {
      if (!current.has(nb)) candidates.add(nb);
    }
  }
  const added: number[] = [];
  for (const c of candidates) {
    if (rng() < spreadChance) added.push(c);
  }
  return added;
}
