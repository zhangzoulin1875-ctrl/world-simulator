import type { MilitaryCategory } from "./military";
import {
  MILITARY_CATEGORIES,
  categoryLabel,
  isMilitaryCategory,
} from "./military";
import type { MilitaryWeapon } from "@workspace/db";

/**
 * 武器系統 — 常數與純計算（可單測）。
 *
 * 設計對應兵種設計：每回合最多設計 3 把武器（次數制）、可銷毀（不退次數）。
 * 戰鬥效果雙軌：確定性戰力乘數（computeEffectivePower）＋ AI 判定敘事
 * （武器與技能資訊序列化進戰爭 AI 提示詞）。
 */

/** 每回合武器設計次數上限（回合引擎每回合回滿至此值）。 */
export const WEAPON_DESIGN_CHARGE_CAP = 3;
/** 每位玩家武器藍圖上限（銷毀可釋放）。 */
export const MAX_WEAPONS_PER_PLAYER = 10;
/** 相容兵種攻擊加成上限（%）。 */
export const WEAPON_ATTACK_PCT_MAX = 15;
/** 相容兵種防禦加成上限（%）。 */
export const WEAPON_DEFENSE_PCT_MAX = 15;
/** 特殊技能效果幅度上限（%）。 */
export const WEAPON_SKILL_BONUS_PCT_MAX = 10;
/** 不相容兵種裝備懲罰（%，攻防同扣）。 */
export const WEAPON_INCOMPATIBLE_PENALTY_PCT = 10;

/** 技能效果類型：offense=進攻加成 | defense=防禦加成 | versatile=攻守各半。 */
export const WEAPON_SKILL_EFFECTS = [
  "offense",
  "defense",
  "versatile",
] as const;
export type WeaponSkillEffect = (typeof WEAPON_SKILL_EFFECTS)[number];

export function isWeaponSkillEffect(v: string): v is WeaponSkillEffect {
  return (WEAPON_SKILL_EFFECTS as readonly string[]).includes(v);
}

/**
 * AI 相容類別輸出夾限：過濾非法值、去重、最多 3 個。
 *
 * allowed（可選）= 玩家目前可用的類別：不在其中的（例如研發火槍兵後的射手、
 * 古代的空軍）一律剔除。全空時回退為 allowed（沒給則全類別），避免武器無法裝備任何兵種。
 * 不傳 allowed 時行為與舊版完全相同。
 */
export function clampCompatibleCategories(
  raw: unknown,
  allowed?: readonly MilitaryCategory[],
): MilitaryCategory[] {
  const fallback = allowed && allowed.length > 0 ? allowed : MILITARY_CATEGORIES;
  if (!Array.isArray(raw)) return [...fallback];
  const seen = new Set<string>();
  for (const item of raw) {
    if (
      typeof item === "string" &&
      isMilitaryCategory(item) &&
      (!allowed || allowed.includes(item))
    ) {
      seen.add(item);
    }
  }
  if (seen.size === 0) return [...fallback];
  return [...seen].slice(0, 3) as MilitaryCategory[];
}

export function weaponCompatibleWith(
  weapon: Pick<MilitaryWeapon, "compatibleCategories">,
  category: string,
): boolean {
  return weapon.compatibleCategories.includes(category);
}

/**
 * 武器對某兵種的戰鬥乘數（純函式；戰鬥結算確定性套用）：
 * - 未裝備 → {1, 1}
 * - 相容 → 攻/防各乘上武器攻防加成，技能效果再加成
 *   （offense/defense 全額、versatile 各半）
 * - 不相容 → 攻防同乘懲罰（武器攻防加成不生效）
 */
export function weaponCombatMods(input: {
  equipped: boolean;
  compatible: boolean;
  attackPct: number;
  defensePct: number;
  skillEffect: WeaponSkillEffect;
  skillBonusPct: number;
}): { offenseMult: number; defenseMult: number } {
  if (!input.equipped) return { offenseMult: 1, defenseMult: 1 };
  if (!input.compatible) {
    const mult = 1 - WEAPON_INCOMPATIBLE_PENALTY_PCT / 100;
    return { offenseMult: mult, defenseMult: mult };
  }
  const skill = Math.max(0, input.skillBonusPct) / 100;
  const offSkill = input.skillEffect === "offense" ? skill : input.skillEffect === "versatile" ? skill / 2 : 0;
  const defSkill = input.skillEffect === "defense" ? skill : input.skillEffect === "versatile" ? skill / 2 : 0;
  return {
    offenseMult: 1 + Math.max(0, input.attackPct) / 100 + offSkill,
    defenseMult: 1 + Math.max(0, input.defensePct) / 100 + defSkill,
  };
}

/** 給序列化/前端顯示用的效果摘要（例如「攻+10%・防+5%・技能：破陣衝鋒（攻+8%）」）。 */
export function describeWeaponMods(mods: {
  equipped: boolean;
  compatible: boolean;
  attackPct: number;
  defensePct: number;
  skillEffect: WeaponSkillEffect;
  skillBonusPct: number;
}): string {
  if (!mods.equipped) return "未裝備";
  if (!mods.compatible) return `不合用（攻防 −${WEAPON_INCOMPATIBLE_PENALTY_PCT}%）`;
  const parts: string[] = [];
  if (mods.attackPct > 0) parts.push(`攻 +${mods.attackPct}%`);
  if (mods.defensePct > 0) parts.push(`防 +${mods.defensePct}%`);
  if (mods.skillBonusPct > 0) {
    const effLabel =
      mods.skillEffect === "offense"
        ? "攻"
        : mods.skillEffect === "defense"
          ? "防"
          : "攻防各半";
    parts.push(`技能效果：${effLabel} +${mods.skillBonusPct}%`);
  }
  return parts.length > 0 ? parts.join("・") : "無加成";
}

/** 供測試與 UI 標籤：類別顯示名（相容清單用）。 */
export function compatibleCategoryLabels(
  categories: readonly string[],
  eraSlug: string,
): string[] {
  return categories
    .filter((c): c is MilitaryCategory =>
      (MILITARY_CATEGORIES as readonly string[]).includes(c),
    )
    .map((c) => categoryLabel(c, eraSlug));
}

/** 供 API 序列化（overview / 設計結果共用）。 */
export function serializeWeapon(
  weapon: MilitaryWeapon,
  eraSlug: string,
) {
  return {
    id: weapon.id,
    name: weapon.name,
    description: weapon.description,
    compatibleCategories: weapon.compatibleCategories,
    compatibleLabels: compatibleCategoryLabels(
      weapon.compatibleCategories,
      eraSlug,
    ),
    attackPct: weapon.attackPct,
    defensePct: weapon.defensePct,
    skillName: weapon.skillName,
    skillDescription: weapon.skillDescription,
    skillEffect: weapon.skillEffect,
    skillBonusPct: weapon.skillBonusPct,
    eraSlug: weapon.eraSlug,
  };
}

/**
 * 依武器名稱/玩家需求中的兵種關鍵字推斷「明確指名」的相容類別（確定性兜底）。
 *
 * 動機：AI 看到「騎兵長槍」常因「槍」字判成 infantry，造成名字是騎兵槍卻只能給步兵
 * 用（玩家回報「一直設計不出騎兵武器」）。名稱/需求明確寫了兵種時，以玩家意圖為準。
 *
 * 只回傳「名稱或需求裡明確出現」的類別；沒有任何關鍵字則回空陣列（交給 AI 判斷）。
 */
const CATEGORY_NAME_KEYWORDS: ReadonlyArray<
  readonly [MilitaryCategory, readonly string[]]
> = [
  ["armor", ["騎兵", "騎士", "騎槍", "騎射", "戰馬", "重騎", "輕騎", "鐵騎", "騎乘", "馬上", "坦克", "戰車", "裝甲"]],
  ["ranged", ["弓", "弩", "射手", "箭"]],
  ["ship", ["戰艦", "艦", "船", "艇", "水師"]],
  ["air", ["戰機", "飛機", "轟炸機", "空軍", "飛行"]],
  ["artillery", ["火砲", "火炮", "大砲", "大炮", "榴彈砲", "加農"]],
  ["siege", ["攻城", "投石", "衝車", "雲梯", "破城"]],
];

export function inferExplicitCategories(
  ...texts: readonly string[]
): MilitaryCategory[] {
  const joined = texts.join(" ");
  const out: MilitaryCategory[] = [];
  for (const [category, words] of CATEGORY_NAME_KEYWORDS) {
    if (words.some((w) => joined.includes(w))) out.push(category);
  }
  return out;
}

/**
 * 合併 AI 建議與明確指名的類別：明確指名者（且玩家可用）優先排前，其後接 AI 建議，
 * 去重、最多 3 個；合併後為空則回退 allowed。
 */
export function mergeCompatibleCategories(
  aiSuggested: readonly MilitaryCategory[],
  explicit: readonly MilitaryCategory[],
  allowed: readonly MilitaryCategory[],
): MilitaryCategory[] {
  const merged: MilitaryCategory[] = [];
  for (const c of [...explicit, ...aiSuggested]) {
    if (allowed.includes(c) && !merged.includes(c)) merged.push(c);
  }
  if (merged.length === 0) return [...allowed];
  return merged.slice(0, 3);
}
