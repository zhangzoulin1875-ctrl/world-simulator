import { asc, eq } from "drizzle-orm";
import {
  db,
  playerArmiesTable,
  militaryUnitTemplatesTable,
} from "@workspace/db";
import type {
  CabinetDomainModule,
  DomainActionKey,
  ExecuteApprovedContext,
  RunDomainContext,
} from "../types";
import { proposeApproval, recordCabinetAction } from "../index";
import { logger } from "../../logger";
import { computeAdjustedNationStats, getEraSlugs } from "../../nationStats";
import { ERAS, getEraIndex } from "../../mapRegionEras";
import {
  applyTechBonuses,
  categoryLabel,
  categoryLockInfo,
  dailyPurchaseCap,
  isMilitaryCategory,
  recruitCost,
  type MilitaryCategory,
} from "../../military";
import {
  loadResearchedKeySlugs,
  loadResearchedMilitaryTechs,
} from "../../militaryTechData";
import { localDateString } from "../../time";
import { computeAvailableProduction } from "../../economy";
import { loadCurrentTurnRecruitSpend } from "../../recruitSpend";
import { listTechTreeResearchCandidates } from "../../techTreeResearch";
import {
  listDesignableCategories,
  militaryAutoBudget,
  purchaseNeedsApproval,
  recruitNeedsApproval,
} from "./militaryPolicy";
import { decideMilitaryActions, type MilitaryPlan } from "./militaryPlanning";
import {
  executeDesign,
  executeDisband,
  executePurchase,
  executeRecruit,
  executeResearch,
  loadQuotaUsed,
} from "./militaryExec";
import {
  autoFormLegions,
  autoIssueBattlefieldOrders,
} from "./militaryBattlefield";

/**
 * Task #244 — 元帥（軍事）領域模組。
 *
 * 每回合結算時，元帥依「授權代理項目（enabledActionKeys）＋常駐方針（directive）
 * ＋代理程度（agencyLevel）＋執政風格（overreach／timidity）」自動處理軍務：
 * 招募、金錢購買、研發軍事科技、設計兵種、編制軍團、下達戰場指令、解散部隊。
 *
 * 「重大決策」（大批招募／購買、昂貴科技或兵種設計、解散既有部隊）不會直接執行，
 * 而是進入待批准佇列（proposeApproval），由玩家批准後才由 executeApproved 套用。
 * 越權傾向高、代理程度積極者，自動執行的門檻越寬；膽小者則多提報、少自作主張。
 *
 * 宣戰不在本模組範圍（由外交／玩家自行決定）。本檔只讀取共用檔，不修改它們。
 *
 * 純門檻判定集中於 militaryPolicy.ts（單元測試）；AI 規劃在 militaryPlanning.ts；
 * 動作執行 helper 在 militaryExec.ts；戰場軍團／指令在 militaryBattlefield.ts。
 * 本檔保留 domain 註冊入口與既有 export（re-export 已搬移的純函式）。
 */

// ── 對外重新匯出（維持既有 import 路徑不變） ───────────────────

export {
  militaryAgentAggression,
  militaryAutoBudget,
  purchaseNeedsApproval,
  recruitNeedsApproval,
  techSpendNeedsApproval,
} from "./militaryPolicy";
export type { MilitaryAutoBudget } from "./militaryPolicy";

// ── 可授權代理項目 ─────────────────────────────────────────────

export const actionKeys: DomainActionKey[] = [
  {
    key: "recruit_units",
    label: "招募部隊",
    description: "由元帥依方針以生產力與人口招募既有兵種。",
  },
  {
    key: "purchase_units",
    label: "金錢購買部隊",
    description: "由元帥動用國庫在每日配額內購買既有兵種。",
  },
  {
    key: "research_tech",
    label: "研發軍事科技",
    description: "由元帥自可研發牌組挑選並投入研發能提升戰力的軍事科技。",
  },
  {
    key: "design_unit",
    label: "設計兵種",
    description: "由元帥運用科技點數設計符合當前時代的新兵種。",
  },
  {
    key: "manage_legions",
    label: "編制軍團",
    description: "戰役開打時，由元帥將可用部隊編成軍團投入戰場。",
  },
  {
    key: "battlefield_command",
    label: "戰場指揮",
    description: "每回合為進行中的戰役下達戰略／進攻／防守／偵查指令。",
  },
  {
    key: "disband_units",
    label: "解散部隊",
    description: "由元帥提報裁撤過剩部隊（不退還資源，需玩家批准）。",
  },
];

// ── 每回合自動代理 ─────────────────────────────────────────────

export async function runDomain(ctx: RunDomainContext): Promise<void> {
  const { nation, minister, enabledActionKeys, directive, agencyLevel, era } = ctx;
  const userId = nation.discordUserId;
  if (!userId) return; // 無主國家不代理。
  const enabled = new Set(enabledActionKeys);
  if (enabled.size === 0) return;

  const ministerName = minister.name;
  const style = minister.style;
  const budget = militaryAutoBudget(agencyLevel, style);

  // 1. 戰場軍團編制（獨立於資源決策，先於下令）。
  if (enabled.has("manage_legions")) {
    await autoFormLegions(nation, era).catch((err) =>
      logger.warn({ err, nationId: nation.id }, "cabinet manage_legions failed"),
    );
  }

  // 2. 戰場指揮：為進行中戰役下達本週期指令。
  if (enabled.has("battlefield_command")) {
    await autoIssueBattlefieldOrders(nation, era, directive).catch((err) =>
      logger.warn(
        { err, nationId: nation.id },
        "cabinet battlefield_command failed",
      ),
    );
  }

  // 3. 資源型動作需要 AI 決策。
  const resourceKeys = [
    "recruit_units",
    "purchase_units",
    "research_tech",
    "design_unit",
    "disband_units",
  ];
  if (!resourceKeys.some((k) => enabled.has(k))) return;

  const { currentEra, statsEra } = await getEraSlugs();
  const eraLabel = ERAS[getEraIndex(currentEra)]?.label ?? currentEra;
  const stats = await computeAdjustedNationStats(nation, statsEra);
  // Task #568 — 可用生產力 = 總量 − 已佔用 − 本回合招募花費（流量）。
  const availableProduction = computeAvailableProduction({
    production: stats.production,
    productionSpent: nation.productionSpent,
    currentTurnSpend: await loadCurrentTurnRecruitSpend(nation.id),
  });
  const availablePopulation = Math.max(0, stats.population - nation.populationSpent);
  const dailyCap = dailyPurchaseCap(stats.population);
  const usedToday = await loadQuotaUsed(userId, localDateString(new Date()));
  const remainingCap = Math.max(0, dailyCap - usedToday);

  const researchedKeySlugs = await loadResearchedKeySlugs(userId);
  const researched = await loadResearchedMilitaryTechs(userId);

  // Task #511 — 玩家（內閣）只可建造自己的自創兵種；預設種子模板留給 NPC。
  const templates = await db
    .select()
    .from(militaryUnitTemplatesTable)
    .where(eq(militaryUnitTemplatesTable.ownerDiscordUserId, userId))
    .orderBy(asc(militaryUnitTemplatesTable.id));
  const unlockedTemplates = templates.filter(
    (t) =>
      categoryLockInfo(t.category as MilitaryCategory, researchedKeySlugs)
        .unlocked,
  );
  const templateById = new Map(unlockedTemplates.map((t) => [t.id, t]));

  const armies = await db
    .select({
      templateId: playerArmiesTable.templateId,
      quantity: playerArmiesTable.quantity,
    })
    .from(playerArmiesTable)
    .where(eq(playerArmiesTable.discordUserId, userId));

  // Task #469 — 科技樹選研候選：軍事領域目前可開始研發的節點（含估算成本）。
  const deck = enabled.has("research_tech")
    ? await listTechTreeResearchCandidates(nation, "military").catch((err) => {
        logger.warn({ err, userId }, "cabinet tech tree candidates load failed");
        return [] as { id: number; name: string; cost: number }[];
      })
    : [];
  const deckById = new Map(deck.map((t) => [t.id, t]));

  // Task #511 — 可設計類別改由全類別＋科技解鎖判定（不再依可見模板推導，
  // 否則玩家沒有任何自創兵種時會永遠無法設計第一個兵種）。
  // 純函式抽至 militaryPolicy.ts（單元測試鎖住行為）。
  const designableCategories = enabled.has("design_unit")
    ? listDesignableCategories(researchedKeySlugs, currentEra)
    : [];

  let plan: MilitaryPlan;
  try {
    plan = await decideMilitaryActions({
      nationName: nation.name ?? "我方",
      eraLabel,
      directive,
      agencyLevel,
      style,
      enabledActionKeys,
      resources: {
        availableProduction,
        availablePopulation,
        money: nation.money,
        techPoints: nation.techPoints,
        remainingPurchaseCap: remainingCap,
      },
      templates: unlockedTemplates.map((t) => {
        const eff = applyTechBonuses(t, researched);
        return {
          id: t.id,
          name: t.name,
          categoryLabel: categoryLabel(t.category as MilitaryCategory, currentEra),
          // Task #557 — 生產力佔用改以有效維護費為基準（每 100 單位 ⌈…⌉，
          // 與 unitProductionReservation 同一口徑），不再乘時代係數。
          prodReservePer100: eff.prodUpkeepPerUnit,
          popCostPerUnit: eff.popCostPerUnit,
          moneyCostPerUnit: eff.moneyCostPerUnit,
        };
      }),
      armies,
      deck: deck.map((t) => ({
        id: t.id,
        name: t.name,
        costPoints: t.cost,
      })),
      designableCategories,
      // Task #510 — 次數制：AI 只需知道剩餘設計次數（0 = 不要規劃設計）。
      unitDesignCharges: nation.unitDesignCharges,
    });
  } catch (err) {
    logger.warn(
      { err, nationId: nation.id },
      "cabinet military AI plan failed; skipping resource actions",
    );
    return;
  }

  // 執行招募（自動或提報）。
  if (enabled.has("recruit_units")) {
    let usedProduction = 0;
    for (const item of plan.recruit) {
      const template = templateById.get(item.templateId);
      if (!template) continue;
      const eff = applyTechBonuses(template, researched);
      const cost = recruitCost(eff, item.quantity);
      const remaining = Math.max(0, availableProduction - usedProduction);
      const summary = `招募 ${template.name} ×${item.quantity.toLocaleString(
        "en-US",
      )}（需生產力 ${cost.production.toLocaleString("en-US")}、人口 ${cost.population.toLocaleString("en-US")}）`;
      if (
        recruitNeedsApproval({
          productionCost: cost.production,
          availableProduction: remaining,
          fraction: budget.recruitProductionFraction,
        })
      ) {
        await proposeApproval({
          nation,
          domain: "military",
          ministerName,
          actionKey: "recruit_units",
          summary,
          params: { templateId: item.templateId, quantity: item.quantity },
          cost: { amount: cost.production, kind: "production" },
        }).catch((err) =>
          logger.warn({ err, nationId: nation.id }, "cabinet recruit propose failed"),
        );
      } else {
        try {
          await executeRecruit(userId, item.templateId, item.quantity);
          usedProduction += cost.production;
          await recordCabinetAction({
            nationId: nation.id,
            domain: "military",
            actionKey: "recruit_units",
            summary,
            mode: "auto",
            cost: { amount: cost.production, kind: "production" },
          });
        } catch (err) {
          logger.warn(
            { err, nationId: nation.id, item },
            "cabinet auto recruit failed",
          );
        }
      }
    }
  }

  // 執行金錢購買（自動或提報）。
  if (enabled.has("purchase_units")) {
    let usedCap = 0;
    for (const item of plan.purchase) {
      const template = templateById.get(item.templateId);
      if (!template) continue;
      const remaining = Math.max(0, remainingCap - usedCap);
      const eff = applyTechBonuses(template, researched);
      const moneyCost = eff.moneyCostPerUnit * item.quantity;
      const summary = `購買 ${template.name} ×${item.quantity.toLocaleString(
        "en-US",
      )}（需金錢 ${moneyCost.toLocaleString("en-US")}）`;
      if (
        purchaseNeedsApproval({
          quantity: item.quantity,
          remainingCap: remaining,
          fraction: budget.purchaseCapFraction,
        })
      ) {
        await proposeApproval({
          nation,
          domain: "military",
          ministerName,
          actionKey: "purchase_units",
          summary,
          params: { templateId: item.templateId, quantity: item.quantity },
          cost: { amount: moneyCost, kind: "money" },
        }).catch((err) =>
          logger.warn(
            { err, nationId: nation.id },
            "cabinet purchase propose failed",
          ),
        );
      } else {
        try {
          await executePurchase(userId, item.templateId, item.quantity);
          usedCap += item.quantity;
          await recordCabinetAction({
            nationId: nation.id,
            domain: "military",
            actionKey: "purchase_units",
            summary,
            mode: "auto",
            cost: { amount: moneyCost, kind: "money" },
          });
        } catch (err) {
          logger.warn(
            { err, nationId: nation.id, item },
            "cabinet auto purchase failed",
          );
        }
      }
    }
  }

  // 研發科技（Task #469：科技樹選研不扣點、可取消 → 已授權即自動執行）。
  if (enabled.has("research_tech") && plan.researchTechId != null) {
    const tech = deckById.get(plan.researchTechId);
    if (tech) {
      const summary = `開始研發軍事科技「${tech.name}」（總成本 ${tech.cost.toLocaleString("en-US")}點）`;
      try {
        await executeResearch(userId, tech.id);
        await recordCabinetAction({
          nationId: nation.id,
          domain: "military",
          actionKey: "research_tech",
          summary,
          mode: "auto",
          cost: { amount: tech.cost, kind: "tech" },
        });
      } catch (err) {
        logger.warn(
          { err, nationId: nation.id, nodeId: tech.id },
          "cabinet auto research failed",
        );
      }
    }
  }

  // 設計兵種（Task #510 次數制：有剩餘次數就自動執行，0 次靜默跳過；
  // 不再有「昂貴設計送批准」——次數本身就是節流）。
  if (enabled.has("design_unit") && plan.designUnit) {
    const { category, requirement } = plan.designUnit;
    if (isMilitaryCategory(category)) {
      if (nation.coupPolicyLockTurns > 0) {
        // Task #584 — 政變後政策封鎖期間內閣靜默跳過兵種設計。
        logger.info(
          { nationId: nation.id, lockTurns: nation.coupPolicyLockTurns },
          "cabinet design skipped: coup policy lock",
        );
      } else if (nation.unitDesignCharges < 1) {
        logger.info(
          { nationId: nation.id },
          "cabinet design skipped: no design charges",
        );
      } else {
        const summary = `設計新兵種（${categoryLabel(category, currentEra)}）：${requirement.slice(0, 60)}`;
        try {
          await executeDesign(userId, category, requirement);
          await recordCabinetAction({
            nationId: nation.id,
            domain: "military",
            actionKey: "design_unit",
            summary,
            mode: "auto",
          });
        } catch (err) {
          logger.warn(
            { err, nationId: nation.id },
            "cabinet auto design failed",
          );
        }
      }
    }
  }

  // 解散部隊：一律送交玩家批准（不退資源的破壞性動作）。
  if (enabled.has("disband_units")) {
    for (const item of plan.disband) {
      const template = templateById.get(item.templateId);
      if (!template) continue;
      await proposeApproval({
        nation,
        domain: "military",
        ministerName,
        actionKey: "disband_units",
        summary: `裁撤 ${template.name} ×${item.quantity.toLocaleString("en-US")}（不退還資源）`,
        params: { templateId: item.templateId, quantity: item.quantity },
      }).catch((err) =>
        logger.warn(
          { err, nationId: nation.id },
          "cabinet disband propose failed",
        ),
      );
    }
  }
}

// ── 玩家批准後執行 ─────────────────────────────────────────────

export async function executeApproved(
  ctx: ExecuteApprovedContext,
): Promise<void> {
  const { nation, approval } = ctx;
  const userId = nation.discordUserId;
  if (!userId) throw new Error("無主國家無法執行內閣動作");
  const params = (approval.params ?? {}) as Record<string, unknown>;

  switch (approval.actionKey) {
    case "recruit_units": {
      const templateId = Number(params.templateId);
      const quantity = Number(params.quantity);
      await executeRecruit(userId, templateId, quantity);
      return;
    }
    case "purchase_units": {
      const templateId = Number(params.templateId);
      const quantity = Number(params.quantity);
      await executePurchase(userId, templateId, quantity);
      return;
    }
    case "research_tech": {
      const nodeId = Number(params.nodeId ?? params.techId);
      await executeResearch(userId, nodeId);
      return;
    }
    case "design_unit": {
      const category = String(params.category ?? "");
      const requirement = String(params.requirement ?? "");
      if (!isMilitaryCategory(category)) throw new Error("兵種類別無效");
      await executeDesign(userId, category, requirement);
      return;
    }
    case "disband_units": {
      const templateId = Number(params.templateId);
      const quantity = Number(params.quantity);
      await executeDisband(userId, nation.id, templateId, quantity);
      return;
    }
    default:
      logger.warn(
        { actionKey: approval.actionKey, nationId: nation.id },
        "cabinet military executeApproved: unknown actionKey",
      );
      throw new Error("未知的軍事待批准動作");
  }
}

export const militaryModule: CabinetDomainModule = {
  domain: "military",
  actionKeys,
  runDomain,
  executeApproved,
};
