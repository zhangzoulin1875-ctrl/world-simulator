import { assertCanRecruit } from "../../mercenaryService";
import { loadNationScales } from "../../nationScale";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  playerArmiesTable,
  militaryUnitTemplatesTable,
  militaryPurchaseQuotasTable,
  recruitProductionSpendsTable,
  type MilitaryUnitTemplate,
  type PlayerNation,
} from "@workspace/db";
import { logger } from "../../logger";
import {
  computeAdjustedNationStats,
  getCurrentGameYear,
  getEraSlugs,
} from "../../nationStats";
import { buildNationGeoCultureContext } from "../../nationGeoCulture";
import {
  applyTechBonuses,
  categoryLabel,
  categoryLockInfo,
  dailyPurchaseCap,
  MAX_ORDER_QUANTITY,
  UNIT_DESIGN_CHARGE_CAP,
  recruitCost,
  recruitProductionSpend,
  releaseReservation,
  unitProductionReservation,
  type MilitaryCategory,
} from "../../military";
import {
  designCustomUnit,
  UnitCapError,
  UnitDesignRejectedError,
} from "../../militaryAi";
import {
  getMilitaryDomainEra,
  loadResearchedKeySlugs,
  loadResearchedMilitaryTechs,
} from "../../militaryTechData";
import { localDateString } from "../../time";
import { resolveUsableTemplate } from "./militaryPolicy";
import { loadCurrentTurnRecruitSpend } from "../../recruitSpend";
import { enqueueInTx, isRecruitQueueEnabled } from "../../recruitQueue";
import { trainingPointsPerUnit } from "../../recruitQueueCore";
import { startTechTreeResearch } from "../../techTreeResearch";

/**
 * Task #244 — 元帥（軍事）領域：共用載入與動作執行 helper（自動與批准後共用）。
 *
 * 每個 execute* 皆為原子交易＋條件式扣除守衛（競態安全）。原 domains/military.ts
 * 內的定義純搬移至此，SQL、錯誤訊息與行為皆不變。此檔不依賴 ../index。
 */

// ── 共用載入 ───────────────────────────────────────────────────

async function loadNationByUser(userId: string): Promise<PlayerNation | null> {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Task #511 — 內閣代理只可建造玩家自己的自創兵種；預設種子模板
 * 保留給 NPC，禁止經由內閣招募／購買。
 */
async function loadUsableTemplate(
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
  // 純判定（預設兵種／他人兵種拒絕、類別鎖）抽至 militaryPolicy.ts 供單元測試。
  return resolveUsableTemplate(template, {
    userId,
    eraSlug,
    researchedKeySlugs,
  });
}

export async function loadQuotaUsed(userId: string, dateLabel: string): Promise<number> {
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

// ── 動作執行（自動與批准後共用） ───────────────────────────────

/** 招募：原子扣生產力＋人口（累計 spent 守衛，競態安全）。 */
export async function executeRecruit(
  userId: string,
  templateId: number,
  quantity: number,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_ORDER_QUANTITY) {
    throw new Error("招募數量無效");
  }
  const nation = await loadNationByUser(userId);
  if (!nation) throw new Error("找不到國家");
  await assertCanRecruit(nation.id);
  const { currentEra, statsEra } = await getEraSlugs();
  const cabScales = await loadNationScales(nation.id, statsEra);
  const researchedKeySlugs = await loadResearchedKeySlugs(userId);
  const template = await loadUsableTemplate(
    userId,
    templateId,
    currentEra,
    researchedKeySlugs,
  );
  const researched = await loadResearchedMilitaryTechs(userId);
  const effective = applyTechBonuses(template, researched, cabScales.price, cabScales.upkeep);
  // Task #557 — 生產力佔用 = ⌈數量 × 有效生產力維護費 ÷ 100⌉（與金錢購買同公式）。
  const cost = recruitCost(effective, quantity);
  // Task #568 — 立即性花費 = ⌈數量 × 有效 prodCostPer100 ÷ 100⌉（當回合流量，
  // 解散不退還、跨回合失效）。
  const spendAmount = recruitProductionSpend(effective, quantity);
  const stats = await computeAdjustedNationStats(nation, statsEra);
  const queueOn = await isRecruitQueueEnabled();

  await db.transaction(async (tx) => {
    // 條件式 UPDATE 先取得該國列鎖（同國並發在此序列化），粗守衛佔用/人口；
    // 本回合花費合計在取得列鎖後讀取再精確複核（與玩家路由同一口徑）。
    const updated = await tx
      .update(playerNationsTable)
      .set({
        productionSpent: sql`${playerNationsTable.productionSpent} + ${cost.production}`,
        populationSpent: sql`${playerNationsTable.populationSpent} + ${cost.population}`,
      })
      .where(
        and(
          eq(playerNationsTable.discordUserId, userId),
          sql`${playerNationsTable.productionSpent} + ${cost.production} <= ${stats.production}`,
          sql`${playerNationsTable.populationSpent} + ${cost.population} <= ${stats.population}`,
        ),
      )
      .returning();
    const freshNation = updated[0];
    if (!freshNation) {
      const prodShort =
        nation.productionSpent + cost.production > stats.production;
      throw new Error(
        prodShort
          ? `生產力不足（需要 ${cost.production.toLocaleString("en-US")}）`
          : `人口不足（需要 ${cost.population.toLocaleString("en-US")}）`,
      );
    }
    // Task #568 — 已持有列鎖後精確複核：佔用（更新後 spent）＋本回合已
    // 花費＋這次花費 ≤ 總生產力，不足即整筆回滾。
    const currentSpend = await loadCurrentTurnRecruitSpend(nation.id, tx);
    if (
      freshNation.productionSpent + currentSpend + spendAmount >
      stats.production
    ) {
      throw new Error(
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
    // 訓練佇列（功能開關開啟時）：與玩家路由同口徑，兵力改進佇列。
    // 內閣招募本來就不扣木礦，故 woodPaid/orePaid 為 0（取消時不會多退）。
    if (queueOn) {
      await enqueueInTx(tx, {
        nationId: nation.id,
        templateId,
        quantity,
        tpPerUnit: trainingPointsPerUnit(effective.prodCostPer100),
        productionReserved: cost.production,
        populationReserved: cost.population,
      });
      return;
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
    if (!army) throw new Error("軍隊寫入失敗");
  });
}

/** 金錢購買：每日配額（人口 1%）＋原子扣款。 */
export async function executePurchase(
  userId: string,
  templateId: number,
  quantity: number,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_ORDER_QUANTITY) {
    throw new Error("購買數量無效");
  }
  const nation = await loadNationByUser(userId);
  if (!nation) throw new Error("找不到國家");
  await assertCanRecruit(nation.id);
  const { currentEra, statsEra } = await getEraSlugs();
  const cabScales = await loadNationScales(nation.id, statsEra);
  const researchedKeySlugs = await loadResearchedKeySlugs(userId);
  const template = await loadUsableTemplate(
    userId,
    templateId,
    currentEra,
    researchedKeySlugs,
  );
  const researched = await loadResearchedMilitaryTechs(userId);
  const effective = applyTechBonuses(template, researched, cabScales.price, cabScales.upkeep);
  const moneyCost = effective.moneyCostPerUnit * quantity;
  if (!Number.isSafeInteger(moneyCost)) throw new Error("購買金額過大");
  const stats = await computeAdjustedNationStats(nation, statsEra);
  const capUnits = dailyPurchaseCap(stats.population);
  const dateLabel = localDateString(new Date());
  if (quantity > capUnits) {
    throw new Error(
      `超過今日購買額度（上限 ${capUnits.toLocaleString("en-US")} 單位）`,
    );
  }
  // Task #546 — 金錢購買也佔用生產力：⌈數量 × 每單位生產力維護費 ÷ 100⌉，
  // 守門口徑與招募一致（spent + 佔用 ≤ 總生產力；Task #568 起無維護費實扣）。
  const prodReserve = unitProductionReservation(effective, quantity);
  const queueOn = await isRecruitQueueEnabled();

  await db.transaction(async (tx) => {
    const quotaResult = await tx.execute(sql`
      INSERT INTO military_purchase_quotas (discord_user_id, date_label, used_units)
      VALUES (${userId}, ${dateLabel}, ${quantity})
      ON CONFLICT (discord_user_id, date_label) DO UPDATE SET
        used_units = military_purchase_quotas.used_units + ${quantity},
        updated_at = NOW()
      WHERE military_purchase_quotas.used_units + ${quantity} <= ${capUnits}
      RETURNING used_units
    `);
    if (!quotaResult.rows[0]) {
      throw new Error("超過今日購買額度，請明天再來");
    }
    const updated = await tx
      .update(playerNationsTable)
      .set({
        money: sql`${playerNationsTable.money} - ${moneyCost}`,
        productionSpent: sql`${playerNationsTable.productionSpent} + ${prodReserve}`,
      })
      .where(
        and(
          eq(playerNationsTable.discordUserId, userId),
          sql`${playerNationsTable.money} >= ${moneyCost}`,
          sql`${playerNationsTable.productionSpent} + ${prodReserve} <= ${stats.production}`,
        ),
      )
      .returning();
    const freshNation = updated[0];
    if (!freshNation) {
      const prodShort =
        nation.productionSpent + prodReserve > stats.production;
      throw new Error(
        prodShort
          ? `生產力不足（購買需佔用 ${prodReserve.toLocaleString("en-US")}）`
          : `金錢不足（需要 ${moneyCost.toLocaleString("en-US")}）`,
      );
    }
    // Task #568 — 已持有列鎖後複核：佔用（更新後 spent）＋本回合招募花費
    // ≤ 總生產力（購買不產生花費，但花費會壓縮可佔用空間）。
    const currentSpend = await loadCurrentTurnRecruitSpend(nation.id, tx);
    if (freshNation.productionSpent + currentSpend > stats.production) {
      throw new Error(
        `生產力不足（購買需佔用 ${prodReserve.toLocaleString("en-US")}）`,
      );
    }
    if (queueOn) {
      await enqueueInTx(tx, {
        nationId: nation.id,
        templateId,
        quantity,
        tpPerUnit: trainingPointsPerUnit(effective.prodCostPer100),
        productionReserved: prodReserve,
        moneyPaid: moneyCost,
      });
      return;
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
    if (!army) throw new Error("軍隊寫入失敗");
  });
}

/**
 * Task #469 — 研發軍事科技改為全球科技樹「選研」：設定軍事領域進行中節點
 * （成本快照鎖定，之後由回合結算逐回合灌點）。守衛與玩家路由共用
 * startTechTreeResearch。
 */
export async function executeResearch(userId: string, nodeId: number): Promise<void> {
  if (!Number.isInteger(nodeId) || nodeId <= 0) throw new Error("科技編號不正確");
  const nation = await loadNationByUser(userId);
  if (!nation) throw new Error("找不到國家");
  const r = await startTechTreeResearch({
    nation,
    nodeId,
    expectedDomain: "military",
  });
  if (!r.ok) throw new Error(r.error);
}

/** 設計兵種：先原子扣 1 次設計次數（Task #510），AI 失敗時退還（未入庫）。 */
export async function executeDesign(
  userId: string,
  category: MilitaryCategory,
  requirement: string,
): Promise<void> {
  const req = requirement.trim();
  if (req.length === 0 || req.length > 500) {
    throw new Error("兵種需求說明必須是 1～500 字");
  }
  const [eraSlug, gameYear] = await Promise.all([
    getMilitaryDomainEra(userId),
    getCurrentGameYear(),
  ]);
  const researchedKeySlugs = await loadResearchedKeySlugs(userId);
  const lock = categoryLockInfo(category, researchedKeySlugs);
  if (!lock.unlocked) {
    throw new Error(
      lock.lockReason ?? `${categoryLabel(category, eraSlug)}尚未解鎖`,
    );
  }
  // Task #510 — 次數制：條件式 UPDATE 原子扣 1 次（與玩家路由同一寫入層
  // 語義）；AI 失敗時退回 1 次並封頂 5。
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
    throw new Error(
      `設計次數不足（每回合恢復 1 次，上限 ${UNIT_DESIGN_CHARGE_CAP} 次）`,
    );
  }
  try {
    const geoContext = await buildNationGeoCultureContext(claimed[0].id);
    await designCustomUnit({
      ownerDiscordUserId: userId,
      category,
      requirement: req,
      eraSlug,
      gameYear,
      geoContext,
      // Task #519 — AI 退件濫用紀錄帶上行為人國家快照。
      nation: { id: claimed[0].id, name: claimed[0].name },
    });
  } catch (err) {
    await db
      .update(playerNationsTable)
      .set({
        unitDesignCharges: sql`LEAST(${UNIT_DESIGN_CHARGE_CAP}, ${playerNationsTable.unitDesignCharges} + 1)`,
      })
      .where(eq(playerNationsTable.discordUserId, userId))
      .catch((refundErr) =>
        logger.error(
          { refundErr, userId },
          "cabinet unit design refund failed",
        ),
      );
    if (err instanceof UnitCapError) throw new Error(err.message);
    if (err instanceof UnitDesignRejectedError) throw new Error(err.message);
    throw err instanceof Error && err.message.startsWith("AI")
      ? err
      : new Error("AI 兵種設計失敗（設計次數已退還）");
  }
}

/** 解散部隊：只能解散未派遣（非前線／非傷兵池）的可用兵力，不退資源。 */
export async function executeDisband(
  userId: string,
  nationId: string,
  templateId: number,
  quantity: number,
): Promise<void> {
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_ORDER_QUANTITY) {
    throw new Error("解散數量無效");
  }
  const reservedSql = sql`
    COALESCE((
      SELECT SUM(wclu.quantity + wclu.wounded)::bigint
      FROM war_campaign_legion_units wclu
      JOIN war_campaign_legions wcl ON wcl.id = wclu.legion_id
      JOIN war_campaigns wc ON wc.id = wcl.campaign_id
      WHERE wcl.nation_id = ${nationId}
        AND wclu.template_id = ${templateId}
        AND wc.status = 'active'
    ), 0) + COALESCE((
      SELECT pwu.wounded
      FROM player_wounded_units pwu
      WHERE pwu.discord_user_id = ${userId}
        AND pwu.template_id = ${templateId}
    ), 0)`;

  await db.transaction(async (tx) => {
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
      throw new Error(
        "解散數量超過可用兵力（部分部隊可能派駐前線或在傷兵池復原中）",
      );
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
  });
}
