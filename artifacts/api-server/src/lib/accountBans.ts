import { db, accountBansTable, userSessionsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

/**
 * 封禁 Discord 登入帳號的核心邏輯。封禁只阻擋登入（不刪除該帳號的國家／資料）：
 * - `isAccountBanned` 於 OAuth callback 與 `getSession` 檢查，阻擋新登入並使既有
 *   session 立即失效。
 * - `banAccount` 寫入封禁列並同時撤銷該帳號所有既有 session（立即踢出）。
 * - `unbanAccount` 移除封禁列（既有 session 已被撤銷，需重新登入）。
 */

export async function isAccountBanned(
  discordUserId: string | null | undefined,
): Promise<boolean> {
  if (!discordUserId) return false;
  const [row] = await db
    .select({ id: accountBansTable.discordUserId })
    .from(accountBansTable)
    .where(eq(accountBansTable.discordUserId, discordUserId))
    .limit(1);
  return Boolean(row);
}

export async function banAccount(input: {
  discordUserId: string;
  reason?: string | null;
  username?: string | null;
}): Promise<void> {
  const discordUserId = input.discordUserId.trim();
  const reason = input.reason?.trim() || null;
  // Snapshot a display name from the most recent session when the caller
  // didn't supply one, so the banned list stays readable.
  let username = input.username?.trim() || null;
  if (!username) {
    const [sess] = await db
      .select({ username: userSessionsTable.username })
      .from(userSessionsTable)
      .where(eq(userSessionsTable.discordUserId, discordUserId))
      .orderBy(desc(userSessionsTable.createdAt))
      .limit(1);
    username = sess?.username ?? null;
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(accountBansTable)
      .values({ discordUserId, username, reason })
      .onConflictDoUpdate({
        target: accountBansTable.discordUserId,
        set: { username, reason },
      });
    // Immediately revoke every live session for this account.
    await tx
      .delete(userSessionsTable)
      .where(eq(userSessionsTable.discordUserId, discordUserId));
  });
}

export async function unbanAccount(discordUserId: string): Promise<boolean> {
  const rows = await db
    .delete(accountBansTable)
    .where(eq(accountBansTable.discordUserId, discordUserId))
    .returning({ id: accountBansTable.discordUserId });
  return rows.length > 0;
}
