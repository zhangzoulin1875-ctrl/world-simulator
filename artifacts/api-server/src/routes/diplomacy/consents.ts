import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  vassalConsentRequestsTable,
} from "@workspace/db";
import { vassalConsentActionLabel } from "../../lib/vassalConsent";
import { notifyVassalConsentDecided } from "../../lib/diplomacyNotify";
import { requirePlayer } from "./shared";

/**
 * 附庸外交同意請求的檢視與審核（附庸條約：附庸宣戰／聯盟行動需宗主同意）。
 * - GET  /diplomacy/vassal-consents            我方相關的請求（宗主視角待審＋附庸視角近況）
 * - POST /diplomacy/vassal-consents/:id/respond 宗主批准／拒絕（conditional UPDATE，race-safe）
 */
const router: IRouter = Router();

router.get("/diplomacy/vassal-consents", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const myId = player.nation.id;

  const [incoming, outgoing] = await Promise.all([
    // 宗主視角：待我批准的請求。
    db
      .select({
        id: vassalConsentRequestsTable.id,
        vassalNationId: vassalConsentRequestsTable.vassalNationId,
        vassalName: playerNationsTable.name,
        actionType: vassalConsentRequestsTable.actionType,
        subjectName: vassalConsentRequestsTable.subjectName,
        createdAt: vassalConsentRequestsTable.createdAt,
      })
      .from(vassalConsentRequestsTable)
      .innerJoin(
        playerNationsTable,
        eq(vassalConsentRequestsTable.vassalNationId, playerNationsTable.id),
      )
      .where(
        and(
          eq(vassalConsentRequestsTable.suzerainNationId, myId),
          eq(vassalConsentRequestsTable.status, "pending"),
        ),
      )
      .orderBy(desc(vassalConsentRequestsTable.id)),
    // 附庸視角：我送出的請求近況（最新 10 筆）。
    db
      .select({
        id: vassalConsentRequestsTable.id,
        suzerainNationId: vassalConsentRequestsTable.suzerainNationId,
        suzerainName: playerNationsTable.name,
        actionType: vassalConsentRequestsTable.actionType,
        subjectName: vassalConsentRequestsTable.subjectName,
        status: vassalConsentRequestsTable.status,
        createdAt: vassalConsentRequestsTable.createdAt,
        decidedAt: vassalConsentRequestsTable.decidedAt,
      })
      .from(vassalConsentRequestsTable)
      .innerJoin(
        playerNationsTable,
        eq(vassalConsentRequestsTable.suzerainNationId, playerNationsTable.id),
      )
      .where(eq(vassalConsentRequestsTable.vassalNationId, myId))
      .orderBy(desc(vassalConsentRequestsTable.id))
      .limit(10),
  ]);

  res.json({
    incoming: incoming.map((r) => ({
      id: r.id,
      vassalNationId: r.vassalNationId,
      vassalName: r.vassalName ?? "（未命名）",
      actionType: r.actionType,
      actionLabel: vassalConsentActionLabel(r.actionType),
      subjectName: r.subjectName,
      createdAt: r.createdAt.toISOString(),
    })),
    outgoing: outgoing.map((r) => ({
      id: r.id,
      suzerainNationId: r.suzerainNationId,
      suzerainName: r.suzerainName ?? "（未命名）",
      actionType: r.actionType,
      actionLabel: vassalConsentActionLabel(r.actionType),
      subjectName: r.subjectName,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    })),
  });
});

router.post("/diplomacy/vassal-consents/:id/respond", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId)) {
    res.status(400).json({ error: "請求 id 不正確" });
    return;
  }
  const approve = (req.body ?? {}).approve === true;

  // conditional UPDATE：只有目前宗主本人能決定、且僅限 pending（重複點擊乾淨 404）。
  const [updated] = await db
    .update(vassalConsentRequestsTable)
    .set({ status: approve ? "approved" : "denied", decidedAt: new Date() })
    .where(
      and(
        eq(vassalConsentRequestsTable.id, requestId),
        eq(vassalConsentRequestsTable.suzerainNationId, player.nation.id),
        eq(vassalConsentRequestsTable.status, "pending"),
      ),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "找不到待審核的請求（可能已被處理）" });
    return;
  }

  // 通知附庸玩家（NPC／無帳號 → fireNotify 自動略過）。
  const [vassal] = await db
    .select({ discordUserId: playerNationsTable.discordUserId })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, updated.vassalNationId))
    .limit(1);
  notifyVassalConsentDecided({
    vassalDiscordUserId: vassal?.discordUserId ?? null,
    suzerainNationName: player.nation.name,
    actionLabel: vassalConsentActionLabel(updated.actionType),
    subjectName: updated.subjectName,
    approved: approve,
  });

  req.log.info(
    { requestId, approve, suzerainNationId: player.nation.id },
    "vassal consent decided",
  );
  res.json({ ok: true, approved: approve });
});

export default router;
