import { z } from "zod";
import type { PlayerNation, PoliticsEntry, PoliticsModifier } from "@workspace/db";

/**
 * Task #43 — 內政系統核心常數與純函式（穩定度加成換算、暴動度每回合判定、
 * 厭戰度攻擊修正、效果淡化、加減成彙整、政策成功率、政變機率）。
 * 與 DB / Express / AI 無耦合，方便單元測試。
 */

// ── 方向與條目類型 ─────────────────────────────────────────────

export const POLITICS_DIRECTIONS = [
  "law",
  "culture",
  "religion",
  "rights",
  "military",
] as const;

export type PoliticsDirection = (typeof POLITICS_DIRECTIONS)[number];

export function isPoliticsDirection(v: string): v is PoliticsDirection {
  return (POLITICS_DIRECTIONS as readonly string[]).includes(v);
}

/** 頁面四區塊名稱（政策方向）。 */
export const DIRECTION_LABELS: Record<PoliticsDirection, string> = {
  law: "秩序",
  culture: "文化",
  religion: "宗教",
  rights: "人權",
  military: "軍方",
};

/**
 * Task #401 — 四項滿意度改為「四大社會階級」滿意度。
 * 政策方向 slug（law/culture/religion/rights）保持不變（politics_entries
 * 既存資料與科技解鎖沿用）；每個方向對應一個社會階級的滿意度：
 * law→農民、culture→工人、rights→貴族(資本家)、religion→教士。
 */
export const SATISFACTION_LABELS: Record<PoliticsDirection, string> = {
  law: "農民滿意度",
  culture: "工人滿意度",
  religion: "教士滿意度",
  rights: "貴族(資本家)滿意度",
  // Task #402 — 第五面向：軍方。
  military: "軍方滿意度",
};

export const POLITICS_ENTRY_TYPES = [
  "policy",
  "tradition",
  "reform",
  "event",
] as const;

export type PoliticsEntryType = (typeof POLITICS_ENTRY_TYPES)[number];

export const ENTRY_TYPE_LABELS: Record<PoliticsEntryType, string> = {
  policy: "政策",
  tradition: "傳統",
  reform: "變革",
  event: "事件",
};

export const MODIFIER_TARGETS = [
  "satisfaction",
  "stability",
  "production",
  "tech",
  "populationGrowth",
  "warWeariness",
  "foodGrowth",
] as const;

export type PoliticsModifierTarget = (typeof MODIFIER_TARGETS)[number];

export const MODIFIER_TARGET_LABELS: Record<PoliticsModifierTarget, string> = {
  satisfaction: "滿意度",
  stability: "穩定度",
  production: "生產力",
  tech: "科技",
  populationGrowth: "人口增長",
  warWeariness: "厭戰度",
  foodGrowth: "糧食增長率",
};

// ── Task #393 統一政策：不分方向的綜合條目與「指定方向」滿意度目標 ──

/** 新制統一政策條目與待判定想法所用的通用方向值。 */
export const GENERAL_DIRECTION = "general";

/** 各政治方向對應的「指定方向」滿意度加減成目標。 */
export const DIRECTION_SATISFACTION_TARGETS = {
  law: "satisfactionLaw",
  culture: "satisfactionCulture",
  religion: "satisfactionReligion",
  rights: "satisfactionRights",
  military: "satisfactionMilitary",
} as const satisfies Record<PoliticsDirection, string>;

export type DirectionalSatisfactionTarget =
  (typeof DIRECTION_SATISFACTION_TARGETS)[PoliticsDirection];

export const DIRECTIONAL_SATISFACTION_TARGETS = Object.values(
  DIRECTION_SATISFACTION_TARGETS,
) as readonly DirectionalSatisfactionTarget[];

/** 指定方向滿意度目標 → 對應方向；非此類目標回 null。 */
export function satisfactionTargetDirection(
  target: string,
): PoliticsDirection | null {
  for (const dir of POLITICS_DIRECTIONS) {
    if (DIRECTION_SATISFACTION_TARGETS[dir] === target) return dir;
  }
  return null;
}

/**
 * 伺服器端強制：把「未解鎖方向」的指定方向滿意度加減成移除（不能靠 AI 自律）。
 * 其他目標（stability/production/tech/populationGrowth 與舊式 satisfaction）不動。
 */
export function restrictModifiersToEnabledDirections(
  modifiers: readonly PoliticsModifier[],
  enabledDirs: readonly PoliticsDirection[],
): PoliticsModifier[] {
  const enabled = new Set(enabledDirs);
  return modifiers.filter((m) => {
    const dir = satisfactionTargetDirection(m.target);
    return dir === null || enabled.has(dir);
  });
}

// ── 可調參數（管理後台全部可改；zod schema 定義預設值與範圍） ──

export const politicsSettingsSchema = z.object({
  /** 穩定度對科技／生產力的最大加成（±%）。 */
  stabilityMaxBonusPct: z.number().min(0).max(100).default(30),

  /** 暴動度每回合判定：滿意度 > 高門檻。 */
  satisfactionHighThreshold: z.number().min(0).max(100).default(50),
  highSatisfactionUnrestDelta: z.number().min(-50).max(50).default(-3),
  highSatisfactionStabilityDelta: z.number().min(-50).max(50).default(1),
  /** 滿意度介於低門檻與高門檻之間（30–50）。 */
  midSatisfactionUnrestDelta: z.number().min(-50).max(50).default(5),
  /** 滿意度 < 低門檻（取代中間檔位，不疊加）。 */
  satisfactionLowThreshold: z.number().min(0).max(100).default(30),
  lowSatisfactionUnrestDelta: z.number().min(-50).max(50).default(10),
  lowSatisfactionStabilityDelta: z.number().min(-50).max(50).default(-5),

  /** 政策判定成功率：基礎 + (穩定度−50)×權重 + (政體契合度−50)×權重，夾在 min–max。 */
  policySuccessBasePct: z.number().min(0).max(100).default(70),
  policySuccessStabilityWeight: z.number().min(0).max(5).default(0.3),
  policySuccessFitWeight: z.number().min(0).max(5).default(0.4),
  policySuccessMinPct: z.number().min(0).max(100).default(5),
  policySuccessMaxPct: z.number().min(0).max(100).default(95),

  /** 隨機事件：每國每回合觸發機率；好事件機率 = 夾在 min–max 的穩定度。 */
  eventChancePct: z.number().min(0).max(100).default(30),
  goodEventMinPct: z.number().min(0).max(100).default(10),
  goodEventMaxPct: z.number().min(0).max(100).default(90),
  /** 事件／變革預設持續回合（AI 可在 1–max 內指定）。 */
  eventDurationTurns: z.number().int().min(1).max(50).default(3),
  reformDurationTurns: z.number().int().min(1).max(50).default(5),
  maxDurationTurns: z.number().int().min(1).max(50).default(20),
  /** AI 產生的單一加減成絕對值上限。 */
  modifierAbsCap: z.number().min(1).max(100).default(20),

  /** 政變／叛亂：暴動度 > 門檻才會判定。 */
  coupUnrestThreshold: z.number().min(0).max(100).default(50),
  coupBaseChancePct: z.number().min(0).max(100).default(20),
  coupUnrestFactor: z.number().min(0).max(10).default(1),
  coupStabilityFactor: z.number().min(0).max(10).default(0.4),
  coupMaxChancePct: z.number().min(0).max(100).default(80),
  // ── Task #584 政變後果（重設制）：政變不再扣減，而是把政局「打回原點」──
  /** 政變後五項滿意度（農/工/貴/教/軍）重設值。 */
  coupResetSatisfaction: z.number().min(0).max(100).default(50),
  /** 政變後軍方服從度重設值。 */
  coupResetObedience: z.number().min(0).max(100).default(50),
  /** 政變後穩定度重設值。 */
  coupResetStability: z.number().min(0).max(100).default(50),
  /** 政變後政治支持度重設值（無論是否改制皆套用）。 */
  coupResetSupport: z.number().min(0).max(100).default(50),
  /** 政變後暴動度重設值。 */
  coupResetUnrest: z.number().min(0).max(100).default(0),
  /** 政變後政策／決策／兵種設計封鎖回合數。 */
  coupPolicyLockTurns: z.number().int().min(0).max(20).default(3),
  /** 政變後軍隊士氣懲罰（戰力計算時扣減的士氣點數，不落地）。 */
  coupMoralePenalty: z.number().min(0).max(100).default(30),
  /** 政變後士氣懲罰持續回合數。 */
  coupMoralePenaltyTurns: z.number().int().min(0).max(20).default(3),

  /** 政策想法輸入長度上限。 */
  ideaMaxLength: z.number().int().min(10).max(2000).default(200),

  // ── Task #127 政府決策 ──
  /** 政府決策自由文字輸入長度上限。 */
  decisionMaxLength: z.number().int().min(10).max(2000).default(200),
  /** 決策成功率：基礎 + (支持度−50)×w − (政體難度−50)×w + (契合度−50)×w，夾 min–max。 */
  decisionSuccessBasePct: z.number().min(0).max(100).default(60),
  decisionSuccessSupportWeight: z.number().min(0).max(5).default(0.3),
  decisionSuccessDifficultyWeight: z.number().min(0).max(5).default(0.4),
  decisionSuccessFitWeight: z.number().min(0).max(5).default(0.3),
  decisionSuccessMinPct: z.number().min(0).max(100).default(5),
  decisionSuccessMaxPct: z.number().min(0).max(100).default(95),
  /** 決策成功／失敗對政治支持度的升降幅度（百分點）。 */
  decisionSuccessSupportDelta: z.number().min(0).max(100).default(8),
  decisionFailureSupportDelta: z.number().min(0).max(100).default(10),

  // ── Task #127 政治支持度與反制事件 ──
  /** 每回合政治支持度朝「四項有效滿意度平均」漂移的比例（0–1）。 */
  supportDriftWeight: z.number().min(0).max(1).default(0.2),
  /** 支持度 ≤ 門檻時，政府決策可能引發反制事件（負面）。 */
  counterEventSupportThreshold: z.number().min(0).max(100).default(30),
  counterEventChancePct: z.number().min(0).max(100).default(40),
  /** 反制事件觸發時額外扣的穩定度（原沿用政變滿意度懲罰，Task #584 獨立）。 */
  counterEventStabilityPenalty: z.number().min(0).max(100).default(15),

  // ── Task #127 政體變更接受度 ──
  /** 支持度 < 門檻時接受度累積、≥ 門檻時消退。 */
  acceptanceSupportThreshold: z.number().min(0).max(100).default(40),
  acceptanceGrowthDelta: z.number().min(0).max(100).default(8),
  acceptanceDecayDelta: z.number().min(0).max(100).default(6),
  /** 政體變更後政治支持度重設值、接受度歸零。 */
  governmentChangeSupportReset: z.number().min(0).max(100).default(55),

  /** 人口增長：每回合基礎增長率（%），政策/事件 populationGrowth 加減成疊加其上。 */
  populationBaseGrowthPct: z.number().min(-20).max(20).default(1),
  /** 人口增長率（基礎+加減成）的絕對值上限（%）。 */
  populationGrowthMaxAbsPct: z.number().min(0).max(100).default(100),
  /** 人口增長率最小絕對值下限（%）；不允許跌破此值（預設 0.01%）。 */
  populationGrowthMinAbsPct: z.number().min(0).max(20).default(0.01),

  // ── Task #529 分項上限、白名單、永久效果控制 ──
  /** 滿意度系列目標（satisfaction / satisfactionLaw 等）單項絕對值上限。 */
  modifierCapSatisfaction: z.number().min(0).max(100).default(10),
  /** 穩定度（stability）單項絕對值上限。 */
  modifierCapStability: z.number().min(0).max(100).default(10),
  /** 生產力（production）單項絕對值上限。 */
  modifierCapProduction: z.number().min(0).max(100).default(5),
  /** 科技（tech）單項絕對值上限。 */
  modifierCapTech: z.number().min(0).max(100).default(5),
  /** 人口增長（populationGrowth）單項絕對值上限。 */
  modifierCapPopulationGrowth: z.number().min(0).max(100).default(3),
  /** 軍方服從度（militaryObedience）單項絕對值上限。 */
  modifierCapMilitaryObedience: z.number().min(0).max(100).default(10),
  /** 白名單：1=允許政策影響滿意度系列目標（含舊式 satisfaction）；0=剔除。 */
  allowTargetSatisfaction: z.number().int().min(0).max(1).default(1),
  /** 白名單：1=允許政策影響穩定度；0=剔除。 */
  allowTargetStability: z.number().int().min(0).max(1).default(1),
  /** 白名單：1=允許政策影響生產力；0=剔除。 */
  allowTargetProduction: z.number().int().min(0).max(1).default(1),
  /** 白名單：1=允許政策影響科技加成；0=剔除。 */
  allowTargetTech: z.number().int().min(0).max(1).default(1),
  /** 白名單：1=允許政策影響人口增長；0=剔除。 */
  allowTargetPopulationGrowth: z.number().int().min(0).max(1).default(1),
  /** 白名單：1=允許政策影響軍方服從度；0=剔除。 */
  allowTargetMilitaryObedience: z.number().int().min(0).max(1).default(1),
  /** 1=傳統（tradition）結果類型允許永久效果（durationTurns=null）；0=一律轉換為 maxDurationTurns。 */
  allowPermanentTradition: z.number().int().min(0).max(1).default(1),

  // ── Task #626 — 厭戰度、糧食增長率修飾 ──
  /** 1=允許政策每回合調整厭戰度；0=剔除此類修飾。 */
  warWearinessModifierEnabled: z.number().int().min(0).max(1).default(1),
  /** warWeariness 修飾目標：每條政策最大 delta 絕對值上限（百分點）。 */
  warWearinessModifierCapPct: z.number().min(0).max(100).default(5),
  /** 1=允許政策影響糧食增長率；0=剔除此類修飾。 */
  foodGrowthEnabled: z.number().int().min(0).max(1).default(1),
  /** foodGrowth 修飾目標：每條政策最大 delta 絕對值上限（%）。 */
  foodGrowthModifierCapPct: z.number().min(0).max(10).default(3),
  /** 全域基礎糧食增長率（%）：0 = 維持現有行為（無額外糧食加成）。 */
  foodGrowthBaseRatePct: z.number().min(0).max(10).default(0),
});

export type PoliticsSettings = z.infer<typeof politicsSettingsSchema>;

export const DEFAULT_POLITICS_SETTINGS: PoliticsSettings =
  politicsSettingsSchema.parse({});

// ── 純函式 ─────────────────────────────────────────────────────

/** 夾在 0–100。 */
export function clampPct(v: number): number {
  return Math.min(100, Math.max(0, v));
}

/**
 * 穩定度 → 科技／生產力乘數：100% → 1+max、50% → 1、0% → 1−max（線性）。
 */
export function stabilityMultiplier(
  stability: number,
  maxBonusPct: number,
): number {
  const s = clampPct(stability);
  return 1 + ((s - 50) / 50) * (maxBonusPct / 100);
}

/** 厭戰度攻擊修正：攻擊力 ×(1 − 厭戰度/100)。 */
export function warWearinessAttackModifier(warWeariness: number): number {
  return 1 - clampPct(warWeariness) / 100;
}

/**
 * 厭戰度每回合回復量（純函式，回合引擎用）。無進行中戰爭 → peacetime；
 * 仍在進行中戰爭 → wartime。回傳非負整數；實際下限由 SQL GREATEST(0,…) 夾。
 */
export function warWearinessRecovery(
  inActiveWar: boolean,
  settings: {
    warWearinessPeacetimeRecovery: number;
    warWearinessWartimeRecovery: number;
  },
): number {
  const raw = inActiveWar
    ? settings.warWearinessWartimeRecovery
    : settings.warWearinessPeacetimeRecovery;
  return Math.max(0, Math.round(Number.isFinite(raw) ? raw : 0));
}

/**
 * 厭戰度上升幅度縮放：AI 每回合厭戰度增量 × 倍率%（四捨五入、非負）。
 * 只縮放正向增量（厭戰度只會上升）；倍率不合法時視為 100（原幅度）。
 */
export function scaleWarWearinessGain(
  delta: number,
  multiplierPct: number,
): number {
  if (!(delta > 0)) return 0;
  const m =
    Number.isFinite(multiplierPct) && multiplierPct >= 0 ? multiplierPct : 100;
  return Math.max(0, Math.round((delta * m) / 100));
}

/**
 * 暴動度每回合判定：對四項（有效）滿意度各自判定後加總。
 * <低門檻 檔位「取代」中間檔位（不疊加）。
 */
export function unrestTick(
  satisfactions: readonly number[],
  s: PoliticsSettings,
): { unrestDelta: number; stabilityDelta: number } {
  let unrestDelta = 0;
  let stabilityDelta = 0;
  for (const sat of satisfactions) {
    if (sat > s.satisfactionHighThreshold) {
      unrestDelta += s.highSatisfactionUnrestDelta;
      stabilityDelta += s.highSatisfactionStabilityDelta;
    } else if (sat < s.satisfactionLowThreshold) {
      unrestDelta += s.lowSatisfactionUnrestDelta;
      stabilityDelta += s.lowSatisfactionStabilityDelta;
    } else {
      unrestDelta += s.midSatisfactionUnrestDelta;
    }
  }
  return { unrestDelta, stabilityDelta };
}

/**
 * 條目當前強度（0–1）：永久（remainingTurns=null）→ 1；
 * 變革／事件線性淡化 remaining/duration；短暫政策／傳統不淡化（到期即止）。
 */
export function entryStrength(
  entry: Pick<
    PoliticsEntry,
    "entryType" | "durationTurns" | "remainingTurns" | "status"
  >,
): number {
  if (entry.status !== "active") return 0;
  if (entry.remainingTurns === null || entry.durationTurns === null) return 1;
  if (entry.durationTurns <= 0) return 0;
  const fades = entry.entryType === "reform" || entry.entryType === "event";
  if (!fades) return entry.remainingTurns > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, entry.remainingTurns / entry.durationTurns));
}

export interface ModifierTotals {
  satisfaction: number;
  stability: number;
  production: number;
  tech: number;
  populationGrowth: number;
  warWeariness: number;
  foodGrowth: number;
}

const ZERO_TOTALS: ModifierTotals = {
  satisfaction: 0,
  stability: 0,
  production: 0,
  tech: 0,
  populationGrowth: 0,
  warWeariness: 0,
  foodGrowth: 0,
};

/** 彙整一組條目的（淡化後）加減成總和。 */
export function sumModifiers(
  entries: readonly Pick<
    PoliticsEntry,
    "entryType" | "durationTurns" | "remainingTurns" | "status" | "modifiers"
  >[],
): ModifierTotals {
  const totals = { ...ZERO_TOTALS };
  for (const entry of entries) {
    const strength = entryStrength(entry);
    if (strength <= 0) continue;
    for (const mod of entry.modifiers as PoliticsModifier[]) {
      if (!(MODIFIER_TARGETS as readonly string[]).includes(mod.target)) {
        continue;
      }
      totals[mod.target as PoliticsModifierTarget] += mod.value * strength;
    }
  }
  return totals;
}

// ── Task #402 — 軍方服從度加減成（militaryObedience 目標） ──

/** 彙整條目中 militaryObedience 目標的（淡化後）偏移總和。 */
export function militaryObedienceOffset(
  entries: readonly Pick<
    PoliticsEntry,
    "entryType" | "durationTurns" | "remainingTurns" | "status" | "modifiers"
  >[],
): number {
  let total = 0;
  for (const entry of entries) {
    const strength = entryStrength(entry);
    if (strength <= 0) continue;
    for (const mod of entry.modifiers as PoliticsModifier[]) {
      if (mod.target === "militaryObedience") {
        total += mod.value * strength;
      }
    }
  }
  return total;
}

/** 有效軍方服從度 = 基底 + 政策偏移，夾 0–100（完整精度，捨入只在序列化）。 */
export function effectiveMilitaryObedience(
  base: number,
  entries: readonly Pick<
    PoliticsEntry,
    "entryType" | "durationTurns" | "remainingTurns" | "status" | "modifiers"
  >[],
): number {
  return Math.min(100, Math.max(0, base + militaryObedienceOffset(entries)));
}

/** 政策判定成功率（%）。 */
export function policySuccessChance(
  stability: number,
  fitScore: number,
  s: PoliticsSettings,
): number {
  const raw =
    s.policySuccessBasePct +
    (clampPct(stability) - 50) * s.policySuccessStabilityWeight +
    (clampPct(fitScore) - 50) * s.policySuccessFitWeight;
  return Math.min(s.policySuccessMaxPct, Math.max(s.policySuccessMinPct, raw));
}

/** 好事件機率（%）＝穩定度夾在 min–max。 */
export function goodEventProbabilityPct(
  stability: number,
  s: PoliticsSettings,
): number {
  return Math.min(s.goodEventMaxPct, Math.max(s.goodEventMinPct, clampPct(stability)));
}

/** 政變／叛亂機率（%）；暴動度 ≤ 門檻時為 0。 */
export function coupChancePct(
  unrest: number,
  stability: number,
  s: PoliticsSettings,
): number {
  if (unrest <= s.coupUnrestThreshold) return 0;
  const raw =
    s.coupBaseChancePct +
    (clampPct(unrest) - s.coupUnrestThreshold) * s.coupUnrestFactor -
    clampPct(stability) * s.coupStabilityFactor;
  return Math.min(s.coupMaxChancePct, Math.max(0, raw));
}

// ── 國家內政狀態彙整（有效值） ─────────────────────────────────

export interface NationPoliticsState {
  /** 有效穩定度（基底 + 所有方向 stability 加減成，夾 0–100）。 */
  stability: number;
  unrest: number;
  warWeariness: number;
  /** 各方向有效滿意度（基底 + 該方向 satisfaction 加減成，夾 0–100）。 */
  satisfactions: Record<PoliticsDirection, number>;
  /** 各方向的加減成總和（淡化後）。 */
  directionTotals: Record<PoliticsDirection, ModifierTotals>;
  /** 全國加總的生產力／科技百分比加成與穩定度偏移。 */
  productionPct: number;
  techPct: number;
  /** 全國加總的人口增長率加減成（百分點；不含基礎增長率）。 */
  populationGrowthPct: number;
  /** 全國加總的厭戰度每回合 delta（正值＝降低厭戰度，負值＝升高）。 */
  warWearinessPolicyDelta: number;
  /** 全國加總的糧食增長率加減成（百分點；不含基礎增長率）。 */
  foodGrowthPct: number;
  stabilityOffset: number;
  /** 穩定度換算後的科技／生產力乘數。 */
  stabilityMult: number;
}

/**
 * 舊四項階級滿意度(農民/工人/教士/貴族)已由「議會」取代(設計決定:只留軍方+議會)。
 * 這四個方向的基礎值固定為中性值,不再隨舊欄位波動,以免與議會系統重複懲罰玩家。
 * 欄位本身保留(惰性資料),日後可安全移除;軍事方向仍讀 satisfactionMilitary。
 */
export const LEGACY_CLASS_SATISFACTION_NEUTRAL = 60;

export function baseSatisfaction(
  nation: Pick<PlayerNation, "satisfactionMilitary">,
  direction: PoliticsDirection,
): number {
  return direction === "military"
    ? nation.satisfactionMilitary
    : LEGACY_CLASS_SATISFACTION_NEUTRAL;
}

/** 由國家列 + 有效條目算出全部有效內政數值。 */
export function computePoliticsState(
  nation: Pick<
    PlayerNation,
    | "stability"
    | "unrest"
    | "warWeariness"
    | "satisfactionFarmers"
    | "satisfactionWorkers"
    | "satisfactionNobles"
    | "satisfactionClergy"
    | "satisfactionMilitary"
  >,
  activeEntries: readonly Pick<
    PoliticsEntry,
    | "direction"
    | "entryType"
    | "durationTurns"
    | "remainingTurns"
    | "status"
    | "modifiers"
  >[],
  settings: PoliticsSettings,
  /**
   * Task #355 — 管理員發放的限回合數滿意度暫時偏移（依方向）。在既有政策修正
   * 之後、夾限 0–100 之前套用，成為有效滿意度的暫時偏移。未提供的方向視為 0。
   */
  satisfactionOffsets?: Partial<Record<PoliticsDirection, number>>,
): NationPoliticsState {
  // 舊制方向條目：依條目 direction 分桶（satisfaction 作用於該方向）。
  const directionTotals = {} as Record<PoliticsDirection, ModifierTotals>;
  for (const dir of POLITICS_DIRECTIONS) {
    directionTotals[dir] = sumModifiers(
      activeEntries.filter((e) => e.direction === dir),
    );
  }

  // Task #393 — 指定方向滿意度目標（satisfactionLaw|...）：不論條目掛在哪個
  // 方向（含新制 general 條目），都直接累加到被指名方向的滿意度總和。
  for (const entry of activeEntries) {
    const strength = entryStrength(entry);
    if (strength <= 0) continue;
    for (const mod of entry.modifiers as PoliticsModifier[]) {
      const dir = satisfactionTargetDirection(mod.target);
      if (dir !== null) {
        directionTotals[dir].satisfaction += mod.value * strength;
      }
    }
  }

  // 新制 general（及其他非方向）條目的非滿意度加減成 → 全國總和。
  const generalTotals = sumModifiers(
    activeEntries.filter((e) => !isPoliticsDirection(e.direction)),
  );

  const stabilityOffset =
    POLITICS_DIRECTIONS.reduce(
      (acc, dir) => acc + directionTotals[dir].stability,
      0,
    ) + generalTotals.stability;
  const productionPct =
    POLITICS_DIRECTIONS.reduce(
      (acc, dir) => acc + directionTotals[dir].production,
      0,
    ) + generalTotals.production;
  const techPct =
    POLITICS_DIRECTIONS.reduce(
      (acc, dir) => acc + directionTotals[dir].tech,
      0,
    ) + generalTotals.tech;
  const populationGrowthPct =
    POLITICS_DIRECTIONS.reduce(
      (acc, dir) => acc + directionTotals[dir].populationGrowth,
      0,
    ) + generalTotals.populationGrowth;
  const warWearinessPolicyDelta =
    POLITICS_DIRECTIONS.reduce(
      (acc, dir) => acc + directionTotals[dir].warWeariness,
      0,
    ) + generalTotals.warWeariness;
  const foodGrowthPct =
    POLITICS_DIRECTIONS.reduce(
      (acc, dir) => acc + directionTotals[dir].foodGrowth,
      0,
    ) + generalTotals.foodGrowth;

  const stability = clampPct(nation.stability + stabilityOffset);
  const satisfactions = {} as Record<PoliticsDirection, number>;
  for (const dir of POLITICS_DIRECTIONS) {
    satisfactions[dir] = clampPct(
      baseSatisfaction(nation, dir) +
        directionTotals[dir].satisfaction +
        (satisfactionOffsets?.[dir] ?? 0),
    );
  }

  return {
    stability,
    unrest: clampPct(nation.unrest),
    warWeariness: clampPct(nation.warWeariness),
    satisfactions,
    directionTotals,
    productionPct,
    techPct,
    populationGrowthPct,
    warWearinessPolicyDelta,
    foodGrowthPct,
    stabilityOffset,
    stabilityMult: stabilityMultiplier(stability, settings.stabilityMaxBonusPct),
  };
}

/** 套用穩定度乘數與政策百分比加成後的整數值（不低於 0）。 */
export function adjustStatValue(
  raw: number,
  stabilityMult: number,
  pctBonus: number,
): number {
  return Math.max(0, Math.round(raw * stabilityMult * (1 + pctBonus / 100)));
}

/**
 * 有效人口增長率（%／回合）＝基礎增長率 + 政策/事件 populationGrowth
 * 加減成，上限 populationGrowthMaxAbsPct，下限 populationGrowthMinAbsPct（預設
 * 0.01%，防止人口永遠衰退）。
 */
export function populationGrowthRatePct(
  modifierPct: number,
  s: PoliticsSettings,
): number {
  const raw = s.populationBaseGrowthPct + modifierPct;
  const cap = s.populationGrowthMaxAbsPct;
  const floor = s.populationGrowthMinAbsPct;
  return Math.min(cap, Math.max(floor, raw));
}

/**
 * 有效糧食增長率（%）＝全域基礎糧食增長率 + 政策 foodGrowth 加減成，
 * 夾在 0.01–10%（啟用時）；總值 ≤ 0 或 foodGrowthEnabled=0 時回傳 0（不加成）。
 */
export function computeFoodGrowthRatePct(
  policyModifierPct: number,
  s: PoliticsSettings,
): number {
  if (s.foodGrowthEnabled === 0) return 0;
  const raw = s.foodGrowthBaseRatePct + policyModifierPct;
  if (raw <= 0) return 0;
  return Math.min(10, Math.max(0.01, raw));
}

/** 本回合人口增長量 = round(總人口 × 增長率%)；人口 ≤ 0 時為 0。 */
export function populationGrowthAmount(
  totalPopulation: number,
  ratePct: number,
): number {
  if (totalPopulation <= 0) return 0;
  return Math.round((totalPopulation * ratePct) / 100);
}

/** 全域人口增長倍率的預設值（%）；100 = 現行速度、行為不變。 */
export const DEFAULT_POPULATION_GROWTH_MULTIPLIER_PCT = 100;

/**
 * 夾取人口增長倍率到 0–100 的整數（非數值／壞值 → 預設 100）。
 * 用於防禦資料庫存了超界／壞值時仍能安全運作（回合結算不會炸）。
 */
export function clampPopulationGrowthMultiplierPct(v: unknown): number {
  const n =
    typeof v === "number" && Number.isFinite(v)
      ? Math.floor(v)
      : DEFAULT_POPULATION_GROWTH_MULTIPLIER_PCT;
  return Math.min(100, Math.max(0, n));
}

/**
 * 依全域倍率縮放「每回合人口增長量」（整數）。倍率先夾 0–100：
 * 100 = 不變、0 = 無增長、越低越慢。四捨五入維持整數。
 * 保留原本正負號（人口衰退時同樣按倍率縮小幅度），故：
 *   - 非負增長量縮放後仍為非負；
 *   - 倍率 100 時結果等於原量（既有行為完全不變）。
 */
export function scalePopulationGrowth(
  amount: number,
  multiplierPct: number,
): number {
  const m = clampPopulationGrowthMultiplierPct(multiplierPct);
  return Math.round((amount * m) / 100);
}

/**
 * 依全域倍率縮放「有效人口增長率」（%／回合），供玩家顯示與回合實際套用
 * 保持一致（兩者皆為 值 × 倍率 / 100）。倍率先夾 0–100。
 */
export function scalePopulationGrowthRatePct(
  ratePct: number,
  multiplierPct: number,
): number {
  const m = clampPopulationGrowthMultiplierPct(multiplierPct);
  return (ratePct * m) / 100;
}

/** 全域「生產力／科技點數基礎倍率」的預設值（%）；100 = 不縮放、行為不變。 */
export const DEFAULT_GLOBAL_STAT_MULTIPLIER_PCT = 100;

/**
 * 夾取全域基礎倍率到 0–1000 的整數（非數值／壞值 → 預設 100）。
 * 用於防禦資料庫存了超界／壞值時仍能安全運作（回合結算不會炸）。
 */
export function clampGlobalStatMultiplierPct(v: unknown): number {
  const n =
    typeof v === "number" && Number.isFinite(v)
      ? Math.floor(v)
      : DEFAULT_GLOBAL_STAT_MULTIPLIER_PCT;
  return Math.min(1000, Math.max(0, n));
}

/**
 * 依全域基礎倍率縮放「調整後生產力／每回合科技產出」（最外層縮放）。
 * 回傳四捨五入整數——與 adjustStatValue 的整數契約一致（生產力/科技產出
 * 全下游皆假設整數：OpenAPI integer、招募/佔用比較、金錢收入）。
 * 倍率先夾 0–1000；100 = 原值不變。
 */
export function scaleByGlobalStatMultiplierPct(
  value: number,
  multiplierPct: number,
): number {
  const m = clampGlobalStatMultiplierPct(multiplierPct);
  return Math.round((value * m) / 100);
}

// ── Task #127 政府治理系統：純函式 ────────────────────────────

/**
 * 依關鍵科技旗標決定「有效」政治方向。法律、文化（工人）與軍方恆為有效
 * （Task #402／#521 文化開局即啟用，不再需要造紙術）；宗教需 世界宗教科技
 * （religionEnabled）、權利需 君權神授科技（rightsEnabled）。
 * 用於政治頁的鎖定顯示，以及回合結算暴動度計算（未解鎖方向不計入）。
 */
export function enabledPoliticsDirections(flags: {
  religionEnabled: boolean;
  rightsEnabled: boolean;
}): PoliticsDirection[] {
  const out: PoliticsDirection[] = ["law", "culture"];
  if (flags.religionEnabled) out.push("religion");
  if (flags.rightsEnabled) out.push("rights");
  out.push("military");
  return out;
}

/**
 * 政府決策成功率（%）：基礎 + (支持度−50)×w − (政體難度−50)×w
 * + (契合度−50)×w，夾在 min–max。契合度 fitScore（0–100）由 AI 判定
 * 該決策與政體/註記的契合程度。
 */
export function decisionSuccessChance(
  politicalSupport: number,
  decisionDifficulty: number,
  fitScore: number,
  s: PoliticsSettings,
): number {
  const raw =
    s.decisionSuccessBasePct +
    (clampPct(politicalSupport) - 50) * s.decisionSuccessSupportWeight -
    (clampPct(decisionDifficulty) - 50) * s.decisionSuccessDifficultyWeight +
    (clampPct(fitScore) - 50) * s.decisionSuccessFitWeight;
  return Math.min(
    s.decisionSuccessMaxPct,
    Math.max(s.decisionSuccessMinPct, raw),
  );
}

/** 低支持度反制事件機率（%）：支持度 ≤ 門檻時為設定機率，否則 0。 */
export function counterEventChancePct(
  politicalSupport: number,
  s: PoliticsSettings,
): number {
  return clampPct(politicalSupport) <= s.counterEventSupportThreshold
    ? s.counterEventChancePct
    : 0;
}

/**
 * 每回合政治支持度漂移：朝「有效滿意度平均」移動 supportDriftWeight 比例，
 * 回傳新的支持度（夾 0–100）。有效滿意度陣列為空時不漂移。
 */
export function supportDriftTick(
  politicalSupport: number,
  effectiveSatisfactions: readonly number[],
  s: PoliticsSettings,
): number {
  if (effectiveSatisfactions.length === 0) return clampPct(politicalSupport);
  const avg =
    effectiveSatisfactions.reduce((a, b) => a + b, 0) /
    effectiveSatisfactions.length;
  const next =
    clampPct(politicalSupport) +
    (avg - clampPct(politicalSupport)) * s.supportDriftWeight;
  return clampPct(Math.round(next));
}

/**
 * 政體變更接受度每回合變化：支持度 < 門檻 → 累積 growth；否則消退 decay。
 * 回傳新的接受度（夾 0–100）。
 */
export function acceptanceTick(
  politicalSupport: number,
  acceptance: number,
  s: PoliticsSettings,
): number {
  const delta =
    clampPct(politicalSupport) < s.acceptanceSupportThreshold
      ? s.acceptanceGrowthDelta
      : -s.acceptanceDecayDelta;
  return clampPct(acceptance + delta);
}

/** 接受度達 100 → 觸發主動政體變更。 */
export function shouldChangeGovernment(acceptance: number): boolean {
  return clampPct(acceptance) >= 100;
}

/**
 * 從候選政體挑一個（排除現行）。candidates 為 slug 陣列（社會科技解鎖的政體）。
 * 無可選則回 null。rand 用於測試注入（預設 Math.random）。
 */
export function pickNextGovernment(
  currentSlug: string | null,
  candidates: readonly string[],
  rand: () => number = Math.random,
): string | null {
  const pool = candidates.filter((s) => s !== currentSlug);
  if (pool.length === 0) return null;
  const idx = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
  return pool[idx] ?? null;
}

/**
 * 政變安裝的政體（依偏好序，排除現行）；偏好清單皆等於現行時回 null。
 */
export function pickCoupGovernment(
  currentSlug: string | null,
  coupSlugs: readonly string[],
): string | null {
  for (const slug of coupSlugs) {
    if (slug !== currentSlug) return slug;
  }
  return null;
}
