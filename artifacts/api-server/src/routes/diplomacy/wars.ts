import { Router, type IRouter } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  diplomacyRelationsTable,
  diplomacyRelationEventsTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
} from "@workspace/db";
import {
  autoJoinNationIds,
  canonicalPair,
  findWarBlockingTreatyType,
  treatyTypeLabel,
} from "../../lib/diplomacy";
import { notifyWarDeclared } from "../../lib/diplomacyNotify";
import { nationsInSameAlliance } from "../../lib/alliances";
import { requireSuzerainConsent } from "../../lib/vassalConsent";
import { requirePlayer, loadNationOr404 } from "./shared";

const router: IRouter = Router();

// ── 宣戰 ───────────────────────────────────────────────────────

router.get("/diplomacy/wars", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;

  const [wars, nations] = await Promise.all([
    db
      .select()
      .from(diplomacyWarsTable)
      .where(isNull(diplomacyWarsTable.endedAt))
      .orderBy(desc(diplomacyWarsTable.id)),
    db
      .select({ id: playerNationsTable.id, name: playerNationsTable.name })
      .from(playerNationsTable),
  ]);
  const nameById = new Map<string, string>();
  for (const n of nations) nameById.set(n.id, n.name ?? "（未命名）");

  res.json({
    wars: wars.map((w) => {
      const involvesMe =
        w.nationAId === player.nation.id || w.nationBId === player.nation.id;
      return {
        id: w.id,
        nationAId: w.nationAId,
        nationAName: nameById.get(w.nationAId) ?? "（未知國家）",
        nationBId: w.nationBId,
        nationBName: nameById.get(w.nationBId) ?? "（未知國家）",
        declaredByNationId: w.declaredByNationId,
        declaredByName: nameById.get(w.declaredByNationId) ?? "（未知國家）",
        involvesMe,
        ceasefireProposedByNationId: w.ceasefireProposedBy,
        ceasefireProposedByMe:
          involvesMe && w.ceasefireProposedBy === player.nation.id,
        createdAt: w.createdAt.toISOString(),
      };
    }),
  });
});

router.post("/diplomacy/wars", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const targetNationId = (req.body ?? {}).targetNationId;
  if (typeof targetNationId !== "string") {
    res.status(400).json({ error: "缺少對象國家" });
    return;
  }
  const target = await loadNationOr404(res, targetNationId);
  if (!target) return;
  if (target.id === player.nation.id) {
    res.status(400).json({ error: "不能對自己宣戰" });
    return;
  }

  const myId = player.nation.id;
  const { low, high } = canonicalPair(myId, target.id);

  const [[relation], activeTreaties] = await Promise.all([
    db
      .select({ score: diplomacyRelationsTable.score })
      .from(diplomacyRelationsTable)
      .where(
        and(
          eq(diplomacyRelationsTable.nationAId, low),
          eq(diplomacyRelationsTable.nationBId, high),
        ),
      )
      .limit(1),
    db
      .select({
        type: diplomacyTreatiesTable.type,
        proposerNationId: diplomacyTreatiesTable.proposerNationId,
        targetNationId: diplomacyTreatiesTable.targetNationId,
        status: diplomacyTreatiesTable.status,
        expiresAt: diplomacyTreatiesTable.expiresAt,
        // 附庸條約方向（宗主自動參戰需要）。
        proposerIsVassal: diplomacyTreatiesTable.proposerIsVassal,
      })
      .from(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.status, "active")),
  ]);
  // Task #228 — 對 NPC 宣戰仍需關係值 < 0；玩家↔玩家沒有關係值，可直接宣戰
  // （仍受下方互不侵犯／聯盟規則限制）。
  const score = relation?.score ?? 0;
  if (target.isNpc && score >= 0) {
    res.status(400).json({
      error: `與 NPC 的關係值必須低於 0 才能宣戰（目前為 ${score}）`,
    });
    return;
  }

  // 條約規則（Task #40）：生效中的互不侵犯條約擋下宣戰。
  const blocking = findWarBlockingTreatyType(activeTreaties, myId, target.id);
  if (blocking !== null) {
    res.status(400).json({
      error: `與該國的${treatyTypeLabel(blocking)}仍在生效中，無法宣戰（條約到期或失效後解除限制）`,
    });
    return;
  }

  // 聯盟規則（Task #215）：同屬一個聯盟的成員不可互相宣戰。
  if (await nationsInSameAlliance(myId, target.id)) {
    res.status(400).json({
      error: "與該國同屬一個聯盟，無法宣戰（需先退出聯盟）",
    });
    return;
  }

  // 附庸外交受限：附庸宣戰需宗主同意（NPC 宗主即時判定／真人宗主待審）。
  const consent = await requireSuzerainConsent({
    vassalNationId: myId,
    vassalName: player.nation.name,
    actionType: "declare_war",
    targetNationId: target.id,
    subjectName: target.name,
    activeTreaties,
  });
  if (!consent.ok) {
    res.status(consent.status).json({ error: consent.error });
    return;
  }

  const inserted = await db
    .insert(diplomacyWarsTable)
    .values({
      nationAId: low,
      nationBId: high,
      declaredByNationId: myId,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    res.status(409).json({ error: "與該國已處於交戰狀態" });
    return;
  }

  // Task #110 — 宣戰也留下互動紀錄，讓玩家在互動時間軸看到關係惡化的來源。
  // 宣戰本身不改分數（delta=0），但仍是重要的關係事件。
  await db.insert(diplomacyRelationEventsTable).values({
    actorNationId: myId,
    targetNationId: target.id,
    action: "declare_war",
  });

  // 自動參戰（Task #40）：被宣戰方的同盟／保障獨立夥伴自動對宣戰方進入交戰。
  const joinerIds = autoJoinNationIds(activeTreaties, target.id, myId);
  const autoJoined: { nationId: string; name: string }[] = [];
  if (joinerIds.length > 0) {
    const joinerNations = await db
      .select({
        id: playerNationsTable.id,
        name: playerNationsTable.name,
      })
      .from(playerNationsTable)
      .where(inArray(playerNationsTable.id, joinerIds));
    for (const joiner of joinerNations) {
      const pair = canonicalPair(joiner.id, myId);
      const joined = await db
        .insert(diplomacyWarsTable)
        .values({
          nationAId: pair.low,
          nationBId: pair.high,
          declaredByNationId: joiner.id,
        })
        .onConflictDoNothing()
        .returning({ id: diplomacyWarsTable.id });
      if (joined.length > 0) {
        autoJoined.push({
          nationId: joiner.id,
          name: joiner.name ?? "（未命名）",
        });
        req.log.info(
          { warId: joined[0]!.id, joinerNationId: joiner.id },
          "ally auto-joined war",
        );
      }
    }
  }

  req.log.info(
    { warId: inserted[0]!.id, targetNationId: target.id },
    "war declared",
  );

  // Task #41 — 私訊通知被宣戰的玩家（fire-and-forget）。
  notifyWarDeclared({
    targetDiscordUserId: target.discordUserId,
    declarerNationName: player.nation.name,
  });
  res.json({
    id: inserted[0]!.id,
    targetNationId: target.id,
    targetName: target.name ?? "（未命名）",
    createdAt: inserted[0]!.createdAt.toISOString(),
    autoJoined,
  });
});

export default router;
