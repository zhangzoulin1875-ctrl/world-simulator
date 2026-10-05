import { and, eq, sql, inArray } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  playerArmiesTable,
  warCampaignsTable,
  warCampaignParticipantsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  playerWoundedUnitsTable,
  mercenaryStatesTable,
  mercenaryDeploymentsTable,
  totalMobilizationStatesTable,
  recruitQueueTable,
  type MercenaryState,
  type MercenaryDeployment,
} from "@workspace/db";
import {
  MERCENARY_COMPANIES,
  getMercenaryCompany,
  canDisarm,
  canSignContract,
  decideRentCharge,
  canRecruit,
  computeMercenaryForce,
  computeMercenaryRent,
  computeDeployFee,
  type MercenaryCompany,
  type MercenaryForce,
} from "./mercenary";
import { powerRatio, standardNationPopulation } from "./nationCostScale";
import { loadNationScales } from "./nationScale";
import { computeUnitCategoryAverages } from "./gameBalance";
import { getStatsEraSlug } from "./nationStats";
import { cancelQueueOrdersForNation } from "./recruitQueue";
import { mobilizationBlocksContract } from "./totalMobilization";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

export class MercenaryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const LEGION_SLOTS = ["A", "B", "C"] as const;
export type LegionSlotId = (typeof LEGION_SLOTS)[number];

/* ───────────── 讀取 ───────────── */

export async function getMercenaryState(
  nationId: string,
  ex: Executor = db,
): Promise<MercenaryState | null> {
  const [row] = await ex
    .select()
    .from(mercenaryStatesTable)
    .where(eq(mercenaryStatesTable.nationId, nationId))
    .limit(1);
  return row ?? null;
}

/** 是否持有生效中的合約(給招募/訓練閘門用)。 */
export async function hasActiveMercenaryContract(
  nationId: string,
  ex: Executor = db,
): Promise<boolean> {
  const s = await getMercenaryState(nationId, ex);
  return !!s?.companyId;
}

/** 招募閘門:有合約就丟 400。招募、訓練、佇列入口共用。 */
export async function assertCanRecruit(
  nationId: string,
  ex: Executor = db,
): Promise<void> {
  const check = canRecruit({
    hasActiveContract: await hasActiveMercenaryContract(nationId, ex),
  });
  if (!check.ok) throw new MercenaryError(400, check.reason);
}

/** 該國是否有進行中的戰役(以主角或參與者身分)。 */
export async function hasActiveCampaign(
  nationId: string,
  ex: Executor = db,
): Promise<boolean> {
  const [lead] = await ex
    .select({ id: warCampaignsTable.id })
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.status, "active"),
        sql`(${warCampaignsTable.attackerNationId} = ${nationId} OR ${warCampaignsTable.defenderNationId} = ${nationId})`,
      ),
    )
    .limit(1);
  if (lead) return true;
  const [part] = await ex
    .select({ id: warCampaignParticipantsTable.id })
    .from(warCampaignParticipantsTable)
    .innerJoin(
      warCampaignsTable,
      eq(warCampaignsTable.id, warCampaignParticipantsTable.campaignId),
    )
    .where(
      and(
        eq(warCampaignParticipantsTable.nationId, nationId),
        eq(warCampaignsTable.status, "active"),
      ),
    )
    .limit(1);
  return !!part;
}

/* ───────────── 戰力與價格(需要全服資料) ───────────── */

export interface MercenaryQuote {
  company: MercenaryCompany;
  force: MercenaryForce;
  rent: number;
  deployFee: number;
  powerRatio: number;
}

/** 針對某國、某時代,算出五間公司的實際兵力與價格。 */
export async function quoteCompanies(
  nationId: string,
  ex: Executor = db,
): Promise<MercenaryQuote[]> {
  const statsEra = await getStatsEraSlug();
  const scales = await loadNationScales(nationId, statsEra);
  const r = powerRatio(scales.population, statsEra);
  const std = standardNationPopulation(statsEra);
  const avg = await computeUnitCategoryAverages("infantry");
  // 全服沒有步兵設計時給一組保底值,避免 0 戰力。
  const avgHp = avg.count > 0 ? avg.hp : 100;
  const avgAttack = avg.count > 0 ? avg.attack : 10;
  const avgDefense = avg.count > 0 ? avg.defense : 10;
  const avgUpkeep = (avg.count > 0 ? avg.upkeep : 1) * scales.upkeep;
  void ex;
  return MERCENARY_COMPANIES.map((company) => {
    const force = computeMercenaryForce({
      company,
      powerRatio: r,
      standardPopulation: std,
      avgHp,
      avgAttack,
      avgDefense,
    });
    const rent = computeMercenaryRent({
      company,
      troops: force.troops,
      avgUpkeepPerUnit: avgUpkeep,
      powerRatio: r,
    });
    return {
      company,
      force,
      rent,
      deployFee: computeDeployFee(rent, company),
      powerRatio: r,
    };
  });
}

export async function quoteCompany(
  nationId: string,
  companyId: string,
): Promise<MercenaryQuote | null> {
  const all = await quoteCompanies(nationId);
  return all.find((q) => q.company.id === companyId) ?? null;
}

/** 是否仍有常備軍或訓練佇列(簽約前必須是空的)。 */
async function hasStandingForces(
  nationId: string,
  userId: string | null,
  ex: Executor,
): Promise<boolean> {
  if (userId) {
    const [army] = await ex
      .select({ n: sql<string>`COALESCE(SUM(${playerArmiesTable.quantity}), 0)` })
      .from(playerArmiesTable)
      .where(eq(playerArmiesTable.discordUserId, userId));
    if (Number(army?.n ?? 0) > 0) return true;
  }
  const [q] = await ex
    .select({ id: recruitQueueTable.id })
    .from(recruitQueueTable)
    .where(eq(recruitQueueTable.nationId, nationId))
    .limit(1);
  return !!q;
}

/* ───────────── 解除武裝(100% 退還) ───────────── */

export interface DisarmResult {
  disbandedUnits: number;
  refundedProduction: number;
  refundedPopulation: number;
  /** 取消訓練佇列時一併退還的原料與金錢。 */
  refundedWood: number;
  refundedOre: number;
  refundedMoney: number;
  templates: number;
}

/**
 * 解除武裝:全軍立刻解散,預留的生產力與人口 100% 退還;
 * 清空招募佇列(佇列內已預扣的資源同樣退還);有進行中戰役不可。
 */
export async function disarmNation(nationId: string): Promise<DisarmResult> {
  return db.transaction(async (tx) => {
    // 鎖國家列,序列化同一國的並發操作。
    const [nation] = await tx
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .for("update")
      .limit(1);
    if (!nation) throw new MercenaryError(404, "找不到國家");
    if (nation.isNpc) throw new MercenaryError(403, "NPC 國家不開放僱傭兵");
    const userId = nation.discordUserId;
    if (!userId) throw new MercenaryError(400, "此國家沒有對應玩家");

    const state = await getMercenaryState(nationId, tx);
    const check = canDisarm({
      hasActiveCampaign: await hasActiveCampaign(nationId, tx),
      alreadyDisarmed: !!state?.disarmed,
    });
    if (!check.ok) throw new MercenaryError(409, check.reason);

    const armies = await tx
      .select()
      .from(playerArmiesTable)
      .where(eq(playerArmiesTable.discordUserId, userId));

    let disbandedUnits = 0;
    let refundedProduction = 0;
    let refundedPopulation = 0;
    let refundedWood = 0;
    let refundedOre = 0;
    let refundedMoney = 0;
    for (const a of armies) {
      disbandedUnits += Math.max(0, a.quantity);
      refundedProduction += Math.max(0, a.productionReserved);
      refundedPopulation += Math.max(0, a.populationReserved);
    }

    // 招募佇列:取消並退還(沿用佇列自己的取消邏輯以免重複實作退款規則)。
    const queue = await tx
      .select()
      .from(recruitQueueTable)
      .where(eq(recruitQueueTable.nationId, nationId));
    if (queue.length > 0) {
      const refund = await cancelQueueOrdersForNation(nationId, tx);
      refundedProduction += refund.production;
      refundedPopulation += refund.population;
      refundedWood += refund.wood;
      refundedOre += refund.ore;
      refundedMoney += refund.money;
    }

    if (armies.length > 0) {
      await tx
        .delete(playerArmiesTable)
        .where(eq(playerArmiesTable.discordUserId, userId));
    }
    // 傷兵同樣解散(否則會變成無主單位)。
    await tx
      .delete(playerWoundedUnitsTable)
      .where(eq(playerWoundedUnitsTable.discordUserId, userId));

    if (refundedProduction > 0 || refundedPopulation > 0) {
      await tx
        .update(playerNationsTable)
        .set({
          productionSpent: sql`GREATEST(0, ${playerNationsTable.productionSpent} - ${refundedProduction})`,
          populationSpent: sql`GREATEST(0, ${playerNationsTable.populationSpent} - ${refundedPopulation})`,
        })
        .where(eq(playerNationsTable.id, nationId));
    }

    // 全民皆兵的民兵就在上面被一併解散、人口已退還;狀態同步關閉,避免殘留繼續扣穩定度。
    await tx
      .update(totalMobilizationStatesTable)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(totalMobilizationStatesTable.nationId, nationId));

    await tx
      .insert(mercenaryStatesTable)
      .values({ nationId, disarmed: true })
      .onConflictDoUpdate({
        target: mercenaryStatesTable.nationId,
        set: { disarmed: true, updatedAt: new Date() },
      });

    return {
      disbandedUnits,
      refundedProduction,
      refundedPopulation,
      refundedWood,
      refundedOre,
      refundedMoney,
      templates: armies.length,
    };
  });
}

/** 恢復建軍:只有在沒有合約時可以。 */
export async function restoreArmy(nationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [nation] = await tx
      .select({ id: playerNationsTable.id })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .for("update")
      .limit(1);
    if (!nation) throw new MercenaryError(404, "找不到國家");
    const state = await getMercenaryState(nationId, tx);
    if (!state?.disarmed) throw new MercenaryError(409, "目前沒有解除武裝");
    if (state.companyId) {
      throw new MercenaryError(409, "簽有僱傭兵合約期間不能重新建軍,請先解約");
    }
    await tx
      .update(mercenaryStatesTable)
      .set({ disarmed: false, updatedAt: new Date() })
      .where(eq(mercenaryStatesTable.nationId, nationId));
  });
}

/* ───────────── 簽約 / 解約 ───────────── */

export async function signContract(
  nationId: string,
  companyId: string,
): Promise<MercenaryState> {
  return db.transaction(async (tx) => {
    const [nation] = await tx
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .for("update")
      .limit(1);
    if (!nation) throw new MercenaryError(404, "找不到國家");
    const [mob] = await tx
      .select({ active: totalMobilizationStatesTable.active })
      .from(totalMobilizationStatesTable)
      .where(eq(totalMobilizationStatesTable.nationId, nationId))
      .limit(1);
    const mobBlock = mobilizationBlocksContract(!!mob?.active);
    if (!mobBlock.ok) throw new MercenaryError(409, mobBlock.reason);
    const state = await getMercenaryState(nationId, tx);
    const check = canSignContract({
      isNpc: nation.isNpc,
      disarmed: !!state?.disarmed,
      activeContractCompanyId: state?.companyId ?? null,
      companyId,
      hasStandingForces: await hasStandingForces(nation.id, nation.discordUserId, tx),
    });
    if (!check.ok) throw new MercenaryError(409, check.reason);
    const [row] = await tx
      .update(mercenaryStatesTable)
      .set({
        companyId,
        signedAt: new Date(),
        lastTerminationNote: null,
        updatedAt: new Date(),
      })
      .where(eq(mercenaryStatesTable.nationId, nationId))
      .returning();
    return row!;
  });
}

/** 解約:同時召回派遣。可立刻改簽別家。 */
export async function terminateContract(
  nationId: string,
  note: string | null = null,
  ex?: Tx,
): Promise<void> {
  const run = async (tx: Tx) => {
    const state = await getMercenaryState(nationId, tx);
    if (!state?.companyId) {
      if (note === null) throw new MercenaryError(409, "目前沒有生效中的合約");
      return;
    }
    await removeMercenaryDeployments(nationId, tx);
    await tx
      .update(mercenaryStatesTable)
      .set({
        companyId: null,
        signedAt: null,
        lastTerminationNote: note,
        updatedAt: new Date(),
      })
      .where(eq(mercenaryStatesTable.nationId, nationId));
  };
  if (ex) return run(ex);
  await db.transaction(async (tx) => {
    await tx
      .select({ id: playerNationsTable.id })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .for("update");
    await run(tx);
  });
}

/* ───────────── 回合租金 ───────────── */

export interface RentChargeResult {
  /** 本回合要併入維護費的租金(無合約或已解約 = 0)。 */
  rentCharged: number;
  /** 是否因付不起而自動解約。 */
  terminated: boolean;
  companyName: string | null;
}

/**
 * 回合結算用:決定該國本回合的僱傭兵租金。
 * 付得起 → 回傳租金並累計 total_rent_paid;付不起 → 自動解約並留下備註,租金 0。
 * 只處理有生效合約的玩家國家;其餘回 0,不碰資料庫。
 */
export async function settleMercenaryRent(params: {
  nationId: string;
  availableFunds: number;
  otherUpkeep: number;
}): Promise<RentChargeResult> {
  const state = await getMercenaryState(params.nationId);
  if (!state?.companyId) return { rentCharged: 0, terminated: false, companyName: null };
  const quote = await quoteCompany(params.nationId, state.companyId);
  if (!quote) {
    await terminateContract(params.nationId, "合約公司已不存在,自動解約");
    return { rentCharged: 0, terminated: true, companyName: null };
  }
  // 派遣中每參戰一場戰役,就加收一次戰役出動費(租金只收一次)。
  const deployments = await listDeployments(params.nationId);
  const perTurn = quote.rent + quote.deployFee * deployments.length;
  const decision = decideRentCharge({
    rent: perTurn,
    availableFunds: params.availableFunds,
    otherUpkeep: params.otherUpkeep,
  });
  if (!decision.charge) {
    await terminateContract(
      params.nationId,
      `資金不足,無法支付「${quote.company.name}」本回合費用 ${perTurn},合約已自動終止`,
    );
    return { rentCharged: 0, terminated: true, companyName: quote.company.name };
  }
  if (decision.rentCharged > 0) {
    await db
      .update(mercenaryStatesTable)
      .set({
        totalRentPaid: sql`${mercenaryStatesTable.totalRentPaid} + ${quote.rent}`,
        totalDeployPaid: sql`${mercenaryStatesTable.totalDeployPaid} + ${decision.rentCharged - quote.rent}`,
        updatedAt: new Date(),
      })
      .where(eq(mercenaryStatesTable.nationId, params.nationId));
  }
  return { rentCharged: decision.rentCharged, terminated: false, companyName: quote.company.name };
}

/* ───────────── 派遣 / 召回 ───────────── */

/**
 * 移除傭兵在戰役中的虛擬軍團(軍團列)與派遣紀錄。
 * campaignId 省略 = 全部場次(解約、被迫終止時使用)。
 */
async function removeMercenaryDeployments(
  nationId: string,
  tx: Executor,
  campaignId?: number,
): Promise<number> {
  const where = campaignId
    ? and(
        eq(mercenaryDeploymentsTable.nationId, nationId),
        eq(mercenaryDeploymentsTable.campaignId, campaignId),
      )
    : eq(mercenaryDeploymentsTable.nationId, nationId);
  const rows = await tx.select().from(mercenaryDeploymentsTable).where(where);
  for (const d of rows) {
    await tx
      .delete(warCampaignLegionsTable)
      .where(
        and(
          eq(warCampaignLegionsTable.campaignId, d.campaignId),
          eq(warCampaignLegionsTable.nationId, nationId),
          eq(warCampaignLegionsTable.slot, d.slot),
        ),
      );
  }
  if (rows.length > 0) await tx.delete(mercenaryDeploymentsTable).where(where);
  return rows.length;
}

/** 目前派遣中的場次(依派遣時間排序)。 */
export async function listDeployments(
  nationId: string,
  ex: Executor = db,
): Promise<MercenaryDeployment[]> {
  return ex
    .select()
    .from(mercenaryDeploymentsTable)
    .where(eq(mercenaryDeploymentsTable.nationId, nationId))
    .orderBy(mercenaryDeploymentsTable.id);
}

export interface DeployInput {
  nationId: string;
  campaignId: number;
  slot: string;
  mode: "defend" | "attack";
}

/**
 * 派遣:在指定戰役佔用一個空的軍團欄位。
 * 僱傭兵以「沒有單位列的虛擬軍團」存在(war_campaign_legions 有列、war_campaign_legion_units 沒列),
 * 戰力在結算載入時由 mercenaryBattle 併入(階段 3)。
 */
export async function deployMercenaries(input: DeployInput): Promise<MercenaryDeployment> {
  const { nationId, campaignId, slot, mode } = input;
  if (!LEGION_SLOTS.includes(slot as LegionSlotId)) {
    throw new MercenaryError(400, "軍團欄位必須是 A、B 或 C");
  }
  if (mode !== "defend" && mode !== "attack") {
    throw new MercenaryError(400, "任務必須是 defend 或 attack");
  }
  return db.transaction(async (tx) => {
    const [nation] = await tx
      .select({ id: playerNationsTable.id, isNpc: playerNationsTable.isNpc })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .for("update")
      .limit(1);
    if (!nation) throw new MercenaryError(404, "找不到國家");
    if (nation.isNpc) throw new MercenaryError(403, "NPC 國家不開放僱傭兵");
    const state = await getMercenaryState(nationId, tx);
    if (!state?.companyId) throw new MercenaryError(409, "尚未簽訂軍事合約");
    // 可同時派進多場戰役;同一場戰役只能派一次(DB 也有唯一索引保證)。
    const [already] = await tx
      .select({ id: mercenaryDeploymentsTable.id })
      .from(mercenaryDeploymentsTable)
      .where(
        and(
          eq(mercenaryDeploymentsTable.nationId, nationId),
          eq(mercenaryDeploymentsTable.campaignId, campaignId),
        ),
      )
      .limit(1);
    if (already) throw new MercenaryError(409, "傭兵已派進這場戰役");

    const [campaign] = await tx
      .select()
      .from(warCampaignsTable)
      .where(eq(warCampaignsTable.id, campaignId))
      .limit(1);
    if (!campaign || campaign.status !== "active") {
      throw new MercenaryError(409, "這場戰役已經結束或不存在");
    }
    // 必須是這場戰役的參與者或主角,且任務要符合所在陣營。
    const [part] = await tx
      .select()
      .from(warCampaignParticipantsTable)
      .where(
        and(
          eq(warCampaignParticipantsTable.campaignId, campaignId),
          eq(warCampaignParticipantsTable.nationId, nationId),
        ),
      )
      .limit(1);
    const leadSide =
      campaign.attackerNationId === nationId
        ? "attacker"
        : campaign.defenderNationId === nationId
          ? "defender"
          : null;
    const side = (part?.side as "attacker" | "defender" | undefined) ?? leadSide;
    if (!side) throw new MercenaryError(403, "你不是這場戰役的參與者");
    if (mode === "defend" && side !== "defender") {
      throw new MercenaryError(400, "只有防守方可以下達『防守』任務");
    }
    if (mode === "attack" && side !== "attacker") {
      throw new MercenaryError(400, "只有進攻方可以下達『進攻』任務");
    }

    // 欄位必須空著。
    const taken = await tx
      .select({ slot: warCampaignLegionsTable.slot })
      .from(warCampaignLegionsTable)
      .where(
        and(
          eq(warCampaignLegionsTable.campaignId, campaignId),
          eq(warCampaignLegionsTable.nationId, nationId),
        ),
      );
    if (taken.some((t) => t.slot === slot)) {
      throw new MercenaryError(409, `軍團欄位 ${slot} 已被使用`);
    }

    await tx.insert(warCampaignLegionsTable).values({
      campaignId,
      nationId,
      slot,
      morale: 80,
      supply: 100,
      garrisoningCity: mode === "defend",
    });

    const [row] = await tx
      .insert(mercenaryDeploymentsTable)
      .values({ nationId, campaignId, slot, mode })
      .returning();
    return row!;
  });
}

/**
 * 召回傭兵。指定 campaignId = 只撤出那一場;省略 = 全部場次撤出。
 */
export async function recallMercenaries(
  nationId: string,
  campaignId?: number,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .select({ id: playerNationsTable.id })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .for("update");
    const n = await removeMercenaryDeployments(nationId, tx, campaignId);
    if (n === 0) throw new MercenaryError(409, "傭兵目前沒有派遣中");
    return n;
  });
}

/** 虛擬單位的 unitRowId:負數,絕不會對應到真實的 war_campaign_legion_units.id。 */
export const MERCENARY_UNIT_ROW_ID = -1;

export interface MercenaryLegionUnit {
  unitRowId: number;
  templateId: number;
  name: string;
  category: string;
  quantity: number;
  wounded: number;
  attack: number;
  defense: number;
  hp: number;
  speed: number;
  accuracy: number;
  range: string;
  antiCavalryPct: number;
  antiRangedPct: number;
  siegePct: number;
}

/**
 * 某場戰役中,所有「已派遣到這場戰役」的僱傭兵,換算成 nationId + slot → 虛擬單位。
 * 戰力依「當下」的國力與全服平均重算,所以會隨時代與科技自然成長。
 */
export async function loadMercenaryUnitsForCampaign(
  campaignId: number,
): Promise<Map<string, MercenaryLegionUnit>> {
  const rows = await db
    .select({
      nationId: mercenaryDeploymentsTable.nationId,
      slot: mercenaryDeploymentsTable.slot,
      companyId: mercenaryStatesTable.companyId,
    })
    .from(mercenaryDeploymentsTable)
    .innerJoin(
      mercenaryStatesTable,
      eq(mercenaryStatesTable.nationId, mercenaryDeploymentsTable.nationId),
    )
    .where(eq(mercenaryDeploymentsTable.campaignId, campaignId));
  const out = new Map<string, MercenaryLegionUnit>();
  for (const st of rows) {
    if (!st.companyId) continue;
    const quotes = await quoteCompanies(st.nationId);
    const q = quotes.find((x) => x.company.id === st.companyId);
    if (!q) continue;
    out.set(`${st.nationId}:${st.slot}`, {
      unitRowId: MERCENARY_UNIT_ROW_ID,
      templateId: 0,
      name: q.company.name,
      category: "infantry",
      quantity: q.force.troops,
      wounded: 0,
      attack: q.force.attack,
      defense: q.force.defense,
      hp: q.force.hp,
      speed: 5,
      accuracy: 60,
      range: "melee",
      antiCavalryPct: 0,
      antiRangedPct: 0,
      siegePct: 0,
    });
  }
  return out;
}

void inArray;
void warCampaignLegionUnitsTable;
