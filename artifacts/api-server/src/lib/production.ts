import type {
  ProductionTechEffect,
  ProductionTechEffectTarget,
} from "@workspace/db";
import { ERAS, getEraIndex, isEraSlug } from "./mapRegionEras";
import { nextEraSlug } from "./socialTech";

/**
 * Task #149 — 生產科技系統的純函式（DB-free、可單元測試）。
 *
 * 內含：10 項生產關鍵技術定義與其效果、關鍵技術→建築解鎖對照、城市建築定義
 * （建造成本／維護費／加成）、效果彙總（單一真實來源）、領域時代推進規則與
 * 關鍵技術成本。牌組機制（3 選 1）與社會科技共用 socialTech.ts 的泛用函式。
 */

/** 領域推進門檻：完成該時代全部關鍵技術、且該時代研究數達此值 → 下回合進代。 */
export const PRODUCTION_ERA_RESEARCH_REQUIREMENT = 10;

/** 暫時人口增長 buff 的持續回合數（研發帶 tempPopulationGrowth 的科技時觸發）。 */
export const TEMP_POP_GROWTH_TURNS = 3;

// ── 城市建築 ────────────────────────────────────────────────

/** 建築可提供的加成（皆為百分比、可堆疊疊加）。 */
export interface BuildingEffect {
  target: "productivity" | "techPoints" | "populationGrowth";
  value: number;
}

export interface BuildingDef {
  /** 穩定識別字（存於 city_buildings.building_type）。 */
  type: string;
  name: string;
  description: string;
  /** 建造成本（金錢）。 */
  buildCost: number;
  /** 每回合維護費（金錢；風車技術可減免）。 */
  upkeep: number;
  effects: BuildingEffect[];
}

/**
 * 6 種城市建築。解鎖由關鍵技術決定（見 KEY_TECH_BUILDINGS）；同型可堆疊，
 * 效果疊加。建造成本／維護費隨建築層級遞增。
 */
export const BUILDINGS: readonly BuildingDef[] = [
  {
    type: "granary",
    name: "糧倉",
    description: "囤糧備荒、穩定民生，促進人口增長。",
    buildCost: 800,
    upkeep: 30,
    effects: [{ target: "populationGrowth", value: 2 }],
  },
  {
    type: "workshop",
    name: "工作坊",
    description: "集中手工生產，提升地區生產力。",
    buildCost: 1200,
    upkeep: 40,
    effects: [{ target: "productivity", value: 4 }],
  },
  {
    type: "library",
    name: "圖書館",
    description: "典藏知識、培育人才，加速科技發展。",
    buildCost: 1800,
    upkeep: 60,
    effects: [{ target: "techPoints", value: 5 }],
  },
  {
    type: "watermill",
    name: "水車",
    description: "以水力驅動器械，大幅提升生產力。",
    buildCost: 2000,
    upkeep: 70,
    effects: [{ target: "productivity", value: 6 }],
  },
  {
    type: "factory",
    name: "工廠",
    description: "機械化量產，帶來巨幅生產力躍升。",
    buildCost: 6000,
    upkeep: 200,
    effects: [{ target: "productivity", value: 12 }],
  },
  {
    type: "gas_plant",
    name: "燃氣電廠",
    description: "穩定供電，同時推升生產力與科技發展。",
    buildCost: 10000,
    upkeep: 350,
    effects: [
      { target: "productivity", value: 8 },
      { target: "techPoints", value: 5 },
    ],
  },
] as const;

const BUILDING_BY_TYPE = new Map(BUILDINGS.map((b) => [b.type, b]));

export function buildingByType(type: string): BuildingDef | null {
  return BUILDING_BY_TYPE.get(type) ?? null;
}

// ── 關鍵技術 ────────────────────────────────────────────────

export interface ProductionKeyTechDef {
  /** 穩定識別字（存於 production_techs.key_slug）。 */
  keySlug: string;
  eraSlug: string;
  name: string;
  description: string;
  effects: ProductionTechEffect[];
}

/**
 * 10 項生產關鍵技術（星號）。建築解鎖不放在 effects——見 KEY_TECH_BUILDINGS。
 * 順序即種入順序。
 */
export const PRODUCTION_KEY_TECHS: readonly ProductionKeyTechDef[] = [
  {
    keySlug: "irrigation",
    eraSlug: "classical",
    name: "灌溉農業",
    description: "興修水利、開闢良田；提升生產力，並在短期內帶動人口激增。解鎖糧倉。",
    effects: [
      { target: "productivity", value: 5 },
      { target: "tempPopulationGrowth", value: 50 },
    ],
  },
  {
    keySlug: "handicraft",
    eraSlug: "roman",
    name: "手工工藝",
    description: "工匠分工精進，器物產量提升。解鎖工作坊。",
    effects: [{ target: "productivity", value: 6 }],
  },
  {
    keySlug: "papermaking",
    eraSlug: "roman",
    name: "造紙術",
    description: "紙張普及，文書與知識流通加速；開啟內政的文化滿意度面向。",
    effects: [
      { target: "techPoints", value: 5 },
      { target: "enableCulture", value: 1 },
    ],
  },
  {
    keySlug: "water_power",
    eraSlug: "early_medieval",
    name: "水力技術",
    description: "以水力驅動磨坊與器械，生產力大增。解鎖水車。",
    effects: [{ target: "productivity", value: 8 }],
  },
  {
    keySlug: "manuscript",
    eraSlug: "early_medieval",
    name: "抄本圖書",
    description: "抄本典籍匯聚，知識制度化，科技發展加速。解鎖圖書館。",
    effects: [{ target: "techPoints", value: 8 }],
  },
  {
    keySlug: "windmill",
    eraSlug: "high_medieval",
    name: "風車技術",
    description: "風車遍佈城郊，機械維護更省成本；建築維護費減半。解鎖城牆建設。",
    effects: [
      { target: "productivity", value: 5 },
      { target: "buildingUpkeepReduction", value: 50 },
      { target: "enableCityWall", value: 1 },
    ],
  },
  {
    keySlug: "crop_rotation",
    eraSlug: "renaissance",
    name: "三圃輪作",
    description: "輪作制度提升地力，糧產穩定；長期提升人口增長率並短期激增人口。",
    effects: [
      { target: "populationGrowth", value: 3 },
      { target: "tempPopulationGrowth", value: 50 },
    ],
  },
  {
    keySlug: "oceanic_shipbuilding",
    eraSlug: "discovery",
    name: "遠洋造船",
    description: "遠洋帆船技術成熟，開啟海外拓殖與海軍建設（旗標，後續系統再啟用）。",
    effects: [
      { target: "productivity", value: 8 },
      { target: "enableColonization", value: 1 },
      { target: "enableNaval", value: 1 },
    ],
  },
  {
    keySlug: "industrialization",
    eraSlug: "industrial",
    name: "工業化",
    description: "蒸汽動力與機械量產帶來生產力革命。解鎖工廠。",
    effects: [{ target: "productivity", value: 15 }],
  },
  {
    keySlug: "electrification",
    eraSlug: "ww2",
    name: "電氣化",
    description: "電力普及驅動工業與研究，全面提升生產力與科技發展。解鎖燃氣電廠。",
    effects: [
      { target: "productivity", value: 10 },
      { target: "techPoints", value: 8 },
    ],
  },
] as const;

/** 關鍵技術 → 解鎖建築（building type）對照。 */
export const KEY_TECH_BUILDINGS: Readonly<Record<string, readonly string[]>> = {
  irrigation: ["granary"],
  handicraft: ["workshop"],
  water_power: ["watermill"],
  manuscript: ["library"],
  industrialization: ["factory"],
  electrification: ["gas_plant"],
};

const KEY_TECH_BY_SLUG = new Map(
  PRODUCTION_KEY_TECHS.map((k) => [k.keySlug, k]),
);

export function productionKeyTechBySlug(
  slug: string,
): ProductionKeyTechDef | null {
  return KEY_TECH_BY_SLUG.get(slug) ?? null;
}

/** 指定時代的關鍵技術（依種入順序）。 */
export function productionKeyTechsForEra(
  eraSlug: string,
): ProductionKeyTechDef[] {
  return PRODUCTION_KEY_TECHS.filter((k) => k.eraSlug === eraSlug);
}

/**
 * 領域是否應在下一回合推進到新時代：該時代全部關鍵技術皆已研發，且該時代
 * 研究數達門檻。
 */
export function shouldAdvanceProductionDomainEra(params: {
  currentEraKeyTechSlugs: readonly string[];
  researchedKeySlugs: readonly string[];
  researchedCountInEra: number;
}): boolean {
  const done = new Set(params.researchedKeySlugs);
  const allKeyDone = params.currentEraKeyTechSlugs.every((s) => done.has(s));
  return (
    allKeyDone &&
    params.researchedCountInEra >= PRODUCTION_ERA_RESEARCH_REQUIREMENT
  );
}

/** 生產關鍵技術的固定研發成本（隨時代科技平均值放大；比一般 AI 科技昂貴）。 */
export function productionKeyTechCost(eraSlug: string): number {
  const era = ERAS[getEraIndex(eraSlug)]!;
  return Math.max(20, Math.round(era.techAvg * 3));
}

// ── 效果彙總（單一真實來源） ────────────────────────────────────

export interface ResearchedProductionTechInput {
  keySlug: string | null;
  effects: ProductionTechEffect[];
}

export interface AggregatedProductionEffects {
  unlockedKeyTechSlugs: string[];
  productivityBonusPct: number;
  techPointsBonusPct: number;
  populationGrowthBonusPct: number;
  /** 建築維護費減免（百分比，0..100）。 */
  buildingUpkeepReductionPct: number;
  /** 已解鎖可興建的建築 type 清單。 */
  unlockedBuildings: string[];
  cultureEnabled: boolean;
  cityWallEnabled: boolean;
  colonizationEnabled: boolean;
  navalEnabled: boolean;
}

/**
 * 效果彙總：輸入某國家已研發的生產科技，回傳彙總後的加成、旗標與已解鎖建築。
 * 政治／地區／回合引擎一律讀取此函式（避免各系統各自實作）。
 */
export function aggregateProductionEffects(
  researched: readonly ResearchedProductionTechInput[],
): AggregatedProductionEffects {
  const agg: AggregatedProductionEffects = {
    unlockedKeyTechSlugs: [],
    productivityBonusPct: 0,
    techPointsBonusPct: 0,
    populationGrowthBonusPct: 0,
    buildingUpkeepReductionPct: 0,
    unlockedBuildings: [],
    cultureEnabled: false,
    cityWallEnabled: false,
    colonizationEnabled: false,
    navalEnabled: false,
  };
  const keys = new Set<string>();
  const buildings = new Set<string>();

  for (const tech of researched) {
    if (tech.keySlug) {
      keys.add(tech.keySlug);
      for (const b of KEY_TECH_BUILDINGS[tech.keySlug] ?? []) buildings.add(b);
    }
    for (const eff of tech.effects) applyEffect(agg, eff);
  }

  agg.buildingUpkeepReductionPct = Math.min(
    100,
    Math.max(0, agg.buildingUpkeepReductionPct),
  );
  agg.unlockedKeyTechSlugs = [...keys];
  agg.unlockedBuildings = [...buildings];
  return agg;
}

function applyEffect(
  agg: AggregatedProductionEffects,
  eff: ProductionTechEffect,
): void {
  switch (eff.target) {
    case "productivity":
      agg.productivityBonusPct += eff.value;
      break;
    case "techPoints":
      agg.techPointsBonusPct += eff.value;
      break;
    case "populationGrowth":
      agg.populationGrowthBonusPct += eff.value;
      break;
    case "buildingUpkeepReduction":
      agg.buildingUpkeepReductionPct += eff.value;
      break;
    case "tempPopulationGrowth":
      // 研發時觸發的暫時 buff，不併入常駐彙總。
      break;
    case "enableCulture":
      agg.cultureEnabled = true;
      break;
    case "enableCityWall":
      agg.cityWallEnabled = true;
      break;
    case "enableColonization":
      agg.colonizationEnabled = true;
      break;
    case "enableNaval":
      agg.navalEnabled = true;
      break;
  }
}

/** 建築加成彙總（跨玩家所有建築；效果疊加）。 */
export interface AggregatedBuildingEffects {
  productivityBonusPct: number;
  techPointsBonusPct: number;
  populationGrowthBonusPct: number;
  /** 減免前的每回合維護費總額。 */
  upkeepTotal: number;
  count: number;
}

export function aggregateBuildingEffects(
  buildingTypes: readonly string[],
): AggregatedBuildingEffects {
  const agg: AggregatedBuildingEffects = {
    productivityBonusPct: 0,
    techPointsBonusPct: 0,
    populationGrowthBonusPct: 0,
    upkeepTotal: 0,
    count: 0,
  };
  for (const type of buildingTypes) {
    const def = BUILDING_BY_TYPE.get(type);
    if (!def) continue;
    agg.count += 1;
    agg.upkeepTotal += def.upkeep;
    for (const eff of def.effects) {
      if (eff.target === "productivity") agg.productivityBonusPct += eff.value;
      else if (eff.target === "techPoints")
        agg.techPointsBonusPct += eff.value;
      else if (eff.target === "populationGrowth")
        agg.populationGrowthBonusPct += eff.value;
    }
  }
  return agg;
}

// ── 生產力加成來源明細（Task #528，純函式） ─────────────────────

/** 生產力加成來源（科技節點）：名稱＋生產力加成 %。 */
export interface ProductivityTechSource {
  name: string;
  pct: number;
}

/** 生產力加成來源（建築）：名稱＋同型數量＋合計生產力加成 %。 */
export interface ProductivityBuildingSource {
  name: string;
  count: number;
  pct: number;
}

/**
 * 已研發科技節點中「有生產力加成」者的來源清單（只列 productivity 目標；
 * pct = 該節點 productivity 效果加總）。清單加總必等於
 * aggregateProductionEffects().productivityBonusPct。
 */
export function productivityTechSources(
  nodes: readonly { name: string; effects: ProductionTechEffect[] }[],
): ProductivityTechSource[] {
  const out: ProductivityTechSource[] = [];
  for (const n of nodes) {
    let pct = 0;
    for (const eff of n.effects) {
      if (eff.target === "productivity") pct += eff.value;
    }
    if (pct !== 0) out.push({ name: n.name, pct });
  }
  return out;
}

/**
 * 已研發科技節點中「有人口增長加成」者的來源清單（只列 populationGrowth 目標）。
 * pct = 該節點 populationGrowth 效果加總。
 */
export function populationGrowthTechSources(
  nodes: readonly { name: string; effects: ProductionTechEffect[] }[],
): ProductivityTechSource[] {
  const out: ProductivityTechSource[] = [];
  for (const n of nodes) {
    let pct = 0;
    for (const eff of n.effects) {
      if (eff.target === "populationGrowth") pct += eff.value;
    }
    if (pct !== 0) out.push({ name: n.name, pct });
  }
  return out;
}

/**
 * 建築中「有人口增長加成」者的來源清單（同型合併：count × 單棟加成）。
 * 清單加總必等於 aggregateBuildingEffects().populationGrowthBonusPct。
 */
export function populationGrowthBuildingSources(
  buildingTypes: readonly string[],
): ProductivityBuildingSource[] {
  const counts = new Map<string, number>();
  for (const t of buildingTypes) counts.set(t, (counts.get(t) ?? 0) + 1);
  const out: ProductivityBuildingSource[] = [];
  for (const def of BUILDINGS) {
    const count = counts.get(def.type) ?? 0;
    if (count === 0) continue;
    let per = 0;
    for (const eff of def.effects) {
      if (eff.target === "populationGrowth") per += eff.value;
    }
    if (per === 0) continue;
    out.push({ name: def.name, count, pct: per * count });
  }
  return out;
}

/**
 * 建築中「有生產力加成」者的來源清單（同型合併：count × 單棟加成）。
 * 清單加總必等於 aggregateBuildingEffects().productivityBonusPct。
 */
export function productivityBuildingSources(
  buildingTypes: readonly string[],
): ProductivityBuildingSource[] {
  const counts = new Map<string, number>();
  for (const t of buildingTypes) counts.set(t, (counts.get(t) ?? 0) + 1);
  const out: ProductivityBuildingSource[] = [];
  for (const def of BUILDINGS) {
    const count = counts.get(def.type) ?? 0;
    if (count === 0) continue;
    let per = 0;
    for (const eff of def.effects) {
      if (eff.target === "productivity") per += eff.value;
    }
    if (per === 0) continue;
    out.push({ name: def.name, count, pct: per * count });
  }
  return out;
}

/** 套用建築維護費減免（百分比）於維護費總額，回傳整數。 */
export function applyUpkeepReduction(
  upkeepTotal: number,
  reductionPct: number,
): number {
  const pct = Math.min(100, Math.max(0, reductionPct));
  return Math.round(upkeepTotal * (1 - pct / 100));
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

/** 單一生產科技效果的 zh-TW 顯示字串。 */
export function describeProductionEffect(eff: ProductionTechEffect): string {
  switch (eff.target) {
    case "productivity":
      return `生產力 ${signed(eff.value)}%`;
    case "techPoints":
      return `科技點數發展 ${signed(eff.value)}%`;
    case "populationGrowth":
      return `人口增長率 ${signed(eff.value)}%`;
    case "tempPopulationGrowth":
      return `人口增長率 ${signed(eff.value)}%（暫時，持續 ${TEMP_POP_GROWTH_TURNS} 回合）`;
    case "buildingUpkeepReduction":
      return `建築維護費 −${eff.value}%`;
    case "enableCulture":
      return "開啟文化滿意度";
    case "enableCityWall":
      return "解鎖城牆建設";
    case "enableColonization":
      return "解鎖海外拓殖";
    case "enableNaval":
      return "解鎖海軍建設";
  }
}

/** 單一建築加成的 zh-TW 顯示字串。 */
export function describeBuildingEffect(eff: BuildingEffect): string {
  switch (eff.target) {
    case "productivity":
      return `生產力 ${signed(eff.value)}%`;
    case "techPoints":
      return `科技點數發展 ${signed(eff.value)}%`;
    case "populationGrowth":
      return `人口增長率 ${signed(eff.value)}%`;
  }
}

const _effectTargets: readonly ProductionTechEffectTarget[] = [
  "productivity",
  "techPoints",
  "populationGrowth",
  "tempPopulationGrowth",
  "buildingUpkeepReduction",
  "enableCulture",
  "enableCityWall",
  "enableColonization",
  "enableNaval",
];

export function isProductionTechEffectTarget(
  v: string,
): v is ProductionTechEffectTarget {
  return (_effectTargets as readonly string[]).includes(v);
}

/** 靜態一致性檢查：關鍵技術時代/建築 slug 合法、無重複 key_slug。 */
export function validateProductionTechTables(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const k of PRODUCTION_KEY_TECHS) {
    if (seen.has(k.keySlug))
      problems.push(`duplicate production key tech slug ${k.keySlug}`);
    seen.add(k.keySlug);
    if (!isEraSlug(k.eraSlug))
      problems.push(`production key tech ${k.keySlug} has unknown era ${k.eraSlug}`);
  }
  for (const [slug, builds] of Object.entries(KEY_TECH_BUILDINGS)) {
    if (!KEY_TECH_BY_SLUG.has(slug))
      problems.push(`building map references unknown key tech ${slug}`);
    for (const b of builds) {
      if (!BUILDING_BY_TYPE.has(b))
        problems.push(`key tech ${slug} references unknown building ${b}`);
    }
  }
  return problems;
}

/** 下一個時代 slug（沿用社會科技的泛用函式）。 */
export { nextEraSlug };
