import { Router, type IRouter } from "express";
import { desc, eq, lt } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  diplomacyLobbyMessagesTable,
} from "@workspace/db";
import { isAdminRequest } from "../../middlewares/requireAdmin";
import { requirePlayer } from "./shared";

const router: IRouter = Router();

// ── 玩家大廳（所有玩家共用的群聊） ─────────────────────────────
// 大廳訊息刻意「不」觸發任何通知（不 DM、不寫鈴鐺、不算未讀），避免群聊
// 洗版式的通知轟炸。與一對一私訊並存，兩者互不影響。

const LOBBY_PAGE_SIZE = 200;

// 大廳為共用聊天室，需要每國發言冷卻擋洪水（私訊有明確收件者、天然分流，不套用）。
const LOBBY_POST_COOLDOWN_MS = 3_000;
const lobbyPostCooldownAt = new Map<string, number>();

function lobbyPostCooldownMessage(remainingMs: number): string {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return `發言太頻繁，請於 ${seconds} 秒後再試`;
}

/** 測試用：清掉大廳發言冷卻時間戳，避免整合測試連續張貼被冷卻擋下。 */
export function __resetLobbyPostCooldownForTests(): void {
  lobbyPostCooldownAt.clear();
}

router.get("/diplomacy/lobby/messages", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;
  const myId = player.nation.id;

  // 分頁游標：僅回傳 id < before 的較舊訊息；未帶 before 則回最新一頁。
  let before: number | null = null;
  if (req.query.before !== undefined) {
    const parsed = Number(req.query.before);
    if (!Number.isInteger(parsed) || parsed < 1) {
      res.status(400).json({ error: "before 游標無效" });
      return;
    }
    before = parsed;
  }

  // 多取一筆以判斷是否還有更舊的訊息（hasMore）。
  const rows = await db
    .select({
      id: diplomacyLobbyMessagesTable.id,
      senderNationId: diplomacyLobbyMessagesTable.senderNationId,
      senderNationName: playerNationsTable.name,
      body: diplomacyLobbyMessagesTable.body,
      createdAt: diplomacyLobbyMessagesTable.createdAt,
    })
    .from(diplomacyLobbyMessagesTable)
    .innerJoin(
      playerNationsTable,
      eq(diplomacyLobbyMessagesTable.senderNationId, playerNationsTable.id),
    )
    .where(
      before === null
        ? undefined
        : lt(diplomacyLobbyMessagesTable.id, before),
    )
    .orderBy(
      desc(diplomacyLobbyMessagesTable.createdAt),
      desc(diplomacyLobbyMessagesTable.id),
    )
    .limit(LOBBY_PAGE_SIZE + 1);

  const hasMore = rows.length > LOBBY_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, LOBBY_PAGE_SIZE) : rows;
  page.reverse();

  res.json({
    hasMore,
    messages: page.map((m) => ({
      id: m.id,
      senderNationId: m.senderNationId,
      senderNationName: m.senderNationName,
      fromMe: m.senderNationId === myId,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

router.post("/diplomacy/lobby/messages", async (req, res) => {
  const player = await requirePlayer(req, res);
  if (!player) return;

  const body = (req.body ?? {}).body;
  if (typeof body !== "string" || body.trim() === "") {
    res.status(400).json({ error: "訊息內容不可為空" });
    return;
  }
  if (body.length > 2000) {
    res.status(400).json({ error: "訊息長度不可超過 2000 字" });
    return;
  }

  // 大廳為所有玩家共用，單一玩家連續刷訊息會淹沒整個聊天室。
  // 以記憶體內每國冷卻擋洪水：在任何 await 之前同步認領時間戳，避免併發競態。
  const now = Date.now();
  const lastAt = lobbyPostCooldownAt.get(player.nation.id);
  if (lastAt !== undefined && now - lastAt < LOBBY_POST_COOLDOWN_MS) {
    const remainingMs = LOBBY_POST_COOLDOWN_MS - (now - lastAt);
    res.setHeader("Retry-After", String(Math.ceil(remainingMs / 1000)));
    res.status(429).json({ error: lobbyPostCooldownMessage(remainingMs) });
    return;
  }
  lobbyPostCooldownAt.set(player.nation.id, now);

  const [row] = await db
    .insert(diplomacyLobbyMessagesTable)
    .values({
      senderNationId: player.nation.id,
      body: body.trim(),
    })
    .returning();

  // 大廳發言絕不觸發任何通知（不 notifyDiplomacyMessage、不寫鈴鐺）。

  res.json({
    id: row!.id,
    senderNationId: player.nation.id,
    senderNationName: player.nation.name,
    fromMe: true,
    body: row!.body,
    createdAt: row!.createdAt.toISOString(),
  });
});

// 管理員刪除大廳訊息：硬刪除單一訊息，維持聊天室秩序。比照專案既有管理 API
// 慣例——以管理金鑰保護、前端 raw fetch、不納入 OpenAPI 規格。改用 isAdminRequest
// 內聯守門（而非共用 requireAdmin），以回傳繁體中文的未授權訊息。
router.delete(
  "/diplomacy/lobby/messages/:id",
  async (req, res) => {
    if (!isAdminRequest(req)) {
      res.status(403).json({ error: "需要管理員權限才能刪除大廳訊息" });
      return;
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: "訊息 id 無效" });
      return;
    }

    const [deleted] = await db
      .delete(diplomacyLobbyMessagesTable)
      .where(eq(diplomacyLobbyMessagesTable.id, id))
      .returning({ id: diplomacyLobbyMessagesTable.id });

    if (!deleted) {
      res.status(404).json({ error: "找不到該則大廳訊息" });
      return;
    }

    res.json({ id: deleted.id });
  },
);

export default router;
