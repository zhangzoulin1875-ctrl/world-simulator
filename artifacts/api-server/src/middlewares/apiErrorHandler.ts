import type { ErrorRequestHandler } from "express";
import { logger } from "../lib/logger";

/**
 * Postgres SQLSTATE 中屬於「使用者輸入不合法」的類別,應回 4xx 而非 500:
 *  - 22003 numeric_value_out_of_range(例:整數超出 int4 範圍)
 *  - 22P02 invalid_text_representation(例:非法 uuid / 數字字串)
 *  - 22001 string_data_right_truncation
 *  - 22007/22008 日期時間格式錯誤
 */
const INPUT_SQLSTATES = new Set(["22003", "22P02", "22001", "22007", "22008"]);

/** drizzle 會把 pg 錯誤包在 cause 裡,沿著 cause 鏈找 SQLSTATE。 */
export function findPgCode(err: unknown): string | null {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export const apiErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  // body-parser 的 JSON 解析錯誤、過大 payload
  const status = (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json({ error: status === 413 ? "請求內容過大" : "請求格式不正確" });
    return;
  }
  const pg = findPgCode(err);
  if (pg && INPUT_SQLSTATES.has(pg)) {
    logger.warn({ pg, url: req.originalUrl }, "rejected invalid input at DB layer");
    res.status(400).json({ error: "輸入的數值或格式不合法" });
    return;
  }
  logger.error({ err, url: req.originalUrl }, "unhandled request error");
  res.status(500).json({ error: "伺服器內部錯誤" });
};
