import { Router, type IRouter } from "express";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  regionControlsTable,
  mapRegionAdjacenciesTable,
  userSessionsTable,
  diplomacyRelationsTable,
  diplomacyWarsTable,
  diplomacyMessagesTable,
  diplomacyAiChatQuotasTable,
  worldGameStateTable,
  type DiplomacyRelation,
} from "@workspace/db";
import {
  AI_CHAT_TURN_CAP,
  bfsRegionDistances,
  compareByDistance,
  nationDistance,
} from "../../lib/diplomacy";
import { requirePlayer } from "./shared";

const router: IRouter = Router();

// ── 國家目錄（距離排序＋搜尋） ─────────────────────────────────

router.get("/diplomacy/nations", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const myId = player.nation.id;

  const q =
    typeof req.query["q"] === "string" ? req.query["q"].trim() : "";

  const [
    nations,
    controls,
    adjacencies,
    relations,
    wars,
    unreadRows,
    conversedRows,
    gameStateRows,
  ] = await Promise.all([
      db
        .select({
          id: playerNationsTable.id,
          name: playerNationsTable.name,
          flagUrl: playerNationsTable.flagUrl,
          isNpc: playerNationsTable.isNpc,
          discordUserId: playerNationsTable.discordUserId,
        })
        .from(playerNationsTable)
        .orderBy(asc(playerNationsTable.createdAt)),
      db
        .select({
          regionId: regionControlsTable.regionId,
          nationId: regionControlsTable.nationId,
        })
        .from(regionControlsTable),
      db
        .select({
          regionId: mapRegionAdjacenciesTable.regionId,
          adjacentRegionId: mapRegionAdjacenciesTable.adjacentRegionId,
        })
        .from(mapRegionAdjacenciesTable),
      db
        .select()
        .from(diplomacyRelationsTable)
        .where(
          or(
            eq(diplomacyRelationsTable.nationAId, myId),
            eq(diplomacyRelationsTable.nationBId, myId),
          ),
        ),
      db
        .select()
        .from(diplomacyWarsTable)
        .where(
          and(
            isNull(diplomacyWarsTable.endedAt),
            or(
              eq(diplomacyWarsTable.nationAId, myId),
              eq(diplomacyWarsTable.nationBId, myId),
            ),
          ),
        ),
      db
        .select({
          senderNationId: diplomacyMessagesTable.senderNationId,
          count: sql<string>`COUNT(*)`,
        })
        .from(diplomacyMessagesTable)
        .where(
          and(
            eq(diplomacyMessagesTable.recipientNationId, myId),
            isNull(diplomacyMessagesTable.readAt),
          ),
        )
        .groupBy(diplomacyMessagesTable.senderNationId),
      db
        .selectDistinct({
          senderNationId: diplomacyMessagesTable.senderNationId,
          recipientNationId: diplomacyMessagesTable.recipientNationId,
        })
        .from(diplomacyMessagesTable)
        .where(
          or(
            eq(diplomacyMessagesTable.senderNationId, myId),
            eq(diplomacyMessagesTable.recipientNationId, myId),
          ),
        ),
      db
        .select({
          turnDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
        })
        .from(worldGameStateTable)
        .where(eq(worldGameStateTable.id, 1))
        .limit(1),
    ]);

  // Task #228 — 本回合已用掉的 AI（NPC）對話次數（所有 NPC 合計），
  // 供前端顯示剩餘可對話則數。
  const currentTurnDate = gameStateRows[0]?.turnDate ?? "";
  const [aiChatQuota] = await db
    .select({ usedCount: diplomacyAiChatQuotasTable.usedCount })
    .from(diplomacyAiChatQuotasTable)
    .where(
      and(
        eq(diplomacyAiChatQuotasTable.nationId, myId),
        eq(diplomacyAiChatQuotasTable.turnDate, currentTurnDate),
      ),
    )
    .limit(1);
  const aiChatRemaining = Math.max(
    0,
    AI_CHAT_TURN_CAP - (aiChatQuota?.usedCount ?? 0),
  );

  // 頭貼：每個 Discord 使用者取最新 session 的 avatar hash。
  const ownerIds = nations
    .map((n) => n.discordUserId)
    .filter((v): v is string => v !== null);
  const avatarByUser = new Map<string, string | null>();
  if (ownerIds.length > 0) {
    const sessionRows = await db
      .selectDistinctOn([userSessionsTable.discordUserId], {
        discordUserId: userSessionsTable.discordUserId,
        avatar: userSessionsTable.avatar,
      })
      .from(userSessionsTable)
      .orderBy(
        asc(userSessionsTable.discordUserId),
        desc(userSessionsTable.createdAt),
      );
    for (const row of sessionRows) {
      avatarByUser.set(row.discordUserId, row.avatar);
    }
  }

  // BFS 距離：從我的掌控地區出發。
  const adjacency = new Map<number, number[]>();
  for (const a of adjacencies) {
    const list = adjacency.get(a.regionId) ?? [];
    list.push(a.adjacentRegionId);
    adjacency.set(a.regionId, list);
  }
  const regionsByNation = new Map<string, number[]>();
  for (const c of controls) {
    const list = regionsByNation.get(c.nationId) ?? [];
    list.push(c.regionId);
    regionsByNation.set(c.nationId, list);
  }
  const distances = bfsRegionDistances(
    regionsByNation.get(myId) ?? [],
    adjacency,
  );

  const relationByOther = new Map<string, DiplomacyRelation>();
  for (const r of relations) {
    const other = r.nationAId === myId ? r.nationBId : r.nationAId;
    relationByOther.set(other, r);
  }
  const warByOther = new Set<string>();
  for (const w of wars) {
    warByOther.add(w.nationAId === myId ? w.nationBId : w.nationAId);
  }
  const unreadByOther = new Map<string, number>();
  for (const u of unreadRows) {
    unreadByOther.set(u.senderNationId, Number(u.count));
  }
  // Task #241 — 我與該國之間是否存在任何往來訊息（送出或收到皆算，不限已讀）。
  const conversedByOther = new Set<string>();
  for (const m of conversedRows) {
    conversedByOther.add(
      m.senderNationId === myId ? m.recipientNationId : m.senderNationId,
    );
  }

  const list = nations
    .filter((n) => n.id !== myId && n.name !== null && n.name.trim() !== "")
    .filter((n) => (q === "" ? true : n.name!.includes(q)))
    .map((n) => {
      const relation = relationByOther.get(n.id) ?? null;
      return {
        id: n.id,
        name: n.name!,
        flagUrl: n.flagUrl,
        isNpc: n.isNpc,
        ownerDiscordUserId: n.discordUserId,
        ownerAvatar: n.discordUserId
          ? (avatarByUser.get(n.discordUserId) ?? null)
          : null,
        // Task #228 — 只有 NPC 才有可顯示的關係值；玩家↔玩家不再有關係值。
        relationScore: n.isNpc ? (relation?.score ?? 0) : null,
        atWar: warByOther.has(n.id),
        unreadCount: unreadByOther.get(n.id) ?? 0,
        // Task #241 — 是否曾與該國往來訊息（供前端「已對話」篩選）。
        hasConversed: conversedByOther.has(n.id),
        distance: nationDistance(regionsByNation.get(n.id) ?? [], distances),
      };
    })
    .sort(compareByDistance);

  res.json({
    myNationId: myId,
    myMoney: player.nation.money,
    // Task #228 — 本回合與 NPC 的剩餘可對話次數（所有 NPC 合計）。
    aiChatRemaining,
    aiChatCap: AI_CHAT_TURN_CAP,
    nations: list,
  });
});

export default router;
