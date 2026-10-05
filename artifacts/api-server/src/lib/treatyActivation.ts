import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  regionControlsTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  type DiplomacyTreaty,
} from "@workspace/db";
import { recordFinanceLedger } from "./financeLedger";
import { recordTerritoryChanges } from "./territoryHistory";
import { pgErrorCode } from "./playerValidation";
import { CIVIL_WAR_NO_CEASEFIRE_MESSAGE, isActiveCivilWar, notCivilWar } from "./civilWar";

/** Error that maps to an HTTP status inside a transaction (throw → rollback). */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * 條約成立：在交易內一次性轉移提案者承諾的資源（金錢／科技點數／領土），
 * 再把條約標記為 active。條件更新防止提案者餘額不足或重複轉移：
 * - 扣款 UPDATE 帶 money/techPoints >= 承諾值 的 WHERE，不足 → 400 rollback。
 * - 領土以 DELETE ... RETURNING 取回提案者的掌控百分比，已不在掌控 → 400。
 * - 併入接受方既有掌控時百分比相加並以 LEAST(..., 100) 夾住，
 *   即使歷史資料超額也不會撞上 region_controls_percent_check 而炸出 500。
 * - 最後的 status 更新帶 status='proposed' 條件；已被別的交易搶先成立
 *   （或已拒絕）→ 409，整筆交易 rollback，資源不會重複轉移。
 */
export async function activateTreaty(
  tx: DbTransaction,
  treaty: DiplomacyTreaty,
): Promise<DiplomacyTreaty> {
  const { proposerNationId, targetNationId } = treaty;

  // Task #341 — 付款方 / 受益方由 proposerIsPayer 決定：
  //   true（既有語意）＝提案方付出、對象受益；
  //   false（附條件停戰／索求）＝提案方受益、對象付出。
  // Task #374 — 自訂條約例外：proposerIsPayer 僅決定「每回合經常性轉移」
  // 的方向；一次性附帶（offer*/request*）固定為 offer=提案方付、
  // request=對象付，不受該旗標影響。
  const oneTimeFlip = !treaty.proposerIsPayer && treaty.type !== "custom";
  const payerId = oneTimeFlip ? targetNationId : proposerNationId;
  const receiverId = oneTimeFlip ? proposerNationId : targetNationId;

  // Task #341 — 附條件停戰：綁定戰爭必須仍在進行中才可成立，且成立時一併結束戰爭。
  // 以條件式 UPDATE（endedAt IS NULL）原子認領，避免與其他停戰路徑競態重複結束。
  if (treaty.boundWarId !== null) {
    const ended = await tx
      .update(diplomacyWarsTable)
      .set({ endedAt: new Date(), ceasefireProposedBy: null })
      .where(
        and(
          eq(diplomacyWarsTable.id, treaty.boundWarId),
          isNull(diplomacyWarsTable.endedAt),
          notCivilWar(),
        ),
      )
      .returning({ id: diplomacyWarsTable.id });
    if (ended.length === 0) {
      if (await isActiveCivilWar(treaty.boundWarId)) throw new HttpError(409, CIVIL_WAR_NO_CEASEFIRE_MESSAGE);
    }
    if (ended.length === 0) {
      throw new HttpError(400, "該場戰爭已結束，此附條件停戰提案已失效");
    }
  }

  // Task #374 — 雙向一次性轉移：offer 側（付款方 → 受益方）先執行，
  // 再執行 request 側（受益方 → 付款方）。任一側餘額／掌控不足 →
  // HttpError(400) → 整筆交易 rollback，不會只轉一半。
  await transferOneTimeSide(tx, {
    fromId: payerId,
    toId: receiverId,
    money: treaty.offerMoney,
    techPoints: treaty.offerTechPoints,
    wood: treaty.offerWood,
    ore: treaty.offerOre,
    regionIds: treaty.offerRegionIds,
    regionPercents: treaty.offerRegionPercents,
    sideLabel: "付款國",
    treatyId: treaty.id,
  });
  await transferOneTimeSide(tx, {
    fromId: receiverId,
    toId: payerId,
    money: treaty.requestMoney,
    techPoints: treaty.requestTechPoints,
    wood: treaty.requestWood,
    ore: treaty.requestOre,
    regionIds: treaty.requestRegionIds,
    regionPercents: treaty.requestRegionPercents,
    sideLabel: "受要求國",
    treatyId: treaty.id,
  });

  const expiresAt =
    treaty.durationDays === null
      ? null
      : new Date(Date.now() + treaty.durationDays * 24 * 60 * 60 * 1000);
  let updated: DiplomacyTreaty | undefined;
  try {
    [updated] = await tx
      .update(diplomacyTreatiesTable)
      .set({
        status: "active",
        awaitingNationId: null,
        acceptedAt: new Date(),
        expiresAt,
        // 附庸條約：轉為 active 的同一條 UPDATE 內寫入附庸方 nation id，
        // 讓部分唯一索引（普通欄位，非 CASE 表達式）強制單一宗主。
        ...(treaty.type === "vassal"
          ? {
              vassalNationId: treaty.proposerIsVassal
                ? treaty.proposerNationId
                : treaty.targetNationId,
            }
          : {}),
      })
      .where(
        and(
          eq(diplomacyTreatiesTable.id, treaty.id),
          eq(diplomacyTreatiesTable.status, "proposed"),
        ),
      )
      .returning();
  } catch (err) {
    // 附庸唯一索引（diplomacy_treaties_vassal_nation_active_uidx）：接受瞬間
    // 準附庸已有別的生效中宗主 → 23505 → 409，整筆交易 rollback。
    if (treaty.type === "vassal" && pgErrorCode(err) === "23505") {
      throw new HttpError(409, "該附庸方已有生效中的宗主，無法再成立附庸條約");
    }
    throw err;
  }
  if (!updated) throw new HttpError(409, "條約狀態已變更，請重新整理");
  return updated;
}

/**
 * Task #374 — 單側一次性轉移（金錢／科技點數／領土），offer 側與 request 側共用。
 * - 金錢／科技以條件式 UPDATE 扣款（餘額不足 → 400，交易 rollback）。
 * - 領土依 regionPercents 決定整份或部分轉移；掌控不足 → 400。
 * - 併入接收方時以 LEAST(...,100) 夾住，避免歷史超額資料炸出 500。
 */
async function transferOneTimeSide(
  tx: DbTransaction,
  params: {
    fromId: string;
    toId: string;
    money: number;
    techPoints: number;
    /** Task #406 — 一次性木材／礦石轉移。 */
    wood: number;
    ore: number;
    regionIds: number[];
    regionPercents: Record<string, number>;
    /** 錯誤訊息中的角色稱呼（繁中），例如「付款國」／「受要求國」。 */
    sideLabel: string;
    /** Task #392 — 領土變更歷史的關聯條約 id。 */
    treatyId: number;
  },
): Promise<void> {
  const {
    fromId,
    toId,
    money,
    techPoints,
    wood,
    ore,
    regionIds,
    regionPercents,
    sideLabel,
    treatyId,
  } = params;

  if (money > 0 || techPoints > 0 || wood > 0 || ore > 0) {
    const deducted = await tx
      .update(playerNationsTable)
      .set({
        money: sql`${playerNationsTable.money} - ${money}`,
        techPoints: sql`${playerNationsTable.techPoints} - ${techPoints}`,
        wood: sql`${playerNationsTable.wood} - ${wood}`,
        ore: sql`${playerNationsTable.ore} - ${ore}`,
      })
      .where(
        and(
          eq(playerNationsTable.id, fromId),
          sql`${playerNationsTable.money} >= ${money}`,
          sql`${playerNationsTable.techPoints} >= ${techPoints}`,
          sql`${playerNationsTable.wood} >= ${wood}`,
          sql`${playerNationsTable.ore} >= ${ore}`,
        ),
      )
      .returning({ id: playerNationsTable.id });
    if (deducted.length === 0) {
      throw new HttpError(
        400,
        `${sideLabel}的金錢、科技點數或資源（木材／礦石）不足，條約無法成立`,
      );
    }
    await tx
      .update(playerNationsTable)
      .set({
        money: sql`${playerNationsTable.money} + ${money}`,
        techPoints: sql`${playerNationsTable.techPoints} + ${techPoints}`,
        wood: sql`${playerNationsTable.wood} + ${wood}`,
        ore: sql`${playerNationsTable.ore} + ${ore}`,
      })
      .where(eq(playerNationsTable.id, toId));
    // 財政流水（純顯示）：金錢款項只記金錢部分（科技點數不入財政）。
    if (money > 0) {
      await recordFinanceLedger(tx, {
        nationId: fromId,
        category: "treaty",
        amount: -money,
        description: "條約款項支出（成立時付予對方）",
      });
      await recordFinanceLedger(tx, {
        nationId: toId,
        category: "treaty",
        amount: money,
        description: "條約款項收入（對方成立時給付）",
      });
    }
  }

  for (const regionId of regionIds) {
    // Task #341 — 每區可指定轉移百分比；未指定 → 整份轉移。
    const requestedPct = regionPercents[String(regionId)];
    if (requestedPct !== undefined && requestedPct > 0 && requestedPct < 100) {
      // 部分轉移：轉出方須有足額掌控，扣除後（歸零則刪列），接收方以 LEAST 併入。
      const [held] = await tx
        .select({ percent: regionControlsTable.percent })
        .from(regionControlsTable)
        .where(
          and(
            eq(regionControlsTable.regionId, regionId),
            eq(regionControlsTable.nationId, fromId),
          ),
        )
        .for("update");
      const heldPct = held?.percent;
      if (heldPct === undefined || heldPct < requestedPct) {
        throw new HttpError(400, `${sideLabel}對條約領土的掌控不足，條約無法成立`);
      }
      const remaining = heldPct - requestedPct;
      if (remaining <= 0) {
        await tx
          .delete(regionControlsTable)
          .where(
            and(
              eq(regionControlsTable.regionId, regionId),
              eq(regionControlsTable.nationId, fromId),
            ),
          );
      } else {
        await tx
          .update(regionControlsTable)
          .set({ percent: remaining })
          .where(
            and(
              eq(regionControlsTable.regionId, regionId),
              eq(regionControlsTable.nationId, fromId),
            ),
          );
      }
      const [mergedPartial] = await tx
        .insert(regionControlsTable)
        .values({ regionId, nationId: toId, percent: requestedPct })
        .onConflictDoUpdate({
          target: [regionControlsTable.regionId, regionControlsTable.nationId],
          set: {
            percent: sql`LEAST(${regionControlsTable.percent} + ${requestedPct}, 100)`,
          },
        })
        .returning({ percent: regionControlsTable.percent });
      // Task #392 — 同交易內記錄條約割讓（部分轉移，雙方各一筆）。
      const receiverAfterPartial = mergedPartial?.percent ?? requestedPct;
      await recordTerritoryChanges(tx, [
        {
          nationId: fromId,
          regionId,
          percentBefore: heldPct,
          percentAfter: remaining,
          changeType: "treaty",
          reason: `條約割讓：依條約 #${treatyId} 轉出 ${requestedPct}% 掌控`,
          treatyId,
        },
        {
          nationId: toId,
          regionId,
          percentBefore: receiverAfterPartial - requestedPct,
          percentAfter: receiverAfterPartial,
          changeType: "treaty",
          reason: `條約割讓：依條約 #${treatyId} 取得 ${requestedPct}% 掌控`,
          treatyId,
        },
      ]);
      continue;
    }

    // 整份轉移（既有語意）：DELETE ... RETURNING 取回轉出方掌控，再併入接收方。
    const removed = await tx
      .delete(regionControlsTable)
      .where(
        and(
          eq(regionControlsTable.regionId, regionId),
          eq(regionControlsTable.nationId, fromId),
        ),
      )
      .returning({ percent: regionControlsTable.percent });
    const percent = removed[0]?.percent;
    if (percent === undefined) {
      throw new HttpError(
        400,
        `條約中的領土已不在${sideLabel}掌控，條約無法成立`,
      );
    }
    const [mergedFull] = await tx
      .insert(regionControlsTable)
      .values({ regionId, nationId: toId, percent })
      .onConflictDoUpdate({
        target: [regionControlsTable.regionId, regionControlsTable.nationId],
        set: {
          percent: sql`LEAST(${regionControlsTable.percent} + ${percent}, 100)`,
        },
      })
      .returning({ percent: regionControlsTable.percent });
    // Task #392 — 同交易內記錄條約割讓（整份轉移，雙方各一筆）。
    // 接收方 before 反推自 after − 轉入量（LEAST 夾住時以 0 為下限）。
    const receiverAfterFull = mergedFull?.percent ?? percent;
    await recordTerritoryChanges(tx, [
      {
        nationId: fromId,
        regionId,
        percentBefore: percent,
        percentAfter: 0,
        changeType: "treaty",
        reason: `條約割讓：依條約 #${treatyId} 轉出全部 ${percent}% 掌控`,
        treatyId,
      },
      {
        nationId: toId,
        regionId,
        percentBefore: Math.max(receiverAfterFull - percent, 0),
        percentAfter: receiverAfterFull,
        changeType: "treaty",
        reason: `條約割讓：依條約 #${treatyId} 取得 ${percent}% 掌控`,
        treatyId,
      },
    ]);
  }
}
