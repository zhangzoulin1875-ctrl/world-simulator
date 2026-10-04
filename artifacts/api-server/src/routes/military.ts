import { loadNationScales } from "../lib/nationScale";
import { Router, type IRouter } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  playerArmiesTable,
  militaryUnitTemplatesTable,
  militaryPurchaseQuotasTable,
  militaryWeaponsTable,
  playerUnitCustomizationsTable,
  recruitProductionSpendsTable,
  type MilitaryUnitTemplate,
  type MilitaryWeapon,
  type PlayerNation,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { aiRateLimit } from "../middlewares/aiRateLimit";
import { ERAS, getEraIndex } from "../lib/mapRegionEras";
import {
  computeAdjustedNationStats,
  getCurrentEraSlug,
  getCurrentGameYear,
  getEraSlugs,
} from "../lib/nationStats";
import {
  DEFAULT_POLITICS_SETTINGS,
  warWearinessAttackModifier,
} from "../lib/politics";
import { getPoliticsSettings } from "../lib/politicsSettings";
import { getWoundedStatus } from "../lib/warEngine";
import {
  MILITARY_CATEGORIES,
  MAX_CUSTOM_UNITS_PER_CATEGORY,
  UNIT_DESIGN_CHARGE_CAP,
  MAX_ORDER_QUANTITY,
  applyTechBonuses,
  categoryLabel,
  categoryLockInfo,
  dailyPurchaseCap,
  effectiveUnitRange,
  isMilitaryCategory,
  normalizeCustomUnitName,
  recruitCost,
  recruitProductionSpend,
  releaseReservation,
  unitProductionReservation,
  summarizeTechBonuses,
  SEA_LANDING_KEY_SLUG,
  type MilitaryCategory,
} from "../lib/military";
import { sumNationalBonusPct } from "../lib/war";
import {
  effectiveLandingAttackReductionPct,
  effectiveSeaLandingCapacity,
} from "../lib/navalLanding";
import {
  UnitCapError,
  UnitDesignRejectedError,
  countCustomUnits,
  designCustomUnit,
} from "../lib/militaryAi";
import { AiQuotaExceededError } from "../lib/gameAi";import type { WeaponSkillEffect } from "../lib/weapons";
import {
  MAX_WEAPONS_PER_PLAYER,
  WEAPON_DESIGN_CHARGE_CAP,
  describeWeaponMods,
  serializeWeapon,
  weaponCombatMods,
  weaponCompatibleWith,
} from "../lib/weapons";
import {
  WeaponCapError,
  WeaponDesignRejectedError,
  countWeapons,
  designCustomWeapon,
} from "../lib/weaponAi";import {
  loadResearchedKeySlugs,
  loadResearchedMilitaryTechs,
  type ResearchedMilitaryNode,
} from "../lib/militaryTechData";
import { localDateString } from "../lib/time";
import { computeAvailableProduction } from "../lib/economy";
import { loadCurrentTurnRecruitSpend } from "../lib/recruitSpend";
import {
  cancelQueueOrder,
  enqueueInTx,
  isRecruitQueueEnabled,
  listNationQueue,
  RecruitQueueFullError,
} from "../lib/recruitQueue";
import {
  estimateTurnsToFinish,
  MAX_QUEUE_TEMPLATES,
  trainingPointsPerUnit,
  turnCapacity,
} from "../lib/recruitQueueCore";
import { buildNationGeoCultureContext } from "../lib/nationGeoCulture";
import {
  getGlobalAveragePopulation,
  researchCostMultiplier,
} from "../lib/researchCost";

const router: IRouter = Router();

/** Error that maps to an HTTP status inside a transaction (throw → rollback). */
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Task #30: no auto-create — the player must found (or claim) a nation on
 * the game home page first. Sends the error response itself; callers just
 * return on null. userId is the session's Discord id (the nation's owner).
 */
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

/**
 * Task #511 — 玩家可建造的模板只剩自己的 AI 自創兵種；預設種子模板保留給
 * NPC 使用，不再出現在建造列表（既有預設軍種部隊的顯示走 war/shared.ts 的
 * 不設限查詢，不受影響）。
 */
async function loadVisibleTemplates(
  userId: string,
): Promise<MilitaryUnitTemplate[]> {
  return db
    .select()
    .from(militaryUnitTemplatesTable)
    .where(eq(militaryUnitTemplatesTable.ownerDiscordUserId, userId))
    .orderBy(asc(militaryUnitTemplatesTable.id));
}

// Task #469 — 已研發軍事科技改由全球科技樹（domain="military"）載入。
async function loadResearchedTechs(
  userId: string,
): Promise<ResearchedMilitaryNode[]> {
  return loadResearchedMilitaryTechs(userId);
}

function serializeTech(tech: ResearchedMilitaryNode) {
  return {
    id: tech.id,
    eraSlug: tech.eraSlug,
    name: tech.name,
    description: tech.description,
    bonuses: tech.bonuses.map((b) => ({
      target: b.target,
      category: b.category,
      pct: b.pct,
    })),
  };
}

/** 玩家對各模板的自訂名稱（templateId → customName）。 */
async function loadCustomNames(userId: string): Promise<Map<number, string>> {
  const rows = await db
    .select({
      templateId: playerUnitCustomizationsTable.templateId,
      customName: playerUnitCustomizationsTable.customName,
    })
    .from(playerUnitCustomizationsTable)
    .where(eq(playerUnitCustomizationsTable.discordUserId, userId));
  return new Map(rows.map((r) => [r.templateId, r.customName]));
}

function serializeTemplate(
  template: MilitaryUnitTemplate,
  researched: ResearchedMilitaryNode[],
  eraSlug: string,
  researchedKeySlugs: readonly string[],
  customName: string | null = null,
  equippedWeapon: MilitaryWeapon | null = null,
  eraScale = 1,
  upkeepScale: number = eraScale,
) {
  const effective = applyTechBonuses(template, researched, eraScale, upkeepScale);
  // 武器系統 — 裝備摘要（相容判定為伺服器純函式；不相容仍可裝備但受懲罰）。
  const weaponCompatible = equippedWeapon
    ? weaponCompatibleWith(equippedWeapon, template.category)
    : null;
  const weaponMods = equippedWeapon
    ? describeWeaponMods({
        equipped: true,
        compatible: weaponCompatible ?? false,
        attackPct: equippedWeapon.attackPct,
        defensePct: equippedWeapon.defensePct,
        skillEffect: equippedWeapon.skillEffect as WeaponSkillEffect,
        skillBonusPct: equippedWeapon.skillBonusPct,
      })
    : null;
  return {
    id: template.id,
    category: template.category,
    categoryLabel: categoryLabel(template.category as MilitaryCategory, eraSlug),
    name: template.name,
    customName,
    description: template.description,
    isDefault: template.isDefault,
    isCustom: template.ownerDiscordUserId !== null,
    range: effectiveUnitRange(template, researchedKeySlugs),
    hp: effective.hp,
    attack: effective.attack,
    defense: effective.defense,
    speed: effective.speed,
    accuracy: effective.accuracy,
    antiCavalryPct: template.antiCavalryPct,
    antiRangedPct: template.antiRangedPct,
    antiArtilleryPct: template.antiArtilleryPct,
    siegePct: template.siegePct,
    // Task #568 — 招募的「立即性花費」以有效 prodCostPer100 計
    // （⌈數量×prodCostPer100÷100⌉）；佔用仍以 prodUpkeepPerUnit 推導。
    prodCostPer100: effective.prodCostPer100,
    popCostPerUnit: effective.popCostPerUnit,
    moneyCostPerUnit: effective.moneyCostPerUnit,
    upkeepPerUnit: effective.upkeepPerUnit,
    prodUpkeepPerUnit: effective.prodUpkeepPerUnit,
    // 木材／礦石成本不吃科技加成（原料量固定）。
    woodCostPerUnit: template.woodCostPerUnit,
    oreCostPerUnit: template.oreCostPerUnit,
    baseHp: template.hp,
    baseAttack: template.attack,
    baseDefense: template.defense,
    baseSpeed: template.speed,
    baseAccuracy: template.accuracy,
    equippedWeaponId: template.equippedWeaponId,
    equippedWeapon: equippedWeapon
      ? {
          ...serializeWeapon(equippedWeapon, eraSlug),
          compatible: weaponCompatible,
          modsLabel: weaponMods,
        }
      : null,
  };
}

interface ResourceSnapshot {
  techPoints: number;
  money: number;
  production: number;
  productionTotal: number;
  productionSpent: number;
  currentTurnSpend: number;
  population: number;
  populationTotal: number;
  wood: number;
  ore: number;
}

function resourceSnapshot(
  nation: PlayerNation,
  stats: { production: number; population: number },
  currentTurnSpend: number,
): ResourceSnapshot {
  // Task #568 — 生產力額度摘要：總量 − 已佔用 − 本回合招募花費 = 剩餘。
  return {
    techPoints: nation.techPoints,
    money: nation.money,
    production: computeAvailableProduction({
      production: stats.production,
      productionSpent: nation.productionSpent,
      currentTurnSpend,
    }),
    productionTotal: stats.production,
    productionSpent: nation.productionSpent,
    currentTurnSpend,
    population: Math.max(0, stats.population - nation.populationSpent),
    populationTotal: stats.population,
    wood: nation.wood,
    ore: nation.ore,
  };
}

async function loadQuota(
  userId: string,
  dateLabel: string,
): Promise<number> {
  const [row] = await db
    .select({ usedUnits: militaryPurchaseQuotasTable.usedUnits })
    .from(militaryPurchaseQuotasTable)
    .where(
      and(
        eq(militaryPurchaseQuotasTable.discordUserId, userId),
        eq(militaryPurchaseQuotasTable.dateLabel, dateLabel),
      ),
    )
    .limit(1);
  return row?.usedUnits ?? 0;
}

/** 軍事總覽：類別解鎖、模板（含科技加成後數值）、軍隊、已研發科技、額度。 */
router.get("/military/overview", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;
  // 解鎖/顯示用當前時代；資源數據用「數據時代」（與玩家首頁一致）。
  const { currentEra: eraSlug, statsEra } = await getEraSlugs();
  const listScales = await loadNationScales(nation.id, statsEra);
  const era = ERAS[getEraIndex(eraSlug)]!;

  const [
    templates,
    researched,
    researchedKeySlugs,
    armies,
    stats,
    customNames,
    wounded,
    currentTurnSpend,
    weapons,
  ] = await Promise.all([
    loadVisibleTemplates(userId),
    loadResearchedTechs(userId),
    loadResearchedKeySlugs(userId),
    db
      .select()
      .from(playerArmiesTable)
      .where(eq(playerArmiesTable.discordUserId, userId))
      .orderBy(asc(playerArmiesTable.templateId)),
    computeAdjustedNationStats(nation, statsEra),
    loadCustomNames(userId),
    getWoundedStatus(userId, nation.id),
    loadCurrentTurnRecruitSpend(nation.id),
    db
      .select()
      .from(militaryWeaponsTable)
      .where(eq(militaryWeaponsTable.ownerDiscordUserId, userId))
      .orderBy(asc(militaryWeaponsTable.id)),
  ]);

  const weaponById = new Map(weapons.map((w) => [w.id, w]));

  const customCounts = new Map<string, number>();
  for (const t of templates) {
    if (t.ownerDiscordUserId !== null) {
      customCounts.set(t.category, (customCounts.get(t.category) ?? 0) + 1);
    }
  }

  const dateLabel = localDateString(new Date());
  const usedUnits = await loadQuota(userId, dateLabel);
  const capUnits = dailyPurchaseCap(stats.population);
  const costMult = researchCostMultiplier(
    stats.population,
    await getGlobalAveragePopulation(statsEra),
  );

  res.json({
    currentEra: eraSlug,
    currentEraLabel: era.label,
    categories: MILITARY_CATEGORIES.map((c) => {
      const lock = categoryLockInfo(c, researchedKeySlugs);
      return {
        slug: c,
        label: categoryLabel(c, eraSlug),
        unlocked: lock.unlocked,
        requiredKeySlug: lock.requiredKeySlug,
        requiredKeyName: lock.requiredKeyName,
        lockReason: lock.lockReason,
        customCount: customCounts.get(c) ?? 0,
      };
    }),
    templates: templates.map((t) =>
      serializeTemplate(
        t,
        researched,
        eraSlug,
        researchedKeySlugs,
        customNames.get(t.id) ?? null,
        t.equippedWeaponId
          ? (weaponById.get(t.equippedWeaponId) ?? null)
          : null,
        listScales.price,
        listScales.upkeep,
      ),
    ),
    armies: armies.map((a) => ({ templateId: a.templateId, quantity: a.quantity })),
    researchedTechs: researched.map(serializeTech),
    bonusSummary: summarizeTechBonuses(researched),
    purchase: {
      dateLabel,
      usedUnits,
      capUnits,
      remainingUnits: Math.max(0, capUnits - usedUnits),
    },
    resources: resourceSnapshot(nation, stats, currentTurnSpend),
    // Task #43 — 厭戰度攻擊修正（純顯示，戰鬥系統落地後取用同一純函式）。
    warWeariness: stats.politics.warWeariness,
    attackModifierPct: Math.round(
      warWearinessAttackModifier(stats.politics.warWeariness) * 100,
    ),
    // Task #510 — 兵種設計改為次數制（每回合 +1、上限 5、每次設計消耗 1）。
    unitDesignCharges: nation.unitDesignCharges,
    unitDesignChargeCap: UNIT_DESIGN_CHARGE_CAP,
    // 武器系統 — 武器藍圖清單與設計次數（每回合回滿至上限）。
    weapons: weapons.map((w) => serializeWeapon(w, eraSlug)),
    weaponDesignCharges: nation.weaponDesignCharges,
    weaponDesignChargeCap: WEAPON_DESIGN_CHARGE_CAP,
    weaponLimit: MAX_WEAPONS_PER_PLAYER,
    // Task #386 — 顯示用倍率（route 序列化才取整到 2 位小數）。
    costMultiplier: Math.round(costMult * 100) / 100,
    maxOrderQuantity: MAX_ORDER_QUANTITY,
    customUnitLimit: MAX_CUSTOM_UNITS_PER_CATEGORY,
    // Task #105 — 傷兵數與科技復原加成（傷兵隨結算迴圈逐步歸隊）。
    woundedTotal: wounded.woundedTotal,
    woundedRecoverySpeedPct: wounded.recoverySpeedPct,
    woundedRecoveryRatePct: wounded.recoveryRatePct,
    // Task #152 — 海上登陸能力（海戰解鎖近海登陸；指南針解鎖跨洋、容許量 ×10）。
    navalLanding: (() => {
      const naval = researchedKeySlugs.includes("naval_warfare");
      const compass = researchedKeySlugs.includes(SEA_LANDING_KEY_SLUG);
      return {
        naval,
        compass,
        troopCapacity: effectiveSeaLandingCapacity(
          sumNationalBonusPct(researched, "seaLandingCapacity"),
          compass,
        ),
        attackReductionPct: effectiveLandingAttackReductionPct(
          sumNationalBonusPct(researched, "landingAttackReduction"),
        ),
      };
    })(),
    // Task #584 — 政變後政策封鎖剩餘回合數（> 0 時前端鎖定兵種設計）。
    coupPolicyLockTurns: nation.coupPolicyLockTurns,
    // Task #584 — 政變後士氣懲罰剩餘回合數（> 0 時戰役結算軍團士氣 −30，戰情室顯示提示）。
    coupMoralePenaltyTurns: nation.coupMoralePenaltyTurns,
    // Task #586 — 懲罰點數（戰情室橫幅顯示「−N」；懲罰未生效時回預設值省一次查詢）。
    coupMoralePenalty:
      nation.coupMoralePenaltyTurns > 0
        ? (await getPoliticsSettings()).coupMoralePenalty
        : DEFAULT_POLITICS_SETTINGS.coupMoralePenalty,
  });
});

function parseOrderBody(body: unknown): { templateId: number; quantity: number } {
  const b = (body ?? {}) as Record<string, unknown>;
  const templateId = b["templateId"];
  const quantity = b["quantity"];
  if (
    typeof templateId !== "number" ||
    !Number.isInteger(templateId) ||
    templateId <= 0
  ) {
    throw new HttpError(400, "templateId 必須是正整數");
  }
  if (
    typeof quantity !== "number" ||
    !Number.isInteger(quantity) ||
    quantity <= 0 ||
    quantity > MAX_ORDER_QUANTITY
  ) {
    throw new HttpError(
      400,
      `quantity 必須是 1 到 ${MAX_ORDER_QUANTITY.toLocaleString("en-US")} 的整數`,
    );
  }
  return { templateId, quantity };
}

/**
 * Task #511 — 徵召/購買只接受玩家自己的自創兵種模板（Task #549 起預設
 * 兵種已全面移除，非本人模板一律 404）。
 */
async function loadOrderTemplate(
  userId: string,
  templateId: number,
  eraSlug: string,
  researchedKeySlugs: readonly string[],
): Promise<MilitaryUnitTemplate> {
  const [template] = await db
    .select()
    .from(militaryUnitTemplatesTable)
    .where(eq(militaryUnitTemplatesTable.id, templateId))
    .limit(1);
  if (!template) throw new HttpError(404, "找不到這個兵種模板");
  if (template.ownerDiscordUserId !== userId) {
    throw new HttpError(404, "找不到這個兵種模板");
  }
  const category = template.category as MilitaryCategory;
  const lock = categoryLockInfo(category, researchedKeySlugs);
  if (!lock.unlocked) {
    throw new HttpError(
      400,
      lock.lockReason ?? `${categoryLabel(category, eraSlug)}尚未解鎖`,
    );
  }
  return template;
}

/**
 * 訓練佇列：目前排隊中的訂單、每回合產能、預估完成回合。
 * 功能關閉時 enabled=false 且佇列為空（前端據此隱藏「訓練中」區塊）。
 */
router.get("/military/queue", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  try {
    const enabled = await isRecruitQueueEnabled();
    const rows = await listNationQueue(nation.id);
    const { statsEra } = await getEraSlugs();
    const stats = await computeAdjustedNationStats(nation, statsEra);
    const capacity = turnCapacity(stats.population);
    const eta = estimateTurnsToFinish(
      rows.map((r) => ({
        id: r.id,
        templateId: r.templateId,
        remaining: r.remaining,
        tpPerUnit: r.tpPerUnit,
      })),
      capacity,
    );
    res.json({
      enabled,
      maxTemplates: MAX_QUEUE_TEMPLATES,
      capacityPerTurn: capacity,
      orders: rows.map((r) => ({
        id: r.id,
        templateId: r.templateId,
        totalQuantity: r.totalQuantity,
        remaining: r.remaining,
        tpPerUnit: r.tpPerUnit,
        turnsToFinish: eta.get(r.id) ?? null,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "military queue read failed");
    res.status(500).json({ error: "讀取訓練佇列失敗，請稍後再試" });
  }
});

/** 取消一筆訂單的剩餘部分，100% 退還資源與佔用（已完成的單位不受影響）。 */
router.post("/military/queue/cancel", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  try {
    const orderId = Number((req.body as { orderId?: unknown } | undefined)?.orderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      throw new HttpError(400, "訂單編號無效");
    }
    const refund = await cancelQueueOrder(nation.id, orderId);
    if (!refund) throw new HttpError(404, "找不到該訓練訂單（可能已完成或已取消）");
    req.log.info({ nationId: nation.id, orderId, refund }, "recruit queue order cancelled");
    res.json({ refund });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "military queue cancel failed");
    res.status(500).json({ error: "取消失敗，請稍後再試" });
  }
});

/** 徵召：原子性扣除生產力與人口（兩者皆以累計 spent 守衛，競態安全）。 */
router.post("/military/recruit", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  try {
    const { templateId, quantity } = parseOrderBody(req.body);
    // 類別解鎖看已研發關鍵技術；可用生產力/人口用「數據時代」計算（與總覽一致）。
    const { currentEra: eraSlug, statsEra } = await getEraSlugs();
    const researchedKeySlugs = await loadResearchedKeySlugs(userId);
    const template = await loadOrderTemplate(
      userId,
      templateId,
      eraSlug,
      researchedKeySlugs,
    );
    const researched = await loadResearchedTechs(userId);
    const orderScales = await loadNationScales(nation.id, statsEra);
    const effective = applyTechBonuses(template, researched, orderScales.price, orderScales.upkeep);
    // Task #557 — 生產力佔用 = ⌈數量 × 有效生產力維護費 ÷ 100⌉（與金錢購買同公式）。
    const cost = recruitCost(effective, quantity);
    // Task #568 — 立即性花費 = ⌈數量 × 有效 prodCostPer100 ÷ 100⌉（一次性
    // 消耗，記錄為當回合流量；解散不退還、跨回合失效）。
    const spendAmount = recruitProductionSpend(effective, quantity);
    const stats = await computeAdjustedNationStats(nation, statsEra);
    const queueOn = await isRecruitQueueEnabled();

    const result = await db.transaction(async (tx) => {
      // 條件式 UPDATE 先取得該國列鎖（同國的並發招募在此序列化），粗守衛
      // 佔用/人口/木礦；本回合花費合計在取得列鎖後讀取再精確複核。
      const updated = await tx
        .update(playerNationsTable)
        .set({
          productionSpent: sql`${playerNationsTable.productionSpent} + ${cost.production}`,
          populationSpent: sql`${playerNationsTable.populationSpent} + ${cost.population}`,
          wood: sql`${playerNationsTable.wood} - ${cost.wood}`,
          ore: sql`${playerNationsTable.ore} - ${cost.ore}`,
        })
        .where(
          and(
            eq(playerNationsTable.discordUserId, userId),
            sql`${playerNationsTable.productionSpent} + ${cost.production} <= ${stats.production}`,
            sql`${playerNationsTable.populationSpent} + ${cost.population} <= ${stats.population}`,
            sql`${playerNationsTable.wood} >= ${cost.wood}`,
            sql`${playerNationsTable.ore} >= ${cost.ore}`,
          ),
        )
        .returning();
      const freshNation = updated[0];
      if (!freshNation) {
        const prodShort =
          nation.productionSpent + cost.production > stats.production;
        const popShort =
          nation.populationSpent + cost.population > stats.population;
        const woodShort = nation.wood < cost.wood;
        throw new HttpError(
          400,
          prodShort
            ? `生產力不足（需佔用 ${cost.production.toLocaleString("en-US")}）`
            : popShort
              ? `人口不足（需要 ${cost.population.toLocaleString("en-US")}）`
              : woodShort
                ? `木材不足（需要 ${cost.wood.toLocaleString("en-US")}）`
                : `礦石不足（需要 ${cost.ore.toLocaleString("en-US")}）`,
        );
      }

      // Task #568 — 已持有列鎖後精確複核：佔用（更新後 spent）＋本回合已
      // 花費＋這次花費 ≤ 總生產力，不足即整筆回滾。
      const currentSpend = await loadCurrentTurnRecruitSpend(nation.id, tx);
      if (
        freshNation.productionSpent + currentSpend + spendAmount >
        stats.production
      ) {
        throw new HttpError(
          400,
          `生產力不足（本次招募需花費 ${spendAmount.toLocaleString("en-US")}，本回合剩餘可用 ${Math.max(
            0,
            stats.production - freshNation.productionSpent - currentSpend,
          ).toLocaleString("en-US")}）`,
        );
      }
      if (spendAmount > 0) {
        await tx.insert(recruitProductionSpendsTable).values({
          nationId: nation.id,
          templateId,
          quantity,
          amount: spendAmount,
        });
      }

      // 訓練佇列（功能開關開啟時）：資源與佔用已在上面扣除，兵力改進佇列，
      // 回合依產能逐批完成後才併入 player_armies。
      if (queueOn) {
        try {
          await enqueueInTx(tx, {
            nationId: nation.id,
            templateId,
            quantity,
            tpPerUnit: trainingPointsPerUnit(effective.prodCostPer100),
            productionReserved: cost.production,
            populationReserved: cost.population,
            woodPaid: cost.wood,
            orePaid: cost.ore,
          });
        } catch (e) {
          if (e instanceof RecruitQueueFullError) throw new HttpError(400, e.message);
          throw e;
        }
        return { freshNation, army: null, currentSpend };
      }

      const [army] = await tx
        .insert(playerArmiesTable)
        .values({
          discordUserId: userId,
          templateId,
          quantity,
          productionReserved: cost.production,
          populationReserved: cost.population,
        })
        .onConflictDoUpdate({
          target: [playerArmiesTable.discordUserId, playerArmiesTable.templateId],
          set: {
            quantity: sql`${playerArmiesTable.quantity} + ${quantity}`,
            productionReserved: sql`${playerArmiesTable.productionReserved} + ${cost.production}`,
            populationReserved: sql`${playerArmiesTable.populationReserved} + ${cost.population}`,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!army) throw new HttpError(500, "軍隊寫入失敗");
      return { freshNation, army, currentSpend };
    });

    req.log.info(
      { userId, templateId, quantity, cost, spendAmount },
      "military recruit completed",
    );
    res.json({
      templateId,
      queued: queueOn,
      quantity: result.army ? result.army.quantity : null,
      resources: resourceSnapshot(
        result.freshNation,
        stats,
        result.currentSpend + spendAmount,
      ),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "military recruit failed");
    res.status(500).json({ error: "徵召失敗，請稍後再試" });
  }
});

/** 金錢直購：每日額度（≈人口 1%）＋原子性扣款。 */
router.post("/military/purchase", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  try {
    const { templateId, quantity } = parseOrderBody(req.body);
    // 類別解鎖看已研發關鍵技術；每日額度（人口 1%）用「數據時代」計算。
    const { currentEra: eraSlug, statsEra } = await getEraSlugs();
    const researchedKeySlugs = await loadResearchedKeySlugs(userId);
    const template = await loadOrderTemplate(
      userId,
      templateId,
      eraSlug,
      researchedKeySlugs,
    );
    const researched = await loadResearchedTechs(userId);
    const orderScales = await loadNationScales(nation.id, statsEra);
    const effective = applyTechBonuses(template, researched, orderScales.price, orderScales.upkeep);
    const moneyCost = effective.moneyCostPerUnit * quantity;
    if (!Number.isSafeInteger(moneyCost)) {
      throw new HttpError(400, "購買金額過大");
    }
    const stats = await computeAdjustedNationStats(nation, statsEra);
    const capUnits = dailyPurchaseCap(stats.population);
    const dateLabel = localDateString(new Date());
    if (quantity > capUnits) {
      throw new HttpError(
        400,
        `超過今日購買額度（上限 ${capUnits.toLocaleString("en-US")} 單位）`,
      );
    }
    // Task #546 — 金錢購買也佔用生產力：⌈數量 × 每單位生產力維護費 ÷ 100⌉。
    // 守門口徑與招募一致：spent + 佔用 ≤ 總生產力 − 本回合生產力維護費實扣量。
    const prodReserve = unitProductionReservation(effective, quantity);
    const queueOn = await isRecruitQueueEnabled();

    const result = await db.transaction(async (tx) => {
      // Quota claim: insert-or-increment guarded by the cap. The insert path
      // is safe because quantity <= capUnits was checked above; the update
      // path re-checks used + quantity <= cap atomically.
      const quotaResult = await tx.execute(sql`
        INSERT INTO military_purchase_quotas (discord_user_id, date_label, used_units)
        VALUES (${userId}, ${dateLabel}, ${quantity})
        ON CONFLICT (discord_user_id, date_label) DO UPDATE SET
          used_units = military_purchase_quotas.used_units + ${quantity},
          updated_at = NOW()
        WHERE military_purchase_quotas.used_units + ${quantity} <= ${capUnits}
        RETURNING used_units
      `);
      const quotaRow = quotaResult.rows[0] as { used_units: string } | undefined;
      if (!quotaRow) {
        throw new HttpError(400, "超過今日購買額度，請明天再來");
      }

      const woodCost = template.woodCostPerUnit * quantity;
      const oreCost = template.oreCostPerUnit * quantity;
      const updated = await tx
        .update(playerNationsTable)
        .set({
          money: sql`${playerNationsTable.money} - ${moneyCost}`,
          wood: sql`${playerNationsTable.wood} - ${woodCost}`,
          ore: sql`${playerNationsTable.ore} - ${oreCost}`,
          productionSpent: sql`${playerNationsTable.productionSpent} + ${prodReserve}`,
        })
        .where(
          and(
            eq(playerNationsTable.discordUserId, userId),
            sql`${playerNationsTable.money} >= ${moneyCost}`,
            sql`${playerNationsTable.wood} >= ${woodCost}`,
            sql`${playerNationsTable.ore} >= ${oreCost}`,
            sql`${playerNationsTable.productionSpent} + ${prodReserve} <= ${stats.production}`,
          ),
        )
        .returning();
      const freshNation = updated[0];
      if (!freshNation) {
        const prodShort =
          nation.productionSpent + prodReserve > stats.production;
        const woodShort = nation.wood < woodCost;
        const oreShort = nation.ore < oreCost;
        throw new HttpError(
          400,
          prodShort
            ? `生產力不足（購買需佔用 ${prodReserve.toLocaleString("en-US")}）`
            : woodShort
              ? `木材不足（需要 ${woodCost.toLocaleString("en-US")}）`
              : oreShort
                ? `礦石不足（需要 ${oreCost.toLocaleString("en-US")}）`
                : `金錢不足（需要 ${moneyCost.toLocaleString("en-US")}）`,
        );
      }

      // Task #568 — 已持有列鎖後複核：佔用（更新後 spent）＋本回合招募花費
      // ≤ 總生產力（購買不產生花費，但花費會壓縮可佔用空間）。
      const currentSpend = await loadCurrentTurnRecruitSpend(nation.id, tx);
      if (freshNation.productionSpent + currentSpend > stats.production) {
        throw new HttpError(
          400,
          `生產力不足（購買需佔用 ${prodReserve.toLocaleString("en-US")}）`,
        );
      }

      // 訓練佇列（功能開關開啟時）：錢／木礦／佔用已扣，兵力改進佇列。
      // 滿 3 種被拒時整筆交易回滾（含每日購買額度），不會白白消耗額度。
      if (queueOn) {
        try {
          await enqueueInTx(tx, {
            nationId: nation.id,
            templateId,
            quantity,
            tpPerUnit: trainingPointsPerUnit(effective.prodCostPer100),
            productionReserved: prodReserve,
            woodPaid: woodCost,
            orePaid: oreCost,
            moneyPaid: moneyCost,
          });
        } catch (e) {
          if (e instanceof RecruitQueueFullError) throw new HttpError(400, e.message);
          throw e;
        }
        return {
          freshNation,
          army: null,
          usedUnits: Number(quotaRow.used_units),
          currentSpend,
        };
      }

      const [army] = await tx
        .insert(playerArmiesTable)
        .values({
          discordUserId: userId,
          templateId,
          quantity,
          productionReserved: prodReserve,
        })
        .onConflictDoUpdate({
          target: [playerArmiesTable.discordUserId, playerArmiesTable.templateId],
          set: {
            quantity: sql`${playerArmiesTable.quantity} + ${quantity}`,
            productionReserved: sql`${playerArmiesTable.productionReserved} + ${prodReserve}`,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!army) throw new HttpError(500, "軍隊寫入失敗");
      return {
        freshNation,
        army,
        usedUnits: Number(quotaRow.used_units),
        currentSpend,
      };
    });

    req.log.info(
      { userId, templateId, quantity, moneyCost },
      "military purchase completed",
    );
    res.json({
      templateId,
      queued: queueOn,
      quantity: result.army ? result.army.quantity : null,
      resources: resourceSnapshot(
        result.freshNation,
        stats,
        result.currentSpend,
      ),
      purchase: {
        dateLabel,
        usedUnits: result.usedUnits,
        capUnits,
        remainingUnits: Math.max(0, capUnits - result.usedUnits),
      },
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "military purchase failed");
    res.status(500).json({ error: "購買失敗，請稍後再試" });
  }
});

/** AI 自訂兵種設計：先原子扣科技點數，AI 失敗時退還。 */
router.post("/military/design-unit", aiRateLimit, async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  // Task #584 — 政變後政策封鎖期間不可設計兵種。
  if (nation.coupPolicyLockTurns > 0) {
    res.status(403).json({
      error: `政變後政局動盪，暫時無法設計兵種（剩餘 ${nation.coupPolicyLockTurns} 回合）`,
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawCategory = body["category"];
  const rawRequirement = body["requirement"];
  if (typeof rawCategory !== "string" || !isMilitaryCategory(rawCategory)) {
    res.status(400).json({ error: "category 不是有效的兵種類別" });
    return;
  }
  if (
    typeof rawRequirement !== "string" ||
    rawRequirement.trim().length === 0 ||
    rawRequirement.trim().length > 500
  ) {
    res.status(400).json({ error: "requirement 必須是 1～500 字的說明" });
    return;
  }
  const requirement = rawRequirement.trim();

  const [eraSlug, gameYear] = await Promise.all([
    getCurrentEraSlug(),
    getCurrentGameYear(),
  ]);
  const researchedKeySlugs = await loadResearchedKeySlugs(userId);
  const lock = categoryLockInfo(rawCategory, researchedKeySlugs);
  if (!lock.unlocked) {
    res.status(400).json({
      error: lock.lockReason ?? `${categoryLabel(rawCategory, eraSlug)}尚未解鎖`,
    });
    return;
  }

  // Task #63 — 每類別自創兵種上限預先檢查（快速失敗，不扣點數）。
  // 併發繞過由 designCustomUnit 入庫交易內的 advisory-lock 檢查兜底。
  const existingCount = await countCustomUnits(db, userId, rawCategory);
  if (existingCount >= MAX_CUSTOM_UNITS_PER_CATEGORY) {
    res.status(400).json({
      error: `${categoryLabel(rawCategory, eraSlug)}的自創兵種已達上限（${MAX_CUSTOM_UNITS_PER_CATEGORY} 個），請先刪除既有自創兵種再設計新的`,
    });
    return;
  }

  // Task #510 — 設計改為次數制：在慢速 AI 呼叫前原子扣 1 次（條件式
  // UPDATE，併發不會雙重消耗）；AI 失敗時退回 1 次（封頂 5）。
  const claimed = await db
    .update(playerNationsTable)
    .set({
      unitDesignCharges: sql`${playerNationsTable.unitDesignCharges} - 1`,
    })
    .where(
      and(
        eq(playerNationsTable.discordUserId, userId),
        sql`${playerNationsTable.unitDesignCharges} >= 1`,
      ),
    )
    .returning();
  if (!claimed[0]) {
    res.status(400).json({
      error: `設計次數不足（每回合恢復 1 次，上限 ${UNIT_DESIGN_CHARGE_CAP} 次）`,
    });
    return;
  }

  let template: Awaited<ReturnType<typeof designCustomUnit>>;
  try {
    const geoContext = await buildNationGeoCultureContext(claimed[0].id);
    template = await designCustomUnit({
      ownerDiscordUserId: userId,
      category: rawCategory,
      requirement,
      eraSlug,
      gameYear,
      geoContext,
      // Task #519 — AI 退件濫用紀錄帶上行為人國家快照。
      nation: { id: claimed[0].id, name: claimed[0].name },
    });
  } catch (err) {
    // Refund the claimed charge — the design never materialized. Only this
    // pre-persist failure path refunds; once the template row exists, later
    // failures must NOT refund (that would grant a free unit + charge back).
    await db
      .update(playerNationsTable)
      .set({
        unitDesignCharges: sql`LEAST(${UNIT_DESIGN_CHARGE_CAP}, ${playerNationsTable.unitDesignCharges} + 1)`,
      })
      .where(eq(playerNationsTable.discordUserId, userId))
      .catch((refundErr) =>
        req.log.error({ refundErr, userId }, "unit design refund failed"),
      );
    if (err instanceof UnitCapError) {
      // 入庫前的上限兜底檢查擋下（併發），次數已退還 → 400 而非 502。
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof AiQuotaExceededError) {
      // Task #593 — 該功能今日 token 配額用罄（次數已退還）→ 503。
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof UnitDesignRejectedError) {
      // Task #451 — AI 判定需求離譜／穿越時代／注入，次數已退還 → 400。
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err, userId }, "AI unit design failed");
    res.status(502).json({
      error:
        err instanceof Error && err.message.startsWith("AI")
          ? err.message
          : "AI 兵種設計失敗，請稍後再試（設計次數已退還）",
    });
    return;
  }

  req.log.info(
    { userId, templateId: template.id, category: rawCategory },
    "AI unit design completed",
  );
  try {
    const researched = await loadResearchedTechs(userId);
    const designScales = await loadNationScales(
      nation.id,
      (await getEraSlugs()).statsEra,
    );
    res.json({
      template: serializeTemplate(
        template,
        researched,
        eraSlug,
        researchedKeySlugs,
        null,
        null,
        designScales.price,
        designScales.upkeep,
      ),
      unitDesignCharges: claimed[0].unitDesignCharges,
    });
  } catch (err) {
    // Template is already persisted and paid for — no refund. The client
    // will see it on the next overview load.
    req.log.error({ err, userId, templateId: template.id },
      "post-design serialization failed (unit persisted, charge kept)");
    res.status(500).json({
      error: "兵種已設計完成，但載入結果時發生錯誤，請重新整理頁面查看",
    });
  }
});

// 舊「科技查詢 / 研發」路由已由 routes/militaryTech.ts 的「3 選 1」抽牌牌組
// （GET /military-tech/overview、POST /military-tech/techs/:id/research）取代。

// ── Task #63 — 兵種管理 ──────────────────────────────────────────

function parseTemplateIdParam(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(400, "兵種模板編號不正確");
  }
  return id;
}

/** 改名（僅限自己的自創兵種）。name null/"" = 清除還原。 */
router.patch("/military/templates/:id/name", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { userId } = auth;

  try {
    const templateId = parseTemplateIdParam(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawName = body["name"];
    if (rawName !== null && rawName !== undefined && typeof rawName !== "string") {
      throw new HttpError(400, "name 必須是字串或 null");
    }
    const normalized = normalizeCustomUnitName(rawName as string | null | undefined);
    if (!normalized.ok) throw new HttpError(400, normalized.error);

    // Task #511 — 只允許改名自己的自創兵種（Task #549 起預設兵種已全面
    // 移除，非本人模板一律 404）。
    const [template] = await db
      .select({
        id: militaryUnitTemplatesTable.id,
        ownerDiscordUserId: militaryUnitTemplatesTable.ownerDiscordUserId,
      })
      .from(militaryUnitTemplatesTable)
      .where(eq(militaryUnitTemplatesTable.id, templateId))
      .limit(1);
    if (!template) throw new HttpError(404, "找不到這個兵種模板");
    if (template.ownerDiscordUserId !== userId) {
      throw new HttpError(404, "找不到這個兵種模板");
    }

    if (normalized.name === null) {
      await db
        .delete(playerUnitCustomizationsTable)
        .where(
          and(
            eq(playerUnitCustomizationsTable.discordUserId, userId),
            eq(playerUnitCustomizationsTable.templateId, templateId),
          ),
        );
    } else {
      await db
        .insert(playerUnitCustomizationsTable)
        .values({ discordUserId: userId, templateId, customName: normalized.name })
        .onConflictDoUpdate({
          target: [
            playerUnitCustomizationsTable.discordUserId,
            playerUnitCustomizationsTable.templateId,
          ],
          set: { customName: normalized.name, updatedAt: new Date() },
        });
    }

    req.log.info(
      { userId, templateId, customName: normalized.name },
      "military unit renamed",
    );
    res.json({ templateId, customName: normalized.name });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "military unit rename failed");
    res.status(500).json({ error: "改名失敗，請稍後再試" });
  }
});

/**
 * 解散軍隊：條件更新守衛（quantity 足夠才扣），扣到 0 時刪列。不退資源。
 * Task #105：派駐前線（進行中戰役的軍團，含前線傷兵）與全國傷兵池中的
 * 士兵不可解散 — 保留量直接寫進條件式 UPDATE 的 WHERE，競態安全。
 */
router.post("/military/armies/disband", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  try {
    const { templateId, quantity } = parseOrderBody(req.body);

    const reservedSql = sql`
      COALESCE((
        SELECT SUM(wclu.quantity + wclu.wounded)::bigint
        FROM war_campaign_legion_units wclu
        JOIN war_campaign_legions wcl ON wcl.id = wclu.legion_id
        JOIN war_campaigns wc ON wc.id = wcl.campaign_id
        WHERE wcl.nation_id = ${nation.id}
          AND wclu.template_id = ${templateId}
          AND wc.status = 'active'
      ), 0) + COALESCE((
        SELECT pwu.wounded
        FROM player_wounded_units pwu
        WHERE pwu.discord_user_id = ${userId}
          AND pwu.template_id = ${templateId}
      ), 0)`;

    const outcome = await db.transaction(async (tx) => {
      const updated = await tx
        .update(playerArmiesTable)
        .set({
          quantity: sql`${playerArmiesTable.quantity} - ${quantity}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(playerArmiesTable.discordUserId, userId),
            eq(playerArmiesTable.templateId, templateId),
            sql`${playerArmiesTable.quantity} >= ${quantity}`,
            sql`${playerArmiesTable.quantity} - ${quantity} >= (${reservedSql})`,
          ),
        )
        .returning();
      const army = updated[0];
      if (!army) {
        const [current] = await tx
          .select({
            quantity: playerArmiesTable.quantity,
            reserved: sql<string>`(${reservedSql})`,
          })
          .from(playerArmiesTable)
          .where(
            and(
              eq(playerArmiesTable.discordUserId, userId),
              eq(playerArmiesTable.templateId, templateId),
            ),
          )
          .limit(1);
        if (current && current.quantity >= quantity) {
          throw new HttpError(
            400,
            "有部隊派駐前線或在傷兵池復原中，僅能解散未派遣的可用兵力",
          );
        }
        throw new HttpError(400, "解散數量超過持有數量");
      }

      // army.quantity 為扣除後的新數量；還原解散前數量以計算等比例釋放。
      const oldQuantity = army.quantity + quantity;
      const prodRelease = releaseReservation(
        oldQuantity,
        quantity,
        army.productionReserved,
      );
      const popRelease = releaseReservation(
        oldQuantity,
        quantity,
        army.populationReserved,
      );

      if (army.quantity <= 0) {
        // 整批解散：連同其全部預留量刪列（下面同步扣回全國 spent）。
        await tx
          .delete(playerArmiesTable)
          .where(
            and(
              eq(playerArmiesTable.discordUserId, userId),
              eq(playerArmiesTable.templateId, templateId),
              sql`${playerArmiesTable.quantity} <= 0`,
            ),
          );
      } else if (prodRelease > 0 || popRelease > 0) {
        await tx
          .update(playerArmiesTable)
          .set({
            productionReserved: sql`GREATEST(0, ${playerArmiesTable.productionReserved} - ${prodRelease})`,
            populationReserved: sql`GREATEST(0, ${playerArmiesTable.populationReserved} - ${popRelease})`,
          })
          .where(
            and(
              eq(playerArmiesTable.discordUserId, userId),
              eq(playerArmiesTable.templateId, templateId),
            ),
          );
      }

      if (prodRelease > 0 || popRelease > 0) {
        await tx
          .update(playerNationsTable)
          .set({
            productionSpent: sql`GREATEST(0, ${playerNationsTable.productionSpent} - ${prodRelease})`,
            populationSpent: sql`GREATEST(0, ${playerNationsTable.populationSpent} - ${popRelease})`,
          })
          .where(eq(playerNationsTable.discordUserId, userId));
      }

      return {
        remaining: Math.max(0, army.quantity),
        prodRelease,
        popRelease,
      };
    });

    req.log.info(
      {
        userId,
        templateId,
        disbanded: quantity,
        remaining: outcome.remaining,
        released: {
          production: outcome.prodRelease,
          population: outcome.popRelease,
        },
      },
      "military army disbanded",
    );
    res.json({ templateId, quantity: outcome.remaining });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "military disband failed");
    res.status(500).json({ error: "解散失敗，請稍後再試" });
  }
});

/**
 * 刪除自創兵種模板：僅限自己的自創兵種；連同軍隊一併刪除（FK cascade），
 * 不退點數。Task #105：該兵種仍派駐進行中戰役或留在傷兵池時不可刪除
 * （NOT EXISTS 直接寫進 DELETE 的 WHERE，競態安全）。
 */
router.delete("/military/templates/:id", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { userId } = auth;

  try {
    const templateId = parseTemplateIdParam(req.params.id);
    const released = await db.transaction(async (tx) => {
      // 刪除前先加總這批（自創兵種僅屬本人）軍隊占用的預留量，
      // FK cascade 刪列後再從全國 spent 扣回，維持 spent = Σreserved。
      const [sums] = await tx
        .select({
          prod: sql<string>`COALESCE(SUM(${playerArmiesTable.productionReserved}), 0)`,
          pop: sql<string>`COALESCE(SUM(${playerArmiesTable.populationReserved}), 0)`,
        })
        .from(playerArmiesTable)
        .where(
          and(
            eq(playerArmiesTable.discordUserId, userId),
            eq(playerArmiesTable.templateId, templateId),
          ),
        );
      const deleted = await tx
        .delete(militaryUnitTemplatesTable)
        .where(
          and(
            eq(militaryUnitTemplatesTable.id, templateId),
            eq(militaryUnitTemplatesTable.ownerDiscordUserId, userId),
            sql`NOT EXISTS (
              SELECT 1
              FROM war_campaign_legion_units wclu
              JOIN war_campaign_legions wcl ON wcl.id = wclu.legion_id
              JOIN war_campaigns wc ON wc.id = wcl.campaign_id
              WHERE wclu.template_id = ${militaryUnitTemplatesTable.id}
                AND wc.status = 'active'
                AND (wclu.quantity > 0 OR wclu.wounded > 0)
            )`,
            sql`NOT EXISTS (
              SELECT 1
              FROM player_wounded_units pwu
              WHERE pwu.template_id = ${militaryUnitTemplatesTable.id}
                AND pwu.wounded > 0
            )`,
          ),
        )
        .returning({ id: militaryUnitTemplatesTable.id });
      if (!deleted[0]) {
        const [existing] = await tx
          .select({ id: militaryUnitTemplatesTable.id })
          .from(militaryUnitTemplatesTable)
          .where(
            and(
              eq(militaryUnitTemplatesTable.id, templateId),
              eq(militaryUnitTemplatesTable.ownerDiscordUserId, userId),
            ),
          )
          .limit(1);
        if (existing) {
          throw new HttpError(
            400,
            "該兵種仍有部隊派駐前線或在傷兵池復原中，無法刪除",
          );
        }
        throw new HttpError(404, "找不到可刪除的自創兵種");
      }

      const prodRelease = Number(sums?.prod ?? 0);
      const popRelease = Number(sums?.pop ?? 0);
      if (prodRelease > 0 || popRelease > 0) {
        await tx
          .update(playerNationsTable)
          .set({
            productionSpent: sql`GREATEST(0, ${playerNationsTable.productionSpent} - ${prodRelease})`,
            populationSpent: sql`GREATEST(0, ${playerNationsTable.populationSpent} - ${popRelease})`,
          })
          .where(eq(playerNationsTable.discordUserId, userId));
      }
      return { prodRelease, popRelease };
    });

    req.log.info(
      { userId, templateId, released },
      "military custom template deleted",
    );
    res.json({ templateId, deleted: true });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "military template delete failed");
    res.status(500).json({ error: "刪除失敗，請稍後再試" });
  }
});

// ── 武器系統（兵種設計的姊妹系統）──────────────────────────────

/** POST /military/design-weapon — AI 武器設計（含特殊技能），消耗 1 次設計次數。 */
router.post("/military/design-weapon", aiRateLimit, async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;

  if (nation.coupPolicyLockTurns > 0) {
    res.status(403).json({
      error: `政變後政局動盪，暫時無法設計武器（剩餘 ${nation.coupPolicyLockTurns} 回合）`,
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawRequirement = body["requirement"];
  if (
    typeof rawRequirement !== "string" ||
    rawRequirement.trim().length === 0 ||
    rawRequirement.trim().length > 500
  ) {
    res.status(400).json({ error: "requirement 必須是 1～500 字的說明" });
    return;
  }
  const requirement = rawRequirement.trim();

  // 武器總數上限預先檢查（快速失敗，不扣次數）；併發繞過由
  // designCustomWeapon 入庫交易內的 advisory-lock 檢查兜底。
  const existingCount = await countWeapons(userId);
  if (existingCount >= MAX_WEAPONS_PER_PLAYER) {
    res.status(400).json({ error: new WeaponCapError().message });
    return;
  }

  // 原子扣 1 次設計次數（條件式 UPDATE，併發不會雙重消耗）。
  const claimed = await db
    .update(playerNationsTable)
    .set({
      weaponDesignCharges: sql`${playerNationsTable.weaponDesignCharges} - 1`,
    })
    .where(
      and(
        eq(playerNationsTable.discordUserId, userId),
        sql`${playerNationsTable.weaponDesignCharges} >= 1`,
      ),
    )
    .returning();
  if (!claimed[0]) {
    res.status(400).json({
      error: `武器設計次數不足（每回合回滿至上限 ${WEAPON_DESIGN_CHARGE_CAP} 次）`,
    });
    return;
  }

  let weapon: Awaited<ReturnType<typeof designCustomWeapon>>;
  try {
    const [eraSlug, gameYear] = await Promise.all([
      getCurrentEraSlug(),
      getCurrentGameYear(),
    ]);
    const geoContext = await buildNationGeoCultureContext(claimed[0].id);
    weapon = await designCustomWeapon({
      ownerDiscordUserId: userId,
      requirement,
      eraSlug,
      gameYear,
      nation: { id: claimed[0].id, name: claimed[0].name },
      geoContext,
    });
  } catch (err) {
    // 未入庫即失敗 → 退還次數（封頂 3；weaponDesignCharges 每回合回滿，
    // 此處仍以 +1 封頂寫回，避免回合中途退還超過上限）。
    await db
      .update(playerNationsTable)
      .set({
        weaponDesignCharges: sql`LEAST(${WEAPON_DESIGN_CHARGE_CAP}, ${playerNationsTable.weaponDesignCharges} + 1)`,
      })
      .where(eq(playerNationsTable.discordUserId, userId))
      .catch((refundErr) =>
        req.log.error({ refundErr, userId }, "weapon design refund failed"),
      );
    if (err instanceof WeaponCapError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof AiQuotaExceededError) {
      res.status(503).json({ error: err.message });
      return;
    }
    if (err instanceof WeaponDesignRejectedError) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err, userId }, "AI weapon design failed");
    res.status(502).json({
      error:
        err instanceof Error && err.message.startsWith("AI")
          ? err.message
          : "AI 武器設計失敗，請稍後再試（設計次數已退還）",
    });
    return;
  }

  req.log.info(
    { userId, weaponId: weapon.id },
    "AI weapon design completed",
  );
  try {
    res.json({
      weapon: serializeWeapon(weapon, weapon.eraSlug ?? "medieval"),
      weaponDesignCharges: claimed[0].weaponDesignCharges,
    });
  } catch (err) {
    // 武器已入庫且已扣次數 — 不退還；下次 overview 會看到。
    req.log.error({ err, userId, weaponId: weapon.id },
      "post-design weapon serialization failed (weapon persisted, charge kept)");
    res.status(500).json({
      error: "武器已設計完成，但載入結果時發生錯誤，請重新整理頁面查看",
    });
  }
});

/**
 * POST /military/equip-weapon — 兵種裝備／卸除武器。
 * body: { templateId, weaponId }（weaponId = null 表示卸除）。
 * 不相容仍可裝備（戰鬥時受懲罰）；伺服器回傳相容判定供前端顯示。
 */
router.post("/military/equip-weapon", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { userId } = auth;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawTemplateId = body["templateId"];
  const rawWeaponId = body["weaponId"];
  const templateId =
    typeof rawTemplateId === "number"
      ? rawTemplateId
      : Number(rawTemplateId);
  if (!Number.isInteger(templateId) || templateId <= 0) {
    res.status(400).json({ error: "templateId 不正確" });
    return;
  }

  try {
    const [template] = await db
      .select()
      .from(militaryUnitTemplatesTable)
      .where(
        and(
          eq(militaryUnitTemplatesTable.id, templateId),
          eq(militaryUnitTemplatesTable.ownerDiscordUserId, userId),
        ),
      )
      .limit(1);
    if (!template) {
      throw new HttpError(404, "找不到該自創兵種");
    }

    let weapon: MilitaryWeapon | null = null;
    if (rawWeaponId !== null && rawWeaponId !== undefined) {
      const weaponId =
        typeof rawWeaponId === "number" ? rawWeaponId : Number(rawWeaponId);
      if (!Number.isInteger(weaponId) || weaponId <= 0) {
        throw new HttpError(400, "weaponId 不正確");
      }
      const [row] = await db
        .select()
        .from(militaryWeaponsTable)
        .where(
          and(
            eq(militaryWeaponsTable.id, weaponId),
            eq(militaryWeaponsTable.ownerDiscordUserId, userId),
          ),
        )
        .limit(1);
      if (!row) throw new HttpError(404, "找不到該武器");
      weapon = row;
    }

    await db
      .update(militaryUnitTemplatesTable)
      .set({ equippedWeaponId: weapon ? weapon.id : null })
      .where(eq(militaryUnitTemplatesTable.id, templateId));

    const compatible = weapon
      ? weaponCompatibleWith(weapon, template.category)
      : null;
    res.json({
      templateId,
      equippedWeaponId: weapon ? weapon.id : null,
      compatible,
      modsLabel: weapon
        ? describeWeaponMods({
            equipped: true,
            compatible: compatible ?? false,
            attackPct: weapon.attackPct,
            defensePct: weapon.defensePct,
            skillEffect: weapon.skillEffect as WeaponSkillEffect,
            skillBonusPct: weapon.skillBonusPct,
          })
        : "未裝備",
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err, userId }, "weapon equip failed");
    res.status(500).json({ error: "裝備設定失敗，請稍後再試" });
  }
});

/** DELETE /military/weapons/:id — 銷毀武器（不退次數；已裝備兵種自動卸除）。 */
router.delete("/military/weapons/:id", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { userId } = auth;

  const weaponId = parseTemplateIdParam(req.params.id);
  const deleted = await db
    .delete(militaryWeaponsTable)
    .where(
      and(
        eq(militaryWeaponsTable.id, weaponId),
        eq(militaryWeaponsTable.ownerDiscordUserId, userId),
      ),
    )
    .returning({ id: militaryWeaponsTable.id });
  if (!deleted[0]) {
    res.status(404).json({ error: "找不到可銷毀的武器" });
    return;
  }
  // equipped_weapon_id FK ON DELETE SET NULL 已自動卸除裝備；此處防禦性
  // 再清一次（涵蓋未來 schema 變動）。
  await db
    .update(militaryUnitTemplatesTable)
    .set({ equippedWeaponId: null })
    .where(
      and(
        eq(militaryUnitTemplatesTable.ownerDiscordUserId, userId),
        eq(militaryUnitTemplatesTable.equippedWeaponId, weaponId),
      ),
    )
    .catch((err) =>
      req.log.error({ err, userId, weaponId }, "weapon unequip cleanup failed"),
    );
  req.log.info({ userId, weaponId }, "weapon deleted");
  res.json({ weaponId, deleted: true });
});

export default router;
