import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db, accountBansTable, playerNationsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import { banAccount, unbanAccount } from "../lib/accountBans";

/**
 * 管理員封禁 Discord 登入帳號（不在 OpenAPI spec；以 ADMIN_TOKEN Bearer 驗證，
 * 前端 raw fetch）。封禁僅阻擋登入，不動該帳號的國家／資料。
 */
const router: IRouter = Router();

/** Discord snowflake：純數字，17–20 位；上限放寬到 32 以防未來變動。 */
function isValidDiscordId(value: string): boolean {
  return /^\d{1,32}$/.test(value);
}

interface KnownAccount {
  discordUserId: string;
  username: string | null;
  globalName: string | null;
  avatar: string | null;
  lastLoginAt: string | null;
  nationId: string | null;
  nationName: string | null;
}

router.get("/admin/account-bans", requireAdmin, async (_req, res) => {
  // 已封禁列（附帶其國家名稱，若有）。
  const bans = await db
    .select({
      discordUserId: accountBansTable.discordUserId,
      username: accountBansTable.username,
      reason: accountBansTable.reason,
      createdAt: accountBansTable.createdAt,
      nationName: playerNationsTable.name,
    })
    .from(accountBansTable)
    .leftJoin(
      playerNationsTable,
      eq(playerNationsTable.discordUserId, accountBansTable.discordUserId),
    )
    .orderBy(desc(accountBansTable.createdAt));

  const bannedIds = new Set(bans.map((b) => b.discordUserId));

  // 已知帳號 = 曾登入者（user_sessions 取每人最新一筆）∪ 國家擁有者
  //（player_nations discord_user_id NOT NULL、非 NPC），排除已封禁者。
  const sessionResult = await db.execute(sql`
    SELECT DISTINCT ON (discord_user_id)
      discord_user_id AS "discordUserId",
      username,
      global_name AS "globalName",
      avatar,
      created_at AS "lastLoginAt"
    FROM user_sessions
    ORDER BY discord_user_id, created_at DESC
  `);
  const sessionRows = sessionResult.rows as Array<{
    discordUserId: string;
    username: string | null;
    globalName: string | null;
    avatar: string | null;
    lastLoginAt: Date | string | null;
  }>;

  const owners = await db
    .select({
      discordUserId: playerNationsTable.discordUserId,
      nationId: playerNationsTable.id,
      nationName: playerNationsTable.name,
    })
    .from(playerNationsTable)
    .where(
      and(
        isNotNull(playerNationsTable.discordUserId),
        eq(playerNationsTable.isNpc, false),
      ),
    );

  const map = new Map<string, KnownAccount>();
  for (const s of sessionRows) {
    if (!s.discordUserId || bannedIds.has(s.discordUserId)) continue;
    map.set(s.discordUserId, {
      discordUserId: s.discordUserId,
      username: s.username,
      globalName: s.globalName,
      avatar: s.avatar,
      lastLoginAt: s.lastLoginAt ? new Date(s.lastLoginAt).toISOString() : null,
      nationId: null,
      nationName: null,
    });
  }
  for (const o of owners) {
    if (!o.discordUserId || bannedIds.has(o.discordUserId)) continue;
    const existing = map.get(o.discordUserId);
    if (existing) {
      existing.nationId = o.nationId;
      existing.nationName = o.nationName;
    } else {
      map.set(o.discordUserId, {
        discordUserId: o.discordUserId,
        username: null,
        globalName: null,
        avatar: null,
        lastLoginAt: null,
        nationId: o.nationId,
        nationName: o.nationName,
      });
    }
  }

  const accounts = Array.from(map.values()).sort((a, b) =>
    (b.lastLoginAt ?? "").localeCompare(a.lastLoginAt ?? ""),
  );

  res.json({ bans, accounts });
});

router.post("/admin/account-bans", requireAdmin, async (req, res) => {
  const body = (req.body ?? {}) as { discordUserId?: unknown; reason?: unknown };
  const discordUserId =
    typeof body.discordUserId === "string" ? body.discordUserId.trim() : "";
  if (!discordUserId) {
    res.status(400).json({ error: "請提供要封禁的 Discord 帳號 ID" });
    return;
  }
  if (!isValidDiscordId(discordUserId)) {
    res.status(400).json({ error: "Discord 帳號 ID 格式不正確（須為數字）" });
    return;
  }
  const reason =
    typeof body.reason === "string" ? body.reason.trim().slice(0, 500) || null : null;

  await banAccount({ discordUserId, reason });
  res.json({ ok: true });
});

router.delete("/admin/account-bans/:discordUserId", requireAdmin, async (req, res) => {
  const param = req.params.discordUserId;
  const discordUserId = (Array.isArray(param) ? param[0] : param ?? "").trim();
  if (!discordUserId) {
    res.status(400).json({ error: "缺少 Discord 帳號 ID" });
    return;
  }
  if (!isValidDiscordId(discordUserId)) {
    res.status(400).json({ error: "Discord 帳號 ID 格式不正確（須為數字）" });
    return;
  }
  const removed = await unbanAccount(discordUserId);
  if (!removed) {
    res.status(404).json({ error: "找不到此封禁紀錄" });
    return;
  }
  res.json({ ok: true });
});

export default router;
