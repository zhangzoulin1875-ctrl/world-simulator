import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  db,
  diplomacyTreatiesTable,
  playerNationsTable,
} from "@workspace/db";
import { recordFinanceLedger } from "./financeLedger";
import { notifyCustomTreatyShortfall } from "./diplomacyNotify";
import { logger } from "./logger";

/**
 * Task #214 — 自訂條約每回合經常性轉移結算。
 *
 * 自訂條約（type='custom'）可設定每回合由「付款方」轉給「受益方」的金錢／
 * 科技點數／木材／礦石。此結算於每日回合（turnEngine）在資源結算之後執行：
 * - 金錢／科技／木材／礦石：以條件式 UPDATE 扣款（餘額不足則本回合略過該項並
 *   通知付款方），成功後加到受益方；金錢另寫入財政流水（純顯示）。
 * - 生產力：不在此結算。生產力輸送是純流量（treatyProductionFlows.ts）——
 *   生效期間於生產力計算層即時加減，廢約即停止；絕不持久化寫 production_bonus
 *   （舊制每回合累積扣、廢約後殘留的 bug 已修正，勿再加回）。
 *
 * 每筆條約各自一個交易，彼此獨立；單筆失敗只記 log，不影響其他條約與回合本身。
 * 金額欄位為整數；扣款以條件式 UPDATE 保證併發安全（不會扣成負值）。
 */

/** 結算所需的自訂條約欄位子集。 */
export interface CustomTreatyRow {
  id: number;
  proposerNationId: string;
  targetNationId: string;
  perTurnMoney: number;
  perTurnTech: number;
  perTurnProduction: number;
  /** Task #476 — 每回合木材／礦石（庫存制，同金錢／科技）。 */
  perTurnWood: number;
  perTurnOre: number;
  /**
   * Task #527 — 反向每回合經常性轉移：requestPerTurn* 由「perTurn 付款方的
   * 對方」支付，兩方向各自獨立結算（任一方不足只略過該方向該項）。
   */
  requestPerTurnMoney: number;
  requestPerTurnTech: number;
  requestPerTurnProduction: number;
  requestPerTurnWood: number;
  requestPerTurnOre: number;
  proposerIsPayer: boolean;
}

/** 一筆自訂條約本回合的轉移計畫（付款方 → 受益方、各資源量）。 */
export interface CustomTreatyTransferPlan {
  treatyId: number;
  payerId: string;
  beneficiaryId: string;
  money: number;
  tech: number;
  production: number;
  wood: number;
  ore: number;
}

function planHasTransfer(plan: CustomTreatyTransferPlan): boolean {
  return (
    plan.money > 0 ||
    plan.tech > 0 ||
    plan.production > 0 ||
    plan.wood > 0 ||
    plan.ore > 0
  );
}

/**
 * 純函式（Task #527 雙向化）：把一筆自訂條約展開為最多兩個方向的轉移計畫。
 * - 正向：perTurn*，付款方依 proposerIsPayer 決定（舊單向語義，完全不變）。
 * - 反向：requestPerTurn*，付款方一律是正向付款方的對方。
 * 只回傳「至少有一項轉移量 > 0」的方向；負值／小數夾成 0／截斷。
 */
export function planCustomTreatyTransfers(
  row: CustomTreatyRow,
): CustomTreatyTransferPlan[] {
  const forwardPayerId = row.proposerIsPayer
    ? row.proposerNationId
    : row.targetNationId;
  const forwardBeneficiaryId = row.proposerIsPayer
    ? row.targetNationId
    : row.proposerNationId;
  const forward: CustomTreatyTransferPlan = {
    treatyId: row.id,
    payerId: forwardPayerId,
    beneficiaryId: forwardBeneficiaryId,
    money: Math.max(0, Math.trunc(row.perTurnMoney)),
    tech: Math.max(0, Math.trunc(row.perTurnTech)),
    production: Math.max(0, Math.trunc(row.perTurnProduction)),
    wood: Math.max(0, Math.trunc(row.perTurnWood)),
    ore: Math.max(0, Math.trunc(row.perTurnOre)),
  };
  const reverse: CustomTreatyTransferPlan = {
    treatyId: row.id,
    payerId: forwardBeneficiaryId,
    beneficiaryId: forwardPayerId,
    money: Math.max(0, Math.trunc(row.requestPerTurnMoney)),
    tech: Math.max(0, Math.trunc(row.requestPerTurnTech)),
    production: Math.max(0, Math.trunc(row.requestPerTurnProduction)),
    wood: Math.max(0, Math.trunc(row.requestPerTurnWood)),
    ore: Math.max(0, Math.trunc(row.requestPerTurnOre)),
  };
  return [forward, reverse].filter(planHasTransfer);
}

export interface CustomTreatySettlementSummary {
  /** 掃描到的生效中自訂條約數。 */
  treaties: number;
  moneyTransferred: number;
  techTransferred: number;
  woodTransferred: number;
  oreTransferred: number;
  /** 因餘額不足而略過（金錢／科技／木材／礦石）的條約數。 */
  shortfalls: number;
  failures: number;
}

/**
 * 執行一次自訂條約結算：處理所有生效中（status='active'、type='custom'、
 * 未到期）且含經常性轉移的自訂條約。
 */
export async function runCustomTreatySettlement(
  now: Date = new Date(),
): Promise<CustomTreatySettlementSummary> {
  const treaties = await db
    .select({
      id: diplomacyTreatiesTable.id,
      proposerNationId: diplomacyTreatiesTable.proposerNationId,
      targetNationId: diplomacyTreatiesTable.targetNationId,
      perTurnMoney: diplomacyTreatiesTable.perTurnMoney,
      perTurnTech: diplomacyTreatiesTable.perTurnTech,
      perTurnProduction: diplomacyTreatiesTable.perTurnProduction,
      perTurnWood: diplomacyTreatiesTable.perTurnWood,
      perTurnOre: diplomacyTreatiesTable.perTurnOre,
      requestPerTurnMoney: diplomacyTreatiesTable.requestPerTurnMoney,
      requestPerTurnTech: diplomacyTreatiesTable.requestPerTurnTech,
      requestPerTurnProduction: diplomacyTreatiesTable.requestPerTurnProduction,
      requestPerTurnWood: diplomacyTreatiesTable.requestPerTurnWood,
      requestPerTurnOre: diplomacyTreatiesTable.requestPerTurnOre,
      proposerIsPayer: diplomacyTreatiesTable.proposerIsPayer,
    })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        eq(diplomacyTreatiesTable.type, "custom"),
        eq(diplomacyTreatiesTable.status, "active"),
        or(
          isNull(diplomacyTreatiesTable.expiresAt),
          gt(diplomacyTreatiesTable.expiresAt, now),
        ),
      ),
    );

  const summary: CustomTreatySettlementSummary = {
    treaties: treaties.length,
    moneyTransferred: 0,
    techTransferred: 0,
    woodTransferred: 0,
    oreTransferred: 0,
    shortfalls: 0,
    failures: 0,
  };

  for (const row of treaties) {
    // Task #527 — 一筆條約最多兩個方向的計畫，各自獨立結算（一方不足只略過
    // 該方向該項，不影響另一方向）。
    for (const plan of planCustomTreatyTransfers(row)) {
      try {
        const result = await settleOneCustomTreaty(plan);
        summary.moneyTransferred += result.moneyMoved;
        summary.techTransferred += result.techMoved;
        summary.woodTransferred += result.woodMoved;
        summary.oreTransferred += result.oreMoved;
        if (
          result.moneyShort ||
          result.techShort ||
          result.woodShort ||
          result.oreShort
        ) {
          summary.shortfalls += 1;
          await notifyPayerShortfall(plan, result);
        }
      } catch (err) {
        summary.failures += 1;
        logger.error(
          { err, treatyId: plan.treatyId },
          "custom treaty settlement failed for treaty",
        );
      }
    }
  }

  return summary;
}

interface OneTreatyResult {
  moneyMoved: number;
  techMoved: number;
  woodMoved: number;
  oreMoved: number;
  moneyShort: boolean;
  techShort: boolean;
  woodShort: boolean;
  oreShort: boolean;
}

/**
 * 單筆自訂條約的轉移（單一交易）：金錢／科技／木材／礦石以條件式扣款
 * （不足則略過該項）。plan.production 在此刻意忽略——生產力輸送是純流量，
 * 由 treatyProductionFlows.ts 於計算層即時呈現，不做任何 DB 寫入。
 *
 * 匯出供整合測試直接針對單筆計畫驗證轉移／缺額略過／併發安全，
 * 免去 runCustomTreatySettlement 全域掃描會動到共用 dev DB 其他真實條約的副作用。
 */
export async function settleOneCustomTreaty(
  plan: CustomTreatyTransferPlan,
): Promise<OneTreatyResult> {
  return db.transaction(async (tx) => {
    const result: OneTreatyResult = {
      moneyMoved: 0,
      techMoved: 0,
      woodMoved: 0,
      oreMoved: 0,
      moneyShort: false,
      techShort: false,
      woodShort: false,
      oreShort: false,
    };

    if (plan.money > 0) {
      const deducted = await tx
        .update(playerNationsTable)
        .set({ money: sql`${playerNationsTable.money} - ${plan.money}` })
        .where(
          and(
            eq(playerNationsTable.id, plan.payerId),
            sql`${playerNationsTable.money} >= ${plan.money}`,
          ),
        )
        .returning({ id: playerNationsTable.id });
      if (deducted.length > 0) {
        await tx
          .update(playerNationsTable)
          .set({ money: sql`${playerNationsTable.money} + ${plan.money}` })
          .where(eq(playerNationsTable.id, plan.beneficiaryId));
        await recordFinanceLedger(tx, {
          nationId: plan.payerId,
          category: "treaty",
          amount: -plan.money,
          description: "自訂條約每回合款項支出",
        });
        await recordFinanceLedger(tx, {
          nationId: plan.beneficiaryId,
          category: "treaty",
          amount: plan.money,
          description: "自訂條約每回合款項收入",
        });
        result.moneyMoved = plan.money;
      } else {
        result.moneyShort = true;
      }
    }

    if (plan.tech > 0) {
      const deducted = await tx
        .update(playerNationsTable)
        .set({
          techPoints: sql`${playerNationsTable.techPoints} - ${plan.tech}`,
        })
        .where(
          and(
            eq(playerNationsTable.id, plan.payerId),
            sql`${playerNationsTable.techPoints} >= ${plan.tech}`,
          ),
        )
        .returning({ id: playerNationsTable.id });
      if (deducted.length > 0) {
        await tx
          .update(playerNationsTable)
          .set({
            techPoints: sql`${playerNationsTable.techPoints} + ${plan.tech}`,
          })
          .where(eq(playerNationsTable.id, plan.beneficiaryId));
        result.techMoved = plan.tech;
      } else {
        result.techShort = true;
      }
    }

    // Task #476 — 木材／礦石：庫存制，條件式扣款（不足則本回合略過該項）。
    if (plan.wood > 0) {
      const deducted = await tx
        .update(playerNationsTable)
        .set({ wood: sql`${playerNationsTable.wood} - ${plan.wood}` })
        .where(
          and(
            eq(playerNationsTable.id, plan.payerId),
            sql`${playerNationsTable.wood} >= ${plan.wood}`,
          ),
        )
        .returning({ id: playerNationsTable.id });
      if (deducted.length > 0) {
        await tx
          .update(playerNationsTable)
          .set({ wood: sql`${playerNationsTable.wood} + ${plan.wood}` })
          .where(eq(playerNationsTable.id, plan.beneficiaryId));
        result.woodMoved = plan.wood;
      } else {
        result.woodShort = true;
      }
    }

    if (plan.ore > 0) {
      const deducted = await tx
        .update(playerNationsTable)
        .set({ ore: sql`${playerNationsTable.ore} - ${plan.ore}` })
        .where(
          and(
            eq(playerNationsTable.id, plan.payerId),
            sql`${playerNationsTable.ore} >= ${plan.ore}`,
          ),
        )
        .returning({ id: playerNationsTable.id });
      if (deducted.length > 0) {
        await tx
          .update(playerNationsTable)
          .set({ ore: sql`${playerNationsTable.ore} + ${plan.ore}` })
          .where(eq(playerNationsTable.id, plan.beneficiaryId));
        result.oreMoved = plan.ore;
      } else {
        result.oreShort = true;
      }
    }

    // plan.production：刻意不處理（純流量，見模組說明）。

    return result;
  });
}

/** 通知付款方本回合有經常性轉移因餘額不足而略過。 */
async function notifyPayerShortfall(
  plan: CustomTreatyTransferPlan,
  result: OneTreatyResult,
): Promise<void> {
  const [payer] = await db
    .select({ discordUserId: playerNationsTable.discordUserId })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, plan.payerId))
    .limit(1);
  if (!payer?.discordUserId) return;
  const missing: string[] = [];
  if (result.moneyShort) missing.push(`金錢 ${plan.money}`);
  if (result.techShort) missing.push(`科技點數 ${plan.tech}`);
  if (result.woodShort) missing.push(`木材 ${plan.wood}`);
  if (result.oreShort) missing.push(`礦石 ${plan.ore}`);
  if (missing.length === 0) return;
  notifyCustomTreatyShortfall({
    payerDiscordUserId: payer.discordUserId,
    missing: missing.join("、"),
  });
}
