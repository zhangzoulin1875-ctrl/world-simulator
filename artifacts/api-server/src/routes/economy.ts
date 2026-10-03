import { Router, type IRouter } from "express";
import { asc, desc, eq, gte, and, inArray, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  financePendingIdeasTable,
  financeEntriesTable,
  nationFinanceLedgerTable,
  regionControlsTable,
  mapRegionsTable,
  mapRegionEraStatsTable,
  mapCitiesTable,
  cityBuildingsTable,
  cityWallsTable,
  playerArmiesTable,
  militaryUnitTemplatesTable,
  regionBuildingsTable,
  type PlayerNation,
  type FinanceEntry,
  type NationFinanceLedger,
  type WallTier,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import {
  computeAdjustedNationStats,
  computeNationStats,
  getEraSlugs,
} from "../lib/nationStats";
import { ERAS, getEraIndex } from "../lib/mapRegionEras";
import { aggregateSocialEffectsForUser } from "../lib/socialTechData";
import { BUILDING_SLOTS_MAX, cityBuildingSlots } from "../lib/socialTech";
import {
  aggregateProductionEffectsForUser,
  getProductionDomainEra,
  loadBuildingUpkeepByUser,
} from "../lib/productionTechData";
import {
  WALL_TIER_LABELS,
  WALL_MAX_DURABILITY,
  WALL_DEFENSE_BONUS_PCT,
  WALL_UPGRADE_COST,
  canUpgradeWall,
  nextWallTier,
  wallTierUnlocked,
} from "../lib/wall";
import {
  BUILDINGS,
  buildingByType,
  describeBuildingEffect,
} from "../lib/production";
import {
  FINANCE_IDEA_MAX_LENGTH,
  TAX_RATE_MAX,
  aggregateMilitaryUpkeep,
  computeAvailableProduction,
  computeTaxIncome,
  effectiveTaxEfficiencyPct,
  financeLedgerCategoryLabel,
} from "../lib/economy";
import { loadCurrentTurnRecruitSpend } from "../lib/recruitSpend";
import {
  effectiveProductivity,
  investmentCost,
  investmentCostMultiplier,
} from "../lib/regionInvestment";
import {
  allocateRegionPopulations,
  allocateRegionTax,
} from "../lib/regionTax";
import { buildingUpkeep } from "../lib/regionBuildings";
import {
  getGameBalanceSettings,
  scaleConstructionCost,
} from "../lib/gameBalance";
import { computeNationFoodReport } from "../lib/foodData";
import {
  FAMINE_POPULATION_LOSS_PCT,
  FAMINE_SURVIVOR_FLOOR,
  famineLossPct,
  FOOD_POLICY_OUTPUT_BONUS_PCT,
  FOOD_POLICY_RATION_SAVING_PCT,
  FOOD_POLICY_SATISFACTION_COST_PER_TURN,
} from "../lib/food";

const router: IRouter = Router();

/**
 * Task #405 — 全世界平均有效生產素質（指定時代；有效 = era stat + 地區投資
 * 累積加成）。投資費用倍率的分母；用有效值，投資推升排名 → 費用自然變貴。
 */
async function loadGlobalAvgEffectiveProductivity(
  era: string,
): Promise<number> {
  const [row] = await db
    .select({
      avg: sql<string>`COALESCE(AVG(${mapRegionEraStatsTable.productivity}::double precision + ${mapRegionsTable.productivityInvestmentBonus}::double precision), 0)`,
    })
    .from(mapRegionEraStatsTable)
    .innerJoin(
      mapRegionsTable,
      eq(mapRegionsTable.id, mapRegionEraStatsTable.regionId),
    )
    .where(eq(mapRegionEraStatsTable.era, era));
  return Number(row?.avg ?? 0);
}

/** 顯示用四捨五入至最多 1 位小數（維護費為 doublePrecision，可能有小數）。 */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 同 politics.ts 的 requirePlayer（session → 已建國的 nation）。 */
async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<{ nation: PlayerNation; userId: string } | null> {
  const session = await getSession(readSessionToken(req));
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return null;
  }
  const userId = session.discordUserId;
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  if (!nation) {
    res.status(400).json({ error: "尚未建國，請先在玩家首頁建立或接手國家" });
    return null;
  }
  return { nation, userId };
}

/** finance_entries 列 → API（details jsonb 攤平成頂層欄位）。 */
function serializeEntry(entry: FinanceEntry) {
  const d = entry.details ?? {};
  return {
    id: entry.id,
    title: entry.title,
    description: entry.description,
    isGood: entry.isGood,
    taxRateBefore: d.taxRateBefore ?? null,
    taxRateAfter: d.taxRateAfter ?? null,
    moneyDelta: d.moneyDelta ?? null,
    satisfactionDelta: d.satisfactionDelta ?? null,
    stabilityDelta: d.stabilityDelta ?? null,
    createdAt: entry.createdAt.toISOString(),
  };
}

/** nation_finance_ledger 列 → API（附中文分類標籤）。 */
function serializeLedger(row: NationFinanceLedger) {
  return {
    id: row.id,
    category: row.category,
    categoryLabel: financeLedgerCategoryLabel(row.category),
    amount: row.amount,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 財政總覽：稅率／稅收效率／預估稅收、四項預算分配與滿意度影響、
 * 待判定財政政策、財政政策歷史。人口與稅收效率以「數據時代」計算，
 * 與回合引擎（turnEngine）一致。
 */
router.get("/economy/overview", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  const { statsEra } = await getEraSlugs();
  const [
    stats,
    pendingRows,
    entries,
    armyRows,
    buildingUpkeepByUser,
    regionBuildingRows,
  ] = await Promise.all([
      computeAdjustedNationStats(nation, statsEra),
      db
        .select()
        .from(financePendingIdeasTable)
        .where(eq(financePendingIdeasTable.nationId, nation.id))
        .limit(1),
      db
        .select()
        .from(financeEntriesTable)
        .where(eq(financeEntriesTable.nationId, nation.id))
        .orderBy(desc(financeEntriesTable.createdAt))
        .limit(30),
      // 軍隊維護費逐兵種原始資料（模板 × 玩家持有數量）。
      db
        .select({
          templateId: militaryUnitTemplatesTable.id,
          name: militaryUnitTemplatesTable.name,
          quantity: playerArmiesTable.quantity,
          upkeepPerUnit: militaryUnitTemplatesTable.upkeepPerUnit,
        })
        .from(playerArmiesTable)
        .innerJoin(
          militaryUnitTemplatesTable,
          eq(militaryUnitTemplatesTable.id, playerArmiesTable.templateId),
        )
        .where(eq(playerArmiesTable.discordUserId, userId)),
      // 建築每回合維護費（已含風車技術等減免）。沿用回合引擎的批次載入器。
      loadBuildingUpkeepByUser(),
      // 地區資源建築（木材廠／礦場）每回合金錢維護費（與回合引擎同組成）。
      db
        .select({
          totalLevel: sql<string>`COALESCE(SUM(${regionBuildingsTable.level}), 0)`,
        })
        .from(regionBuildingsTable)
        .where(eq(regionBuildingsTable.nationId, nation.id)),
    ]);

  const totalPopulation = stats.population;
  // Task #126 — 社會科技的收稅效率加成疊加到國家既有加成上。
  const socialTaxBonus = nation.discordUserId
    ? (await aggregateSocialEffectsForUser(nation.discordUserId))
        .taxEfficiencyBonusPct
    : 0;
  const taxEfficiencyPct = effectiveTaxEfficiencyPct(
    statsEra,
    nation.taxEfficiencyBonus + socialTaxBonus,
  );
  const taxIncomePerTurn = computeTaxIncome({
    population: totalPopulation,
    taxRatePct: nation.taxRatePct,
    taxEfficiencyPct,
  });

  // 軍隊維護費逐兵種明細 + 建築維護費 + 地區資源建築維護費
  // （與回合引擎一致的維護費組成，見 turnEngine 的 upkeep 合成）。
  const militaryUpkeep = aggregateMilitaryUpkeep(armyRows);
  const rawBuildingUpkeep = buildingUpkeepByUser.get(userId) ?? 0;
  const rawRegionBuildingUpkeep = buildingUpkeep(
    Number(regionBuildingRows[0]?.totalLevel ?? 0),
  );
  const buildingUpkeepPerTurn = round1(rawBuildingUpkeep);
  const regionBuildingUpkeepPerTurn = round1(rawRegionBuildingUpkeep);
  const militaryUpkeepPerTurn = round1(militaryUpkeep.total);
  // 回合引擎對合併維護費無條件進位後扣款（computeTurnFinance）。
  const upkeepChargedPerTurn = Math.max(
    0,
    Math.ceil(
      militaryUpkeep.total + rawBuildingUpkeep + rawRegionBuildingUpkeep,
    ),
  );
  // 含維護費的每回合淨結餘：稅收 −（軍隊 ＋ 建築 ＋ 地區資源建築維護費）。
  const netSurplusPerTurn = taxIncomePerTurn - upkeepChargedPerTurn;

  // Task #568 — 生產力維護費機制已移除；可用生產力 = 總量 − 已佔用 −
  // 本回合招募花費（流量，跨回合自動歸零）。
  const availableProduction = computeAvailableProduction({
    production: stats.production,
    productionSpent: nation.productionSpent,
    currentTurnSpend: await loadCurrentTurnRecruitSpend(nation.id),
  });

  const pending = pendingRows[0] ?? null;
  res.json({
    money: nation.money,
    taxRatePct: nation.taxRatePct,
    taxRateMax: TAX_RATE_MAX,
    taxEfficiencyPct,
    totalPopulation,
    taxIncomePerTurn,
    surplusPerTurn: taxIncomePerTurn,
    militaryUpkeepLines: militaryUpkeep.lines.map((l) => ({
      templateId: l.templateId,
      name: l.name,
      quantity: l.quantity,
      upkeepPerUnit: round1(l.upkeepPerUnit),
      subtotal: round1(l.subtotal),
    })),
    militaryUpkeepPerTurn,
    buildingUpkeepPerTurn,
    regionBuildingUpkeepPerTurn,
    upkeepPerTurn: upkeepChargedPerTurn,
    netSurplusPerTurn,
    availableProduction,
    ideaMaxLength: FINANCE_IDEA_MAX_LENGTH,
    pendingIdea: pending
      ? {
          id: pending.id,
          idea: pending.idea,
          createdAt: pending.createdAt.toISOString(),
        }
      : null,
    entries: entries.map(serializeEntry),
  });
});

/**
 * 送出財政政策自由文字（一國一筆待判定；回合結算時由 AI 判定）。
 * 已有待判定想法 → 409。
 */
router.post("/economy/ideas", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const idea = body["idea"];
  if (typeof idea !== "string" || idea.trim().length === 0) {
    res.status(400).json({ error: "請輸入財政政策內容" });
    return;
  }
  const trimmed = idea.trim();
  if (trimmed.length > FINANCE_IDEA_MAX_LENGTH) {
    res
      .status(400)
      .json({ error: `財政政策最長 ${FINANCE_IDEA_MAX_LENGTH} 字` });
    return;
  }

  const inserted = await db
    .insert(financePendingIdeasTable)
    .values({ nationId: nation.id, idea: trimmed })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    res
      .status(409)
      .json({ error: "已有待判定的財政政策，請先撤回或等待回合結算" });
    return;
  }

  req.log.info({ nationId: nation.id }, "finance idea submitted");
  res.json({ ok: true });
});

/** 撤回待判定的財政政策。 */
router.delete("/economy/ideas", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const deleted = await db
    .delete(financePendingIdeasTable)
    .where(eq(financePendingIdeasTable.nationId, nation.id))
    .returning();
  if (deleted.length === 0) {
    res.status(404).json({ error: "沒有待判定的財政政策" });
    return;
  }
  res.json({ ok: true });
});

/** 財政流水（外交／內政／財政政策造成的金錢收支，純顯示；最近 30 天）。 */
router.get("/economy/ledger", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(nationFinanceLedgerTable)
    .where(
      and(
        eq(nationFinanceLedgerTable.nationId, nation.id),
        gte(nationFinanceLedgerTable.createdAt, since),
      ),
    )
    .orderBy(desc(nationFinanceLedgerTable.createdAt))
    .limit(200);

  res.json({ entries: rows.map(serializeLedger) });
});

/**
 * 地區建築槽框架（Task #128）：列出玩家掌控地區與其城市，並回報每座城市
 * 的建築槽上限。建築槽系統在解鎖「部落革新」關鍵技術前不啟用；啟用後由
 * 社會關鍵技術彙總（大學制度／行會革新／三權分立）累加，夾在硬上限內。
 * 本階段僅提供空槽位資料，實際建築物種類／加成／維護費屬日後生產科技。
 */
router.get("/economy/regions", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;

  const social = nation.discordUserId
    ? await aggregateSocialEffectsForUser(nation.discordUserId)
    : null;
  const prod = nation.discordUserId
    ? await aggregateProductionEffectsForUser(nation.discordUserId)
    : null;
  const buildingSlotsEnabled = social?.buildingSlotsEnabled ?? false;
  const buildingSlotsPerCity = social ? cityBuildingSlots(social) : 0;
  const unlockedBuildingTypes = new Set(prod?.unlockedBuildings ?? []);

  // 掌控地區（依種子順序＝大區順序）。經濟數據以「數據時代」（statsEra）
  // 計算，與財政總覽／回合引擎一致。left join 避免缺該時代數據時整列消失
  // （缺數據時人口只剩累積成長量、生產素質為 null）。
  const { statsEra } = await getEraSlugs();
  const controls = await db
    .select({
      regionId: mapRegionsTable.id,
      name: mapRegionsTable.name,
      macroRegion: mapRegionsTable.macroRegion,
      percent: regionControlsTable.percent,
      investmentBonus: mapRegionsTable.productivityInvestmentBonus,
      accrued: regionControlsTable.populationBonus,
      eraPopulation: mapRegionEraStatsTable.population,
      eraProductivity: mapRegionEraStatsTable.productivity,
    })
    .from(regionControlsTable)
    .innerJoin(mapRegionsTable, eq(mapRegionsTable.id, regionControlsTable.regionId))
    .leftJoin(
      mapRegionEraStatsTable,
      and(
        eq(mapRegionEraStatsTable.regionId, regionControlsTable.regionId),
        eq(mapRegionEraStatsTable.era, statsEra),
      ),
    )
    .where(eq(regionControlsTable.nationId, nation.id))
    .orderBy(asc(mapRegionsTable.id));

  // 全國稅收（與 /economy/overview 完全同一套算式：computeNationStats 的
  // 人口 × 稅率 × 稅收效率）。
  const [raw, socialForTax] = await Promise.all([
    computeNationStats(nation.id, statsEra),
    nation.discordUserId
      ? aggregateSocialEffectsForUser(nation.discordUserId)
      : Promise.resolve(null),
  ]);
  const taxEfficiencyPct = effectiveTaxEfficiencyPct(
    statsEra,
    nation.taxEfficiencyBonus + (socialForTax?.taxEfficiencyBonusPct ?? 0),
  );
  const taxIncomePerTurn = computeTaxIncome({
    population: raw.population,
    taxRatePct: nation.taxRatePct,
    taxEfficiencyPct,
  });

  // 各地區經濟貢獻：稅收與顯示人口都用「最大餘數法」分配（lib/regionTax.ts
  // 純函式），保證 Σ 地區稅收 = 全國稅收、Σ 地區顯示人口 = 全國人口
  // （Task #430；兩頁完全可對帳）。
  const taxByIndex = allocateRegionTax(controls, taxIncomePerTurn);
  const populationByIndex = allocateRegionPopulations(controls, raw.population);
  const regionEconomy = controls.map((r, i) => ({
    population: populationByIndex[i]!,
    productionQuality:
      r.eraProductivity == null ? null : Number(r.eraProductivity),
    // Task #198 — 生產力貢獻 = 生產素質 × 控制比例 × 地區人口 ÷ 10,000。
    productionContribution: Math.round(
      (Number(r.eraProductivity ?? 0) * r.percent * Number(r.eraPopulation ?? 0)) /
        10000,
    ),
    taxContribution: taxByIndex[i]!,
  }));

  const regionIds = controls.map((r) => r.regionId);

  // Task #405 — 生產力投資資訊：數據時代的 era stat（生產素質/人口）、
  // 各地區累積人口成長量、全球平均有效生產素質（費用倍率分母）。
  const [investStatRows, accruedRows, globalAvgEffective, balance] = await Promise.all([
    regionIds.length
      ? db
          .select({
            regionId: mapRegionEraStatsTable.regionId,
            productivity: mapRegionEraStatsTable.productivity,
            population: mapRegionEraStatsTable.population,
          })
          .from(mapRegionEraStatsTable)
          .where(
            and(
              inArray(mapRegionEraStatsTable.regionId, regionIds),
              eq(mapRegionEraStatsTable.era, statsEra),
            ),
          )
      : Promise.resolve([]),
    regionIds.length
      ? db
          .select({
            regionId: regionControlsTable.regionId,
            accrued: sql<string>`COALESCE(SUM(${regionControlsTable.populationBonus}), 0)`,
          })
          .from(regionControlsTable)
          .where(inArray(regionControlsTable.regionId, regionIds))
          .groupBy(regionControlsTable.regionId)
      : Promise.resolve([]),
    loadGlobalAvgEffectiveProductivity(statsEra),
    getGameBalanceSettings(),
  ]);
  const investStatByRegion = new Map(
    investStatRows.map((r) => [
      r.regionId,
      { productivity: r.productivity, population: r.population },
    ]),
  );
  const accruedByRegion = new Map(
    accruedRows.map((r) => [r.regionId, Math.round(Number(r.accrued))]),
  );
  const investmentInfo = (r: (typeof controls)[number]) => {
    const stat = investStatByRegion.get(r.regionId);
    if (!stat) return null;
    const population = Math.max(
      0,
      stat.population + (accruedByRegion.get(r.regionId) ?? 0),
    );
    const effective = effectiveProductivity(
      stat.productivity,
      r.investmentBonus,
    );
    const multiplier = investmentCostMultiplier(effective, globalAvgEffective);
    return {
      baseProductivity: stat.productivity,
      investmentBonus: r.investmentBonus,
      effectiveProductivity: effective,
      population,
      avgEffectiveProductivity: Math.round(globalAvgEffective * 10) / 10,
      costMultiplier: Math.round(multiplier * 100) / 100,
      // Task #523 — 管理員建設成本倍率：與扣款端點同一縮放（顯示＝實扣）。
      nextInvestCost: scaleConstructionCost(
        investmentCost(population, effective, globalAvgEffective),
        balance.constructionCosts.productivityInvestment,
      ),
    };
  };
  const cityRows = regionIds.length
    ? await db
        .select({
          id: mapCitiesTable.id,
          name: mapCitiesTable.name,
          regionId: mapCitiesTable.regionId,
        })
        .from(mapCitiesTable)
        .where(inArray(mapCitiesTable.regionId, regionIds))
        .orderBy(asc(mapCitiesTable.id))
    : [];

  // 該玩家在這些城市已興建的建築。
  const cityIds = cityRows.map((c) => c.id);
  const buildingRows =
    nation.discordUserId && cityIds.length
      ? await db
          .select({
            id: cityBuildingsTable.id,
            cityId: cityBuildingsTable.cityId,
            buildingType: cityBuildingsTable.buildingType,
          })
          .from(cityBuildingsTable)
          .where(
            and(
              eq(cityBuildingsTable.discordUserId, nation.discordUserId),
              inArray(cityBuildingsTable.cityId, cityIds),
            ),
          )
          .orderBy(asc(cityBuildingsTable.id))
      : [];
  const buildingsByCity = new Map<
    number,
    { id: number; type: string; name: string }[]
  >();
  for (const b of buildingRows) {
    const def = buildingByType(b.buildingType);
    const list = buildingsByCity.get(b.cityId) ?? [];
    list.push({ id: b.id, type: b.buildingType, name: def?.name ?? b.buildingType });
    buildingsByCity.set(b.cityId, list);
  }

  // 城牆（Task #150）：每座城市的城牆階級（未建列 = 木牆）＋升級解鎖狀態。
  const wallRows = cityIds.length
    ? await db
        .select({ cityId: cityWallsTable.cityId, tier: cityWallsTable.tier })
        .from(cityWallsTable)
        .where(inArray(cityWallsTable.cityId, cityIds))
    : [];
  const tierByCity = new Map<number, WallTier>();
  for (const w of wallRows) tierByCity.set(w.cityId, w.tier);

  const cityWallEnabled = prod?.cityWallEnabled ?? false;
  const productionEraSlug = nation.discordUserId
    ? await getProductionDomainEra(nation.discordUserId)
    : "classical";
  const wallOpts = { cityWallEnabled, productionEraSlug };
  const wallInfo = (cityId: number) => {
    const tier = tierByCity.get(cityId) ?? "wood";
    const next = nextWallTier(tier);
    return {
      tier,
      tierLabel: WALL_TIER_LABELS[tier],
      maxDurability: WALL_MAX_DURABILITY[tier],
      defenseBonusPct: WALL_DEFENSE_BONUS_PCT[tier],
      nextTier: next,
      nextTierLabel: next ? WALL_TIER_LABELS[next] : null,
      upgradeCost: next ? WALL_UPGRADE_COST[next] : null,
      nextTierUnlocked: next ? wallTierUnlocked(next, wallOpts) : false,
      canUpgrade: next ? canUpgradeWall(tier, next, wallOpts).ok : false,
    };
  };

  const citiesByRegion = new Map<
    number,
    {
      id: number;
      name: string;
      slotsUsed: number;
      buildings: { id: number; type: string; name: string }[];
      wall: ReturnType<typeof wallInfo>;
    }[]
  >();
  for (const c of cityRows) {
    const list = citiesByRegion.get(c.regionId) ?? [];
    const cityBuildings = buildingsByCity.get(c.id) ?? [];
    list.push({
      id: c.id,
      name: c.name,
      slotsUsed: cityBuildings.length,
      buildings: cityBuildings,
      wall: wallInfo(c.id),
    });
    citiesByRegion.set(c.regionId, list);
  }

  res.json({
    economy: {
      statsEra,
      statsEraLabel: ERAS[getEraIndex(statsEra)]?.label ?? statsEra,
      taxRatePct: nation.taxRatePct,
      taxEfficiencyPct,
      totalPopulation: raw.population,
      taxIncomePerTurn,
    },
    buildingSlotsEnabled,
    buildingSlotsPerCity,
    buildingSlotsMax: BUILDING_SLOTS_MAX,
    cityWallEnabled,
    wallTiers: (["wood", "stone", "bunker", "concrete"] as WallTier[]).map(
      (t) => ({
        tier: t,
        label: WALL_TIER_LABELS[t],
        maxDurability: WALL_MAX_DURABILITY[t],
        defenseBonusPct: WALL_DEFENSE_BONUS_PCT[t],
        upgradeCost: WALL_UPGRADE_COST[t],
      }),
    ),
    availableBuildings: BUILDINGS.map((b) => ({
      type: b.type,
      name: b.name,
      description: b.description,
      // Task #523 — 一般城市建築成本倍率（顯示與扣款一致）。
      buildCost: scaleConstructionCost(
        b.buildCost,
        balance.constructionCosts.cityBuilding,
      ),
      upkeep: b.upkeep,
      unlocked: unlockedBuildingTypes.has(b.type),
      effects: b.effects.map((e) => ({
        target: e.target,
        value: e.value,
        label: describeBuildingEffect(e),
      })),
    })),
    regions: controls.map((r, i) => ({
      regionId: r.regionId,
      name: r.name,
      macroRegion: r.macroRegion,
      percent: r.percent,
      population: regionEconomy[i]!.population,
      productionQuality: regionEconomy[i]!.productionQuality,
      productionContribution: regionEconomy[i]!.productionContribution,
      taxContribution: regionEconomy[i]!.taxContribution,
      cities: citiesByRegion.get(r.regionId) ?? [],
      investment: investmentInfo(r),
    })),
  });
});

/**
 * Task #405 — 地區生產力投資：花錢讓地區生產素質 +1（全地區共享、跨時代
 * 固定加值，存 map_regions.productivity_investment_bonus，絕不動
 * map_region_era_stats）。費用一律伺服器端重算：基礎 = 該地區目前人口
 * （數據時代 era stat + 累積成長量），倍率 = 有效生產素質 ÷ 全球平均有效
 * 生產素質（下限 1），最終費用 = ceil(人口 × 倍率)。以 per-region
 * pg_advisory_xact_lock 序列化併發投資，鎖內重算費用；條件式 UPDATE 扣款。
 */
router.post("/economy/region-investments", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  const body = (req.body ?? {}) as { regionId?: unknown };
  const regionId = Number(body.regionId);
  if (!Number.isInteger(regionId) || regionId <= 0) {
    res.status(400).json({ error: "地區編號不正確" });
    return;
  }

  // 只有實際掌控該地區（region_controls 有持分）的國家可投資。
  const [control] = await db
    .select({ id: regionControlsTable.id })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.nationId, nation.id),
        eq(regionControlsTable.regionId, regionId),
      ),
    )
    .limit(1);
  if (!control) {
    res.status(400).json({ error: "你未掌控這個地區，無法投資" });
    return;
  }

  try {
    // Task #523 — 管理員建設成本倍率（顯示端點與扣款共用同一縮放）。
    const balance = await getGameBalanceSettings();
    const investMult = balance.constructionCosts.productivityInvestment;
    const result = await db.transaction(async (tx) => {
      // per-region 鎖：避免兩人同時用舊價格扣款、加成原子遞增。
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`regioninvest:${regionId}`}))`,
      );

      // 鎖內重算費用（不信任前端）。
      const { statsEra } = await getEraSlugs();
      const [stat] = await tx
        .select({
          productivity: mapRegionEraStatsTable.productivity,
          population: mapRegionEraStatsTable.population,
          bonus: mapRegionsTable.productivityInvestmentBonus,
        })
        .from(mapRegionEraStatsTable)
        .innerJoin(
          mapRegionsTable,
          eq(mapRegionsTable.id, mapRegionEraStatsTable.regionId),
        )
        .where(
          and(
            eq(mapRegionEraStatsTable.regionId, regionId),
            eq(mapRegionEraStatsTable.era, statsEra),
          ),
        )
        .limit(1);
      if (!stat) throw new HttpError(404, "找不到這個地區的時代數據");
      const [accrued] = await tx
        .select({
          sum: sql<string>`COALESCE(SUM(${regionControlsTable.populationBonus}), 0)`,
        })
        .from(regionControlsTable)
        .where(eq(regionControlsTable.regionId, regionId));
      const [avgRow] = await tx
        .select({
          avg: sql<string>`COALESCE(AVG(${mapRegionEraStatsTable.productivity}::double precision + ${mapRegionsTable.productivityInvestmentBonus}::double precision), 0)`,
        })
        .from(mapRegionEraStatsTable)
        .innerJoin(
          mapRegionsTable,
          eq(mapRegionsTable.id, mapRegionEraStatsTable.regionId),
        )
        .where(eq(mapRegionEraStatsTable.era, statsEra));

      const population = Math.max(
        0,
        stat.population + Math.round(Number(accrued?.sum ?? 0)),
      );
      const effective = effectiveProductivity(stat.productivity, stat.bonus);
      const globalAvg = Number(avgRow?.avg ?? 0);
      const cost = scaleConstructionCost(
        investmentCost(population, effective, globalAvg),
        investMult,
      );

      // 條件式扣款護欄：金錢不足 → 不扣款。
      const updated = await tx
        .update(playerNationsTable)
        .set({ money: sql`${playerNationsTable.money} - ${cost}` })
        .where(
          and(
            eq(playerNationsTable.id, nation.id),
            sql`${playerNationsTable.money} >= ${cost}`,
          ),
        )
        .returning({ money: playerNationsTable.money });
      if (!updated[0]) {
        throw new HttpError(
          400,
          `金錢不足（本次投資需要 ${cost.toLocaleString("en-US")}）`,
        );
      }

      // 加成原子遞增（+1/次）。
      const [region] = await tx
        .update(mapRegionsTable)
        .set({
          productivityInvestmentBonus: sql`${mapRegionsTable.productivityInvestmentBonus} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(mapRegionsTable.id, regionId))
        .returning({
          bonus: mapRegionsTable.productivityInvestmentBonus,
        });
      if (!region) throw new HttpError(404, "找不到這個地區");

      // 投資後的下一次費用（加成 +1 → 有效值 +1、全球平均也 +1/373）。
      const newEffective = effectiveProductivity(
        stat.productivity,
        region.bonus,
      );
      const [newAvgRow] = await tx
        .select({
          avg: sql<string>`COALESCE(AVG(${mapRegionEraStatsTable.productivity}::double precision + ${mapRegionsTable.productivityInvestmentBonus}::double precision), 0)`,
        })
        .from(mapRegionEraStatsTable)
        .innerJoin(
          mapRegionsTable,
          eq(mapRegionsTable.id, mapRegionEraStatsTable.regionId),
        )
        .where(eq(mapRegionEraStatsTable.era, statsEra));
      const newAvg = Number(newAvgRow?.avg ?? 0);

      return {
        cost,
        money: updated[0].money,
        investmentBonus: region.bonus,
        effectiveProductivity: newEffective,
        nextInvestCost: scaleConstructionCost(
          investmentCost(population, newEffective, newAvg),
          investMult,
        ),
        costMultiplier:
          Math.round(investmentCostMultiplier(newEffective, newAvg) * 100) /
          100,
      };
    });

    req.log.info(
      { userId, nationId: nation.id, regionId, cost: result.cost },
      "region productivity investment",
    );
    res.json(result);
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err, regionId }, "region productivity investment failed");
    res.status(500).json({ error: "投資失敗，請稍後再試" });
  }
});

/**
 * 興建城市建築：驗證城市在玩家掌控地區內、建築已解鎖、建築槽未滿、金錢足夠，
 * 於交易中以條件式 UPDATE 原子扣款並插入建築列。以 pg_advisory_xact_lock 鎖定
 * （玩家×城市）避免併發搶建超過槽位上限；鎖內重新計算已用槽位。
 */
router.post("/economy/buildings", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  const body = req.body as { cityId?: unknown; buildingType?: unknown };
  const cityId = Number(body.cityId);
  const buildingType =
    typeof body.buildingType === "string" ? body.buildingType : "";
  if (!Number.isInteger(cityId) || cityId <= 0) {
    res.status(400).json({ error: "城市編號不正確" });
    return;
  }
  const def = buildingByType(buildingType);
  if (!def) {
    res.status(400).json({ error: "建築類型不正確" });
    return;
  }

  // 建築槽解鎖與每城上限（社會科技）。
  const social = await aggregateSocialEffectsForUser(userId);
  if (!social.buildingSlotsEnabled) {
    res.status(400).json({ error: "尚未解鎖建築槽，請先研發對應的社會科技" });
    return;
  }
  const slotsPerCity = cityBuildingSlots(social);
  if (slotsPerCity <= 0) {
    res.status(400).json({ error: "目前沒有可用的建築槽" });
    return;
  }

  // 建築解鎖（生產關鍵技術）。
  const prod = await aggregateProductionEffectsForUser(userId);
  if (!prod.unlockedBuildings.includes(buildingType)) {
    res.status(400).json({ error: `${def.name}尚未解鎖，請先研發對應的生產關鍵技術` });
    return;
  }

  // 城市須位於玩家掌控地區內。
  const [city] = await db
    .select({ id: mapCitiesTable.id, regionId: mapCitiesTable.regionId })
    .from(mapCitiesTable)
    .where(eq(mapCitiesTable.id, cityId))
    .limit(1);
  if (!city) {
    res.status(404).json({ error: "找不到這座城市" });
    return;
  }
  const [control] = await db
    .select({ id: regionControlsTable.id })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.nationId, nation.id),
        eq(regionControlsTable.regionId, city.regionId),
      ),
    )
    .limit(1);
  if (!control) {
    res.status(400).json({ error: "這座城市不在你的掌控地區內" });
    return;
  }

  try {
    // Task #523 — 一般城市建築成本倍率（與 /economy/regions 顯示一致）。
    const balance = await getGameBalanceSettings();
    const buildCost = scaleConstructionCost(
      def.buildCost,
      balance.constructionCosts.cityBuilding,
    );
    const inserted = await db.transaction(async (tx) => {
      // 鎖定（玩家×城市）：序列化同城同人的併發興建，鎖內重算已用槽位。
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`citybuild:${userId}:${cityId}`}))`,
      );
      const [{ used }] = await tx
        .select({ used: sql<number>`count(*)::int` })
        .from(cityBuildingsTable)
        .where(
          and(
            eq(cityBuildingsTable.discordUserId, userId),
            eq(cityBuildingsTable.cityId, cityId),
          ),
        );
      if (used >= slotsPerCity) {
        throw new HttpError(400, "這座城市的建築槽已滿");
      }

      const updated = await tx
        .update(playerNationsTable)
        .set({ money: sql`${playerNationsTable.money} - ${buildCost}` })
        .where(
          and(
            eq(playerNationsTable.discordUserId, userId),
            sql`${playerNationsTable.money} >= ${buildCost}`,
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new HttpError(
          400,
          `金錢不足（需要 ${buildCost.toLocaleString("en-US")}）`,
        );
      }

      const [row] = await tx
        .insert(cityBuildingsTable)
        .values({ discordUserId: userId, cityId, buildingType })
        .returning();
      return { building: row, money: updated[0].money };
    });

    req.log.info(
      { userId, cityId, buildingType, buildCost },
      "city building constructed",
    );
    res.status(201).json({
      building: {
        id: inserted.building.id,
        cityId: inserted.building.cityId,
        type: inserted.building.buildingType,
        name: def.name,
      },
      money: inserted.money,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err, cityId, buildingType }, "city building failed");
    res.status(500).json({ error: "興建失敗，請稍後再試" });
  }
});

/** 拆除城市建築（不退款）：僅可拆除自己名下的建築。 */
router.delete("/economy/buildings/:id", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { userId } = auth;
  const buildingId = Number(req.params.id);
  if (!Number.isInteger(buildingId) || buildingId <= 0) {
    res.status(400).json({ error: "建築編號不正確" });
    return;
  }
  const deleted = await db
    .delete(cityBuildingsTable)
    .where(
      and(
        eq(cityBuildingsTable.id, buildingId),
        eq(cityBuildingsTable.discordUserId, userId),
      ),
    )
    .returning();
  if (!deleted[0]) {
    res.status(404).json({ error: "找不到這座建築" });
    return;
  }
  req.log.info({ userId, buildingId }, "city building demolished");
  res.json({ ok: true });
});

/**
 * 升級城市城牆（Task #150）：逐級升級、只升不降、需已解鎖對應階級、金錢足夠。
 * 城牆以 city_id 為鍵（非玩家私有）——任何掌控該城所在地區的國家皆可升級。
 * 以 pg_advisory_xact_lock 鎖定該城，鎖內重讀目前階級 → 校驗 →
 * 條件式扣款 → upsert 城牆列，天然防止同城併發重複升級。
 * 進行中的戰役以開戰快照為準，不受本次升級影響。
 */
router.post("/economy/walls/:cityId/upgrade", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  const cityId = Number(req.params.cityId);
  if (!Number.isInteger(cityId) || cityId <= 0) {
    res.status(400).json({ error: "城市編號不正確" });
    return;
  }
  const body = req.body as { tier?: unknown };
  const targetTier = typeof body.tier === "string" ? body.tier : "";
  if (!targetTier) {
    res.status(400).json({ error: "請指定要升級的城牆階級" });
    return;
  }

  // 城市須位於玩家掌控地區內。
  const [city] = await db
    .select({ id: mapCitiesTable.id, regionId: mapCitiesTable.regionId })
    .from(mapCitiesTable)
    .where(eq(mapCitiesTable.id, cityId))
    .limit(1);
  if (!city) {
    res.status(404).json({ error: "找不到這座城市" });
    return;
  }
  const [control] = await db
    .select({ id: regionControlsTable.id })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.nationId, nation.id),
        eq(regionControlsTable.regionId, city.regionId),
      ),
    )
    .limit(1);
  if (!control) {
    res.status(400).json({ error: "這座城市不在你的掌控地區內" });
    return;
  }

  // 城牆解鎖情境（生產科技的城牆開關＋生產領域時代）。
  const prod = await aggregateProductionEffectsForUser(userId);
  const productionEraSlug = await getProductionDomainEra(userId);
  const wallOpts = {
    cityWallEnabled: prod.cityWallEnabled,
    productionEraSlug,
  };

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`citywall:${cityId}`}))`,
      );
      const [wallRow] = await tx
        .select({ tier: cityWallsTable.tier })
        .from(cityWallsTable)
        .where(eq(cityWallsTable.cityId, cityId))
        .limit(1);
      const current: WallTier = wallRow?.tier ?? "wood";
      const check = canUpgradeWall(current, targetTier, wallOpts);
      if (!check.ok) throw new HttpError(400, check.error);
      const cost = WALL_UPGRADE_COST[check.tier];

      const updated = await tx
        .update(playerNationsTable)
        .set({ money: sql`${playerNationsTable.money} - ${cost}` })
        .where(
          and(
            eq(playerNationsTable.id, nation.id),
            sql`${playerNationsTable.money} >= ${cost}`,
          ),
        )
        .returning();
      if (!updated[0]) {
        throw new HttpError(
          400,
          `金錢不足（需要 ${cost.toLocaleString("en-US")}）`,
        );
      }

      await tx
        .insert(cityWallsTable)
        .values({ cityId, tier: check.tier })
        .onConflictDoUpdate({
          target: cityWallsTable.cityId,
          set: { tier: check.tier },
        });
      return { tier: check.tier, cost, money: updated[0].money };
    });

    req.log.info(
      { userId, cityId, tier: result.tier, cost: result.cost },
      "city wall upgraded",
    );
    res.json({
      cityId,
      tier: result.tier,
      tierLabel: WALL_TIER_LABELS[result.tier],
      maxDurability: WALL_MAX_DURABILITY[result.tier],
      defenseBonusPct: WALL_DEFENSE_BONUS_PCT[result.tier],
      money: result.money,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err, cityId, targetTier }, "city wall upgrade failed");
    res.status(500).json({ error: "城牆升級失敗，請稍後再試" });
  }
});

// ── 糧食系統（Task #382） ───────────────────────────────────────

/** GET /api/economy/food — 糧食總覽（非累積；每次即時計算）。 */
router.get("/economy/food", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  try {
    const { statsEra } = await getEraSlugs();
    // Task #626 — 傳入 foodGrowthRatePct，讓糧食總覽與回合引擎結算使用相同的增長率。
    const stats = await computeAdjustedNationStats(nation, statsEra);
    const report = await computeNationFoodReport(nation, statsEra, stats.foodGrowthRatePct);
    res.json({
      eraSlug: report.eraSlug,
      eraIndex: report.eraIndex,
      farmerPct: report.farmerPct,
      population: report.population,
      soldiers: report.soldiers,
      civilians: report.civilians,
      production: {
        base: round1(report.production.base),
        total: round1(report.production.total),
      },
      consumption: {
        civilian: round1(report.consumption.civilian),
        military: round1(report.consumption.military),
        total: round1(report.consumption.total),
      },
      treaty: {
        inflow: report.treaty.inflow,
        outflow: report.treaty.outflow,
      },
      balance: round1(report.balance),
      famine: report.famine,
      faminePopulationLossPct: FAMINE_POPULATION_LOSS_PCT,
      consecutiveFamineTurns: nation.consecutiveFamineTurns ?? 0,
      currentFamineLossPct: round1(
        famineLossPct(nation.consecutiveFamineTurns ?? 0),
      ),
      famineSurvivorFloor: FAMINE_SURVIVOR_FLOOR,
      policies: {
        mobilization: report.policies.mobilization,
        rationing: report.policies.rationing,
        outputBonusPct: FOOD_POLICY_OUTPUT_BONUS_PCT,
        rationSavingPct: FOOD_POLICY_RATION_SAVING_PCT,
        satisfactionCostPerTurn: FOOD_POLICY_SATISFACTION_COST_PER_TURN,
      },
      regions: report.regions.map((r) => ({
        regionId: r.regionId,
        name: r.name,
        fertility: r.fertility,
        controlledAreaKm2: Math.round(r.controlledAreaKm2),
        controlledPopulation: r.controlledPopulation,
        farmers: Math.round(r.farmers),
        output: round1(r.output),
      })),
    });
  } catch (err) {
    req.log.error({ err, nationId: nation.id }, "food overview failed");
    res.status(500).json({ error: "無法載入糧食資料，請稍後再試" });
  }
});

/** POST /api/economy/food/policies — 切換糧食政策開關。 */
router.post("/economy/food/policies", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const mobilization = body["mobilization"];
  const rationing = body["rationing"];
  if (
    (mobilization !== undefined && typeof mobilization !== "boolean") ||
    (rationing !== undefined && typeof rationing !== "boolean")
  ) {
    res.status(400).json({ error: "政策開關必須是布林值" });
    return;
  }
  if (mobilization === undefined && rationing === undefined) {
    res.status(400).json({ error: "請至少指定一項政策" });
    return;
  }
  try {
    const [updated] = await db
      .update(playerNationsTable)
      .set({
        ...(mobilization !== undefined
          ? { foodPolicyMobilization: mobilization }
          : {}),
        ...(rationing !== undefined ? { foodPolicyRationing: rationing } : {}),
        updatedAt: sql`NOW()`,
      })
      .where(eq(playerNationsTable.id, nation.id))
      .returning({
        mobilization: playerNationsTable.foodPolicyMobilization,
        rationing: playerNationsTable.foodPolicyRationing,
      });
    if (!updated) {
      res.status(400).json({ error: "國家不存在或已被移除" });
      return;
    }
    req.log.info(
      { userId, nationId: nation.id, mobilization, rationing },
      "food policies updated",
    );
    res.json({
      mobilization: updated.mobilization,
      rationing: updated.rationing,
    });
  } catch (err) {
    req.log.error({ err, nationId: nation.id }, "food policy update failed");
    res.status(500).json({ error: "糧食政策更新失敗，請稍後再試" });
  }
});

export default router;
