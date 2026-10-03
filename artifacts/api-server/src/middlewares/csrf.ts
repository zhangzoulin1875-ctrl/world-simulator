import type { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE_NAME } from "../lib/sessions";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * CSRF protection for cookie-authenticated requests.
 *
 * The Discord session cookie is `SameSite=None` (required so the dashboard
 * keeps working inside the cross-site Replit preview iframe), which means the
 * browser will attach it even on requests initiated by other sites. To stop a
 * malicious page from driving authenticated state changes, every unsafe request
 * that carries the session cookie must originate from the same host — verified
 * via the `Origin` header, falling back to `Referer`. Requests authenticated
 * only by the backend admin Bearer token (no session cookie) are not
 * CSRF-exploitable and are left untouched.
 */
export function csrfGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const cookies = (req as Request & { cookies?: Record<string, unknown> })
    .cookies;
  const hasSessionCookie =
    typeof cookies?.[SESSION_COOKIE_NAME] === "string" &&
    cookies[SESSION_COOKIE_NAME].length > 0;
  if (!hasSessionCookie) {
    next();
    return;
  }
  const requestHost = req.get("host");
  const sourceHost = hostOf(req.get("origin")) ?? hostOf(req.get("referer"));
  if (sourceHost && requestHost && sourceHost === requestHost) {
    next();
    return;
  }
  req.log?.warn(
    { requestHost, sourceHost, url: req.url?.split("?")[0] },
    "Rejected cross-site request on cookie-authenticated route",
  );
  res.status(403).json({ error: "cross-site request blocked" });
}
