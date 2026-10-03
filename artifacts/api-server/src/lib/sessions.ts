import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { db, userSessionsTable } from "@workspace/db";
import type { UserSession } from "@workspace/db";
import { eq, lt } from "drizzle-orm";
import { logger } from "./logger";
import { isAccountBanned } from "./accountBans";

export const SESSION_COOKIE_NAME = "dn_session";
export const OAUTH_STATE_COOKIE_NAME = "dn_oauth_state";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export interface CreateSessionInput {
  discordUserId: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  manageableGuildIds: string[];
}

export async function createSession(
  input: CreateSessionInput,
): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(userSessionsTable).values({
    token,
    discordUserId: input.discordUserId,
    username: input.username,
    globalName: input.globalName,
    avatar: input.avatar,
    manageableGuildIds: input.manageableGuildIds,
    expiresAt,
  });
  return token;
}

export async function getSession(
  token: string | undefined | null,
): Promise<UserSession | null> {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(userSessionsTable)
    .where(eq(userSessionsTable.token, token))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db
      .delete(userSessionsTable)
      .where(eq(userSessionsTable.token, token))
      .catch(() => {});
    return null;
  }
  // A ban placed after the session was issued must take effect immediately:
  // treat the session as gone and revoke it so nothing keeps using it.
  if (await isAccountBanned(row.discordUserId)) {
    await db
      .delete(userSessionsTable)
      .where(eq(userSessionsTable.token, token))
      .catch(() => {});
    return null;
  }
  return row;
}

export async function deleteSession(
  token: string | undefined | null,
): Promise<void> {
  if (!token) return;
  await db.delete(userSessionsTable).where(eq(userSessionsTable.token, token));
}

export function readSessionToken(req: Request): string | null {
  const cookies = (req as Request & { cookies?: Record<string, unknown> })
    .cookies;
  const c = cookies?.[SESSION_COOKIE_NAME];
  return typeof c === "string" && c.length > 0 ? c : null;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    // The dashboard is embedded in a cross-site iframe (Replit preview), so
    // the cookie must be SameSite=None to be sent on credentialed fetches.
    sameSite: "none",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
  });
}

/** Periodically purge expired sessions. */
export function startSessionCleanupLoop(): void {
  const tick = () => {
    db.delete(userSessionsTable)
      .where(lt(userSessionsTable.expiresAt, new Date()))
      .catch((err) => logger.warn({ err }, "session cleanup failed"));
  };
  tick();
  setInterval(tick, 1000 * 60 * 60 * 6).unref();
}
