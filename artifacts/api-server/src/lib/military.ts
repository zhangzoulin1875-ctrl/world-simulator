import type {
  MilitaryTechBonus,
  MilitaryUnitTemplate,
} from "@workspace/db";
import { getEraIndex, isEraSlug } from "./mapRegionEras";

/**
 * Task #27 — 軍事系統核心常數與純函式（類別解鎖、成本計算、科技加成疊算、
 * 每日購買額度）。與 DB / Express 無耦合，方便單元測試。
 */

export type MilitaryCategory =
  | "infantry"
  | "ranged"
  | "armor"
  | "artillery"
  | "ship"
  | "air"
  | "siege";

export const MILITARY_CATEGORIES: readonly MilitaryCategory[] = [
  "infantry",
  "ranged",
  "armor",
  "artillery",
  "ship",
  "air",
  "siege",
];

export function isMilitaryCategory(v: string): v is MilitaryCategory {
  return (MILITARY_CATEGORIES as readonly string[]).includes(v);
}

/**
 * 類別解鎖所需的關鍵技術 key_slug（null = 一開始就可用，不需研發）。
 * 見 MILITARY_KEY_TECHS。射手另有「火槍兵」反向鎖定規則（見 isCategoryUnlocked）。
 */
const CATEGORY_KEY_TECH: Record<MilitaryCategory, string | null> = {
  infantry: null,
  ranged: "marksmanship",
  armor: null,
  artillery: "gunpowder",
  ship: "naval_warfare",
  air: "aviation",
  siege: null,
};

/** 「裝甲」在 ww1（20 世紀）之前顯示為「騎兵」。 */
const ARMOR_RENAME_ERA = "ww1";

const CATEGORY_BASE_LABEL: Record<MilitaryCategory, string> = {
  infantry: "步兵",
  ranged: "射手",
  armor: "裝甲",
  artillery: "火炮",
  ship: "戰船",
  air: "空軍",
  siege: "攻城武器",
};

/** 類別在指定時代下的顯示名稱（armor 於 ww1 前顯示「騎兵」）。 */
export function categoryLabel(
  category: MilitaryCategory,
  eraSlug: string,
): string {
  if (
    category === "armor" &&
    getEraIndex(eraSlug) < getEraIndex(ARMOR_RENAME_ERA)
  ) {
    return "騎兵";
  }
  return CATEGORY_BASE_LABEL[category];
}

/** 類別解鎖所需的關鍵技術 key_slug（null = 不需研發）。 */
export function categoryRequiredKeyTech(
  category: MilitaryCategory,
): string | null {
  return CATEGORY_KEY_TECH[category];
}

/**
 * 類別是否已解鎖：需研發對應關鍵技術者，須在已研發清單中；射手在研發「火槍兵」
 * 後反向鎖定（火槍取代弓弩，步兵改為遠程輸出）。
 */
export function isCategoryUnlocked(
  category: MilitaryCategory,
  researchedKeySlugs: readonly string[],
): boolean {
  if (
    category === "ranged" &&
    researchedKeySlugs.includes(MUSKETEER_KEY_SLUG)
  ) {
    return false;
  }
  const required = CATEGORY_KEY_TECH[category];
  if (required === null) return true;
  return researchedKeySlugs.includes(required);
}

/** 類別的鎖定資訊（供前端顯示解鎖條件與鎖定原因）。 */
export interface CategoryLockInfo {
  unlocked: boolean;
  requiredKeySlug: string | null;
  requiredKeyName: string | null;
  lockReason: string | null;
}

export function categoryLockInfo(
  category: MilitaryCategory,
  researchedKeySlugs: readonly string[],
): CategoryLockInfo {
  const unlocked = isCategoryUnlocked(category, researchedKeySlugs);
  const required = CATEGORY_KEY_TECH[category];
  const requiredDef = required ? militaryKeyTechBySlug(required) : null;
  let lockReason: string | null = null;
  if (!unlocked) {
    if (
      category === "ranged" &&
      researchedKeySlugs.includes(MUSKETEER_KEY_SLUG)
    ) {
      lockReason = "已研發「火槍兵」，弓弩射手已被火槍取代（步兵改為遠程作戰）";
    } else if (requiredDef) {
      lockReason = `需先研發關鍵技術「${requiredDef.name}」`;
    }
  }
  return {
    unlocked,
    requiredKeySlug: required,
    requiredKeyName: requiredDef?.name ?? null,
    lockReason,
  };
}

/**
 * 兵種在已研發關鍵技術下的有效射程：研發「火槍兵」後，步兵改為遠程作戰。
 */
export function effectiveUnitRange(
  template: Pick<MilitaryUnitTemplate, "category" | "range">,
  researchedKeySlugs: readonly string[],
): "melee" | "ranged" {
  if (
    template.category === "infantry" &&
    researchedKeySlugs.includes(MUSKETEER_KEY_SLUG)
  ) {
    return "ranged";
  }
  return template.range === "ranged" ? "ranged" : "melee";
}

// ── 軍事關鍵技術（映射到全球科技樹主幹線節點，見 lib/techTreeSeed/） ──────

/** 「火槍兵」關鍵技術：解鎖後鎖定射手、步兵改為遠程作戰。 */
export const MUSKETEER_KEY_SLUG = "musketeer";

/** 「指南針」關鍵技術：解鎖跨海登陸能力（旗標；登陸戰鬥後續系統再落地）。 */
export const SEA_LANDING_KEY_SLUG = "compass";

export interface MilitaryKeyTechDef {
  /** 穩定識別字（存於 military_techs.key_slug）。 */
  keySlug: string;
  /** 所屬時代 slug（見 mapRegionEras.ts）。 */
  eraSlug: string;
  name: string;
  description: string;
  bonuses: MilitaryTechBonus[];
}

/**
 * 7 項軍事關鍵技術（星號）。兵種類別解鎖對照見 CATEGORY_KEY_TECH；
 * 火槍兵的反鎖與步兵遠程化見 isCategoryUnlocked／effectiveUnitRange；
 * 指南針的跨海登陸為旗標（SEA_LANDING_KEY_SLUG）。順序即種入順序。
 */
export const MILITARY_KEY_TECHS: readonly MilitaryKeyTechDef[] = [
  {
    keySlug: "marksmanship",
    eraSlug: "classical",
    name: "射擊",
    description: "弓弩齊射之術漸成體系；解鎖射手，遠程單位命中率提升。",
    bonuses: [{ target: "accuracy", category: "ranged", pct: 20 }],
  },
  {
    keySlug: "naval_warfare",
    eraSlug: "roman",
    name: "海戰",
    description: "樓船水軍成軍，江海皆可征伐；解鎖戰船，戰船更堅固。",
    bonuses: [{ target: "hp", category: "ship", pct: 10 }],
  },
  {
    keySlug: "gunpowder",
    eraSlug: "high_medieval",
    name: "火藥",
    description: "火器初現戰場，威力驚人；解鎖火炮，火炮攻擊力提升。",
    bonuses: [{ target: "attack", category: "artillery", pct: 20 }],
  },
  {
    keySlug: "musketeer",
    eraSlug: "renaissance",
    name: "火槍兵",
    description:
      "火槍取代弓弩，步兵改為遠程齊射；射手兵種自此不再可用，步兵攻擊與命中大增。",
    bonuses: [
      { target: "attack", category: "infantry", pct: 30 },
      { target: "accuracy", category: "infantry", pct: 20 },
    ],
  },
  {
    keySlug: "compass",
    eraSlug: "discovery",
    name: "指南針",
    description:
      "羅盤導航使遠洋航行成真；解鎖跨海登陸能力（旗標，後續系統再啟用），戰船速度提升。",
    bonuses: [{ target: "speed", category: "ship", pct: 20 }],
  },
  {
    keySlug: "medicine",
    eraSlug: "scientific",
    name: "醫學",
    description: "軍醫制度與外科進步；傷兵康復速度大幅提升。",
    bonuses: [{ target: "recoveryRate", category: null, pct: 50 }],
  },
  {
    keySlug: "aviation",
    eraSlug: "ww1",
    name: "飛行器",
    description: "動力飛行器投入戰場，開啟制空權時代；解鎖空軍。",
    bonuses: [{ target: "attack", category: "air", pct: 10 }],
  },
] as const;

const MILITARY_KEY_TECH_BY_SLUG = new Map(
  MILITARY_KEY_TECHS.map((k) => [k.keySlug, k]),
);

export function militaryKeyTechBySlug(slug: string): MilitaryKeyTechDef | null {
  return MILITARY_KEY_TECH_BY_SLUG.get(slug) ?? null;
}

/** 指定時代的關鍵技術（依種入順序）。 */
export function militaryKeyTechsForEra(eraSlug: string): MilitaryKeyTechDef[] {
  return MILITARY_KEY_TECHS.filter((k) => k.eraSlug === eraSlug);
}

/** 靜態一致性檢查：關鍵技術時代 slug 合法、無重複 key_slug、類別對照有效。 */
export function validateMilitaryKeyTechs(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const k of MILITARY_KEY_TECHS) {
    if (seen.has(k.keySlug)) {
      problems.push(`duplicate key tech slug ${k.keySlug}`);
    }
    seen.add(k.keySlug);
    if (!isEraSlug(k.eraSlug)) {
      problems.push(`key tech ${k.keySlug} has unknown era ${k.eraSlug}`);
    }
  }
  for (const [category, slug] of Object.entries(CATEGORY_KEY_TECH)) {
    if (slug !== null && !MILITARY_KEY_TECH_BY_SLUG.has(slug)) {
      problems.push(`category ${category} references unknown key tech ${slug}`);
    }
  }
  return problems;
}

// Task #549 — 預設兵種種子（DEFAULT_UNIT_SEEDS）已全面移除：玩家與 NPC 一律
// 使用 AI 自創兵種模板。

/**
 * Task #557 — 部隊的生產力佔用量（招募與金錢購買共用的唯一公式；向上取整）。
 *
 * 佔用 = ⌈數量 × 該兵種每單位生產力維護費 ÷ 100⌉，用「含科技加成後」的有效
 * prodUpkeepPerUnit（applyTechBonuses 之後）。維護費本身不隨時代放大，
 * 故此佔用亦不乘時代係數。
 *
 * 歷史：Task #546 先為金錢購買引入此公式（當時名為 purchaseProductionReservation）；
 * Task #557 起「招募」的生產力佔用也改用同一條公式——舊的
 * recruitProductionEraScale（prodCostPer100 × 時代係數）已整個移除，
 * prodCostPer100 欄位保留但不再參與任何佔用／守門計算。
 */
export function unitProductionReservation(
  template: Pick<MilitaryUnitTemplate, "prodUpkeepPerUnit">,
  quantity: number,
): number {
  if (quantity <= 0 || template.prodUpkeepPerUnit <= 0) return 0;
  return Math.ceil((quantity * template.prodUpkeepPerUnit) / 100);
}

/**
 * Task #568 — 招募的「立即性生產力花費」（一次性消耗，不是佔用）：
 * ⌈數量 × 有效 prodCostPer100 ÷ 100⌉，用「含科技加成後」的 prodCostPer100
 * （applyTechBonuses 的 prodCost target）。不乘時代係數（AI 兵種設計已按
 * 基準等比定價，再乘會重複放大）。招募當下從當回合剩餘可用生產力扣除、
 * 記錄為流量（recruit_production_spends），跨回合自動失效；解散不退還。
 */
export function recruitProductionSpend(
  template: Pick<MilitaryUnitTemplate, "prodCostPer100">,
  quantity: number,
): number {
  if (quantity <= 0 || template.prodCostPer100 <= 0) return 0;
  return Math.ceil((quantity * template.prodCostPer100) / 100);
}

/**
 * 招募成本（人口 = 單價 × 數量；生產力佔用 = unitProductionReservation，
 * 與金錢購買完全同一條公式——Task #557）。
 *
 * 徵召只扣「生產力佔用 + 人口 + 木材/礦石」；回傳的 `money` 僅為單位資訊，
 * 徵召不收費，金錢僅用於另一條「金錢購買」路徑（該路徑另有每日額度限制）。
 */
export function recruitCost(
  template: Pick<
    MilitaryUnitTemplate,
    | "prodUpkeepPerUnit"
    | "moneyCostPerUnit"
    | "popCostPerUnit"
    | "woodCostPerUnit"
    | "oreCostPerUnit"
  >,
  quantity: number,
): {
  production: number;
  population: number;
  money: number;
  wood: number;
  ore: number;
} {
  return {
    // 佔用（持續壓低上限；解散按比例釋放）。
    production: unitProductionReservation(template, quantity),
    population: quantity * template.popCostPerUnit,
    money: template.moneyCostPerUnit * quantity,
    // Task #406 — 木材／礦石製造成本不隨時代與科技放大（原料量固定）。
    wood: quantity * template.woodCostPerUnit,
    ore: quantity * template.oreCostPerUnit,
  };
}

/**
 * 解散／刪除部隊時應「釋放」的資源預留量（生產力或人口）。
 *
 * 每支軍隊列記錄其占用的 production_reserved／population_reserved；解散其中一部分時，
 * 依「移除數量 ÷ 原數量」比例釋放（向下取整，偏保守不超額釋放）；整批移除（removed ≥ old）
 * 則全數釋放，避免殘留無法歸還的預留量。Task #546 起金錢購買也佔用生產力
 * （purchaseProductionReservation），解散時同樣按比例釋放；更早的歷史購買列
 * 預留量為 0，解散它們自然釋放 0，不會誤退從未占用過的生產力。
 */
export function releaseReservation(
  oldQuantity: number,
  removedQuantity: number,
  reserved: number,
): number {
  if (reserved <= 0 || removedQuantity <= 0 || oldQuantity <= 0) return 0;
  if (removedQuantity >= oldQuantity) return reserved;
  return Math.floor((reserved * removedQuantity) / oldQuantity);
}

/** 每日金錢購買上限 ≈ 玩家總人口的 1%（至少 0）。 */
export function dailyPurchaseCap(population: number): number {
  return Math.max(0, Math.floor(population * 0.01));
}

/** 招募/購買數量的單次上限（防止 int 溢位與惡意輸入）。 */
export const MAX_ORDER_QUANTITY = 10_000_000;

/** Task #365 — 每單位維護費的下限；任何兵種每回合至少要付一點維護費。 */
export const MIN_UPKEEP_PER_UNIT = 0.1;

const BONUS_TARGETS = [
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

export type BonusTarget = (typeof BONUS_TARGETS)[number];

export function isBonusTarget(v: string): v is BonusTarget {
  return (BONUS_TARGETS as readonly string[]).includes(v);
}

/** 套用科技加成後的有效數值（含成本）。 */
export interface EffectiveUnitStats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  accuracy: number;
  prodCostPer100: number;
  popCostPerUnit: number;
  moneyCostPerUnit: number;
  /** 金錢維護費（每單位／回合）。 */
  upkeepPerUnit: number;
  /** 生產力維護費（每單位／回合）；與金錢維護費共用 upkeep 加成。 */
  prodUpkeepPerUnit: number;
  /** 木材製造成本（每單位）；原料量固定，不吃科技加成。 */
  woodCostPerUnit: number;
  /** 礦石製造成本（每單位）；原料量固定，不吃科技加成。 */
  oreCostPerUnit: number;
}

/**
 * 科技加成疊算：同一 target 的百分比「相加」後一次套用
 * （例：+50% 與 +20% → ×1.7；-30% 與 -30% → ×0.4）。
 * 任何欄位不會低於 0；成本欄位至少為 0。
 */
export function applyTechBonuses(
  template: Pick<
    MilitaryUnitTemplate,
    | "category"
    | "hp"
    | "attack"
    | "defense"
    | "speed"
    | "accuracy"
    | "prodCostPer100"
    | "popCostPerUnit"
    | "moneyCostPerUnit"
    | "upkeepPerUnit"
    | "prodUpkeepPerUnit"
    | "woodCostPerUnit"
    | "oreCostPerUnit"
  >,
  techs: readonly { bonuses: MilitaryTechBonus[] }[],
  /**
   * 時代開銷係數（lib/eraCostScale.ts，預設 1 = 不縮放）。只縮放「金錢售價」
   * 「金錢維護費」與「招募一次性生產力花費」；佔用型 prodUpkeepPerUnit 不縮放
   * （它寫入 player_armies.production_reserved，受 production_spent 不變量約束）。
   */
  eraScale = 1,
): EffectiveUnitStats {
  const pctByTarget = new Map<BonusTarget, number>();
  for (const tech of techs) {
    for (const bonus of tech.bonuses as MilitaryTechBonus[]) {
      if (!isBonusTarget(bonus.target)) continue;
      if (bonus.category !== null && bonus.category !== template.category) {
        continue;
      }
      pctByTarget.set(
        bonus.target,
        (pctByTarget.get(bonus.target) ?? 0) + bonus.pct,
      );
    }
  }

  const factor = (target: BonusTarget): number =>
    Math.max(0, 1 + (pctByTarget.get(target) ?? 0) / 100);

  return {
    hp: Math.max(0, Math.round(template.hp * factor("hp"))),
    attack: Math.max(0, Math.round(template.attack * factor("attack"))),
    defense: Math.max(0, Math.round(template.defense * factor("defense"))),
    speed: Math.max(
      0,
      Math.round(template.speed * factor("speed") * 100) / 100,
    ),
    accuracy: Math.max(0, Math.round(template.accuracy * factor("accuracy"))),
    prodCostPer100: Math.max(
      0,
      Math.round(template.prodCostPer100 * factor("prodCost") * eraScale),
    ),
    // Task #382 — 每單位人口消耗硬下限 1（糧食系統口徑：軍人數 = Σ 數量 × 人口消耗）。
    popCostPerUnit: Math.max(
      1,
      Math.round(template.popCostPerUnit * factor("popCost")),
    ),
    moneyCostPerUnit: Math.max(
      0,
      Math.round(template.moneyCostPerUnit * factor("moneyCost") * eraScale),
    ),
    upkeepPerUnit: Math.max(
      MIN_UPKEEP_PER_UNIT,
      Math.round(template.upkeepPerUnit * factor("upkeep") * eraScale * 100) / 100,
    ),
    prodUpkeepPerUnit: Math.max(
      MIN_UPKEEP_PER_UNIT,
      Math.round(template.prodUpkeepPerUnit * factor("upkeep") * 100) / 100,
    ),
    // Task #406 — 原料成本固定，不吃科技加成。
    woodCostPerUnit: template.woodCostPerUnit,
    oreCostPerUnit: template.oreCostPerUnit,
  };
}

/** 正規化科技研究方向（庫存查詢鍵）：trim、壓縮空白、lower-case。 */
export function normalizeTechDirection(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Task #63 — 每個兵種類別最多可持有的自創兵種數。 */
export const MAX_CUSTOM_UNITS_PER_CATEGORY = 5;

/**
 * Task #510 — 兵種設計次數上限（體力條式）：建國即滿、每日回合 +1、
 * 每次 AI 設計消耗 1 次（AI 失敗退回 1 次，同樣封頂）。
 */
export const UNIT_DESIGN_CHARGE_CAP = 5;

/**
 * Task #63 — 自訂兵種顯示名稱的正規化：trim 後空字串視為「清空還原」
 * （回傳 null）；超過 40 字回傳錯誤訊息（zh-TW）。
 */
export function normalizeCustomUnitName(
  raw: string | null | undefined,
): { ok: true; name: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, name: null };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, name: null };
  if (trimmed.length > 40) {
    return { ok: false, error: "兵種名稱不可超過 40 字" };
  }
  return { ok: true, name: trimmed };
}

/** 彙總後的單項加成：同 target×category 的 pct 相加。 */
export interface TechBonusSummaryEntry {
  target: string;
  category: string | null;
  pct: number;
}

const BONUS_TARGET_LABEL: Record<string, string> = {
  hp: "生命值",
  attack: "攻擊力",
  defense: "防禦力",
  speed: "速度",
  accuracy: "命中率",
  prodCost: "招募生產力成本",
  popCost: "招募人口成本",
  moneyCost: "金錢購買價格",
  upkeep: "維護費",
  recoverySpeed: "傷兵復原速度",
  recoveryRate: "傷兵復原率",
  seaLandingCapacity: "海上登陸容許量",
  landingAttackReduction: "登陸減損攻擊力",
  foodConsumption: "軍糧消耗",
};

/** 以繁體中文描述單一加成，例如「步兵攻擊力 +30%」。 */
export function describeMilitaryBonus(bonus: {
  target: string;
  category: string | null;
  pct: number;
}): string {
  const cat =
    bonus.category === null
      ? "全兵種"
      : categoryLabel(bonus.category as MilitaryCategory, "future");
  const targetLabel = BONUS_TARGET_LABEL[bonus.target] ?? bonus.target;
  const sign = bonus.pct >= 0 ? "+" : "";
  return `${cat}${targetLabel} ${sign}${bonus.pct}%`;
}

/**
 * Task #63 — 已研究科技的累積加成總覽：把所有加成按（target, category）
 * 分組相加（與 applyTechBonuses 的「同 target 百分比相加」邏輯一致，
 * 但保留 category 維度供 UI 顯示「步兵攻擊 +15%」）。pct 合計為 0 的
 * 項目會被剔除；輸出依 target 再 category 排序，結果穩定。
 */
export function summarizeTechBonuses(
  techs: readonly { bonuses: MilitaryTechBonus[] }[],
): TechBonusSummaryEntry[] {
  const byKey = new Map<string, TechBonusSummaryEntry>();
  for (const tech of techs) {
    for (const bonus of tech.bonuses as MilitaryTechBonus[]) {
      const category = bonus.category ?? null;
      const key = `${bonus.target}\u0000${category ?? ""}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.pct += bonus.pct;
      } else {
        byKey.set(key, { target: bonus.target, category, pct: bonus.pct });
      }
    }
  }
  return [...byKey.values()]
    .filter((e) => e.pct !== 0)
    .sort(
      (a, b) =>
        a.target.localeCompare(b.target) ||
        (a.category ?? "").localeCompare(b.category ?? ""),
    );
}
