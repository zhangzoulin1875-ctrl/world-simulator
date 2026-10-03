import type { Request, Response, NextFunction } from "express";
import { logger } from "../lib/logger";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  logger.error(
    "ADMIN_TOKEN is not set. AI-triggering endpoints will reject all requests until it is configured.",
  );
}

function extractToken(req: Request): string | null {
  const auth = req.header("authorization");
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  const headerToken = req.header("x-admin-token");
  if (headerToken) return headerToken.trim();
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!ADMIN_TOKEN) {
    res.status(503).json({ error: "admin token not configured" });
    return;
  }
  const token = extractToken(req);
  if (!token || !timingSafeEqual(token, ADMIN_TOKEN)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

export function isAdminRequest(req: Request): boolean {
  if (!ADMIN_TOKEN) return false;
  const token = extractToken(req);
  if (!token) return false;
  return timingSafeEqual(token, ADMIN_TOKEN);
}
