import type { SocialTechEffect, SocialTechEffectTarget } from "@workspace/db";
import { ERAS, getEraIndex, isEraSlug } from "./mapRegionEras";

/**
 * Task #126 — 社會科技系統的純函式（DB-free、可單元測試）。
 *
 * 內含：8 項社會科學關鍵技術定義與其效果、關鍵技術→政體解鎖對照、
 * 每領域時代推進規則、關鍵技術刷新機率，以及「效果彙總」單一真實來源函式
 * （供政治、地區等後續系統讀取，避免各系統各自實作）。
 */

/** 三個科技領域（本任務只完整啟用 social；production/military 先保留框架）。 */
export const TECH_DOMAINS = ["social", "production", "military"] as const;
export type TechDomain = (typeof TECH_DOMAINS)[number];

export function isTechDomain(v: string): v is TechDomain {
  return (TECH_DOMAINS as readonly string[]).includes(v);
}

export interface KeyTechDef {
  /** 穩定識別字（存於 social_techs.key_slug）。 */
  keySlug: string;
  /** 所屬時代 slug（見 mapRegionEras.ts）。 */
  eraSlug: string;
  name: string;
  description: string;
  effects: SocialTechEffect[];
}

/**
 * 8 項社會科學關鍵技術（星號）。政體解鎖不放在 effects——見
 * KEY_TECH_GOVERNMENTS。順序即種入順序。
 */
export const KEY_TECHS: readonly KeyTechDef[] = [
  {
    keySlug: "political_philosophy",
    eraSlug: "classical",
    name: "政治哲學",
    description:
      "先賢論道治國，奠定政體與制度之基；解鎖政治顧問槽與多種早期政體。",
    effects: [
      { target: "enableAdvisorSlot", value: 1 },
      { target: "taxEfficiency", value: 1 },
    ],
  },
  {
    keySlug: "world_religion",
    eraSlug: "roman",
    name: "世界宗教",
    description:
      "普世信仰跨越族群，凝聚人心；解鎖國家宗教並開啟宗教滿意度面向。",
    effects: [
      { target: "enableNationalReligion", value: 1 },
      { target: "enableReligionSatisfaction", value: 1 },
      { target: "taxEfficiency", value: 2 },
    ],
  },
  {
    keySlug: "tribal_innovation",
    eraSlug: "roman",
    name: "部落革新",
    description: "聚落走向城邑，開啟城市建築槽系統（起始 5 格）。",
    effects: [
      { target: "enableBuildingSlots", value: 5 },
      { target: "taxEfficiency", value: 3 },
    ],
  },
  {
    keySlug: "university_system",
    eraSlug: "early_medieval",
    name: "大學制度",
    description:
      "學府林立，知識制度化；解鎖圖書館以外的科學建築（建築本體屬日後生產科技）。",
    effects: [{ target: "buildingSlots", value: 5 }],
  },
  {
    keySlug: "guild_innovation",
    eraSlug: "high_medieval",
    name: "行會革新",
    description: "工商行會壯大，城市機能擴張；建築槽增加、稅政效率提升、厭戰情緒趨緩。",
    effects: [
      { target: "buildingSlots", value: 10 },
      { target: "taxEfficiency", value: 5 },
      { target: "warWearinessGrowth", value: -50 },
    ],
  },
  {
    keySlug: "divine_right",
    eraSlug: "renaissance",
    name: "君權神授",
    description:
      "王權神聖化，中央集權強化；解鎖立憲君主諸制、開啟人權滿意度並促進人口增長。",
    effects: [
      { target: "taxEfficiency", value: 10 },
      { target: "populationGrowth", value: 5 },
      { target: "enableRightsSatisfaction", value: 1 },
    ],
  },
  {
    keySlug: "separation_of_powers",
    eraSlug: "enlightenment",
    name: "三權分立",
    description: "行政、立法、司法分權制衡；解鎖近代民主諸制，行政效率與城建大增。",
    effects: [
      { target: "taxEfficiency", value: 10 },
      { target: "buildingSlots", value: 10 },
    ],
  },
  {
    keySlug: "socialism",
    eraSlug: "industrial",
    name: "社會主義",
    description: "工人運動與公有理念興起；解鎖社會主義委員會制與財閥共和。",
    effects: [],
  },
] as const;

/** 關鍵技術 → 解鎖政體（government slug）對照。政體實際變更機制屬政治任務。 */
export const KEY_TECH_GOVERNMENTS: Readonly<Record<string, readonly string[]>> = {
  political_philosophy: [
    "parliamentary_republic",
    "military_dictatorship",
    "council_system",
    "absolute_monarchy",
  ],
  world_religion: ["theocracy"],
  tribal_innovation: ["aristocracy", "elective_monarchy"],
  divine_right: ["constitutional_monarchy", "dual_monarchy"],
  separation_of_powers: ["presidential_democracy", "confederation", "parliamentary"],
  socialism: ["socialist_council", "plutocracy"],
};

const KEY_TECH_BY_SLUG = new Map(KEY_TECHS.map((k) => [k.keySlug, k]));

export function keyTechBySlug(slug: string): KeyTechDef | null {
  return KEY_TECH_BY_SLUG.get(slug) ?? null;
}

/** 指定時代的關鍵技術（依種入順序）。 */
export function keyTechsForEra(eraSlug: string): KeyTechDef[] {
  return KEY_TECHS.filter((k) => k.eraSlug === eraSlug);
}

/** 下一個時代 slug；已在最後（future）回 null。 */
export function nextEraSlug(eraSlug: string): string | null {
  if (!isEraSlug(eraSlug)) return null;
  const idx = getEraIndex(eraSlug);
  return idx + 1 < ERAS.length ? ERAS[idx + 1]!.slug : null;
}

// ── 效果彙總（單一真實來源） ────────────────────────────────────

export interface ResearchedSocialTechInput {
  /** 關鍵技術的 key_slug；AI 科技為 null。 */
  keySlug: string | null;
  effects: SocialTechEffect[];
}

export interface AggregatedSocialEffects {
  /** 已研發的關鍵技術 key_slug 清單。 */
  unlockedKeyTechSlugs: string[];
  taxEfficiencyBonusPct: number;
  techPointsBonusPct: number;
  populationGrowthBonusPct: number;
  /** 厭戰度增長調整（百分比，負值＝減緩）。 */
  warWearinessGrowthPct: number;
  /** 城市建築槽上限（僅在 buildingSlotsEnabled 時有意義）。 */
  buildingSlots: number;
  buildingSlotsEnabled: boolean;
  /** 已解鎖政體 slug 清單（依 KEY_TECH_GOVERNMENTS）。 */
  unlockedGovernments: string[];
  religionSatisfactionEnabled: boolean;
  rightsSatisfactionEnabled: boolean;
  nationalReligionEnabled: boolean;
  advisorSlotEnabled: boolean;
}

/**
 * 效果彙總：輸入某國家已研發的社會科技（含關鍵技術），回傳彙總後的加成與
 * 開啟旗標、已解鎖政體與關鍵技術清單。政治／地區等系統一律讀取此函式。
 */
export function aggregateSocialEffects(
  researched: readonly ResearchedSocialTechInput[],
): AggregatedSocialEffects {
  const agg: AggregatedSocialEffects = {
    unlockedKeyTechSlugs: [],
    taxEfficiencyBonusPct: 0,
    techPointsBonusPct: 0,
    populationGrowthBonusPct: 0,
    warWearinessGrowthPct: 0,
    buildingSlots: 0,
    buildingSlotsEnabled: false,
    unlockedGovernments: [],
    religionSatisfactionEnabled: false,
    rightsSatisfactionEnabled: false,
    nationalReligionEnabled: false,
    advisorSlotEnabled: false,
  };
  const govs = new Set<string>();
  const keys = new Set<string>();

  for (const tech of researched) {
    if (tech.keySlug) {
      keys.add(tech.keySlug);
      for (const g of KEY_TECH_GOVERNMENTS[tech.keySlug] ?? []) govs.add(g);
    }
    for (const eff of tech.effects) {
      applyEffect(agg, eff);
    }
  }

  agg.unlockedKeyTechSlugs = [...keys];
  agg.unlockedGovernments = [...govs];
  return agg;
}

/**
 * 城市建築槽硬上限（部落革新起始 5 ＋ 大學制度 +5 ＋ 行會革新 +10 ＋
 * 三權分立 +10 ＝ 30；日後生產科技若再加成仍夾在此上限內）。
 */
export const BUILDING_SLOTS_MAX = 30;

/**
 * 每座城市可用的建築槽數：未解鎖建築槽系統（部落革新）時為 0；
 * 否則取彙總值並夾在 0..BUILDING_SLOTS_MAX。純函式、可單元測試。
 */
export function cityBuildingSlots(agg: AggregatedSocialEffects): number {
  if (!agg.buildingSlotsEnabled) return 0;
  return Math.min(BUILDING_SLOTS_MAX, Math.max(0, agg.buildingSlots));
}

function applyEffect(agg: AggregatedSocialEffects, eff: SocialTechEffect): void {
  switch (eff.target) {
    case "taxEfficiency":
      agg.taxEfficiencyBonusPct += eff.value;
      break;
    case "techPoints":
      agg.techPointsBonusPct += eff.value;
      break;
    case "populationGrowth":
      agg.populationGrowthBonusPct += eff.value;
      break;
    case "warWearinessGrowth":
      agg.warWearinessGrowthPct += eff.value;
      break;
    case "buildingSlots":
      agg.buildingSlots += eff.value;
      break;
    case "enableBuildingSlots":
      agg.buildingSlotsEnabled = true;
      agg.buildingSlots += eff.value;
      break;
    case "enableReligionSatisfaction":
      agg.religionSatisfactionEnabled = true;
      break;
    case "enableRightsSatisfaction":
      agg.rightsSatisfactionEnabled = true;
      break;
    case "enableNationalReligion":
      agg.nationalReligionEnabled = true;
      break;
    case "enableAdvisorSlot":
      agg.advisorSlotEnabled = true;
      break;
  }
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

/** 單一效果的 zh-TW 顯示字串（供前端條列）。 */
export function describeSocialEffect(eff: SocialTechEffect): string {
  switch (eff.target) {
    case "taxEfficiency":
      return `收稅效率 ${signed(eff.value)}%`;
    case "techPoints":
      return `科技點數發展 ${signed(eff.value)}%`;
    case "populationGrowth":
      return `人口增長率 ${signed(eff.value)}%`;
    case "warWearinessGrowth":
      return `厭戰度增長 ${signed(eff.value)}%`;
    case "buildingSlots":
      return `城市建築槽 ${signed(eff.value)}`;
    case "enableBuildingSlots":
      return `解鎖城市建築槽系統（起始 ${eff.value} 格）`;
    case "enableReligionSatisfaction":
      return "開啟宗教滿意度";
    case "enableRightsSatisfaction":
      return "開啟人權滿意度";
    case "enableNationalReligion":
      return "解鎖國家宗教";
    case "enableAdvisorSlot":
      return "解鎖政治顧問槽";
  }
}

const _effectTargets: readonly SocialTechEffectTarget[] = [
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
];

export function isSocialTechEffectTarget(v: string): v is SocialTechEffectTarget {
  return (_effectTargets as readonly string[]).includes(v);
}

/** 靜態一致性檢查：關鍵技術時代/政體 slug 合法、無重複 key_slug。 */
export function validateSocialTechTables(governmentSlugs: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const k of KEY_TECHS) {
    if (seen.has(k.keySlug)) problems.push(`duplicate key tech slug ${k.keySlug}`);
    seen.add(k.keySlug);
    if (!isEraSlug(k.eraSlug)) problems.push(`key tech ${k.keySlug} has unknown era ${k.eraSlug}`);
  }
  for (const [slug, govs] of Object.entries(KEY_TECH_GOVERNMENTS)) {
    if (!KEY_TECH_BY_SLUG.has(slug)) problems.push(`gov map references unknown key tech ${slug}`);
    for (const g of govs) {
      if (!governmentSlugs.has(g)) problems.push(`key tech ${slug} references unknown government ${g}`);
    }
  }
  return problems;
}
