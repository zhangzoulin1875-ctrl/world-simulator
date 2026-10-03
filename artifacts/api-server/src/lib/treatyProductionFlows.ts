import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db, diplomacyTreatiesTable } from "@workspace/db";

/**
 * 條約生產力輸送——純流量（比照糧食輸送 sumTreatyFoodFlows 的模式）。
 *
 * 自訂條約的「每回合生產力」不再持久化寫入 player_nations.production_bonus
 * （舊制每回合累積加減、廢約後偏移量永久殘留——鐵則「流量 vs 庫存」違規）。
 * 改為：只在條約生效期間，於生產力計算層即時加減（付款方 −N、受益方 +N）；
 * 條約廢除／到期即刻停止，無任何殘留。
 *
 * 生產力是流量：付款方不做餘額檢查，即使自己生產力不足也照樣輸出
 * （有效生產力下限 0 由計算層的 max(0, …) 保證）。
 *
 * 獨立小模組（不放 customTreatySettlement.ts）：nationStats 需要 import 本
 * 模組，而 customTreatySettlement → diplomacyNotify → gameNotify 鏈可能形成
 * 循環相依。
 */

/** sumTreatyProductionFlows 所需的條約欄位子集。 */
export interface TreatyProductionRow {
  proposerNationId: string;
  targetNationId: string;
  perTurnProduction: number;
  /** Task #527 — 反向生產力輸送（由 perTurn 付款方的對方支付）。 */
  requestPerTurnProduction: number;
  proposerIsPayer: boolean;
}

/**
 * 純函式：由生效自訂條約列計算某國的生產力輸送流量。
 * 正向 perTurnProduction：付款方（proposerIsPayer 決定方向）outflow +N、
 * 受益方 inflow +N；反向 requestPerTurnProduction（Task #527）方向恰好相反，
 * 兩方向可同時存在。負值/非整數夾成 0（與 planCustomTreatyTransfers 同口徑）。
 */
export function sumTreatyProductionFlows(
  nationId: string,
  rows: readonly TreatyProductionRow[],
): { inflow: number; outflow: number } {
  let inflow = 0;
  let outflow = 0;
  for (const r of rows) {
    const payerId = r.proposerIsPayer ? r.proposerNationId : r.targetNationId;
    const beneficiaryId = r.proposerIsPayer
      ? r.targetNationId
      : r.proposerNationId;
    const forward = Math.max(0, Math.trunc(r.perTurnProduction));
    if (forward > 0) {
      if (payerId === nationId) outflow += forward;
      else if (beneficiaryId === nationId) inflow += forward;
    }
    const reverse = Math.max(0, Math.trunc(r.requestPerTurnProduction));
    if (reverse > 0) {
      if (beneficiaryId === nationId) outflow += reverse;
      else if (payerId === nationId) inflow += reverse;
    }
  }
  return { inflow, outflow };
}

/** 該國參與、生效中且含生產力輸送的自訂條約（口徑同 runCustomTreatySettlement）。 */
async function loadTreatyProductionRows(
  nationId: string,
  now: Date,
): Promise<TreatyProductionRow[]> {
  return db
    .select({
      proposerNationId: diplomacyTreatiesTable.proposerNationId,
      targetNationId: diplomacyTreatiesTable.targetNationId,
      perTurnProduction: diplomacyTreatiesTable.perTurnProduction,
      requestPerTurnProduction:
        diplomacyTreatiesTable.requestPerTurnProduction,
      proposerIsPayer: diplomacyTreatiesTable.proposerIsPayer,
    })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        eq(diplomacyTreatiesTable.type, "custom"),
        eq(diplomacyTreatiesTable.status, "active"),
        or(
          gt(diplomacyTreatiesTable.perTurnProduction, 0),
          gt(diplomacyTreatiesTable.requestPerTurnProduction, 0),
        ),
        or(
          isNull(diplomacyTreatiesTable.expiresAt),
          gt(diplomacyTreatiesTable.expiresAt, now),
        ),
        or(
          eq(diplomacyTreatiesTable.proposerNationId, nationId),
          eq(diplomacyTreatiesTable.targetNationId, nationId),
        ),
      ),
    );
}

/** 某國的條約生產力淨流量（inflow − outflow；可為負）。 */
export async function loadTreatyProductionNet(
  nationId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await loadTreatyProductionRows(nationId, now);
  const { inflow, outflow } = sumTreatyProductionFlows(nationId, rows);
  return inflow - outflow;
}

/**
 * 批次版：一次撈出所有生效中含生產力輸送的自訂條約，回傳 nationId → 淨流量。
 * 回合引擎逐國迴圈與全球平均生產力計算用（避免每國一次查詢）。
 * 不在 map 中的國家＝淨流量 0。
 */
export async function loadTreatyProductionNetByNation(
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      proposerNationId: diplomacyTreatiesTable.proposerNationId,
      targetNationId: diplomacyTreatiesTable.targetNationId,
      perTurnProduction: diplomacyTreatiesTable.perTurnProduction,
      requestPerTurnProduction:
        diplomacyTreatiesTable.requestPerTurnProduction,
      proposerIsPayer: diplomacyTreatiesTable.proposerIsPayer,
    })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        eq(diplomacyTreatiesTable.type, "custom"),
        eq(diplomacyTreatiesTable.status, "active"),
        or(
          gt(diplomacyTreatiesTable.perTurnProduction, 0),
          gt(diplomacyTreatiesTable.requestPerTurnProduction, 0),
        ),
        or(
          isNull(diplomacyTreatiesTable.expiresAt),
          gt(diplomacyTreatiesTable.expiresAt, now),
        ),
      ),
    );

  const net = new Map<string, number>();
  const add = (nationId: string, delta: number) => {
    net.set(nationId, (net.get(nationId) ?? 0) + delta);
  };
  for (const r of rows) {
    const payerId = r.proposerIsPayer ? r.proposerNationId : r.targetNationId;
    const beneficiaryId = r.proposerIsPayer
      ? r.targetNationId
      : r.proposerNationId;
    const forward = Math.max(0, Math.trunc(r.perTurnProduction));
    if (forward > 0) {
      add(payerId, -forward);
      add(beneficiaryId, forward);
    }
    const reverse = Math.max(0, Math.trunc(r.requestPerTurnProduction));
    if (reverse > 0) {
      add(beneficiaryId, -reverse);
      add(payerId, reverse);
    }
  }
  return net;
}
