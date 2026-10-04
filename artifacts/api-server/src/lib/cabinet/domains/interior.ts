import { getEraSlugs } from "../../nationStats";
import { eraCostScale, scaleByEra } from "../../eraCostScale";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  cabinetApprovalsTable,
  cityBuildingsTable,
  cityWallsTable,
  financePendingIdeasTable,
  mapCitiesTable,
  playerNationsTable,
  regionControlsTable,
  type PlayerNation,
  type WallTier,
} from "@workspace/db";
import { z } from "zod";
import type {
  CabinetDomainModule,
  DomainActionKey,
  ExecuteApprovedContext,
  RunDomainContext,
} from "../types";
import { logger } from "../../logger";
import {
  proposeApproval,
  recordCabinetAction,
  type CabinetActionCost,
} from "../index";
import { fireCabinetNotify } from "../cabinetNotify";
import { agencyLevelHint, normalizeStyle, styleToPromptFragment } from "../style";
import {
  interiorBoldness,
  isLastBuildingSlot,
  isMajorFoodPolicyChange,
  isMajorSpend,
  shouldAutoSubmitFiscalPolicy,
  willOverstepAuthorization,
} from "./interiorPolicy";
import { computeNationFoodReport } from "../../foodData";
import { buildNationContext } from "../../nationContext";
import { loadActivePolicySummaries } from "../../politicsActivePolicies";
import {
  FOOD_POLICY_OUTPUT_BONUS_PCT,
  FOOD_POLICY_RATION_SAVING_PCT,
  FOOD_POLICY_SATISFACTION_COST_PER_TURN,
} from "../../food";
import {
  planInteriorActions,
  type FoodBrief,
  type BuildOption,
  type DemolishOption,
  type InteriorPlanInput,
  type TechOption,
  type WallOption,
} from "./interiorAi";
import { FINANCE_IDEA_MAX_LENGTH } from "../../economy";
import { aggregateSocialEffectsForUser } from "../../socialTechData";
import {
  aggregateProductionEffectsForUser,
  getProductionDomainEra,
} from "../../productionTechData";
import {
  listTechTreeResearchCandidates,
  startTechTreeResearch,
} from "../../techTreeResearch";
import { buildingByType } from "../../production";
import {
  getGameBalanceSettings,
  scaleConstructionCost,
} from "../../gameBalance";
import { cityBuildingSlots } from "../../socialTech";
import {
  canUpgradeWall,
  nextWallTier,
  WALL_TIER_LABELS,
  WALL_UPGRADE_COST,
} from "../../wall";
import { ERAS, getEraIndex } from "../../mapRegionEras";

/**
 * Task #243 — 內政大臣領域模組（代理執行）。
 *
 * 每回合依玩家常駐方針、已授權的可代理項目、代理程度與大臣執政風格，透過一次
 * bulk AI 規劃，挑選當回合要推動的內政行動並：
 *   - 已授權且非重大 → 直接代理執行（沿用既有 economy/tech/region 規則與交易守衛）。
 *   - 重大決策，或大臣「越界」提出未授權項目 → 送進審批佇列（不自動執行）。
 * 玩家在內閣批准後，executeApproved 以相同守衛真正套用。所有文字皆 zh-TW。
 *
 * 純門檻判定集中於 interiorPolicy.ts（單元測試）；AI 規劃在 interiorAi.ts。
 */

const KEY_RESEARCH_SOCIAL = "research_social_tech";
const KEY_RESEARCH_PRODUCTION = "research_production_tech";
const KEY_FISCAL_POLICY = "fiscal_policy";
const KEY_BUILD_BUILDING = "build_city_building";
const KEY_DEMOLISH_BUILDING = "demolish_city_building";
const KEY_UPGRADE_WALL = "upgrade_wall";
const KEY_FOOD_POLICY = "food_policy";

export const actionKeys: DomainActionKey[] = [
  {
    key: KEY_RESEARCH_SOCIAL,
    label: "研發社會科技",
    description: "由大臣依方針從社會科技樹挑選下一個研發目標（科研點數逐回合投入）。",
  },
  {
    key: KEY_RESEARCH_PRODUCTION,
    label: "研發生產科技",
    description: "由大臣依方針從生產科技樹挑選下一個研發目標（科研點數逐回合投入）。",
  },
  {
    key: KEY_FISCAL_POLICY,
    label: "財政稅制政策",
    description: "由大臣草擬加稅／減稅／稅制改革，回合結算時由 AI 判定。",
  },
  {
    key: KEY_BUILD_BUILDING,
    label: "興建城市建築",
    description: "由大臣在掌控城市興建已解鎖的建築（消耗金錢）。",
  },
  {
    key: KEY_DEMOLISH_BUILDING,
    label: "拆除城市建築",
    description: "由大臣拆除掌控城市內既有建築以騰出建築槽（不退款，一律送審批）。",
  },
  {
    key: KEY_UPGRADE_WALL,
    label: "升級城牆",
    description: "由大臣升級掌控城市的城牆至已解鎖階級（消耗金錢）。",
  },
  {
    key: KEY_FOOD_POLICY,
    label: "糧食政策開關",
    description:
      "由大臣依糧食報告開關全民動員／配給制（每項開啟中的政策每回合扣人民滿意度）。",
  },
];

const ACTION_LABEL: Record<string, string> = Object.fromEntries(
  actionKeys.map((a) => [a.key, a.label]),
);
const ALL_KEYS = actionKeys.map((a) => a.key);

type ExecResult = { ok: true; detail: string } | { ok: false; error: string };

class ExecGuardError extends Error {}

// ── 守衛式執行 helper（沿用各路由的交易與條件式扣除規則） ──────────────

/**
 * Task #469 — 內閣自動研發改為全球科技樹「選研」：不再即時扣科技點數，
 * 而是把該領域的進行中節點設為所選節點（成本快照鎖定，之後由回合結算
 * 逐回合灌入科研點數）。守衛（前置／時代／同領域一次一項）與玩家路由共用
 * startTechTreeResearch。
 */
async function execStartTreeResearch(
  nation: PlayerNation,
  domain: "social" | "production",
  nodeId: number,
): Promise<ExecResult> {
  if (!nation.discordUserId) return { ok: false, error: "此國家已無擁有者" };
  const r = await startTechTreeResearch({
    nation,
    nodeId,
    expectedDomain: domain,
  });
  if (!r.ok) return { ok: false, error: r.error };
  const label = domain === "social" ? "社會" : "生產";
  return { ok: true, detail: `開始研發${label}科技「${r.node.name}」` };
}

async function execFiscalPolicy(
  nationId: string,
  idea: string,
): Promise<ExecResult> {
  const trimmed = idea.trim();
  if (!trimmed) return { ok: false, error: "財政政策內容為空" };
  if (trimmed.length > FINANCE_IDEA_MAX_LENGTH) {
    return { ok: false, error: "財政政策內容過長" };
  }
  const inserted = await db
    .insert(financePendingIdeasTable)
    .values({ nationId, idea: trimmed })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    return { ok: false, error: "已有待判定的財政政策" };
  }
  return { ok: true, detail: "提交財政稅制政策" };
}

/**
 * 切換糧食政策開關（沿用 POST /economy/food/policies 的寫入守則：
 * 布林驗證、至少一項、直接 UPDATE player_nations 並回傳最新狀態）。
 */
async function execFoodPolicy(
  nationId: string,
  changes: { mobilization?: boolean; rationing?: boolean },
): Promise<ExecResult> {
  if (changes.mobilization === undefined && changes.rationing === undefined) {
    return { ok: false, error: "沒有要切換的糧食政策" };
  }
  const [updated] = await db
    .update(playerNationsTable)
    .set({
      ...(changes.mobilization !== undefined
        ? { foodPolicyMobilization: changes.mobilization }
        : {}),
      ...(changes.rationing !== undefined
        ? { foodPolicyRationing: changes.rationing }
        : {}),
      updatedAt: sql`NOW()`,
    })
    .where(eq(playerNationsTable.id, nationId))
    .returning({
      mobilization: playerNationsTable.foodPolicyMobilization,
      rationing: playerNationsTable.foodPolicyRationing,
    });
  if (!updated) return { ok: false, error: "國家不存在或已被移除" };
  const parts: string[] = [];
  if (changes.mobilization !== undefined) {
    parts.push(`全民動員${changes.mobilization ? "開啟" : "關閉"}`);
  }
  if (changes.rationing !== undefined) {
    parts.push(`配給制${changes.rationing ? "開啟" : "關閉"}`);
  }
  return { ok: true, detail: `糧食政策調整：${parts.join("、")}` };
}

async function assertCityControlled(
  nationId: string,
  cityId: number,
): Promise<{ regionId: number } | null> {
  const [city] = await db
    .select({ id: mapCitiesTable.id, regionId: mapCitiesTable.regionId })
    .from(mapCitiesTable)
    .where(eq(mapCitiesTable.id, cityId))
    .limit(1);
  if (!city) return null;
  const [control] = await db
    .select({ id: regionControlsTable.id })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.nationId, nationId),
        eq(regionControlsTable.regionId, city.regionId),
      ),
    )
    .limit(1);
  if (!control) return null;
  return { regionId: city.regionId };
}

async function execBuildBuilding(
  userId: string,
  nationId: string,
  cityId: number,
  buildingType: string,
): Promise<ExecResult> {
  const def = buildingByType(buildingType);
  if (!def) return { ok: false, error: "建築類型不正確" };
  const social = await aggregateSocialEffectsForUser(userId);
  if (!social.buildingSlotsEnabled) {
    return { ok: false, error: "尚未解鎖建築槽" };
  }
  const slotsPerCity = cityBuildingSlots(social);
  if (slotsPerCity <= 0) return { ok: false, error: "目前沒有可用的建築槽" };
  const prod = await aggregateProductionEffectsForUser(userId);
  if (!prod.unlockedBuildings.includes(buildingType)) {
    return { ok: false, error: `${def.name}尚未解鎖` };
  }
  const controlled = await assertCityControlled(nationId, cityId);
  if (!controlled) return { ok: false, error: "這座城市不在掌控地區內" };
  // Task #523 — 一般城市建築成本倍率（與 POST /economy/buildings 同一縮放）。
  const buildCost = scaleConstructionCost(
    def.buildCost * eraCostScale((await getEraSlugs()).statsEra),
    (await getGameBalanceSettings()).constructionCosts.cityBuilding,
  );
  try {
    await db.transaction(async (tx) => {
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
        throw new ExecGuardError("這座城市的建築槽已滿");
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
      if (!updated[0]) throw new ExecGuardError("金錢不足");
      await tx
        .insert(cityBuildingsTable)
        .values({ discordUserId: userId, cityId, buildingType });
    });
  } catch (err) {
    if (err instanceof ExecGuardError) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: true, detail: `興建${def.name}` };
}

async function execDemolishBuilding(
  userId: string,
  buildingId: number,
): Promise<ExecResult> {
  // 沿用 DELETE /economy/buildings/:id 的守衛：僅可拆除自己名下的建築、不退款。
  const [existing] = await db
    .select({
      id: cityBuildingsTable.id,
      buildingType: cityBuildingsTable.buildingType,
    })
    .from(cityBuildingsTable)
    .where(
      and(
        eq(cityBuildingsTable.id, buildingId),
        eq(cityBuildingsTable.discordUserId, userId),
      ),
    )
    .limit(1);
  if (!existing) return { ok: false, error: "找不到這座建築" };
  const deleted = await db
    .delete(cityBuildingsTable)
    .where(
      and(
        eq(cityBuildingsTable.id, buildingId),
        eq(cityBuildingsTable.discordUserId, userId),
      ),
    )
    .returning();
  if (!deleted[0]) return { ok: false, error: "找不到這座建築" };
  const def = buildingByType(existing.buildingType);
  return { ok: true, detail: `拆除${def?.name ?? "建築"}` };
}

async function execUpgradeWall(
  userId: string,
  nationId: string,
  cityId: number,
  targetTier: string,
): Promise<ExecResult> {
  const controlled = await assertCityControlled(nationId, cityId);
  if (!controlled) return { ok: false, error: "這座城市不在掌控地區內" };
  const prod = await aggregateProductionEffectsForUser(userId);
  const productionEraSlug = await getProductionDomainEra(userId);
  const wallOpts = {
    cityWallEnabled: prod.cityWallEnabled,
    productionEraSlug,
  };
  const wallEraScale = eraCostScale((await getEraSlugs()).statsEra);
  try {
    return await db.transaction(async (tx) => {
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
      if (!check.ok) throw new ExecGuardError(check.error);
      const cost = scaleByEra(WALL_UPGRADE_COST[check.tier], wallEraScale);
      const updated = await tx
        .update(playerNationsTable)
        .set({ money: sql`${playerNationsTable.money} - ${cost}` })
        .where(
          and(
            eq(playerNationsTable.id, nationId),
            sql`${playerNationsTable.money} >= ${cost}`,
          ),
        )
        .returning();
      if (!updated[0]) throw new ExecGuardError("金錢不足");
      await tx
        .insert(cityWallsTable)
        .values({ cityId, tier: check.tier })
        .onConflictDoUpdate({
          target: cityWallsTable.cityId,
          set: { tier: check.tier },
        });
      return {
        ok: true as const,
        detail: `升級城牆至${WALL_TIER_LABELS[check.tier]}`,
      };
    });
  } catch (err) {
    if (err instanceof ExecGuardError) return { ok: false, error: err.message };
    throw err;
  }
}

// ── 每回合代理 ─────────────────────────────────────────────────────

function eraLabel(slug: string): string {
  return ERAS[getEraIndex(slug)]?.label ?? slug;
}

/** 蒐集當回合可代理行動的候選清單（僅蒐集 consider 內的項目）。 */
async function gatherOptions(
  nation: PlayerNation,
  userId: string,
  nationId: string,
  consider: Set<string>,
): Promise<{
  socialHand: TechOption[];
  productionHand: TechOption[];
  buildOptions: BuildOption[];
  demolishOptions: DemolishOption[];
  wallOptions: WallOption[];
}> {
  let socialHand: TechOption[] = [];
  let productionHand: TechOption[] = [];
  let buildOptions: BuildOption[] = [];
  let demolishOptions: DemolishOption[] = [];
  let wallOptions: WallOption[] = [];

  // Task #469 — 科技樹選研候選：該領域目前可開始研發的節點（含估算成本，
  // 成本會在選研當下由 startTechTreeResearch 重算並快照）。已有進行中 → 空。
  if (consider.has(KEY_RESEARCH_SOCIAL)) {
    try {
      socialHand = await listTechTreeResearchCandidates(nation, "social");
    } catch (err) {
      logger.error({ err }, "cabinet: load social tree candidates failed");
    }
  }
  if (consider.has(KEY_RESEARCH_PRODUCTION)) {
    try {
      productionHand = await listTechTreeResearchCandidates(nation, "production");
    } catch (err) {
      logger.error({ err }, "cabinet: load production tree candidates failed");
    }
  }

  const needCities =
    consider.has(KEY_BUILD_BUILDING) || consider.has(KEY_UPGRADE_WALL);
  if (needCities) {
    const cities = await db
      .select({ id: mapCitiesTable.id, name: mapCitiesTable.name })
      .from(mapCitiesTable)
      .innerJoin(
        regionControlsTable,
        eq(regionControlsTable.regionId, mapCitiesTable.regionId),
      )
      .where(eq(regionControlsTable.nationId, nationId));
    if (cities.length > 0) {
      const cityIds = cities.map((c) => c.id);
      const prod = await aggregateProductionEffectsForUser(userId);

      if (consider.has(KEY_BUILD_BUILDING)) {
        const social = await aggregateSocialEffectsForUser(userId);
        const slotsPerCity = cityBuildingSlots(social);
        if (
          social.buildingSlotsEnabled &&
          slotsPerCity > 0 &&
          prod.unlockedBuildings.length > 0
        ) {
          const usedRows = await db
            .select({
              cityId: cityBuildingsTable.cityId,
              n: sql<number>`count(*)::int`,
            })
            .from(cityBuildingsTable)
            .where(
              and(
                eq(cityBuildingsTable.discordUserId, userId),
                inArray(cityBuildingsTable.cityId, cityIds),
              ),
            )
            .groupBy(cityBuildingsTable.cityId);
          const usedByCity = new Map(usedRows.map((r) => [r.cityId, r.n]));
          // Task #523 — 一般城市建築成本倍率（顯示與扣款一致）。
          const cityBuildingMult = (await getGameBalanceSettings())
            .constructionCosts.cityBuilding;
          const menuEraScale = eraCostScale((await getEraSlugs()).statsEra);
          for (const c of cities) {
            const remainingSlots = slotsPerCity - (usedByCity.get(c.id) ?? 0);
            if (remainingSlots <= 0) continue;
            for (const bt of prod.unlockedBuildings) {
              const def = buildingByType(bt);
              if (!def) continue;
              buildOptions.push({
                cityId: c.id,
                cityName: c.name,
                buildingType: bt,
                buildingName: def.name,
                cost: scaleConstructionCost(def.buildCost * menuEraScale, cityBuildingMult),
                remainingSlots,
              });
            }
          }
        }
      }

      if (consider.has(KEY_DEMOLISH_BUILDING)) {
        const nameByCity = new Map(cities.map((c) => [c.id, c.name]));
        const existing = await db
          .select({
            id: cityBuildingsTable.id,
            cityId: cityBuildingsTable.cityId,
            buildingType: cityBuildingsTable.buildingType,
          })
          .from(cityBuildingsTable)
          .where(
            and(
              eq(cityBuildingsTable.discordUserId, userId),
              inArray(cityBuildingsTable.cityId, cityIds),
            ),
          );
        for (const b of existing) {
          const def = buildingByType(b.buildingType);
          demolishOptions.push({
            buildingId: b.id,
            cityId: b.cityId,
            cityName: nameByCity.get(b.cityId) ?? "",
            buildingType: b.buildingType,
            buildingName: def?.name ?? b.buildingType,
          });
        }
      }

      if (consider.has(KEY_UPGRADE_WALL)) {
        const wallMenuEraScale = eraCostScale((await getEraSlugs()).statsEra);
        const productionEraSlug = await getProductionDomainEra(userId);
        const wallOpts = {
          cityWallEnabled: prod.cityWallEnabled,
          productionEraSlug,
        };
        const wallRows = await db
          .select({ cityId: cityWallsTable.cityId, tier: cityWallsTable.tier })
          .from(cityWallsTable)
          .where(inArray(cityWallsTable.cityId, cityIds));
        const tierByCity = new Map(
          wallRows.map((r) => [r.cityId, r.tier as WallTier]),
        );
        for (const c of cities) {
          const current = tierByCity.get(c.id) ?? "wood";
          const next = nextWallTier(current);
          if (!next) continue;
          const check = canUpgradeWall(current, next, wallOpts);
          if (!check.ok) continue;
          wallOptions.push({
            cityId: c.id,
            cityName: c.name,
            tier: next,
            tierLabel: WALL_TIER_LABELS[next],
            cost: scaleByEra(WALL_UPGRADE_COST[next], wallMenuEraScale),
          });
        }
      }
    }
  }

  return {
    socialHand,
    productionHand,
    buildOptions: buildOptions.slice(0, 24),
    demolishOptions: demolishOptions.slice(0, 24),
    wallOptions: wallOptions.slice(0, 24),
  };
}

export async function runDomain(ctx: RunDomainContext): Promise<void> {
  const { nation, minister, enabledActionKeys, directive, agencyLevel, era } =
    ctx;
  // 大臣為玩家服務；無主國家（無 Discord 帳號）不代理，也無從通知。
  if (!nation.discordUserId) return;
  const userId = nation.discordUserId;
  const style = normalizeStyle(minister.style);
  const boldness = interiorBoldness(agencyLevel, style);

  const enabled = new Set(enabledActionKeys);
  const overstep = willOverstepAuthorization(style);
  const consider = new Set<string>(enabled);
  if (overstep) for (const k of ALL_KEYS) consider.add(k);
  if (consider.size === 0) return;

  const options = await gatherOptions(nation, userId, nation.id, consider);

  // 糧食報告（Task #435）：讓大臣懂得在饑荒前開政策、豐收時關政策止血滿意度。
  // 報告失敗不影響其他內政行動（food = null → AI 不得切換糧食政策）。
  let food: FoodBrief | null = null;
  if (consider.has(KEY_FOOD_POLICY)) {
    try {
      const report = await computeNationFoodReport(nation, era);
      food = {
        production: report.production.total,
        consumption: report.consumption.total,
        balance: report.balance,
        famine: report.famine,
        mobilization: report.policies.mobilization,
        rationing: report.policies.rationing,
        outputBonusPct: FOOD_POLICY_OUTPUT_BONUS_PCT,
        rationSavingPct: FOOD_POLICY_RATION_SAVING_PCT,
        satisfactionCostPerTurn: FOOD_POLICY_SATISFACTION_COST_PER_TURN,
      };
    } catch (err) {
      logger.error(
        { err, nationId: nation.id },
        "cabinet: food report failed",
      );
    }
  }

  const hasActionable =
    consider.has(KEY_FISCAL_POLICY) ||
    food !== null ||
    options.socialHand.length > 0 ||
    options.productionHand.length > 0 ||
    options.buildOptions.length > 0 ||
    options.demolishOptions.length > 0 ||
    options.wallOptions.length > 0;
  if (!hasActionable) return;

  // 已存在的待批准事項：同一 actionKey 已在佇列就不重複提案（避免每回合灌爆）。
  const pending = await db
    .select({ actionKey: cabinetApprovalsTable.actionKey })
    .from(cabinetApprovalsTable)
    .where(
      and(
        eq(cabinetApprovalsTable.nationId, nation.id),
        eq(cabinetApprovalsTable.domain, "interior"),
        eq(cabinetApprovalsTable.status, "pending"),
      ),
    );
  const pendingKeys = new Set(pending.map((p) => p.actionKey));

  // 國情快照（2026-10）：讓大臣知道戰爭狀態與現行制度（國力／糧食
  // 它已有自己的報告行）。載入失敗只省略該行，不擋規劃。
  const buildInteriorContext = async (): Promise<string | null> => {
    try {
      const activePolicies = await loadActivePolicySummaries(nation.id);
      return await buildNationContext(nation, era, {
        activePolicies,
        minimal: true,
      });
    } catch (err) {
      logger.error({ err, nationId: nation.id }, "interior context load failed");
      return null;
    }
  };

  const input: InteriorPlanInput = {
    nationName: nation.name,
    eraLabel: eraLabel(era),
    directive,
    stylePrompt: styleToPromptFragment(style),
    agencyHint: agencyLevelHint(agencyLevel),
    actionMenu: [...consider]
      .map((k) => ACTION_LABEL[k])
      .filter((l): l is string => Boolean(l)),
    treasury: Number(nation.money),
    techPoints: nation.techPoints,
    taxRatePct: nation.taxRatePct,
    socialHand: options.socialHand,
    productionHand: options.productionHand,
    buildOptions: options.buildOptions,
    demolishOptions: options.demolishOptions,
    wallOptions: options.wallOptions,
    food,
    context: await buildInteriorContext(),
  };

  let plan;
  try {
    plan = await planInteriorActions(input);
  } catch (err) {
    logger.error(
      { err, nationId: nation.id },
      "cabinet interior AI plan failed",
    );
    return;
  }

  const ministerName = minister.name;
  const autoDone: string[] = [];
  const isAuthorized = (key: string) => enabled.has(key);
  const propose = async (
    key: string,
    summary: string,
    params: unknown,
    cost?: CabinetActionCost | null,
  ): Promise<void> => {
    if (pendingKeys.has(key)) return;
    await proposeApproval({
      nation,
      domain: "interior",
      ministerName,
      actionKey: key,
      summary,
      params,
      cost,
    });
    pendingKeys.add(key);
  };

  // 科技樹選研（不扣點、可取消 → 已授權即自動執行，未授權才送審批）。
  if (plan.researchSocialTechId != null && consider.has(KEY_RESEARCH_SOCIAL)) {
    const opt = options.socialHand.find(
      (t) => t.id === plan.researchSocialTechId,
    );
    if (opt) {
      const summary = `開始研發社會科技「${opt.name}」（總成本 ${opt.cost.toLocaleString("en-US")}點）`;
      if (isAuthorized(KEY_RESEARCH_SOCIAL)) {
        const r = await execStartTreeResearch(nation, "social", opt.id);
        if (r.ok) {
          autoDone.push(r.detail);
          await recordCabinetAction({
            nationId: nation.id,
            domain: "interior",
            actionKey: KEY_RESEARCH_SOCIAL,
            summary,
            mode: "auto",
            cost: { amount: opt.cost, kind: "tech" },
          });
        } else
          logger.info({ nationId: nation.id, err: r.error }, "cabinet: social research skipped");
      } else {
        await propose(
          KEY_RESEARCH_SOCIAL,
          summary,
          { nodeId: opt.id, techName: opt.name, costPoints: opt.cost },
          { amount: opt.cost, kind: "tech" },
        );
      }
    }
  }

  if (
    plan.researchProductionTechId != null &&
    consider.has(KEY_RESEARCH_PRODUCTION)
  ) {
    const opt = options.productionHand.find(
      (t) => t.id === plan.researchProductionTechId,
    );
    if (opt) {
      const summary = `開始研發生產科技「${opt.name}」（總成本 ${opt.cost.toLocaleString("en-US")}點）`;
      if (isAuthorized(KEY_RESEARCH_PRODUCTION)) {
        const r = await execStartTreeResearch(nation, "production", opt.id);
        if (r.ok) {
          autoDone.push(r.detail);
          await recordCabinetAction({
            nationId: nation.id,
            domain: "interior",
            actionKey: KEY_RESEARCH_PRODUCTION,
            summary,
            mode: "auto",
            cost: { amount: opt.cost, kind: "tech" },
          });
        } else
          logger.info({ nationId: nation.id, err: r.error }, "cabinet: production research skipped");
      } else {
        await propose(
          KEY_RESEARCH_PRODUCTION,
          summary,
          { nodeId: opt.id, techName: opt.name, costPoints: opt.cost },
          { amount: opt.cost, kind: "tech" },
        );
      }
    }
  }

  // 財政稅制政策（高影響：僅積極度足夠者自行提交，否則送審批）。
  // Task #584 — 政變後政策封鎖期間內閣靜默跳過（不提案、不送審批）。
  if (
    plan.fiscalPolicy &&
    consider.has(KEY_FISCAL_POLICY) &&
    nation.coupPolicyLockTurns > 0
  ) {
    logger.info(
      { nationId: nation.id, lockTurns: nation.coupPolicyLockTurns },
      "cabinet: fiscal policy skipped (coup policy lock)",
    );
  } else if (plan.fiscalPolicy && consider.has(KEY_FISCAL_POLICY)) {
    const idea = plan.fiscalPolicy;
    const summary = `提交財政稅制政策：${idea.slice(0, 60)}${idea.length > 60 ? "…" : ""}`;
    if (isAuthorized(KEY_FISCAL_POLICY) && shouldAutoSubmitFiscalPolicy(boldness)) {
      const r = await execFiscalPolicy(nation.id, idea);
      if (r.ok) {
        autoDone.push(r.detail);
        await recordCabinetAction({
          nationId: nation.id,
          domain: "interior",
          actionKey: KEY_FISCAL_POLICY,
          summary,
          mode: "auto",
        });
      } else
        logger.info({ nationId: nation.id, err: r.error }, "cabinet: fiscal policy skipped");
    } else {
      await propose(KEY_FISCAL_POLICY, summary, { idea });
    }
  }

  // 城市建築（以國庫金錢餘額判定重大與否）。
  if (plan.building && consider.has(KEY_BUILD_BUILDING)) {
    const opt = options.buildOptions.find(
      (b) =>
        b.cityId === plan.building!.cityId &&
        b.buildingType === plan.building!.buildingType,
    );
    if (opt) {
      // 重大條件：花費佔國庫比例過高，或這次興建會用掉該城最後一個建築槽。
      const major =
        isMajorSpend({
          cost: opt.cost,
          treasury: Number(nation.money),
          boldness,
        }) || isLastBuildingSlot(opt.remainingSlots);
      const summary = `於${opt.cityName}興建${opt.buildingName}（${opt.cost.toLocaleString("en-US")}金）`;
      if (isAuthorized(KEY_BUILD_BUILDING) && !major) {
        const r = await execBuildBuilding(
          userId,
          nation.id,
          opt.cityId,
          opt.buildingType,
        );
        if (r.ok) {
          autoDone.push(`於${opt.cityName}${r.detail}`);
          await recordCabinetAction({
            nationId: nation.id,
            domain: "interior",
            actionKey: KEY_BUILD_BUILDING,
            summary,
            mode: "auto",
            cost: { amount: opt.cost, kind: "money" },
          });
        } else
          logger.info({ nationId: nation.id, err: r.error }, "cabinet: build skipped");
      } else {
        await propose(
          KEY_BUILD_BUILDING,
          summary,
          {
            cityId: opt.cityId,
            cityName: opt.cityName,
            buildingType: opt.buildingType,
            buildingName: opt.buildingName,
            cost: opt.cost,
          },
          { amount: opt.cost, kind: "money" },
        );
      }
    }
  }

  // 拆除建築（不退款、不可逆）：一律視為重大，永不自動執行，只送審批。
  if (plan.demolish && consider.has(KEY_DEMOLISH_BUILDING)) {
    const opt = options.demolishOptions.find(
      (d) => d.buildingId === plan.demolish!.buildingId,
    );
    if (opt) {
      const summary = `拆除${opt.cityName}的${opt.buildingName}（不退款）`;
      await propose(KEY_DEMOLISH_BUILDING, summary, {
        buildingId: opt.buildingId,
        cityName: opt.cityName,
        buildingName: opt.buildingName,
      });
    }
  }

  // 城牆升級（以國庫金錢餘額判定重大與否）。
  if (plan.wall && consider.has(KEY_UPGRADE_WALL)) {
    const opt = options.wallOptions.find(
      (w) => w.cityId === plan.wall!.cityId,
    );
    if (opt) {
      const major = isMajorSpend({
        cost: opt.cost,
        treasury: Number(nation.money),
        boldness,
      });
      const summary = `升級${opt.cityName}城牆至${opt.tierLabel}（${opt.cost.toLocaleString("en-US")}金）`;
      if (isAuthorized(KEY_UPGRADE_WALL) && !major) {
        const r = await execUpgradeWall(
          userId,
          nation.id,
          opt.cityId,
          opt.tier,
        );
        if (r.ok) {
          autoDone.push(`於${opt.cityName}${r.detail}`);
          await recordCabinetAction({
            nationId: nation.id,
            domain: "interior",
            actionKey: KEY_UPGRADE_WALL,
            summary,
            mode: "auto",
            cost: { amount: opt.cost, kind: "money" },
          });
        } else
          logger.info({ nationId: nation.id, err: r.error }, "cabinet: wall upgrade skipped");
      } else {
        await propose(
          KEY_UPGRADE_WALL,
          summary,
          {
            cityId: opt.cityId,
            cityName: opt.cityName,
            tier: opt.tier,
            cost: opt.cost,
          },
          { amount: opt.cost, kind: "money" },
        );
      }
    }
  }

  // 糧食政策開關（Task #435）：順向切換（饑荒開、豐收關）為 minor，
  // 逆向切換（無饑荒硬開、饑荒中硬關）為重大 → 送審批。
  if (plan.foodPolicy && consider.has(KEY_FOOD_POLICY) && food) {
    const changes: { mobilization?: boolean; rationing?: boolean } = {};
    if (
      plan.foodPolicy.mobilization !== null &&
      plan.foodPolicy.mobilization !== food.mobilization
    ) {
      changes.mobilization = plan.foodPolicy.mobilization;
    }
    if (
      plan.foodPolicy.rationing !== null &&
      plan.foodPolicy.rationing !== food.rationing
    ) {
      changes.rationing = plan.foodPolicy.rationing;
    }
    const changedFlags = [changes.mobilization, changes.rationing].filter(
      (v): v is boolean => v !== undefined,
    );
    if (changedFlags.length > 0) {
      const major = changedFlags.some((enable) =>
        isMajorFoodPolicyChange({ enable, famine: food.famine }),
      );
      const parts: string[] = [];
      if (changes.mobilization !== undefined) {
        parts.push(`全民動員${changes.mobilization ? "開啟" : "關閉"}`);
      }
      if (changes.rationing !== undefined) {
        parts.push(`配給制${changes.rationing ? "開啟" : "關閉"}`);
      }
      const summary = `糧食政策調整：${parts.join("、")}（目前${food.famine ? "饑荒中" : "糧食充足"}，結餘 ${Math.round(food.balance).toLocaleString("en-US")}）`;
      if (isAuthorized(KEY_FOOD_POLICY) && !major) {
        const r = await execFoodPolicy(nation.id, changes);
        if (r.ok) {
          autoDone.push(r.detail);
          await recordCabinetAction({
            nationId: nation.id,
            domain: "interior",
            actionKey: KEY_FOOD_POLICY,
            summary,
            mode: "auto",
          });
        } else
          logger.info({ nationId: nation.id, err: r.error }, "cabinet: food policy skipped");
      } else {
        await propose(KEY_FOOD_POLICY, summary, changes);
      }
    }
  }

  if (autoDone.length > 0) {
    fireCabinetNotify(userId, {
      title: "內政大臣代理施政",
      body: `🏛️ 內政大臣「${ministerName}」本回合代理執行：${autoDone.join("；")}`,
    });
  }
}

// ── 批准後執行 ─────────────────────────────────────────────────────

const approveSocialSchema = z.object({ nodeId: z.number().int().positive() });
const approveProductionSchema = z.object({
  nodeId: z.number().int().positive(),
});
const approveFiscalSchema = z.object({ idea: z.string().trim().min(1) });
const approveBuildSchema = z.object({
  cityId: z.number().int().positive(),
  buildingType: z.string().trim().min(1),
});
const approveDemolishSchema = z.object({
  buildingId: z.number().int().positive(),
});
const approveWallSchema = z.object({
  cityId: z.number().int().positive(),
  tier: z.string().trim().min(1),
});
const approveFoodPolicySchema = z
  .object({
    mobilization: z.boolean().optional(),
    rationing: z.boolean().optional(),
  })
  .refine((v) => v.mobilization !== undefined || v.rationing !== undefined, {
    message: "請至少指定一項糧食政策",
  });

export async function executeApproved(
  ctx: ExecuteApprovedContext,
): Promise<void> {
  const { nation, approval } = ctx;
  const userId = nation.discordUserId;
  const params = approval.params;

  const fail = (msg: string): never => {
    throw new Error(msg);
  };

  let result: ExecResult;
  switch (approval.actionKey) {
    case KEY_RESEARCH_SOCIAL: {
      if (!userId) return fail("此國家已無擁有者");
      const p = approveSocialSchema.parse(params);
      result = await execStartTreeResearch(nation, "social", p.nodeId);
      break;
    }
    case KEY_RESEARCH_PRODUCTION: {
      if (!userId) return fail("此國家已無擁有者");
      const p = approveProductionSchema.parse(params);
      result = await execStartTreeResearch(nation, "production", p.nodeId);
      break;
    }
    case KEY_FISCAL_POLICY: {
      const p = approveFiscalSchema.parse(params);
      result = await execFiscalPolicy(nation.id, p.idea);
      break;
    }
    case KEY_BUILD_BUILDING: {
      if (!userId) return fail("此國家已無擁有者");
      const p = approveBuildSchema.parse(params);
      result = await execBuildBuilding(
        userId,
        nation.id,
        p.cityId,
        p.buildingType,
      );
      break;
    }
    case KEY_DEMOLISH_BUILDING: {
      if (!userId) return fail("此國家已無擁有者");
      const p = approveDemolishSchema.parse(params);
      result = await execDemolishBuilding(userId, p.buildingId);
      break;
    }
    case KEY_UPGRADE_WALL: {
      if (!userId) return fail("此國家已無擁有者");
      const p = approveWallSchema.parse(params);
      result = await execUpgradeWall(userId, nation.id, p.cityId, p.tier);
      break;
    }
    case KEY_FOOD_POLICY: {
      const p = approveFoodPolicySchema.parse(params);
      result = await execFoodPolicy(nation.id, p);
      break;
    }
    default:
      return fail("未知的內政待批准項目");
  }

  if (!result.ok) fail(result.error);
}

export const interiorModule: CabinetDomainModule = {
  domain: "interior",
  actionKeys,
  runDomain,
  executeApproved,
};
