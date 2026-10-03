import { z } from "zod";
import type { CabinetStyle } from "@workspace/db";
import type { AgencyLevel } from "../types";
import { normalizeStyle, styleBand } from "../style";
import { isTreatyType, type TreatyType } from "../../diplomacy";

/**
 * Task #245 — 外交官代理的純函式（無 DB／IO／AI 相依，供單元測試）。
 *
 * 抽到獨立檔案的原因：`domains/diplomacy.ts` 會 import `../index`（proposeApproval），
 * 而 `../index` 又經由 registry 反向 import `diplomacyModule`，形成模組循環。
 * 測試若直接 import `domains/diplomacy` 會在初始化前存取 `diplomacyModule` 而丟
 * ReferenceError。此檔只相依 zod／型別／style／基礎 diplomacy 純函式，可安全單測。
 */

// ── 純函式：代理程度 × 風格 → 動作上限與讓步門檻 ──────────────

/**
 * 每回合動作強度（1～3）：代理程度為基準，越權傾向高 +1、膽小程度高 −1，夾在 1～3。
 */
export function diplomatIntensity(
  agencyLevel: AgencyLevel,
  style: CabinetStyle,
): number {
  const s = normalizeStyle(style);
  const base =
    agencyLevel === "aggressive" ? 3 : agencyLevel === "conservative" ? 1 : 2;
  const adj =
    (styleBand(s.overreach) === "高" ? 1 : 0) -
    (styleBand(s.timidity) === "高" ? 1 : 0);
  return Math.max(1, Math.min(3, base + adj));
}

/** 每回合可執行的動作總數上限（= 強度）。 */
export function diplomatActionBudget(
  agencyLevel: AgencyLevel,
  style: CabinetStyle,
): number {
  return diplomatIntensity(agencyLevel, style);
}

/**
 * 「可自動讓步」占目前持有量的比例：代理程度為基準，越權傾向拉高、膽小程度壓低。
 * 夾在 1%～50%。超過此比例的金錢／科技讓步視為「大額」，需玩家批准。
 */
export function concessionAutonomyFraction(
  agencyLevel: AgencyLevel,
  style: CabinetStyle,
): number {
  const s = normalizeStyle(style);
  const base =
    agencyLevel === "aggressive"
      ? 0.25
      : agencyLevel === "conservative"
        ? 0.05
        : 0.12;
  const overreachAdj = (s.overreach / 100) * 0.15;
  const timidityAdj = (s.timidity / 100) * 0.15;
  const f = base + overreachAdj - timidityAdj;
  return Math.min(0.5, Math.max(0.01, f));
}

export interface ConcessionThresholds {
  /** 可自動附帶的金錢上限（含）。 */
  maxAutoMoney: number;
  /** 可自動附帶的科技點數上限（含）。 */
  maxAutoTech: number;
}

/** 依目前持有量與代理程度／風格算出可自動附帶的金錢／科技上限。 */
export function concessionThresholds(
  money: number,
  techPoints: number,
  agencyLevel: AgencyLevel,
  style: CabinetStyle,
): ConcessionThresholds {
  const f = concessionAutonomyFraction(agencyLevel, style);
  return {
    maxAutoMoney: Math.floor(Math.max(0, money) * f),
    maxAutoTech: Math.floor(Math.max(0, techPoints) * f),
  };
}

/**
 * 條約讓步是否屬「大額」（需玩家批准）：金錢或科技超過門檻、或包含割地一律為大額。
 */
export function isMajorConcession(
  terms: {
    offerMoney: number;
    offerTechPoints: number;
    offerRegionIds: number[];
  },
  thresholds: ConcessionThresholds,
): boolean {
  if (terms.offerRegionIds.length > 0) return true; // 割地一律需批准
  if (terms.offerMoney > thresholds.maxAutoMoney) return true;
  if (terms.offerTechPoints > thresholds.maxAutoTech) return true;
  return false;
}

// ── AI 規劃輸出（zod 驗證） ────────────────────────────────────

const diplomatActionSchema = z.object({
  targetId: z.string().min(1),
  kind: z.enum(["chat", "treaty", "war"]),
  /** kind=chat 時的外交訊息（我方主動送出的一句話）。 */
  message: z.string().nullish(),
  /** kind=treaty 時的條約類型 slug；sanitize 以 isTreatyType 嚴格驗證。 */
  treatyType: z.string().nullish(),
  durationDays: z.number().int().min(1).max(3650).nullish(),
  offerMoney: z.number().int().min(0).nullish(),
  offerTechPoints: z.number().int().min(0).nullish(),
  /** 一句話理由（用於待批准摘要與紀錄）。 */
  reason: z.string().nullish(),
});

const diplomatPlanSchema = z.object({
  actions: z.array(diplomatActionSchema).max(20),
});

export type RawDiplomatAction = z.infer<typeof diplomatActionSchema>;

/**
 * 純函式：從 AI 原始文字抽出並驗證行動清單（去 code fence → JSON → zod）。
 * 失敗丟例外，交呼叫端記錄並略過本回合（絕不寫入半套資料）。
 */
export function extractDiplomatActions(raw: string): RawDiplomatAction[] {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const parsed: unknown = JSON.parse(cleaned);
  return diplomatPlanSchema.parse(parsed).actions;
}

// ── 純函式：把 AI 清單過濾成可安全執行的計畫 ─────────────────

export interface PlannedDiplomatAction {
  targetId: string;
  kind: "chat" | "treaty" | "war";
  message: string | null;
  treatyType: TreatyType | null;
  durationDays: number | null;
  offerMoney: number;
  offerTechPoints: number;
  reason: string | null;
}

export interface SanitizeDiplomatContext {
  /** 可行動對象：NPC id（is_npc=true）。絕不含真人玩家／無主國家。 */
  npcTargetIds: ReadonlySet<string>;
  /** 已授權的 actionKeys。 */
  enabledActionKeys: ReadonlySet<string>;
  /** 已有 proposed 提案的對象（略過重複締約）。 */
  pendingTargetIds: ReadonlySet<string>;
  /** 交戰中的對象（略過重複締約；宣戰對象須未交戰）。 */
  atWarTargetIds: ReadonlySet<string>;
  /** 每對象目前關係值（宣戰須 < 0）。 */
  relationScores: ReadonlyMap<string, number>;
  /** 每回合動作總數上限。 */
  budget: number;
}

/**
 * 純函式：套用安全閘門與上限，回傳可執行計畫。
 * - 對象必須是 NPC（never 真人玩家）；每對象每回合至多一項；依 budget 截斷。
 * - chat：需 chat 授權且有訊息文字。
 * - treaty：需 propose_treaty 授權；對象未交戰、無進行中提案；治具 send_gift 未授權時
 *   一律清零附帶讓步（不送禮）。
 * - war：需 declare_war 授權、對象關係 < 0 且未交戰；一律標記為需批准（呼叫端不自動執行）。
 */
export function sanitizeDiplomatActions(
  raw: readonly RawDiplomatAction[],
  ctx: SanitizeDiplomatContext,
): PlannedDiplomatAction[] {
  const planned: PlannedDiplomatAction[] = [];
  const usedTargets = new Set<string>();
  const canGift = ctx.enabledActionKeys.has("send_gift");

  for (const a of raw) {
    if (planned.length >= ctx.budget) break;
    const targetId = a.targetId;
    if (!ctx.npcTargetIds.has(targetId)) continue; // 只對 NPC，且排除自己
    if (usedTargets.has(targetId)) continue;

    if (a.kind === "chat") {
      if (!ctx.enabledActionKeys.has("chat")) continue;
      const message = typeof a.message === "string" ? a.message.trim() : "";
      if (message === "") continue;
      usedTargets.add(targetId);
      planned.push({
        targetId,
        kind: "chat",
        message: message.slice(0, 2000),
        treatyType: null,
        durationDays: null,
        offerMoney: 0,
        offerTechPoints: 0,
        reason: a.reason?.trim() ?? null,
      });
      continue;
    }

    if (a.kind === "war") {
      if (!ctx.enabledActionKeys.has("declare_war")) continue;
      if (ctx.atWarTargetIds.has(targetId)) continue;
      if ((ctx.relationScores.get(targetId) ?? 0) >= 0) continue;
      usedTargets.add(targetId);
      planned.push({
        targetId,
        kind: "war",
        message: null,
        treatyType: null,
        durationDays: null,
        offerMoney: 0,
        offerTechPoints: 0,
        reason: a.reason?.trim() ?? null,
      });
      continue;
    }

    // treaty
    if (!ctx.enabledActionKeys.has("propose_treaty")) continue;
    if (ctx.pendingTargetIds.has(targetId)) continue;
    if (ctx.atWarTargetIds.has(targetId)) continue;
    // 自訂條約需玩家自訂條款與付款方向，外交官不自動提；誤輸出降為互不侵犯。
    const type: TreatyType =
      isTreatyType(a.treatyType) && a.treatyType !== "custom"
        ? a.treatyType
        : "nonaggression";
    const offerMoney = canGift ? Math.max(0, a.offerMoney ?? 0) : 0;
    const offerTechPoints = canGift ? Math.max(0, a.offerTechPoints ?? 0) : 0;
    usedTargets.add(targetId);
    planned.push({
      targetId,
      kind: "treaty",
      message: null,
      treatyType: type,
      durationDays: a.durationDays ?? null,
      offerMoney,
      offerTechPoints,
      reason: a.reason?.trim() ?? null,
    });
  }

  return planned;
}
