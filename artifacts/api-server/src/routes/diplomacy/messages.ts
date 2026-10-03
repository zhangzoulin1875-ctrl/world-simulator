import { Router, type IRouter } from "express";
import {
  and,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  db,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  diplomacyRelationsTable,
  diplomacyRelationEventsTable,
  diplomacyAiChatQuotasTable,
  diplomacyMessagesTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  worldGameStateTable,
} from "@workspace/db";
import {
  AI_CHAT_TURN_CAP,
  canonicalPair,
  clampChatTalkRelationDelta,
  clampRelationScore,
} from "../../lib/diplomacy";
import { AiQuotaExceededError } from "../../lib/gameAi";
import {
  decideNpcChatReply,
  type ChatActionTargetSummary,
} from "../../lib/diplomacyAi";
import { buildNationGeoCultureContext } from "../../lib/nationGeoCulture";
import {
  sanitizeChatActions,
  chatActionLabel,
  type ChatActionCandidate,
} from "../../lib/npcChatActions";
import { executeNpcChatActions } from "../../lib/npcChatActionExecutor";
import { recordNpcChatGuardEventInBackground } from "../../lib/npcChatGuardLog";
import { ensurePoliticalNote } from "../../lib/politicalNote";
import { getAiJudgmentDirective } from "../../lib/aiDirective";
import { notifyDiplomacyMessage } from "../../lib/diplomacyNotify";
import { requirePlayer, loadNationOr404 } from "./shared";

const router: IRouter = Router();

// ── 通訊（玩家聊天） ───────────────────────────────────────────

router.get("/diplomacy/messages/:nationId", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const other = await loadNationOr404(res, String(req.params.nationId));
  if (!other) return;
  if (other.id === player.nation.id) {
    res.status(400).json({ error: "不能與自己對話" });
    return;
  }

  const myId = player.nation.id;
  const rows = await db
    .select()
    .from(diplomacyMessagesTable)
    .where(
      or(
        and(
          eq(diplomacyMessagesTable.senderNationId, myId),
          eq(diplomacyMessagesTable.recipientNationId, other.id),
        ),
        and(
          eq(diplomacyMessagesTable.senderNationId, other.id),
          eq(diplomacyMessagesTable.recipientNationId, myId),
        ),
      ),
    )
    .orderBy(desc(diplomacyMessagesTable.id))
    .limit(200);
  rows.reverse();

  // 讀取即標記已讀（對方寄給我的未讀訊息）。
  await db
    .update(diplomacyMessagesTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(diplomacyMessagesTable.senderNationId, other.id),
        eq(diplomacyMessagesTable.recipientNationId, myId),
        isNull(diplomacyMessagesTable.readAt),
      ),
    );

  res.json({
    messages: rows.map((m) => ({
      id: m.id,
      fromMe: m.senderNationId === myId,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

router.post("/diplomacy/messages/:nationId", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const other = await loadNationOr404(res, String(req.params.nationId));
  if (!other) return;
  if (other.id === player.nation.id) {
    res.status(400).json({ error: "不能傳訊息給自己" });
    return;
  }
  // Task #228 — 可對話對象：玩家國家或 NPC 國家。無主國家（非 NPC 且無玩家）不可對話。
  if (!other.isNpc && other.discordUserId === null) {
    res.status(400).json({ error: "只能與玩家或 NPC 國家通訊" });
    return;
  }

  const body = (req.body ?? {}).body;
  if (typeof body !== "string" || body.trim() === "") {
    res.status(400).json({ error: "訊息內容不可為空" });
    return;
  }
  if (body.length > 2000) {
    res.status(400).json({ error: "訊息長度不可超過 2000 字" });
    return;
  }
  const trimmedBody = body.trim();
  const myId = player.nation.id;

  // ── 與 NPC 對話：AI 產生回覆並判定關係值增減（每回合每位玩家上限 5 則） ──
  if (other.isNpc) {
    // 目前回合日期（world_game_state.game_date）作為每回合額度識別。
    const [gs] = await db
      .select({
        turnDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
        chatActionLevel: worldGameStateTable.npcChatActionLevel,
      })
      .from(worldGameStateTable)
      .where(eq(worldGameStateTable.id, 1))
      .limit(1);
    const turnDate = gs?.turnDate ?? "";
    const chatActionLevel = gs?.chatActionLevel ?? 3;

    // 原子佔用額度：INSERT ... ON CONFLICT DO UPDATE ... WHERE used_count < cap，
    // 併發時只有未達上限者能取得新的 used_count；達上限則回 0 列 → 400。
    const claimed = await db
      .insert(diplomacyAiChatQuotasTable)
      .values({ nationId: myId, turnDate, usedCount: 1 })
      .onConflictDoUpdate({
        target: [
          diplomacyAiChatQuotasTable.nationId,
          diplomacyAiChatQuotasTable.turnDate,
        ],
        set: {
          usedCount: sql`${diplomacyAiChatQuotasTable.usedCount} + 1`,
          updatedAt: new Date(),
        },
        setWhere: sql`${diplomacyAiChatQuotasTable.usedCount} < ${AI_CHAT_TURN_CAP}`,
      })
      .returning({ usedCount: diplomacyAiChatQuotasTable.usedCount });
    if (claimed.length === 0) {
      res.status(400).json({
        error: `本回合與 NPC 的對話次數已用完（每回合上限 ${AI_CHAT_TURN_CAP} 則），下回合可再對話`,
      });
      return;
    }
    const usedCount = claimed[0]!.usedCount;

    // 近期對話（新→舊，截斷）作為 AI 前後一致的脈絡。
    const recent = await db
      .select({
        senderNationId: diplomacyMessagesTable.senderNationId,
        body: diplomacyMessagesTable.body,
      })
      .from(diplomacyMessagesTable)
      .where(
        or(
          and(
            eq(diplomacyMessagesTable.senderNationId, myId),
            eq(diplomacyMessagesTable.recipientNationId, other.id),
          ),
          and(
            eq(diplomacyMessagesTable.senderNationId, other.id),
            eq(diplomacyMessagesTable.recipientNationId, myId),
          ),
        ),
      )
      .orderBy(desc(diplomacyMessagesTable.id))
      .limit(8);
    const recentMessages = recent.map((m) => ({
      fromPlayer: m.senderNationId === myId,
      body: m.body,
    }));

    const { low, high } = canonicalPair(myId, other.id);
    const [[relation], [war]] = await Promise.all([
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
        .select({ id: diplomacyWarsTable.id })
        .from(diplomacyWarsTable)
        .where(
          and(
            eq(diplomacyWarsTable.nationAId, low),
            eq(diplomacyWarsTable.nationBId, high),
            isNull(diplomacyWarsTable.endedAt),
          ),
        )
        .limit(1),
    ]);

    const npcPoliticalNote = await ensurePoliticalNote(other, {
      allowNpc: true,
    });
    const adminDirective = await getAiJudgmentDirective();

    // ── Task #256：可行動目標與自身資源快照（供 NPC 於對話中即時決策） ──
    const actorId = other.id;
    // 候選目標：真人玩家（有 Discord 帳號）與其他 NPC，排除自己與無主國家。
    const candidateRows = await db
      .select({
        id: playerNationsTable.id,
        name: playerNationsTable.name,
        isNpc: playerNationsTable.isNpc,
      })
      .from(playerNationsTable)
      .where(
        and(
          ne(playerNationsTable.id, actorId),
          or(
            isNotNull(playerNationsTable.discordUserId),
            eq(playerNationsTable.isNpc, true),
          ),
        ),
      );

    const [relRows, warRows, pendingRows, actorRegions, counterpartRegions] =
      await Promise.all([
      db
        .select({
          a: diplomacyRelationsTable.nationAId,
          b: diplomacyRelationsTable.nationBId,
          score: diplomacyRelationsTable.score,
        })
        .from(diplomacyRelationsTable)
        .where(
          or(
            eq(diplomacyRelationsTable.nationAId, actorId),
            eq(diplomacyRelationsTable.nationBId, actorId),
          ),
        ),
      db
        .select({
          a: diplomacyWarsTable.nationAId,
          b: diplomacyWarsTable.nationBId,
        })
        .from(diplomacyWarsTable)
        .where(
          and(
            or(
              eq(diplomacyWarsTable.nationAId, actorId),
              eq(diplomacyWarsTable.nationBId, actorId),
            ),
            isNull(diplomacyWarsTable.endedAt),
          ),
        ),
      db
        .select({
          proposer: diplomacyTreatiesTable.proposerNationId,
          target: diplomacyTreatiesTable.targetNationId,
        })
        .from(diplomacyTreatiesTable)
        .where(
          and(
            eq(diplomacyTreatiesTable.status, "proposed"),
            or(
              eq(diplomacyTreatiesTable.proposerNationId, actorId),
              eq(diplomacyTreatiesTable.targetNationId, actorId),
            ),
          ),
        ),
      db
        .select({
          id: regionControlsTable.regionId,
          name: mapRegionsTable.name,
        })
        .from(regionControlsTable)
        .innerJoin(
          mapRegionsTable,
          eq(mapRegionsTable.id, regionControlsTable.regionId),
        )
        .where(
          and(
            eq(regionControlsTable.nationId, actorId),
            gt(regionControlsTable.percent, 0),
          ),
        )
        .limit(30),
      // Task #341 — 對話玩家（counterpart）目前掌控的地區與百分比，
      // 供附條件停戰索求割地時夾限（只能索求對方實際持有的份額）。
      db
        .select({
          regionId: regionControlsTable.regionId,
          percent: regionControlsTable.percent,
        })
        .from(regionControlsTable)
        .where(
          and(
            eq(regionControlsTable.nationId, myId),
            gt(regionControlsTable.percent, 0),
          ),
        ),
    ]);
    const counterpartRegionPercents = new Map<number, number>();
    for (const r of counterpartRegions) {
      counterpartRegionPercents.set(r.regionId, r.percent);
    }

    const scoreByOther = new Map<string, number>();
    for (const r of relRows) {
      scoreByOther.set(r.a === actorId ? r.b : r.a, r.score);
    }
    const atWarWith = new Set<string>();
    for (const w of warRows) atWarWith.add(w.a === actorId ? w.b : w.a);
    const pendingWith = new Set<string>();
    for (const p of pendingRows) {
      pendingWith.add(p.proposer === actorId ? p.target : p.proposer);
    }

    // 對話對象優先，其次交戰中，再依關係絕對值排序；限制傳給 AI 的候選數量。
    const CHAT_ACTION_MAX_CANDIDATES = 24;
    const sortedCandidates = candidateRows.slice().sort((x, y) => {
      const xc = x.id === myId ? 1 : 0;
      const yc = y.id === myId ? 1 : 0;
      if (xc !== yc) return yc - xc;
      const xw = atWarWith.has(x.id) ? 1 : 0;
      const yw = atWarWith.has(y.id) ? 1 : 0;
      if (xw !== yw) return yw - xw;
      return (
        Math.abs(scoreByOther.get(y.id) ?? 0) -
        Math.abs(scoreByOther.get(x.id) ?? 0)
      );
    });
    const candidatesMap = new Map<string, ChatActionCandidate>();
    const actionTargets: ChatActionTargetSummary[] = [];
    for (const c of sortedCandidates.slice(0, CHAT_ACTION_MAX_CANDIDATES)) {
      const cand: ChatActionCandidate = {
        kind: c.isNpc ? "npc" : "player",
        relationScore: scoreByOther.get(c.id) ?? 0,
        atWar: atWarWith.has(c.id),
        hasPendingProposal: pendingWith.has(c.id),
      };
      candidatesMap.set(c.id, cand);
      actionTargets.push({
        id: c.id,
        name: c.name,
        kind: cand.kind,
        relationScore: cand.relationScore,
        atWar: cand.atWar,
        hasPendingProposal: cand.hasPendingProposal,
        isCounterpart: c.id === myId,
      });
    }
    const actorResources = {
      money: other.money,
      techPoints: other.techPoints,
      regions: actorRegions.map((r) => ({ id: r.id, name: r.name })),
    };

    // Task #369 — 讓 NPC 回覆用語貼合對話對方（玩家國家）所在地區文化。
    const counterpartGeoContext = await buildNationGeoCultureContext(
      player.nation.id,
    );

    let reply;
    try {
      reply = await decideNpcChatReply({
        npcName: other.name ?? "NPC",
        playerName: player.nation.name ?? "（未命名）",
        playerMessage: trimmedBody,
        relationScore: relation?.score ?? 0,
        atWar: war !== undefined,
        recentMessages,
        politicalNote: npcPoliticalNote,
        diplomaticAttitude: other.diplomaticAttitude,
        adminDirective,
        counterpartGeoContext,
        actionTargets,
        resources: actorResources,
        actionLevel: chatActionLevel,
      });
    } catch (err) {
      // AI 失敗：退還本次額度（不扣次數），回 502 讓玩家可重試。
      await db
        .update(diplomacyAiChatQuotasTable)
        .set({
          usedCount: sql`GREATEST(${diplomacyAiChatQuotasTable.usedCount} - 1, 0)`,
        })
        .where(
          and(
            eq(diplomacyAiChatQuotasTable.nationId, myId),
            eq(diplomacyAiChatQuotasTable.turnDate, turnDate),
          ),
        );
      if (err instanceof AiQuotaExceededError) {
        // Task #593 — NPC 對話今日 token 配額用罄（對話額度已退還）→ 503。
        res.status(503).json({ error: err.message });
        return;
      }
      req.log.error({ err, npcId: other.id }, "NPC chat AI failed");
      res.status(502).json({ error: "NPC 對話回覆失敗，請再試一次" });
      return;
    }

    // Task #499 — 純對話的正向關係值伺服器端硬性封頂（嘴甜洗不出高關係值；
    // 真實利益轉移的行動各有自己的關係事件），負向照舊。
    const delta = clampChatTalkRelationDelta(reply.relationDelta);

    // ── Task #256：淨化並即時執行 NPC 於對話中決定採取的動作 ──
    const plannedActions = sanitizeChatActions(
      reply.actions ?? [],
      {
        actorId,
        counterpartId: myId,
        candidates: candidatesMap,
        npcMoney: other.money,
        npcTechPoints: other.techPoints,
        npcRegionIds: new Set(actorRegions.map((r) => r.id)),
        counterpartMoney: player.nation.money,
        counterpartTechPoints: player.nation.techPoints,
        counterpartRegionPercents,
        level: chatActionLevel,
      },
      // Task #499 — 讓利動作被反操縱守門剔除時記 log，觀察玩家操縱嘗試。
      // Task #501 — 同時持久化到 npc_chat_guard_events（fire-and-forget），
      // 讓管理員可在 /world-sim 後台檢視操縱嘗試紀錄。
      (rejection) => {
        req.log.warn(
          { npcId: other.id, playerNationId: myId, ...rejection },
          "npc chat concession action blocked by anti-manipulation guard",
        );
        recordNpcChatGuardEventInBackground({
          playerNationId: myId,
          npcNationId: other.id,
          playerName: player.nation.name ?? "（未命名）",
          npcName: other.name ?? "（未命名）",
          actionType: rejection.type,
          reason: rejection.reason,
        });
      },
    );
    let executedActions: Awaited<ReturnType<typeof executeNpcChatActions>> = [];
    if (plannedActions.length > 0) {
      try {
        executedActions = await executeNpcChatActions({
          actorId,
          counterpartId: myId,
          planned: plannedActions,
          adminDirective,
        });
      } catch (err) {
        req.log.error(
          { err, npcId: other.id },
          "npc chat actions execution failed",
        );
        executedActions = [];
      }
    }

    // 成功執行的動作以繁體中文摘要附加在 NPC 回覆末尾（對話歷史也看得到）。
    const okActions = executedActions.filter((a) => a.ok);
    const replyBody =
      okActions.length > 0
        ? `${reply.reply}\n\n〔本回合行動〕\n${okActions
            .map(
              (a) =>
                `・${chatActionLabel(a.type)}${
                  a.targetName ? `（${a.targetName}）` : ""
                }：${a.detail}`,
            )
            .join("\n")}`
        : reply.reply;

    const result = await db.transaction(async (tx) => {
      // 存玩家訊息與 NPC 回覆。
      const [playerRow] = await tx
        .insert(diplomacyMessagesTable)
        .values({
          senderNationId: myId,
          recipientNationId: other.id,
          body: trimmedBody,
        })
        .returning();
      const [npcRow] = await tx
        .insert(diplomacyMessagesTable)
        .values({
          senderNationId: other.id,
          recipientNationId: myId,
          body: replyBody,
          // NPC 回覆立即視為已讀（是即時對話，不需未讀提醒）。
          readAt: new Date(),
        })
        .returning();

      // 套用 AI 判定的關係值增減（與總分一起夾在 −100～100）。
      await tx
        .insert(diplomacyRelationsTable)
        .values({ nationAId: low, nationBId: high })
        .onConflictDoNothing();
      const [rel] = await tx
        .select()
        .from(diplomacyRelationsTable)
        .where(
          and(
            eq(diplomacyRelationsTable.nationAId, low),
            eq(diplomacyRelationsTable.nationBId, high),
          ),
        )
        .for("update");
      const newScore = clampRelationScore((rel?.score ?? 0) + delta);
      await tx
        .update(diplomacyRelationsTable)
        .set({ score: newScore })
        .where(
          and(
            eq(diplomacyRelationsTable.nationAId, low),
            eq(diplomacyRelationsTable.nationBId, high),
          ),
        );

      // 留下互動紀錄（供 NPC 判斷回顧）。
      await tx.insert(diplomacyRelationEventsTable).values({
        actorNationId: myId,
        targetNationId: other.id,
        action: "chat",
      });

      return { playerRow: playerRow!, npcRow: npcRow!, newScore };
    });

    res.json({
      id: result.playerRow.id,
      fromMe: true,
      body: result.playerRow.body,
      createdAt: result.playerRow.createdAt.toISOString(),
      npcReply: {
        id: result.npcRow.id,
        fromMe: false,
        body: result.npcRow.body,
        createdAt: result.npcRow.createdAt.toISOString(),
      },
      relationScore: result.newScore,
      relationDelta: delta,
      aiChatRemaining: Math.max(0, AI_CHAT_TURN_CAP - usedCount),
      aiChatCap: AI_CHAT_TURN_CAP,
      actions: executedActions,
    });
    return;
  }

  // ── 與玩家對話：一般私訊（無關係值判定） ──
  const [row] = await db
    .insert(diplomacyMessagesTable)
    .values({
      senderNationId: myId,
      recipientNationId: other.id,
      body: trimmedBody,
    })
    .returning();

  // Task #41 — 私訊通知對方玩家（fire-and-forget，失敗不影響回應）。
  notifyDiplomacyMessage({
    recipientDiscordUserId: other.discordUserId,
    senderNationId: myId,
    senderNationName: player.nation.name,
  });

  res.json({
    id: row!.id,
    fromMe: true,
    body: row!.body,
    createdAt: row!.createdAt.toISOString(),
  });
});

export default router;
