import { loadRegionGrowthInputs } from "./regionPopulation";
import { summarizeCapacity } from "./populationCapacity";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  db,
  politicsEntriesTable,
  regionControlsTable,
  mapRegionsTable,
  mapRegionEraStatsTable,
  worldGameStateTable,
  type PlayerNation,
} from "@workspace/db";
import { DEFAULT_ERA_SLUG } from "./mapRegionEras";
import { computeAvailableProduction } from "./economy";
import {
  loadBuildingReservedLines,
  loadProductionReservedLines,
  type BuildingReservedLine,
  type ProductionReservedLine,
} from "./prodUpkeep";
import {
  loadCurrentTurnRecruitSpend,
  loadRecruitSpendLines,
  type RecruitSpendLine,
} from "./recruitSpend";
import {
  adjustStatValue,
  clampGlobalStatMultiplierPct,
  clampPopulationGrowthMultiplierPct,
  computeFoodGrowthRatePct,
  computePoliticsState,
  entryStrength,
  populationGrowthRatePct,
  scaleByGlobalStatMultiplierPct,
  scalePopulationGrowthRatePct,
  stabilityMultiplier,
  type NationPoliticsState,
  type PoliticsDirection,
  type PoliticsEntryType,
} from "./politics";
import { getPoliticsSettings } from "./politicsSettings";
import {
  loadActiveSatisfactionBuffs,
  loadProductionModifierDetailForUser,
  loadProductionModifiersForUser,
  type ProductionModifierDetail,
  type ProductionModifiers,
  type SatisfactionOffsets,
} from "./productionTechData";
import type {
  ProductivityBuildingSource,
  ProductivityTechSource,
} from "./production";
import { loadTreatyProductionNet } from "./treatyProductionFlows";

const ZERO_PRODUCTION_MODS: ProductionModifiers = {
  productionBonusPct: 0,
  techPointsBonusPct: 0,
  populationGrowthBonusPct: 0,
};

/** 全域「生產力／科技點數基礎倍率」（%；0–1000，100 = 不縮放）。 */
export interface GlobalStatMultipliers {
  productionPct: number;
  techPct: number;
}

/**
 * Task #24 — weighted nation stats from controlled regions. For every
 * region_controls row of this player, take the region's current-era stats.
 * 人口／科技點數為單純的控制比例加權：Σ(percent/100 × stat)。
 * 生產力（Task #198）額外反映人口規模：
 *   Σ(生產素質 × 控制比例 × 地區人口 ÷ 1,000,000) ＝ 生產素質 × 控制人口 ÷ 10000。
 * A player with no controlled regions gets all zeros. Rounded to integers.
 *
 * (Extracted from routes/player.ts in Task #27 so the military routes can
 * reuse the same computation.)
 */
export async function computeNationStats(
  nationId: string,
  currentEra: string,
): Promise<{
  /** 總人口 = max(0, round(基準加權人口) + 各地區累積成長量)。 */
  population: number;
  /** 基準加權人口 = round(Σ percent/100 × 地區人口)（不含累積成長量）。 */
  basePopulation: number;
  /** 各掌控地區累積成長量的總和（Task #322；可為負）。 */
  accruedGrowth: number;
  production: number;
  techPerTurn: number;
}> {
  const [row] = await db
    .select({
      basePopulation: sql<string>`COALESCE(SUM(${regionControlsTable.percent}::bigint * ${mapRegionEraStatsTable.population}::bigint / 100.0), 0)`,
      // Task #322 — 人口成長累積量改為 per-region（region_controls.population_bonus）。
      accruedGrowth: sql<string>`COALESCE(SUM(${regionControlsTable.populationBonus}), 0)`,
      // Task #198 — 生產力 = Σ(生產素質 × 控制比例 × 地區人口 ÷ 10,000)
      // Task #405 — 有效生產素質 = era stat + 地區投資累積加成（跨時代固定）。
      production: sql<string>`COALESCE(SUM((${mapRegionEraStatsTable.productivity}::bigint + ${mapRegionsTable.productivityInvestmentBonus}::bigint) * ${regionControlsTable.percent}::bigint * ${mapRegionEraStatsTable.population}::bigint / 10000.0), 0)`,
      techPerTurn: sql<string>`COALESCE(SUM(${regionControlsTable.percent}::bigint * ${mapRegionEraStatsTable.techPoints}::bigint / 100.0), 0)`,
    })
    .from(regionControlsTable)
    .innerJoin(
      mapRegionsTable,
      eq(mapRegionsTable.id, regionControlsTable.regionId),
    )
    .innerJoin(
      mapRegionEraStatsTable,
      and(
        eq(mapRegionEraStatsTable.regionId, regionControlsTable.regionId),
        eq(mapRegionEraStatsTable.era, currentEra),
      ),
    )
    .where(eq(regionControlsTable.nationId, nationId));

  const basePopulation = Math.round(Number(row?.basePopulation ?? 0));
  const accruedGrowth = Math.round(Number(row?.accruedGrowth ?? 0));
  return {
    population: Math.max(0, basePopulation + accruedGrowth),
    basePopulation,
    accruedGrowth,
    production: Math.round(Number(row?.production ?? 0)),
    techPerTurn: Math.round(Number(row?.techPerTurn ?? 0)),
  };
}

/**
 * Task #43 — 內政調整後的國家數值：生產力與科技每回合套用
 * 穩定度 ±max% 乘數與政策百分比加成。
 * 人口 = 地區計算人口（basePopulation）＋ 累積人口增長量（population_bonus，
 * 由每日回合依 populationGrowthRatePct 累加），下限 0。
 * 回傳同時附上內政有效狀態（穩定度／暴動度／厭戰度／滿意度／加減成），
 * 供玩家序列化與軍事總覽重用、避免重複查詢。
 */
export async function computeAdjustedNationStats(
  nation: PlayerNation,
  currentEra: string,
  /**
   * Task #149 — 生產科技/建築/暫時 buff 的合併修正值。回合引擎可批次預載後
   * 傳入以避免每國一次查詢；未傳入且國家有主（discordUserId）時內部自行載入。
   */
  productionMods?: ProductionModifiers,
  /**
   * 全域人口增長倍率（0–100）。回傳的 populationGrowthRatePct 會依此縮放，
   * 使玩家顯示與回合實際套用一致。未傳入時內部自 world_game_state 載入
   * （單列查詢）；回合引擎在批次迴圈中會顯式傳入以避免每國一次查詢。
   */
  populationGrowthMultiplierPct?: number,
  /**
   * Task #355 — 管理員發放的限回合數滿意度暫時偏移（依方向）。回合引擎可批次
   * 預載後傳入以避免每國一次查詢；未傳入且國家有主（discordUserId）時內部自行
   * 載入。回合引擎不需滿意度偏移時應傳入空物件 {} 以停用內部載入。
   */
  satisfactionOffsets?: SatisfactionOffsets,
  /**
   * 生效自訂條約的生產力淨流量（inflow − outflow；可為負）。回合引擎可用
   * loadTreatyProductionNetByNation 批次預載後傳入以避免每國一次查詢；
   * 未傳入時內部自行載入（單國查詢）。
   */
  treatyProductionNet?: number,
  /**
   * 全域「生產力／科技點數基礎倍率」（%；0–1000，100 = 不縮放）。套在調整後
   * 生產力與每回合科技產出的最外層。未傳入時內部自 world_game_state 載入
   * （單列查詢）；回合引擎在批次迴圈中會顯式傳入以避免每國一次查詢。
   */
  globalStatMultipliers?: GlobalStatMultipliers,
): Promise<{
  population: number;
  /** 純地區加權人口（不含人口增長累積量）；回合引擎作為 bonus 下限用。 */
  basePopulation: number;
  production: number;
  techPerTurn: number;
  /** 有效人口增長率（%／回合；基礎 + 加減成，夾 ±上限）。 */
  populationGrowthRatePct: number;
  /** 厭戰度每回合政策 delta（正值=降低厭戰；啟用時才非零）。 */
  warWearinessPolicyDelta: number;
  /** 有效糧食增長率（%；0=無加成）。 */
  foodGrowthRatePct: number;
  politics: NationPoliticsState;
}> {
  const [
    raw,
    settings,
    activeEntries,
    loadedMods,
    loadedMultiplier,
    loadedSat,
    loadedTreatyNet,
    loadedGlobalMults,
  ] = await Promise.all([
    computeNationStats(nation.id, currentEra),
    getPoliticsSettings(),
    db
      .select()
      .from(politicsEntriesTable)
      .where(
        and(
          eq(politicsEntriesTable.nationId, nation.id),
          eq(politicsEntriesTable.status, "active"),
        ),
      ),
    productionMods === undefined && nation.discordUserId
      ? loadProductionModifiersForUser(nation.discordUserId)
      : Promise.resolve<ProductionModifiers | null>(null),
    populationGrowthMultiplierPct === undefined
      ? getPopulationGrowthMultiplierPct()
      : Promise.resolve<number | null>(null),
    satisfactionOffsets === undefined && nation.discordUserId
      ? loadActiveSatisfactionBuffs(nation.discordUserId)
      : Promise.resolve<SatisfactionOffsets | null>(null),
    treatyProductionNet === undefined
      ? loadTreatyProductionNet(nation.id)
      : Promise.resolve<number | null>(null),
    globalStatMultipliers === undefined
      ? getGlobalStatMultipliers()
      : Promise.resolve<GlobalStatMultipliers | null>(null),
  ]);
  const mods = productionMods ?? loadedMods ?? ZERO_PRODUCTION_MODS;
  const treatyNet = treatyProductionNet ?? loadedTreatyNet ?? 0;
  const globalMults = globalStatMultipliers ??
    loadedGlobalMults ?? { productionPct: 100, techPct: 100 };
  const multiplier = clampPopulationGrowthMultiplierPct(
    populationGrowthMultiplierPct ?? loadedMultiplier ?? undefined,
  );
  const satOffsets = satisfactionOffsets ?? loadedSat ?? undefined;
  const politics = computePoliticsState(
    nation,
    activeEntries,
    settings,
    satOffsets,
  );
  return {
    population: raw.population,
    basePopulation: raw.basePopulation,
    // 條約生產力輸送改為純流量（treatyNet：生效條約每回合淨流量，可為負；
    // 廢約即停止、無殘留）；productionBonus 僅剩超事件/管理員的持久偏移。
    // 兩者加到地區計算生產力上，下限 0，再套內政乘數/加成，最外層再套
    // 全域「生產力基礎倍率」（管理員回合設定；四捨五入整數，研發成本
    // 全球平均同步縮放故國力研發倍率不受影響）。
    production: scaleByGlobalStatMultiplierPct(
      adjustStatValue(
        Math.max(0, raw.production + nation.productionBonus + treatyNet),
        politics.stabilityMult,
        politics.productionPct + mods.productionBonusPct,
      ),
      globalMults.productionPct,
    ),
    // 每回合科技產出最外層套全域「科技點數基礎倍率」，回合實際發放
    // （round(techPerTurn)）與玩家顯示皆以此縮放，兩者一致。
    techPerTurn: scaleByGlobalStatMultiplierPct(
      adjustStatValue(
        raw.techPerTurn,
        politics.stabilityMult,
        politics.techPct + mods.techPointsBonusPct,
      ),
      globalMults.techPct,
    ),
    // 有效人口增長率再套全域「人口增長倍率」，使玩家顯示與回合實際套用一致。
    populationGrowthRatePct: scalePopulationGrowthRatePct(
      populationGrowthRatePct(
        politics.populationGrowthPct + mods.populationGrowthBonusPct,
        settings,
      ),
      multiplier,
    ),
    // Task #626 — 厭戰度每回合政策 delta（啟用開關控制；0=關閉）。
    warWearinessPolicyDelta: settings.warWearinessModifierEnabled !== 0
      ? politics.warWearinessPolicyDelta
      : 0,
    // Task #626 — 有效糧食增長率（%；0=無加成；基礎+政策夾在 0.01–10%）。
    foodGrowthRatePct: computeFoodGrowthRatePct(politics.foodGrowthPct, settings),
    politics,
  };
}

/** 顯示用：四捨五入至最多一位小數（回合結算仍用完整精度）。 */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 掌控地區對各數值的加權貢獻（percent/100 × 該時代地區數值）。 */
export interface RegionStatContribution {
  regionId: number;
  name: string;
  macroRegion: string;
  percent: number;
  /** 加權後的人口貢獻（percent/100 × 地區人口）。 */
  population: number;
  /** 加權後的生產力貢獻。 */
  productivity: number;
  /** 加權後的科技點數貢獻。 */
  techPoints: number;
  /** Task #528 — 該時代地區基礎生產素質（era stat，未含投資加成）。 */
  baseProductivity: number;
  /** Task #528 — 地區投資累積生產素質加成（跨時代固定；0 = 無）。 */
  productivityInvestBonus: number;
}

/** 逐條政策/傳統/變革/事件對穩定度的（淡化後）加減成。 */
export interface StabilityModifierEntry {
  title: string;
  entryType: PoliticsEntryType;
  direction: PoliticsDirection;
  /** 淡化後的穩定度加減成（可為正負）。 */
  value: number;
}

export interface NationStatBreakdown {
  era: string;
  regions: RegionStatContribution[];
  production: {
    /** 地區加權基礎生產力合計（不含條約轉移）。 */
    regionBase: number;
    /** 生效條約每回合生產力淨流量（可正負；廢約即停止）。 */
    treatyBonus: number;
    /** 其他持久生產力偏移（超事件/管理員；production_bonus，可正負）。 */
    otherBonus: number;
    /** 基礎合計 = max(0, 地區加權 + 條約流量 + 其他偏移)。 */
    base: number;
    stabilityMult: number;
    policyPct: number;
    /** 生產科技加成（%）。 */
    techPct: number;
    /** 建築加成（%）。 */
    buildingPct: number;
    /** 生產科技加成的來源清單（節點名稱＋%）。 */
    techSources: ProductivityTechSource[];
    /** 建築加成的來源清單（建築名稱＋數量＋合計 %）。 */
    buildingSources: ProductivityBuildingSource[];
    /** 全域生產力基礎倍率（%；100 = 不縮放，管理員回合設定；最外層縮放）。 */
    globalMultiplierPct: number;
    total: number;
    /** 佔用合計（= 軍事 + 建築；production_spent）。 */
    spent: number;
    /** 軍事佔用（Σ 軍隊 production_reserved）。 */
    armySpent: number;
    /** 建築佔用（Σ 地區資源建築 production_reserved）。 */
    buildingSpent: number;
    remaining: number;
    /** Task #568 — 本回合招募花費合計（跨回合自動歸零；解散不退還）。 */
    recruitSpendThisTurn: number;
    /** Task #568 — 本回合招募花費逐筆明細（新→舊）。 */
    recruitSpendLines: RecruitSpendLine[];
    /** Task #541 — 逐兵種的生產力佔用明細（production_reserved 彙總）。 */
    spentLines: ProductionReservedLine[];
    /** 逐建築的生產力佔用明細（region_buildings.production_reserved）。 */
    buildingSpentLines: BuildingReservedLine[];
  };
  tech: {
    base: number;
    stabilityMult: number;
    policyPct: number;
    techBonusPct: number;
    /** 全域科技點數基礎倍率（%；100 = 不縮放，管理員回合設定；最外層縮放）。 */
    globalMultiplierPct: number;
    total: number;
  };
  population: {
    base: number;
    accruedGrowth: number;
    total: number;
    spent: number;
    remaining: number;
    growth: {
      basePct: number;
      policyPct: number;
      /** 科技樹人口增長加成（百分點）。 */
      techPct: number;
      /** 建築人口增長加成（百分點）。 */
      buildingPct: number;
      /** 暫時人口 buff 增長加成（百分點）。 */
      buffPct: number;
      capAbsPct: number;
      /** 有效增長率／出生率(尚未受承載量限制)。 */
      effectivePct: number;
      /** 實際淨成長率(%/回合):出生率套上承載量後的期望值,超載時為負。 */
      netPct: number;
      /** 全國人口承載量(各掌控地區加總)。 */
      capacity: number;
      /** 人口 ÷ 承載量;大於 1 = 超載(緩慢回落)。 */
      loadRatio: number;
      /** 人口增長加成：科技節點來源清單。 */
      techSources: ProductivityTechSource[];
      /** 人口增長加成：建築來源清單。 */
      buildingSources: ProductivityBuildingSource[];
    };
  };
  politics: {
    stabilityBase: number;
    stabilityEntries: StabilityModifierEntry[];
    stabilityEffective: number;
    unrest: number;
    warWeariness: number;
    satisfactions: Record<PoliticsDirection, number>;
    satisfactionHighThreshold: number;
    satisfactionLowThreshold: number;
  };
}

/** 載入掌控地區於指定時代的加權貢獻清單（依大區/種子順序）。 */
async function loadRegionContributions(
  nationId: string,
  era: string,
): Promise<RegionStatContribution[]> {
  const rows = await db
    .select({
      regionId: mapRegionsTable.id,
      name: mapRegionsTable.name,
      macroRegion: mapRegionsTable.macroRegion,
      percent: regionControlsTable.percent,
      accrued: regionControlsTable.populationBonus,
      population: mapRegionEraStatsTable.population,
      productivity: mapRegionEraStatsTable.productivity,
      investBonus: mapRegionsTable.productivityInvestmentBonus,
      techPoints: mapRegionEraStatsTable.techPoints,
    })
    .from(regionControlsTable)
    .innerJoin(mapRegionsTable, eq(mapRegionsTable.id, regionControlsTable.regionId))
    .innerJoin(
      mapRegionEraStatsTable,
      and(
        eq(mapRegionEraStatsTable.regionId, regionControlsTable.regionId),
        eq(mapRegionEraStatsTable.era, era),
      ),
    )
    .where(eq(regionControlsTable.nationId, nationId))
    .orderBy(asc(mapRegionsTable.id));

  return rows.map((r) => {
    const w = r.percent / 100;
    return {
      regionId: r.regionId,
      name: r.name,
      macroRegion: r.macroRegion,
      percent: r.percent,
      // Task #322 — 人口貢獻 = 基準加權人口 + 該地區累積成長量，下限 0。
      population: Math.max(0, Math.round(Number(r.population) * w) + r.accrued),
      // Task #198 — 生產力貢獻 = 生產素質 × 控制比例 × 地區人口 ÷ 10,000。
      // Task #405 — 生產素質採有效值（era stat + 地區投資累積加成）。
      productivity: Math.round(
        ((Number(r.productivity) + r.investBonus) *
          r.percent *
          Number(r.population)) /
          10000,
      ),
      techPoints: Math.round(Number(r.techPoints) * w),
      // Task #528 — 生產力組成攤開：基礎素質（era stat）與投資加成分列。
      baseProductivity: Number(r.productivity),
      productivityInvestBonus: r.investBonus,
    };
  });
}

/**
 * Task #179 — 數值來源明細：把「現有計算結果」的組成逐層攤開，供前端彈窗。
 * 重用 computeNationStats / computePoliticsState / 生產科技修正等既有算式，
 * 不重寫任何計算邏輯，只是把中間值呈現出來（顯示層四捨五入一位小數）。
 */
export async function buildNationStatBreakdown(
  nation: PlayerNation,
  era: string,
): Promise<NationStatBreakdown> {
  const [
    raw,
    regions,
    settings,
    activeEntries,
    loadedDetail,
    multiplier,
    loadedSat,
    recruitSpendThisTurn,
    recruitSpendLines,
    spentLines,
    buildingSpentLines,
    treatyNet,
    globalMults,
  ] = await Promise.all([
    computeNationStats(nation.id, era),
    loadRegionContributions(nation.id, era),
    getPoliticsSettings(),
    db
      .select()
      .from(politicsEntriesTable)
      .where(
        and(
          eq(politicsEntriesTable.nationId, nation.id),
          eq(politicsEntriesTable.status, "active"),
        ),
      ),
    nation.discordUserId
      ? loadProductionModifierDetailForUser(nation.discordUserId)
      : Promise.resolve<ProductionModifierDetail | null>(null),
    getPopulationGrowthMultiplierPct(),
    nation.discordUserId
      ? loadActiveSatisfactionBuffs(nation.discordUserId)
      : Promise.resolve<SatisfactionOffsets | null>(null),
    loadCurrentTurnRecruitSpend(nation.id),
    loadRecruitSpendLines(nation.id),
    loadProductionReservedLines(nation.discordUserId),
    loadBuildingReservedLines(nation.id),
    loadTreatyProductionNet(nation.id),
    getGlobalStatMultipliers(),
  ]);
  const mods = loadedDetail?.mods ?? ZERO_PRODUCTION_MODS;
  const politics = computePoliticsState(
    nation,
    activeEntries,
    settings,
    loadedSat ?? undefined,
  );

  // 逐條穩定度加減成（淡化後），只列出有穩定度效果的條目。
  const stabilityEntries: StabilityModifierEntry[] = [];
  for (const entry of activeEntries) {
    const strength = entryStrength(entry);
    if (strength <= 0) continue;
    let stab = 0;
    for (const mod of entry.modifiers) {
      if (mod.target === "stability") stab += mod.value * strength;
    }
    if (stab === 0) continue;
    stabilityEntries.push({
      title: entry.title,
      entryType: entry.entryType as PoliticsEntryType,
      direction: entry.direction as PoliticsDirection,
      value: round1(stab),
    });
  }

  // 條約生產力輸送為純流量（生效條約每回合淨流量，可為負；廢約即停止）；
  // productionBonus 僅剩超事件/管理員持久偏移。基礎合計下限 0。
  const productionBase = Math.max(
    0,
    raw.production + nation.productionBonus + treatyNet,
  );
  // 最外層套全域「生產力／科技點數基礎倍率」，與 computeAdjustedNationStats
  // 及回合實際發放的口徑一致（明細彈窗另列一行倍率）。
  const productionTotal = scaleByGlobalStatMultiplierPct(
    adjustStatValue(
      productionBase,
      politics.stabilityMult,
      politics.productionPct + mods.productionBonusPct,
    ),
    globalMults.productionPct,
  );
  const techTotal = scaleByGlobalStatMultiplierPct(
    adjustStatValue(
      raw.techPerTurn,
      politics.stabilityMult,
      politics.techPct + mods.techPointsBonusPct,
    ),
    globalMults.techPct,
  );
  // Task #322 — 總人口 = 各地區（基準加權 + 累積成長量），下限 0；
  // raw.population 已含各地區累積量並夾在 0。
  const populationTotal = raw.population;
  // 有效人口增長率再套全域「人口增長倍率」，與首頁顯示及回合實際套用一致。
  const growthEffective = scalePopulationGrowthRatePct(
    populationGrowthRatePct(
      politics.populationGrowthPct + mods.populationGrowthBonusPct,
      settings,
    ),
    multiplier,
  );

  // 人口承載量/實際淨成長率:與回合引擎同一口徑(loadRegionGrowthInputs + 同一個增長率),
  // 讓明細彈窗、首頁百分比、回合實際結算三者一致。
  const capacitySummary = summarizeCapacity(
    await loadRegionGrowthInputs(db, nation.id, era),
    growthEffective,
  );

  return {
    era,
    regions,
    production: {
      // Task #528 — 基礎值攤開：地區加權合計、條約流量與其他偏移分列。
      regionBase: raw.production,
      treatyBonus: treatyNet,
      otherBonus: nation.productionBonus,
      base: productionBase,
      stabilityMult: round1(politics.stabilityMult * 100) / 100,
      policyPct: round1(politics.productionPct),
      // Task #528 — 科技與建築加成拆開，並附來源清單。
      techPct: round1(loadedDetail?.productionTechPct ?? 0),
      buildingPct: round1(loadedDetail?.productionBuildingPct ?? 0),
      techSources: loadedDetail?.techSources ?? [],
      buildingSources: loadedDetail?.buildingSources ?? [],
      globalMultiplierPct: globalMults.productionPct,
      total: productionTotal,
      // 佔用合計 = 軍事 + 建築（production_spent 不變量）；分列供前端拆開顯示。
      spent: nation.productionSpent,
      armySpent: spentLines.reduce((sum, l) => sum + l.reserved, 0),
      buildingSpent: buildingSpentLines.reduce((sum, l) => sum + l.reserved, 0),
      // Task #568 — 剩餘 = 總量 − 已佔用 − 本回合招募花費（花費為流量，
      // 跨回合自動歸零；佔用為 stock，解散按比例釋放）。
      remaining: computeAvailableProduction({
        production: productionTotal,
        productionSpent: nation.productionSpent,
        currentTurnSpend: recruitSpendThisTurn,
      }),
      recruitSpendThisTurn,
      recruitSpendLines,
      // Task #541 — 「軍事已佔用」逐兵種展開（production_reserved 依模板彙總）。
      spentLines,
      // 逐建築的生產力佔用展開（建造＋歷次升級累計，拆除時釋放）。
      buildingSpentLines,
    },
    tech: {
      base: raw.techPerTurn,
      stabilityMult: round1(politics.stabilityMult * 100) / 100,
      policyPct: round1(politics.techPct),
      techBonusPct: round1(mods.techPointsBonusPct),
      globalMultiplierPct: globalMults.techPct,
      total: techTotal,
    },
    population: {
      base: raw.basePopulation,
      accruedGrowth: raw.accruedGrowth,
      total: populationTotal,
      spent: nation.populationSpent,
      remaining: Math.max(0, populationTotal - nation.populationSpent),
      growth: {
        basePct: round1(settings.populationBaseGrowthPct),
        policyPct: round1(politics.populationGrowthPct),
        techPct: round1(loadedDetail?.populationTechPct ?? 0),
        buildingPct: round1(loadedDetail?.populationBuildingPct ?? 0),
        buffPct: round1(loadedDetail?.populationBuffPct ?? 0),
        capAbsPct: round1(settings.populationGrowthMaxAbsPct),
        effectivePct: round1(growthEffective),
        netPct: Math.round(capacitySummary.netGrowthPct * 100) / 100,
        capacity: capacitySummary.capacity,
        loadRatio: Math.round(capacitySummary.loadRatio * 1000) / 1000,
        techSources: loadedDetail?.populationTechSources ?? [],
        buildingSources: loadedDetail?.populationBuildingSources ?? [],
      },
    },
    politics: {
      stabilityBase: nation.stability,
      stabilityEntries,
      stabilityEffective: round1(politics.stability),
      unrest: politics.unrest,
      warWeariness: politics.warWeariness,
      satisfactions: {
        law: round1(politics.satisfactions.law),
        culture: round1(politics.satisfactions.culture),
        religion: round1(politics.satisfactions.religion),
        rights: round1(politics.satisfactions.rights),
        military: round1(politics.satisfactions.military),
      },
      satisfactionHighThreshold: settings.satisfactionHighThreshold,
      satisfactionLowThreshold: settings.satisfactionLowThreshold,
    },
  };
}

/**
 * 讀取全域時代（world_game_state id=1；缺列時回預設時代）。
 * currentEra = 世界顯示/進度時代（背景、解鎖、AI 敘事）；
 * statsEra = 「數據時代」——玩家國家數據（人口/生產力/科技產出）計算用，
 * 管理員改時代未勾「同步預設」時會與 currentEra 不同（null 時沿用 currentEra）。
 */
export async function getEraSlugs(): Promise<{
  currentEra: string;
  statsEra: string;
}> {
  const [gameState] = await db
    .select()
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  const currentEra = gameState?.currentEra ?? DEFAULT_ERA_SLUG;
  return { currentEra, statsEra: gameState?.statsEra ?? currentEra };
}

/** 讀取全域當前時代（world_game_state id=1；缺列時回預設時代）。 */
export async function getCurrentEraSlug(): Promise<string> {
  return (await getEraSlugs()).currentEra;
}

/** 讀取當前遊戲年份（world_game_state.game_date 的年份部分；缺列時回 1）。 */
export async function getCurrentGameYear(): Promise<number> {
  const [row] = await db
    .select({ gameDate: worldGameStateTable.gameDate })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  const dateStr = row?.gameDate ?? "0001-01-01";
  return Number.parseInt(dateStr.slice(0, 4), 10);
}

/**
 * 讀取全域「人口增長倍率」（world_game_state id=1；0–100，缺列/壞值 → 100）。
 * 供玩家數據序列化的顯示路徑載入，確保與回合實際套用一致。
 */
export async function getPopulationGrowthMultiplierPct(): Promise<number> {
  const [row] = await db
    .select({ pct: worldGameStateTable.populationGrowthMultiplierPct })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  return clampPopulationGrowthMultiplierPct(row?.pct);
}

/** 讀取「數據時代」（玩家數據計算用；未設定時沿用當前時代）。 */
export async function getStatsEraSlug(): Promise<string> {
  return (await getEraSlugs()).statsEra;
}

/**
 * 讀取全域「生產力／科技點數基礎倍率」（world_game_state id=1；各 0–1000，
 * 缺列/壞值 → 100）。顯示路徑與研發成本全球平均皆以此載入，確保與回合
 * 實際套用一致。
 */
export async function getGlobalStatMultipliers(): Promise<GlobalStatMultipliers> {
  const [row] = await db
    .select({
      productionPct: worldGameStateTable.productionMultiplierPct,
      techPct: worldGameStateTable.techMultiplierPct,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  return {
    productionPct: clampGlobalStatMultiplierPct(row?.productionPct),
    techPct: clampGlobalStatMultiplierPct(row?.techPct),
  };
}
