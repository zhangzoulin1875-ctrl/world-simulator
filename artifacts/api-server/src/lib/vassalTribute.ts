import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, diplomacyTreatiesTable, playerNationsTable } from "@workspace/db";
import { recordFinanceLedger } from "./financeLedger";
import { notifyVassalTributeShortfall } from "./diplomacyNotify";
import { vassalPartiesOf } from "./diplomacy";
import { logger } from "./logger";

/**
 * 附庸貢金結算：每回合附庸把「本回合稅收 × tributePct%」上繳宗主。
 *
 * - 基數是回合引擎當回合算出的稅收（taxIncomeByNationId），不是國庫存量。
 * - 扣款用條件式 UPDATE（money >= 貢金）：附庸在結算前把錢花掉導致餘額
 *   不足 → 該筆全額跳過並通知附庸（不部分扣款、金錢永不為負）。
 * - 每筆條約一個交易；單筆失敗只記 log，不阻斷其他條約。
 */

/** 純函式：貢金 = floor(稅收 × pct / 100)，稅收非正或 pct 越界時夾限。 */
export function computeTributeAmount(
  taxIncome: number,
  tributePct: number,
): number {
  if (!Number.isFinite(taxIncome) || taxIncome <= 0) return 0;
  if (!Number.isFinite(tributePct)) return 0;
  const pct = Math.min(100, Math.max(0, Math.trunc(tributePct)));
  return Math.floor((taxIncome * pct) / 100);
}

export interface VassalTributeSummary {
  treaties: number;
  tributeTransferred: number;
  shortfalls: number;
  failures: number;
}

/**
 * 執行一次附庸貢金結算：處理所有生效中（status='active'、type='vassal'、
 * 未到期）的附庸條約。taxIncomeByNationId = 本回合各國稅收（nation id → 稅收）。
 */
export async function runVassalTributeSettlement(
  taxIncomeByNationId: ReadonlyMap<string, number>,
  now: Date = new Date(),
): Promise<VassalTributeSummary> {
  const treaties = await db
    .select({
      id: diplomacyTreatiesTable.id,
      proposerNationId: diplomacyTreatiesTable.proposerNationId,
      targetNationId: diplomacyTreatiesTable.targetNationId,
      type: diplomacyTreatiesTable.type,
      status: diplomacyTreatiesTable.status,
      expiresAt: diplomacyTreatiesTable.expiresAt,
      tributePct: diplomacyTreatiesTable.tributePct,
      proposerIsVassal: diplomacyTreatiesTable.proposerIsVassal,
    })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        eq(diplomacyTreatiesTable.type, "vassal"),
        eq(diplomacyTreatiesTable.status, "active"),
        gt(diplomacyTreatiesTable.tributePct, 0),
        or(
          isNull(diplomacyTreatiesTable.expiresAt),
          gt(diplomacyTreatiesTable.expiresAt, now),
        ),
      ),
    );

  const summary: VassalTributeSummary = {
    treaties: treaties.length,
    tributeTransferred: 0,
    shortfalls: 0,
    failures: 0,
  };

  for (const row of treaties) {
    const { vassalId, suzerainId } = vassalPartiesOf(row);
    const tribute = computeTributeAmount(
      taxIncomeByNationId.get(vassalId) ?? 0,
      row.tributePct,
    );
    if (tribute <= 0) continue;
    try {
      const paid = await settleOneTribute({
        treatyId: row.id,
        vassalId,
        suzerainId,
        tribute,
      });
      if (paid) {
        summary.tributeTransferred += tribute;
      } else {
        summary.shortfalls += 1;
        await notifyShortfall(vassalId, tribute);
      }
    } catch (err) {
      summary.failures += 1;
      logger.error(
        { err, treatyId: row.id },
        "vassal tribute settlement failed for treaty",
      );
    }
  }

  return summary;
}

/**
 * 單筆貢金轉帳（單一交易）：條件式扣附庸、加宗主、記雙向財政流水。
 * 回傳是否成功轉帳（false = 附庸餘額不足，全額跳過）。
 * 匯出供整合測試直接驗證轉帳／缺額跳過／併發安全。
 */
export async function settleOneTribute(plan: {
  treatyId: number;
  vassalId: string;
  suzerainId: string;
  tribute: number;
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deducted = await tx
      .update(playerNationsTable)
      .set({ money: sql`${playerNationsTable.money} - ${plan.tribute}` })
      .where(
        and(
          eq(playerNationsTable.id, plan.vassalId),
          sql`${playerNationsTable.money} >= ${plan.tribute}`,
        ),
      )
      .returning({ id: playerNationsTable.id });
    if (deducted.length === 0) return false;
    await tx
      .update(playerNationsTable)
      .set({ money: sql`${playerNationsTable.money} + ${plan.tribute}` })
      .where(eq(playerNationsTable.id, plan.suzerainId));
    await recordFinanceLedger(tx, {
      nationId: plan.vassalId,
      category: "treaty",
      amount: -plan.tribute,
      description: "附庸條約貢金上繳",
    });
    await recordFinanceLedger(tx, {
      nationId: plan.suzerainId,
      category: "treaty",
      amount: plan.tribute,
      description: "附庸條約貢金收入",
    });
    return true;
  });
}

async function notifyShortfall(
  vassalId: string,
  tribute: number,
): Promise<void> {
  const [vassal] = await db
    .select({ discordUserId: playerNationsTable.discordUserId })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, vassalId))
    .limit(1);
  if (!vassal?.discordUserId) return;
  notifyVassalTributeShortfall({
    vassalDiscordUserId: vassal.discordUserId,
    tribute,
  });
}
