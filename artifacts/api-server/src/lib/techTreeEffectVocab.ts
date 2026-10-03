// Task #494 — 科技樹節點效果語彙白名單（admin create/update 驗證用）。
// 三領域各自沿用既有效果型別（SocialTechEffect / ProductionTechEffect /
// MilitaryTechBonus），不擴充新效果類型。

import type { TechTreeDomain } from "@workspace/db";

/** social 領域合法 target（lib/db schema/socialTech.ts SocialTechEffectTarget）。 */
export const SOCIAL_EFFECT_TARGETS = [
  "taxEfficiency",
  "techPoints",
  "populationGrowth",
  "warWearinessGrowth",
  "buildingSlots",
  "enableBuildingSlots",
  "enableReligionSatisfaction",
  "enableRightsSatisfaction",
  "enableNationalReligion",
  "enableAdvisorSlot",
] as const;

/** production 領域合法 target（lib/db schema/production.ts ProductionTechEffectTarget）。 */
export const PRODUCTION_EFFECT_TARGETS = [
  "productivity",
  "techPoints",
  "populationGrowth",
  "tempPopulationGrowth",
  "buildingUpkeepReduction",
  "enableCulture",
  "enableCityWall",
  "enableColonization",
  "enableNaval",
] as const;

/** military 領域合法 target（lib/db schema/military.ts MilitaryTechBonus）。 */
export const MILITARY_EFFECT_TARGETS = [
  "hp",
  "attack",
  "defense",
  "speed",
  "accuracy",
  "prodCost",
  "popCost",
  "moneyCost",
  "upkeep",
  "recoverySpeed",
  "recoveryRate",
  "seaLandingCapacity",
  "landingAttackReduction",
  "foodConsumption",
] as const;

/** military 領域合法兵種類別（null＝全類別）。 */
export const MILITARY_EFFECT_CATEGORIES = [
  "infantry",
  "ranged",
  "armor",
  "artillery",
  "ship",
  "air",
  "siege",
] as const;

const SOCIAL_TARGET_SET = new Set<string>(SOCIAL_EFFECT_TARGETS);
const PRODUCTION_TARGET_SET = new Set<string>(PRODUCTION_EFFECT_TARGETS);
const MILITARY_TARGET_SET = new Set<string>(MILITARY_EFFECT_TARGETS);
const MILITARY_CATEGORY_SET = new Set<string>(MILITARY_EFFECT_CATEGORIES);

/**
 * 依領域對 effects 陣列做白名單驗證。回傳 zh-TW 錯誤訊息；合法回 null。
 * 不靜默丟棄任何欄位——不合法一律回報，由呼叫端回 400。
 */
export function validateTechTreeEffects(
  domain: TechTreeDomain,
  effects: unknown[],
): string | null {
  for (let i = 0; i < effects.length; i++) {
    const raw = effects[i];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return `第 ${i + 1} 條效果必須是物件`;
    }
    const e = raw as Record<string, unknown>;
    const target = typeof e.target === "string" ? e.target : "";

    if (domain === "military") {
      if (!MILITARY_TARGET_SET.has(target)) {
        return `第 ${i + 1} 條效果的類型（target）不屬於軍事領域語彙：${String(e.target ?? "")}`;
      }
      const category = e.category ?? null;
      if (category !== null && !MILITARY_CATEGORY_SET.has(String(category))) {
        return `第 ${i + 1} 條效果的兵種類別（category）不合法：${String(category)}`;
      }
      const pct = e.pct;
      if (typeof pct !== "number" || !Number.isFinite(pct)) {
        return `第 ${i + 1} 條效果的百分比（pct）必須是有限數字`;
      }
      continue;
    }

    const targetSet = domain === "social" ? SOCIAL_TARGET_SET : PRODUCTION_TARGET_SET;
    const domainLabel = domain === "social" ? "社會" : "生產";
    if (!targetSet.has(target)) {
      return `第 ${i + 1} 條效果的類型（target）不屬於${domainLabel}領域語彙：${String(e.target ?? "")}`;
    }
    const value = e.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return `第 ${i + 1} 條效果的數值（value）必須是有限數字`;
    }
  }
  return null;
}
