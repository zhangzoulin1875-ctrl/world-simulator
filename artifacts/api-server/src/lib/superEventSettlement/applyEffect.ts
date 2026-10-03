import { eq, sql } from "drizzle-orm";
import {
  db,
  superEventNationImpactsTable,
  playerNationsTable,
  type SuperEventKind,
} from "@workspace/db";
import { applyRegionPopulationDelta } from "../regionPopulation";
import {
  computeExposureRatio,
  governmentResistanceFactor,
  responseFitFactor,
  computeDirectPopulationDelta,
  clampHarmfulDelta,
  DEFAULT_LOSS_BOUNDS,
  type SuperEventLossBounds,
} from "../superEventImpact";
import type { SuperEventEffect } from "../superEventAi";
import { ZERO_DELTAS, type AffectedNation, type AppliedDeltas } from "./types";

/**
 * 把本回合的 effect 套用到單一國家（人口／生產／滿意度／穩定度／暴動度），並回傳
 * 實際套用（夾限後）的整數變動。
 *
 * Task #356 — 差異化影響：齊頭數值（滿意度／穩定度／暴動度）乘上
 * 暴露比例 × 政體修正 × 應對契合度；生產本身已依受影響地區基準（scoped）
 * 反映暴露，只再乘政體與應對修正，避免重複折算。
 *
 * 人口例外——「直接扣除幾 %」：人口變動＝scopedPopBase × pct%，只乘管理員的
 * 明確倍率旋鈕 popMult（事件 impactPct × 全域倍率），不乘政體抗性／應對契合／
 * 階段嚴重度等差異化修正，也與人口增長率機制無關（見 computeDirectPopulationDelta）。
 *
 * 損失上下限（lossBounds）：所有「有害方向」的最終有效幅度（人口％／生產％／
 * 滿意度、安定度下降、暴動度上升）依管理員設定的上下限夾限——只在事件本就
 * 造成該項損失時生效（不無中生有）；上限 0 ＝ 取消所有負面影響；增益不受影響。
 */
export async function applyEffectToNation(
  nation: AffectedNation,
  effect: SuperEventEffect,
  mult: number,
  popMult: number,
  statsEra: string,
  scope: string,
  kind: SuperEventKind,
  fitScore: number | null,
  lossBounds: SuperEventLossBounds = DEFAULT_LOSS_BOUNDS,
): Promise<AppliedDeltas> {
  const exposure = computeExposureRatio(
    nation.scopedPopBase,
    nation.totalPopBase,
    scope,
  );
  const govF = governmentResistanceFactor(nation.government, kind);
  const fitF = responseFitFactor(fitScore, kind);
  const magFactor = mult * govF * fitF; // 生產（scoped 已含暴露）
  const flatFactor = magFactor * exposure; // 齊頭數值另乘暴露比例

  const applied = ZERO_DELTAS();

  const popDelta = computeDirectPopulationDelta(
    nation.scopedPopBase,
    effect.populationDeltaPct,
    popMult,
    lossBounds,
  );
  if (popDelta !== 0) {
    applied.populationDelta = await applyRegionPopulationDelta(
      db,
      nation.id,
      statsEra,
      popDelta,
      nation.scopedRegionIds,
    );
  }

  const prodPct = clampHarmfulDelta(
    effect.productivityDeltaPct * magFactor,
    -1,
    lossBounds,
  );
  const prodDelta = Math.round(nation.scopedProdBase * (prodPct / 100));
  const flatScale = (v: number, harmfulSign: 1 | -1 = -1) =>
    Math.round(clampHarmfulDelta(v * flatFactor, harmfulSign, lossBounds));
  const farmers = flatScale(effect.satisfactionFarmersDelta);
  const workers = flatScale(effect.satisfactionWorkersDelta);
  const nobles = flatScale(effect.satisfactionNoblesDelta);
  const clergy = flatScale(effect.satisfactionClergyDelta);
  const stability = flatScale(effect.stabilityDelta);
  const unrest = flatScale(effect.unrestDelta, 1); // 暴動度：上升＝有害

  const needsFlat =
    farmers !== 0 ||
    workers !== 0 ||
    nobles !== 0 ||
    clergy !== 0 ||
    stability !== 0 ||
    unrest !== 0;

  if (prodDelta === 0 && !needsFlat) return applied;

  // 讀取目前齊頭數值，於 JS 夾限，算出實際套用量後以明確值寫回。
  const [cur] = await db
    .select({
      satisfactionFarmers: playerNationsTable.satisfactionFarmers,
      satisfactionWorkers: playerNationsTable.satisfactionWorkers,
      satisfactionNobles: playerNationsTable.satisfactionNobles,
      satisfactionClergy: playerNationsTable.satisfactionClergy,
      stability: playerNationsTable.stability,
      unrest: playerNationsTable.unrest,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nation.id))
    .limit(1);
  if (!cur) return applied;

  const clampInt = (v: number) => Math.max(0, Math.min(100, v));
  const set: Record<string, unknown> = {};

  if (prodDelta !== 0) {
    set["productionBonus"] = sql`${playerNationsTable.productionBonus} + ${prodDelta}`;
    applied.productionDelta = prodDelta;
  }

  const applyClamped = (
    col: keyof AppliedDeltas,
    field:
      | "satisfactionFarmers"
      | "satisfactionWorkers"
      | "satisfactionNobles"
      | "satisfactionClergy"
      | "stability"
      | "unrest",
    delta: number,
  ) => {
    if (delta === 0) return;
    const oldVal = cur[field];
    const newVal = clampInt(oldVal + delta);
    if (newVal === oldVal) return;
    set[field] = newVal;
    applied[col] = newVal - oldVal;
  };

  applyClamped("satisfactionFarmersDelta", "satisfactionFarmers", farmers);
  applyClamped("satisfactionWorkersDelta", "satisfactionWorkers", workers);
  applyClamped("satisfactionNoblesDelta", "satisfactionNobles", nobles);
  applyClamped("satisfactionClergyDelta", "satisfactionClergy", clergy);
  applyClamped("stabilityDelta", "stability", stability);
  applyClamped("unrestDelta", "unrest", unrest);

  if (Object.keys(set).length > 0) {
    await db
      .update(playerNationsTable)
      .set(set)
      .where(eq(playerNationsTable.id, nation.id));
  }
  return applied;
}

/**
 * 把本回合套用的數值影響整理成一句 zh-TW 摘要（供時間軸顯示）。
 * 人口用 popMult（直接扣除幾 %，不乘階段等修正；未給時沿用 mult）。
 * 有帶 lossBounds 時，損失方向的顯示值同樣夾限（與實際套用一致）。
 */
export function buildEffectSummary(
  effect: SuperEventEffect,
  mult: number,
  popMult?: number,
  lossBounds?: SuperEventLossBounds,
): string {
  const bounds = lossBounds ?? DEFAULT_LOSS_BOUNDS;
  const parts: string[] = [];
  const pct = (
    v: number,
    label: string,
    m: number = mult,
    harmfulSign: 1 | -1 = -1,
  ) => {
    const scaled =
      Math.round(clampHarmfulDelta(v * m, harmfulSign, bounds) * 10) / 10;
    if (scaled !== 0) parts.push(`${label} ${scaled > 0 ? "+" : ""}${scaled}%`);
  };
  const pt = (v: number, label: string, harmfulSign: 1 | -1 = -1) => {
    const scaled = Math.round(clampHarmfulDelta(v * mult, harmfulSign, bounds));
    if (scaled !== 0) parts.push(`${label} ${scaled > 0 ? "+" : ""}${scaled}`);
  };
  pct(effect.populationDeltaPct, "人口", popMult ?? mult);
  pct(effect.productivityDeltaPct, "生產素質");
  pt(effect.satisfactionFarmersDelta, "農民滿意");
  pt(effect.satisfactionWorkersDelta, "工人滿意");
  pt(effect.satisfactionNoblesDelta, "貴族滿意");
  pt(effect.satisfactionClergyDelta, "教士滿意");
  pt(effect.stabilityDelta, "穩定度");
  pt(effect.unrestDelta, "暴動度", 1); // 暴動度：上升＝有害
  return parts.length > 0 ? parts.join("、") : "本回合無顯著數值變動";
}

/** 寫入每國本回合實際套用的影響紀錄（略過全 0 者以省列）。 */
export async function recordNationImpacts(
  eventId: string,
  turnNumber: number,
  impactByNation: Map<string, AppliedDeltas>,
): Promise<void> {
  const rows: (typeof superEventNationImpactsTable.$inferInsert)[] = [];
  for (const [nationId, d] of impactByNation) {
    const nonZero =
      d.populationDelta !== 0 ||
      d.productionDelta !== 0 ||
      d.satisfactionFarmersDelta !== 0 ||
      d.satisfactionWorkersDelta !== 0 ||
      d.satisfactionNoblesDelta !== 0 ||
      d.satisfactionClergyDelta !== 0 ||
      d.stabilityDelta !== 0 ||
      d.unrestDelta !== 0;
    if (!nonZero) continue;
    rows.push({
      eventId,
      nationId,
      turnNumber,
      populationDelta: d.populationDelta,
      productionDelta: d.productionDelta,
      satisfactionFarmersDelta: d.satisfactionFarmersDelta,
      satisfactionWorkersDelta: d.satisfactionWorkersDelta,
      satisfactionNoblesDelta: d.satisfactionNoblesDelta,
      satisfactionClergyDelta: d.satisfactionClergyDelta,
      stabilityDelta: d.stabilityDelta,
      unrestDelta: d.unrestDelta,
    });
  }
  if (rows.length === 0) return;
  await db.insert(superEventNationImpactsTable).values(rows);
}
