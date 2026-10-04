import type { Request, Response, NextFunction } from "express";
import { getSession, readSessionToken } from "../lib/sessions";
import { isAutopilotLocked } from "../lib/autopilotState";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 託管中仍允許的寫入（精確比對，不含 /api 前綴之後的查詢字串）：
 * 解除託管、登出、通知已讀。其餘玩家寫入一律 423。
 */
const ALLOWED_WRITES = new Set<string>([
  "/api/player/autopilot/disable",
  "/api/auth/logout",
  "/api/player/notifications/read",
]);

/** 管理員 Bearer（無玩家 session）不受鎖定影響。 */
export async function autopilotLock(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (SAFE_METHODS.has(req.method)) return next();
    const path = req.originalUrl.split("?")[0]!.replace(/\/+$/, "");
    if (ALLOWED_WRITES.has(path)) return next();
    const token = readSessionToken(req);
    if (!token) return next();
    const session = await getSession(token);
    if (!session) return next();
    if (await isAutopilotLocked(session.discordUserId)) {
      res.status(423).json({
        error: "國家由 AI 託管中，操作已鎖定。請先解除託管模式。",
        code: "AUTOPILOT_LOCKED",
      });
      return;
    }
    next();
  } catch (err) {
    // 查詢失敗時放行：鎖定是便利功能，不該因 DB 抖動讓所有玩家寫入失敗。
    req.log?.warn({ err }, "autopilotLock check failed; allowing request");
    next();
  }
}
