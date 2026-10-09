import type { Request, Response, NextFunction } from "express";
import { isSeasonFrozen } from "../lib/oilRigService";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 凍結期間仍放行的寫入:登出與登入流程(玩家要能進來看榜單與地圖)。 */
const ALLOWED_WRITE_PREFIXES = ["/api/auth/"];

/**
 * 賽季凍結:有油井國家達 10000 分後,所有玩家寫入一律 423,只留讀取。
 * 管理員 Bearer 請求放行(否則無法手動重置)。判斷依據是 Authorization 標頭,
 * 真正的權限仍由各管理員路由自己的 requireAdmin 把關。
 */
export async function seasonFreeze(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (SAFE_METHODS.has(req.method)) return next();
  const path = req.originalUrl.split("?")[0]!.replace(/\/+$/, "");
  if (ALLOWED_WRITE_PREFIXES.some((p) => path.startsWith(p))) return next();
  if (path.startsWith("/api/admin/") && (req.headers.authorization ?? "").startsWith("Bearer ")) return next();
  if (!(await isSeasonFrozen())) return next();
  res.status(423).json({
    error: "本賽季已結束,遊戲凍結中。你可以查看排行榜與地圖,請等待管理員重置新賽季。",
    code: "SEASON_FROZEN",
  });
}
