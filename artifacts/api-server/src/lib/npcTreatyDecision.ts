import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  diplomacyTreatiesTable,
  mapRegionsTable,
  playerNationsTable,
  regionControlsTable,
  type DiplomacyTreaty,
} from "@workspace/db";
import { HttpError, activateTreaty, type DbTransaction } from "./treatyActivation";
import { invalidateGlobalAveragePopulationCache } from "./researchCost";
import { pgErrorCode } from "./playerValidation";
import { mergeNpcCounterDemandRegions } from "./diplomacy";
import {
  findNpcTreatyCapViolations,
  npcPaidFields,
  type NpcTreatyCaps,
} from "./npcTreatyCaps";
import { loadNpcTreatyCaps } from "./npcTreatyCapData";
import { logger } from "./logger";
import type { NpcTreatyDecision } from "./diplomacyAi";

/**
 * Task #570 — accept 前在交易內重驗「NPC 付出側」是否仍在資源上限內
 * （提案通過守門後，世界設定或 NPC 資源可能已變）。超限 → 回傳違規清單。
 */
async function findAcceptCapViolations(
  tx: DbTransaction,
  fresh: DiplomacyTreaty,
): Promise<string[] | null> {
  const [npc] = await tx
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, fresh.targetNationId))
    .limit(1);
  if (!npc?.isNpc) return null;
  const hasNpcPaidPerTurn = fresh.proposerIsPayer
    ? fresh.requestPerTurnMoney > 0 ||
      fresh.requestPerTurnTech > 0 ||
      fresh.requestPerTurnProduction > 0 ||
      fresh.requestPerTurnFood > 0 ||
      fresh.requestPerTurnWood > 0 ||
      fresh.requestPerTurnOre > 0
    : fresh.perTurnMoney > 0 ||
      fresh.perTurnTech > 0 ||
      fresh.perTurnProduction > 0 ||
      fresh.perTurnFood > 0 ||
      fresh.perTurnWood > 0 ||
      fresh.perTurnOre > 0;
  const hasNpcPaid =
    fresh.requestMoney > 0 ||
    fresh.requestTechPoints > 0 ||
    fresh.requestWood > 0 ||
    fresh.requestOre > 0 ||
    fresh.requestRegionIds.length > 0 ||
    hasNpcPaidPerTurn;
  if (!hasNpcPaid) return null;
  const caps = await loadNpcTreatyCaps(npc);
  const [controls, regionRows] = await Promise.all([
    tx
      .select({
        regionId: regionControlsTable.regionId,
        percent: regionControlsTable.percent,
      })
      .from(regionControlsTable)
      .where(eq(regionControlsTable.nationId, npc.id)),
    fresh.requestRegionIds.length > 0
      ? tx
          .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
          .from(mapRegionsTable)
          .where(inArray(mapRegionsTable.id, fresh.requestRegionIds))
      : Promise.resolve([] as { id: number; name: string }[]),
  ]);
  const held = new Map(controls.map((r) => [r.regionId, r.percent]));
  const nameById = new Map(regionRows.map((r) => [r.id, r.name]));
  const violations = findNpcTreatyCapViolations(
    npcPaidFields({
      money: fresh.requestMoney,
      techPoints: fresh.requestTechPoints,
      wood: fresh.requestWood,
      ore: fresh.requestOre,
      regions: fresh.requestRegionIds.map((id) => {
        const heldPercent = held.get(id) ?? 0;
        return {
          regionId: id,
          regionName: nameById.get(id),
          transferPercent:
            fresh.requestRegionPercents[String(id)] ?? heldPercent,
          heldPercent,
        };
      }),
      perTurnMoney: fresh.proposerIsPayer
        ? fresh.requestPerTurnMoney
        : fresh.perTurnMoney,
      perTurnTech: fresh.proposerIsPayer
        ? fresh.requestPerTurnTech
        : fresh.perTurnTech,
      perTurnProduction: fresh.proposerIsPayer
        ? fresh.requestPerTurnProduction
        : fresh.perTurnProduction,
      perTurnFood: fresh.proposerIsPayer
        ? fresh.requestPerTurnFood
        : fresh.perTurnFood,
      perTurnWood: fresh.proposerIsPayer
        ? fresh.requestPerTurnWood
        : fresh.perTurnWood,
      perTurnOre: fresh.proposerIsPayer
        ? fresh.requestPerTurnOre
        : fresh.perTurnOre,
    }),
    caps,
  );
  return violations.length > 0 ? violations : null;
}

/**
 * Task #52 — NPC 條約即時判斷的套用邏輯（自路由抽出，供整合測試直接呼叫）。
 *
 * 競態防護：
 * - accept / counter 都在交易內先 SELECT ... FOR UPDATE 重新讀取條約列，
 *   並檢查仍為 proposed（AI 呼叫期間狀態可能已被其他請求變更 → 409）。
 * - accept 使用 activateTreaty 的條件更新：AI 判斷期間玩家餘額若已不足
 *   （例如同時在軍事頁面花錢）→ 400 且整筆交易 rollback；此時把仍為
 *   proposed 的提案列刪除（與 AI 失敗路徑一致），避免提案卡住無法重試。
 * - counter 的兩筆寫入（原提案 superseded ＋ 新對案列）在同一交易內，
 *   任何一筆失敗都會整體 rollback，不會只寫一半。
 * - reject 為帶 status='proposed' 條件的單一 UPDATE。
 */
export async function applyNpcTreatyDecision(
  treatyId: number,
  decision: NpcTreatyDecision,
): Promise<DiplomacyTreaty> {
  if (decision.decision === "accept") {
    try {
      const activated = await db.transaction(async (tx) => {
        const fresh = await lockProposedTreaty(tx, treatyId);
        // Task #570 — 接受前重驗 NPC 付出側是否仍在資源上限內；
        // 超限 → 降為拒絕（附上限說明），不啟用條約。
        const capViolations = await findAcceptCapViolations(tx, fresh);
        if (capViolations) {
          const [rejected] = await tx
            .update(diplomacyTreatiesTable)
            .set({
              status: "rejected",
              awaitingNationId: null,
              responseNote: `超過我國可提供的資源上限，礙難接受：${capViolations.join("；")}`,
            })
            .where(
              and(
                eq(diplomacyTreatiesTable.id, treatyId),
                eq(diplomacyTreatiesTable.status, "proposed"),
              ),
            )
            .returning();
          if (!rejected) {
            throw new HttpError(409, "條約狀態已變更，請重新整理");
          }
          logger.info(
            { treatyId, violations: capViolations },
            "npc treaty accept downgraded to reject (cap exceeded)",
          );
          return rejected;
        }
        await tx
          .update(diplomacyTreatiesTable)
          .set({ responseNote: decision.note })
          .where(eq(diplomacyTreatiesTable.id, treatyId));
        return activateTreaty(tx, fresh);
      });
      // Task #387 — 條約若含領土轉移，成立後全球平均生產力快取立即失效，
      // 避免玩家在 30 秒 TTL 內被舊平均計算的研發成本倍率扣點。
      if (
        activated.offerRegionIds.length > 0 ||
        activated.requestRegionIds.length > 0
      ) {
        invalidateGlobalAveragePopulationCache();
      }
      return activated;
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        // 餘額不足／領土已易主：撤回提案（僅在仍為 proposed 時），
        // 讓玩家調整後可重新提案，不留下卡住的 proposed 列。
        await db
          .delete(diplomacyTreatiesTable)
          .where(
            and(
              eq(diplomacyTreatiesTable.id, treatyId),
              eq(diplomacyTreatiesTable.status, "proposed"),
            ),
          );
      }
      throw err;
    }
  }

  if (decision.decision === "reject") {
    const [updated] = await db
      .update(diplomacyTreatiesTable)
      .set({
        status: "rejected",
        awaitingNationId: null,
        responseNote: decision.note,
      })
      .where(
        and(
          eq(diplomacyTreatiesTable.id, treatyId),
          eq(diplomacyTreatiesTable.status, "proposed"),
        ),
      )
      .returning();
    if (!updated) throw new HttpError(409, "條約狀態已變更，請重新整理");
    return updated;
  }

  // counter：原提案 superseded ＋ 新對案列，同一交易內原子寫入。
  const counter = decision.counter;
  if (!counter) {
    throw new HttpError(502, "NPC 外交回覆格式不正確，請再試一次");
  }
  try {
    return await db.transaction(async (tx) => {
      const fresh = await lockProposedTreaty(tx, treatyId);
      const [superseded] = await tx
        .update(diplomacyTreatiesTable)
        .set({
          status: "superseded",
          awaitingNationId: null,
          responseNote: decision.note,
        })
        .where(
          and(
            eq(diplomacyTreatiesTable.id, treatyId),
            eq(diplomacyTreatiesTable.status, "proposed"),
          ),
        )
        .returning();
      if (!superseded) throw new HttpError(409, "條約狀態已變更，請重新整理");
      const isCustom = fresh.type === "custom";
      // Task #570 — 自訂條約 proposerIsPayer=false 時，perTurn* 由 NPC
      // （對案方＝target）支付：AI 對案調整的每回合金額夾進 NPC 資源上限。
      let npcPerTurnCaps: NpcTreatyCaps | null = null;
      if (isCustom && !fresh.proposerIsPayer) {
        const [npc] = await tx
          .select()
          .from(playerNationsTable)
          .where(eq(playerNationsTable.id, fresh.targetNationId))
          .limit(1);
        if (npc?.isNpc) {
          npcPerTurnCaps = await loadNpcTreatyCaps(npc);
        }
      }
      const clampPerTurn = (value: number, cap: number | undefined): number =>
        cap === undefined ? value : Math.min(value, cap);
      // Task #376 — NPC 對案的領土索求：AI 以地區名稱指定，這裡做
      // 名稱 → id 對映＋掌控與百分比驗證，通過才併入 offer 側；
      // 驗證不過（AI 幻覺／越界）→ 丟棄領土索求、保留金錢／科技對案。
      let offerRegionIds = fresh.offerRegionIds;
      let offerRegionPercents = fresh.offerRegionPercents;
      const demands = counter.demandRegions ?? [];
      if (demands.length > 0) {
        const [regions, proposerControls] = await Promise.all([
          tx
            .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
            .from(mapRegionsTable),
          tx
            .select({
              regionId: regionControlsTable.regionId,
              percent: regionControlsTable.percent,
            })
            .from(regionControlsTable)
            .where(eq(regionControlsTable.nationId, fresh.proposerNationId)),
        ]);
        const regionIdByName = new Map<string, number>();
        for (const r of regions) {
          if (r.name) regionIdByName.set(r.name.trim(), r.id);
        }
        const merged = mergeNpcCounterDemandRegions({
          demands,
          regionIdByName,
          proposerHeld: new Map(
            proposerControls.map((r) => [r.regionId, r.percent]),
          ),
          existingOfferIds: fresh.offerRegionIds,
          existingOfferPercents: fresh.offerRegionPercents,
        });
        if (merged.ok) {
          offerRegionIds = merged.offerRegionIds;
          offerRegionPercents = merged.offerRegionPercents;
        } else {
          logger.warn(
            { treatyId, error: merged.error },
            "npc counter region demand dropped (invalid)",
          );
        }
      }
      // Task #374 — 雙向語意下的對案：保留原提案雙側條件；NPC 追加的
      // demandMoney/demandTechPoints/demandRegions 是「要求提案方多付」，
      // 直接疊到 offer 側（offer 一律由提案方付出，proposerIsPayer 只管
      // 自訂條約每回合方向）。
      await tx.insert(diplomacyTreatiesTable).values({
        proposerNationId: fresh.proposerNationId,
        targetNationId: fresh.targetNationId,
        type: fresh.type,
        durationDays: counter.durationDays,
        offerMoney: fresh.offerMoney + counter.demandMoney,
        offerTechPoints: fresh.offerTechPoints + counter.demandTechPoints,
        // Task #476 — 一次性木材／礦石照原提案帶入（NPC 對案不調整此兩項）。
        offerWood: fresh.offerWood,
        offerOre: fresh.offerOre,
        offerRegionIds,
        offerRegionPercents,
        requestMoney: fresh.requestMoney,
        requestTechPoints: fresh.requestTechPoints,
        requestWood: fresh.requestWood,
        requestOre: fresh.requestOre,
        requestRegionIds: fresh.requestRegionIds,
        requestRegionPercents: fresh.requestRegionPercents,
        customClause: isCustom ? fresh.customClause : null,
        perTurnMoney: isCustom
          ? clampPerTurn(
              counter.perTurnMoney ?? fresh.perTurnMoney,
              npcPerTurnCaps?.perTurnMoney,
            )
          : 0,
        perTurnTech: isCustom
          ? clampPerTurn(
              counter.perTurnTech ?? fresh.perTurnTech,
              npcPerTurnCaps?.perTurnTech,
            )
          : 0,
        perTurnProduction: isCustom
          ? clampPerTurn(
              counter.perTurnProduction ?? fresh.perTurnProduction,
              npcPerTurnCaps?.perTurnProduction,
            )
          : 0,
        perTurnFood: isCustom
          ? clampPerTurn(
              counter.perTurnFood ?? fresh.perTurnFood,
              npcPerTurnCaps?.perTurnFood,
            )
          : 0,
        // Task #476 — 每回合木材／礦石（庫存制）：對案可調整，未給則沿用原提案。
        perTurnWood: isCustom
          ? clampPerTurn(
              counter.perTurnWood ?? fresh.perTurnWood,
              npcPerTurnCaps?.perTurnWood,
            )
          : 0,
        perTurnOre: isCustom
          ? clampPerTurn(
              counter.perTurnOre ?? fresh.perTurnOre,
              npcPerTurnCaps?.perTurnOre,
            )
          : 0,
        // Task #527 — 反向每回合定期支付：對案照原提案帶入（NPC 對案不調整
        // 反向側；方向語義 requestPerTurn* 一律由 perTurn 付款方的對方支付）。
        requestPerTurnMoney: isCustom ? fresh.requestPerTurnMoney : 0,
        requestPerTurnTech: isCustom ? fresh.requestPerTurnTech : 0,
        requestPerTurnProduction: isCustom ? fresh.requestPerTurnProduction : 0,
        requestPerTurnFood: isCustom ? fresh.requestPerTurnFood : 0,
        requestPerTurnWood: isCustom ? fresh.requestPerTurnWood : 0,
        requestPerTurnOre: isCustom ? fresh.requestPerTurnOre : 0,
        proposerIsPayer: fresh.proposerIsPayer,
        // 附庸條約對案：貢金比例與方向照原提案帶入（NPC 對案只調金錢／科技／領土）。
        tributePct: fresh.tributePct,
        proposerIsVassal: fresh.proposerIsVassal,
        status: "proposed",
        awaitingNationId: fresh.proposerNationId,
        counterOfTreatyId: fresh.id,
        responseNote: decision.note,
      });
      return superseded;
    });
  } catch (err) {
    // Task #67 — 極端時序下（對案寫入前，同一 pair 又出現一筆 proposed），
    // 部分唯一索引擋下對案列 → 整筆交易 rollback（原提案維持 proposed），
    // 以乾淨的 409 回覆而非 500。
    if (pgErrorCode(err) === "23505") {
      throw new HttpError(409, "與該國已有待回覆的條約提案，請先處理");
    }
    throw err;
  }
}

async function lockProposedTreaty(
  tx: DbTransaction,
  treatyId: number,
): Promise<DiplomacyTreaty> {
  const [fresh] = await tx
    .select()
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.id, treatyId))
    .for("update");
  if (!fresh) throw new HttpError(404, "找不到這個條約");
  if (fresh.status !== "proposed") {
    throw new HttpError(409, "條約狀態已變更，請重新整理");
  }
  return fresh;
}
