import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  diplomacyRelationsTable,
  diplomacyRelationEventsTable,
  diplomacyTreatiesTable,
} from "@workspace/db";
import {
  canonicalPair,
  clampRelationScore,
  isTreatyInEffect,
  TREATY_ANNUL_RELATION_PENALTY,
} from "../../lib/diplomacy";
import {
  notifyTreatyAnnulled,
  notifyTreatyResponse,
  notifyTreatyWithdrawn,
} from "../../lib/diplomacyNotify";
import { HttpError, activateTreaty } from "../../lib/treatyActivation";
import { invalidateGlobalAveragePopulationCache } from "../../lib/researchCost";
import { withdrawTreatyAsNation } from "../../lib/treatyWithdraw";
import { endCampaignsForWar } from "../../lib/warEngine";
import { requirePlayer } from "./shared";
import { serializeTreaty, loadTreatyContext } from "./treatyContext";

const router: IRouter = Router();

router.post("/diplomacy/treaties/:id/accept", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const treatyId = Number(req.params.id);
  if (!Number.isInteger(treatyId) || treatyId <= 0) {
    res.status(400).json({ error: "條約 id 不正確" });
    return;
  }

  try {
    const activated = await db.transaction(async (tx) => {
      const [treaty] = await tx
        .select()
        .from(diplomacyTreatiesTable)
        .where(eq(diplomacyTreatiesTable.id, treatyId))
        .for("update");
      if (!treaty) throw new HttpError(404, "找不到這個條約");
      if (treaty.status !== "proposed") {
        throw new HttpError(400, "這個條約已不在待回覆狀態");
      }
      if (treaty.awaitingNationId !== player.nation.id) {
        throw new HttpError(403, "這個條約目前不需要你回覆");
      }
      return activateTreaty(tx, treaty);
    });

    // Task #387 — 條約若含領土轉移，成立後全球平均生產力快取立即失效，
    // 避免玩家在 30 秒 TTL 內被舊平均計算的研發成本倍率扣點。
    if (
      activated.offerRegionIds.length > 0 ||
      activated.requestRegionIds.length > 0
    ) {
      invalidateGlobalAveragePopulationCache();
    }

    // Task #341 — 附條件停戰：條約綁定的戰爭已在 activateTreaty 內結束，
    // 交易提交後再收拾其戰役（endCampaignsForWar 使用 db 而非 tx），
    // 避免遺留仍在結算並鎖住地區的孤兒戰役（見 war-end-campaign-teardown）。
    if (activated.boundWarId !== null) {
      await endCampaignsForWar(activated.boundWarId, "ceasefire");
    }

    // Task #41 — 私訊通知提案方（fire-and-forget）。
    notifyTreatyResponse({
      treaty: activated,
      responderNationId: player.nation.id,
      responderNationName: player.nation.name,
      accepted: true,
    });

    const { nameById } = await loadTreatyContext(player.nation.id);
    req.log.info({ treatyId }, "treaty accepted");
    res.json({
      treaty: serializeTreaty(activated, nameById, player.nation.id),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

router.post("/diplomacy/treaties/:id/reject", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const treatyId = Number(req.params.id);
  if (!Number.isInteger(treatyId) || treatyId <= 0) {
    res.status(400).json({ error: "條約 id 不正確" });
    return;
  }

  const [updated] = await db
    .update(diplomacyTreatiesTable)
    .set({ status: "rejected", awaitingNationId: null })
    .where(
      and(
        eq(diplomacyTreatiesTable.id, treatyId),
        eq(diplomacyTreatiesTable.status, "proposed"),
        eq(diplomacyTreatiesTable.awaitingNationId, player.nation.id),
      ),
    )
    .returning();
  if (!updated) {
    res.status(400).json({ error: "找不到需要你回覆的這個條約" });
    return;
  }

  // Task #41 — 私訊通知提案方（fire-and-forget）。
  notifyTreatyResponse({
    treaty: updated,
    responderNationId: player.nation.id,
    responderNationName: player.nation.name,
    accepted: false,
  });

  const { nameById } = await loadTreatyContext(player.nation.id);
  req.log.info({ treatyId }, "treaty rejected");
  res.json({
    treaty: serializeTreaty(updated, nameById, player.nation.id),
  });
});

// Task #71 — 撤回自己送出的待回覆提案：不扣關係分數，讓 pair 解鎖。
router.post("/diplomacy/treaties/:id/withdraw", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const treatyId = Number(req.params.id);
  if (!Number.isInteger(treatyId) || treatyId <= 0) {
    res.status(400).json({ error: "條約 id 不正確" });
    return;
  }
  const myId = player.nation.id;

  try {
    const withdrawn = await withdrawTreatyAsNation(treatyId, myId);

    // 私訊通知對方提案已撤回（fire-and-forget）。
    notifyTreatyWithdrawn({
      treaty: withdrawn,
      withdrawerNationId: myId,
      withdrawerNationName: player.nation.name,
    });

    const { nameById } = await loadTreatyContext(myId);
    req.log.info({ treatyId }, "treaty withdrawn");
    res.json({
      treaty: serializeTreaty(withdrawn, nameById, myId),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

// Task #49 — 廢除生效中條約：僅條約當事國可操作，關係值大幅下降。
router.post("/diplomacy/treaties/:id/annul", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const treatyId = Number(req.params.id);
  if (!Number.isInteger(treatyId) || treatyId <= 0) {
    res.status(400).json({ error: "條約 id 不正確" });
    return;
  }
  const myId = player.nation.id;

  try {
    const annulled = await db.transaction(async (tx) => {
      const [treaty] = await tx
        .select()
        .from(diplomacyTreatiesTable)
        .where(eq(diplomacyTreatiesTable.id, treatyId))
        .for("update");
      if (!treaty) throw new HttpError(404, "找不到這個條約");
      if (treaty.proposerNationId !== myId && treaty.targetNationId !== myId) {
        throw new HttpError(403, "你不是這份條約的當事國");
      }
      if (!isTreatyInEffect(treaty)) {
        throw new HttpError(400, "這份條約目前不在生效中，無法廢除");
      }
      const [updated] = await tx
        .update(diplomacyTreatiesTable)
        .set({ status: "annulled", updatedAt: new Date() })
        .where(eq(diplomacyTreatiesTable.id, treaty.id))
        .returning();

      // 廢約代價：關係值 −TREATY_ANNUL_RELATION_PENALTY（夾限 −100）。
      const otherId =
        treaty.proposerNationId === myId
          ? treaty.targetNationId
          : treaty.proposerNationId;
      const { low, high } = canonicalPair(myId, otherId);
      await tx
        .insert(diplomacyRelationsTable)
        .values({ nationAId: low, nationBId: high })
        .onConflictDoNothing();
      const [relation] = await tx
        .select()
        .from(diplomacyRelationsTable)
        .where(
          and(
            eq(diplomacyRelationsTable.nationAId, low),
            eq(diplomacyRelationsTable.nationBId, high),
          ),
        )
        .for("update");
      if (!relation) throw new HttpError(500, "關係資料讀取失敗");
      await tx
        .update(diplomacyRelationsTable)
        .set({
          score: clampRelationScore(
            relation.score - TREATY_ANNUL_RELATION_PENALTY,
          ),
        })
        .where(eq(diplomacyRelationsTable.id, relation.id));

      // Task #110 — 廢約也留下互動紀錄，玩家才能對照關係值 −30 的來源。
      // 與扣分同一交易內寫入，且 treaty FOR UPDATE + isTreatyInEffect 已擋掉
      // 雙方同時廢約的重複結算，故這裡也只會寫入一筆。
      await tx.insert(diplomacyRelationEventsTable).values({
        actorNationId: myId,
        targetNationId: otherId,
        action: "annul_treaty",
      });

      return updated!;
    });

    // 私訊通知條約另一方（fire-and-forget）。
    notifyTreatyAnnulled({
      treaty: annulled,
      annullerNationId: myId,
      annullerNationName: player.nation.name,
    });

    const { nameById } = await loadTreatyContext(myId);
    req.log.info({ treatyId }, "treaty annulled");
    res.json({
      treaty: serializeTreaty(annulled, nameById, myId),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

export default router;
