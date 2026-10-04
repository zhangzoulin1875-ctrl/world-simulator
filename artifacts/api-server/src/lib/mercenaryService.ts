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
  recruitQueueTable,
  type MercenaryState,
} from "@workspace/db";
import {
  MERCENARY_COMPANIES,
  getMercenaryCompany,
  canDisarm,
  canSignContract,
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
    await removeMercenaryLegion(nationId, state, tx);
    await tx
      .update(mercenaryStatesTable)
      .set({
        companyId: null,
        signedAt: null,
        deployedCampaignId: null,
        deployedSlot: null,
        deployedMode: null,
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

/* ───────────── 派遣 / 召回 ───────────── */

/** 僱傭兵軍團在資料庫裡的標記:軍團單位的 template_id 為 null 不可行,改用 nation 自己的軍團列 + 專屬旗標表。 */
async function removeMercenaryLegion(
  nationId: string,
  state: MercenaryState,
  tx: Executor,
): Promise<void> {
  if (!state.deployedCampaignId || !state.deployedSlot) return;
  await tx
    .delete(warCampaignLegionsTable)
    .where(
      and(
        eq(warCampaignLegionsTable.campaignId, state.deployedCampaignId),
        eq(warCampaignLegionsTable.nationId, nationId),
        eq(warCampaignLegionsTable.slot, state.deployedSlot),
      ),
    );
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
export async function deployMercenaries(input: DeployInput): Promise<MercenaryState> {
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
    if (state.deployedCampaignId) {
      throw new MercenaryError(409, "僱傭兵已派遣中,請先召回");
    }

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
      .update(mercenaryStatesTable)
      .set({
        deployedCampaignId: campaignId,
        deployedSlot: slot,
        deployedMode: mode,
        updatedAt: new Date(),
      })
      .where(eq(mercenaryStatesTable.nationId, nationId))
      .returning();
    return row!;
  });
}

export async function recallMercenaries(nationId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .select({ id: playerNationsTable.id })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .for("update");
    const state = await getMercenaryState(nationId, tx);
    if (!state?.deployedCampaignId) {
      throw new MercenaryError(409, "僱傭兵目前沒有派遣中");
    }
    await removeMercenaryLegion(nationId, state, tx);
    await tx
      .update(mercenaryStatesTable)
      .set({
        deployedCampaignId: null,
        deployedSlot: null,
        deployedMode: null,
        updatedAt: new Date(),
      })
      .where(eq(mercenaryStatesTable.nationId, nationId));
  });
}

void inArray;
void warCampaignLegionUnitsTable;
