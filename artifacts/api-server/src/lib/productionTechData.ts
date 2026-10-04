import { and, eq, gt, sql } from "drizzle-orm";
import {
  db,
  cityBuildingsTable,
  nationPopulationBuffsTable,
  nationSatisfactionBuffsTable,
  type ProductionTechEffect,
} from "@workspace/db";
import { POLITICS_DIRECTIONS, type PoliticsDirection } from "./politics";
import {
  aggregateBuildingEffects,
  aggregateProductionEffects,
  applyUpkeepReduction,
  populationGrowthBuildingSources,
  populationGrowthTechSources,
  productivityBuildingSources,
  productivityTechSources,
  type AggregatedBuildingEffects,
  type AggregatedProductionEffects,
  type ProductivityBuildingSource,
  type ProductivityTechSource,
  type ResearchedProductionTechInput,
} from "./production";
import {
  getTechTreeDomainEra,
  loadResearchedNodes,
  loadResearchedNodesByUser,
} from "./techTreeData";

/**
 * Task #149／#469 — 生產科技的 DB 存取層（供 routes 與回合引擎共用）。
 * Task #469 起科技來源為全球統一線性科技樹（tech_tree_nodes，
 * domain="production"）；建築／暫時 buff 查詢不變。效果彙總純函式沿用
 * production.ts。
 */

/** 已研發的生產／建築加成合併後、供 computeAdjustedNationStats 套用的修正值。 */
export interface ProductionModifiers {
  productionBonusPct: number;
  techPointsBonusPct: number;
  populationGrowthBonusPct: number;
}

/** 已研發的生產科技樹節點（效果彙總所需欄位）。 */
export interface ResearchedProductionNode {
  id: number;
  name: string;
  eraSlug: string;
  keySlug: string | null;
  effects: ProductionTechEffect[];
}

/** 讀取某玩家的生產領域目前時代（無列時回預設古典時代）。 */
export async function getProductionDomainEra(userId: string): Promise<string> {
  return getTechTreeDomainEra(userId, "production");
}

/** 載入某玩家已研發的生產科技節點（含 key_slug／effects／所屬時代）。 */
export async function loadResearchedProductionTechs(
  userId: string,
): Promise<ResearchedProductionNode[]> {
  const nodes = await loadResearchedNodes(userId, "production");
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    eraSlug: n.eraSlug,
    keySlug: n.keySlug,
    effects: n.effects as ProductionTechEffect[],
  }));
}

function toInput(t: ResearchedProductionNode): ResearchedProductionTechInput {
  return { keySlug: t.keySlug, effects: t.effects };
}

/** 某玩家的彙總生產科技效果（單一真實來源）。 */
export async function aggregateProductionEffectsForUser(
  userId: string,
): Promise<AggregatedProductionEffects> {
  const techs = await loadResearchedProductionTechs(userId);
  return aggregateProductionEffects(techs.map(toInput));
}

/** 一次載入全部玩家已研發生產科技的彙總輸入（批次工具）。 */
async function loadProductionInputsByUser(): Promise<
  Map<string, ResearchedProductionTechInput[]>
> {
  const byUser = await loadResearchedNodesByUser("production");
  const out = new Map<string, ResearchedProductionTechInput[]>();
  for (const [userId, nodes] of byUser) {
    out.set(
      userId,
      nodes.map((n) => ({
        keySlug: n.keySlug,
        effects: n.effects as ProductionTechEffect[],
      })),
    );
  }
  return out;
}

/** 載入某玩家全部城市建築的 building_type 清單。 */
export async function loadNationBuildingTypes(
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ buildingType: cityBuildingsTable.buildingType })
    .from(cityBuildingsTable)
    .where(eq(cityBuildingsTable.discordUserId, userId));
  return rows.map((r) => r.buildingType);
}

/** 某玩家的建築加成彙總。 */
export async function aggregateBuildingEffectsForUser(
  userId: string,
): Promise<AggregatedBuildingEffects> {
  const types = await loadNationBuildingTypes(userId);
  return aggregateBuildingEffects(types);
}

/** 某玩家目前有效暫時人口增長 buff 的總增長率（remaining_turns > 0 加總）。 */
export async function loadActivePopBuffPct(userId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${nationPopulationBuffsTable.growthPct}), 0)`,
    })
    .from(nationPopulationBuffsTable)
    .where(
      and(
        eq(nationPopulationBuffsTable.discordUserId, userId),
        gt(nationPopulationBuffsTable.remainingTurns, 0),
      ),
    );
  return Number(row?.total ?? 0);
}

/** 某方向的滿意度暫時偏移對照（未列出的方向視為 0）。 */
export type SatisfactionOffsets = Partial<Record<PoliticsDirection, number>>;

function isSatisfactionDirection(v: string): v is PoliticsDirection {
  return (POLITICS_DIRECTIONS as readonly string[]).includes(v);
}

/**
 * Task #355 — 某玩家目前有效（remaining_turns > 0）滿意度 buff，依方向加總。
 * 供單筆請求路徑（computeAdjustedNationStats／buildNationStatBreakdown／
 * routes/politics）載入，作為有效滿意度的暫時偏移。
 */
export async function loadActiveSatisfactionBuffs(
  userId: string,
): Promise<SatisfactionOffsets> {
  const rows = await db
    .select({
      direction: nationSatisfactionBuffsTable.direction,
      total: sql<string>`SUM(${nationSatisfactionBuffsTable.satisfactionOffset})`,
    })
    .from(nationSatisfactionBuffsTable)
    .where(
      and(
        eq(nationSatisfactionBuffsTable.discordUserId, userId),
        gt(nationSatisfactionBuffsTable.remainingTurns, 0),
      ),
    )
    .groupBy(nationSatisfactionBuffsTable.direction);
  const out: SatisfactionOffsets = {};
  for (const r of rows) {
    if (isSatisfactionDirection(r.direction)) {
      out[r.direction] = (out[r.direction] ?? 0) + Number(r.total);
    }
  }
  return out;
}

/**
 * Task #355 — 一次載入全部玩家目前有效滿意度 buff（回合引擎批次用；避免每國
 * 一次查詢）。key = discord_user_id，value = 各方向偏移加總。
 */
export async function loadSatisfactionBuffsByUser(): Promise<
  Map<string, SatisfactionOffsets>
> {
  const rows = await db
    .select({
      userId: nationSatisfactionBuffsTable.discordUserId,
      direction: nationSatisfactionBuffsTable.direction,
      total: sql<string>`SUM(${nationSatisfactionBuffsTable.satisfactionOffset})`,
    })
    .from(nationSatisfactionBuffsTable)
    .where(gt(nationSatisfactionBuffsTable.remainingTurns, 0))
    .groupBy(
      nationSatisfactionBuffsTable.discordUserId,
      nationSatisfactionBuffsTable.direction,
    );
  const out = new Map<string, SatisfactionOffsets>();
  for (const r of rows) {
    if (!isSatisfactionDirection(r.direction)) continue;
    let m = out.get(r.userId);
    if (!m) {
      m = {};
      out.set(r.userId, m);
    }
    m[r.direction] = (m[r.direction] ?? 0) + Number(r.total);
  }
  return out;
}

/**
 * 組合某玩家（有主國家）的生產修正值：生產科技 + 建築加成 + 暫時人口 buff。
 * discord_user_id 為 null（無主／NPC 且無擁有者）時回傳全 0。
 */
export async function loadProductionModifiersForUser(
  userId: string,
): Promise<ProductionModifiers> {
  const [techAgg, buildingAgg, buffPct] = await Promise.all([
    aggregateProductionEffectsForUser(userId),
    aggregateBuildingEffectsForUser(userId),
    loadActivePopBuffPct(userId),
  ]);
  return {
    productionBonusPct:
      techAgg.productivityBonusPct + buildingAgg.productivityBonusPct,
    techPointsBonusPct:
      techAgg.techPointsBonusPct + buildingAgg.techPointsBonusPct,
    populationGrowthBonusPct:
      techAgg.populationGrowthBonusPct +
      buildingAgg.populationGrowthBonusPct +
      buffPct,
  };
}

/**
 * Task #528 — 生產修正值的「明細版」：除了合併修正值外，另把生產力加成拆成
 * 科技 vs 建築兩個獨立百分比，並附上各自的來源清單（節點名稱＋%／建築名稱
 * ＋數量＋%）。供 stat-breakdown 端點使用；合併值語義與
 * loadProductionModifiersForUser 完全一致（同一次載入計算，保證對帳）。
 */
export interface ProductionModifierDetail {
  mods: ProductionModifiers;
  /** 生產科技的生產力加成（%）。 */
  productionTechPct: number;
  /** 建築的生產力加成（%）。 */
  productionBuildingPct: number;
  techSources: ProductivityTechSource[];
  buildingSources: ProductivityBuildingSource[];
  /** 科技樹對人口增長率的加成（%）。 */
  populationTechPct: number;
  /** 建築對人口增長率的加成（%）。 */
  populationBuildingPct: number;
  /** 暫時人口 buff 增長率加成（%）。 */
  populationBuffPct: number;
  /** 人口增長加成：科技節點來源清單。 */
  populationTechSources: ProductivityTechSource[];
  /** 人口增長加成：建築來源清單。 */
  populationBuildingSources: ProductivityBuildingSource[];
}

export async function loadProductionModifierDetailForUser(
  userId: string,
): Promise<ProductionModifierDetail> {
  const [techs, buildingTypes, buffPct] = await Promise.all([
    loadResearchedProductionTechs(userId),
    loadNationBuildingTypes(userId),
    loadActivePopBuffPct(userId),
  ]);
  const techAgg = aggregateProductionEffects(techs.map(toInput));
  const buildingAgg = aggregateBuildingEffects(buildingTypes);
  return {
    mods: {
      productionBonusPct:
        techAgg.productivityBonusPct + buildingAgg.productivityBonusPct,
      techPointsBonusPct:
        techAgg.techPointsBonusPct + buildingAgg.techPointsBonusPct,
      populationGrowthBonusPct:
        techAgg.populationGrowthBonusPct +
        buildingAgg.populationGrowthBonusPct +
        buffPct,
    },
    productionTechPct: techAgg.productivityBonusPct,
    productionBuildingPct: buildingAgg.productivityBonusPct,
    techSources: productivityTechSources(techs),
    buildingSources: productivityBuildingSources(buildingTypes),
    populationTechPct: techAgg.populationGrowthBonusPct,
    populationBuildingPct: buildingAgg.populationGrowthBonusPct,
    populationBuffPct: buffPct,
    populationTechSources: populationGrowthTechSources(techs),
    populationBuildingSources: populationGrowthBuildingSources(buildingTypes),
  };
}

/**
 * 一次載入全部玩家的生產修正值（回合引擎批次用；避免每國一次查詢）。
 * key = discord_user_id。含生產科技、建築加成與暫時人口 buff。
 */
export async function loadProductionModifiersByUser(): Promise<
  Map<string, ProductionModifiers>
> {
  const out = new Map<string, ProductionModifiers>();
  const add = (userId: string): ProductionModifiers => {
    let m = out.get(userId);
    if (!m) {
      m = {
        productionBonusPct: 0,
        techPointsBonusPct: 0,
        populationGrowthBonusPct: 0,
      };
      out.set(userId, m);
    }
    return m;
  };

  // 生產科技彙總。
  const techByUser = await loadProductionInputsByUser();
  for (const [userId, list] of techByUser) {
    const agg = aggregateProductionEffects(list);
    const m = add(userId);
    m.productionBonusPct += agg.productivityBonusPct;
    m.techPointsBonusPct += agg.techPointsBonusPct;
    m.populationGrowthBonusPct += agg.populationGrowthBonusPct;
  }

  // 建築加成彙總。
  const buildingRows = await db
    .select({
      userId: cityBuildingsTable.discordUserId,
      buildingType: cityBuildingsTable.buildingType,
    })
    .from(cityBuildingsTable);
  const buildingByUser = new Map<string, string[]>();
  for (const r of buildingRows) {
    const list = buildingByUser.get(r.userId) ?? [];
    list.push(r.buildingType);
    buildingByUser.set(r.userId, list);
  }
  for (const [userId, list] of buildingByUser) {
    const agg = aggregateBuildingEffects(list);
    const m = add(userId);
    m.productionBonusPct += agg.productivityBonusPct;
    m.techPointsBonusPct += agg.techPointsBonusPct;
    m.populationGrowthBonusPct += agg.populationGrowthBonusPct;
  }

  // 暫時人口 buff。
  const buffRows = await db
    .select({
      userId: nationPopulationBuffsTable.discordUserId,
      total: sql<string>`SUM(${nationPopulationBuffsTable.growthPct})`,
    })
    .from(nationPopulationBuffsTable)
    .where(gt(nationPopulationBuffsTable.remainingTurns, 0))
    .groupBy(nationPopulationBuffsTable.discordUserId);
  for (const r of buffRows) {
    add(r.userId).populationGrowthBonusPct += Number(r.total);
  }

  return out;
}

/**
 * 一次載入全部玩家的「已減免建築維護費」（回合引擎批次用）。
 * key = discord_user_id, value = 減免後的每回合維護費。
 */
export async function loadBuildingUpkeepByUser(
  eraScale = 1,
): Promise<Map<string, number>> {
  const buildingRows = await db
    .select({
      userId: cityBuildingsTable.discordUserId,
      buildingType: cityBuildingsTable.buildingType,
    })
    .from(cityBuildingsTable);
  const byUser = new Map<string, string[]>();
  for (const r of buildingRows) {
    const list = byUser.get(r.userId) ?? [];
    list.push(r.buildingType);
    byUser.set(r.userId, list);
  }

  const out = new Map<string, number>();
  if (byUser.size === 0) return out;

  // 各玩家的建築維護費減免（來自生產科技，如風車技術 −50%）。
  const techByUser = await loadProductionInputsByUser();

  for (const [userId, types] of byUser) {
    // 維護費隨時代膨脹（與稅收同一把尺）；減免百分比在縮放後套用。
    const upkeepTotal = aggregateBuildingEffects(types).upkeepTotal * eraScale;
    const reductionPct = techByUser.has(userId)
      ? aggregateProductionEffects(techByUser.get(userId)!)
          .buildingUpkeepReductionPct
      : 0;
    out.set(userId, applyUpkeepReduction(upkeepTotal, reductionPct));
  }
  return out;
}

/**
 * 回合結算：所有暫時人口 buff remaining_turns −1，歸零者刪除。回傳刪除數。
 */
export async function tickPopulationBuffs(): Promise<{ expired: number }> {
  await db
    .update(nationPopulationBuffsTable)
    .set({
      remainingTurns: sql`${nationPopulationBuffsTable.remainingTurns} - 1`,
    })
    .where(gt(nationPopulationBuffsTable.remainingTurns, 0));
  const deleted = await db
    .delete(nationPopulationBuffsTable)
    .where(sql`${nationPopulationBuffsTable.remainingTurns} <= 0`)
    .returning({ id: nationPopulationBuffsTable.id });
  return { expired: deleted.length };
}

/**
 * Task #355 — 回合結算：所有暫時滿意度 buff remaining_turns −1，歸零者刪除。
 * 回傳刪除數。比照 tickPopulationBuffs。
 */
export async function tickSatisfactionBuffs(): Promise<{ expired: number }> {
  await db
    .update(nationSatisfactionBuffsTable)
    .set({
      remainingTurns: sql`${nationSatisfactionBuffsTable.remainingTurns} - 1`,
    })
    .where(gt(nationSatisfactionBuffsTable.remainingTurns, 0));
  const deleted = await db
    .delete(nationSatisfactionBuffsTable)
    .where(sql`${nationSatisfactionBuffsTable.remainingTurns} <= 0`)
    .returning({ id: nationSatisfactionBuffsTable.id });
  return { expired: deleted.length };
}
