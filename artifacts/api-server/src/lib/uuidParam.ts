import type { RequestParamHandler } from "express";

/** UUID 格式（不檢查版本位，只擋資料庫會丟 `invalid input syntax for type uuid` 的字串）。 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * 給 `router.param("id", uuidParam)` 用：路徑參數不是合法 uuid 就直接回 404
 * （該資源一定不存在），不讓畸形 id 一路打到資料庫變成 500 + HTML 錯誤頁。
 * 只掛在「主鍵是 uuid」的 router 上；主鍵是整數的參數不要套用。
 */
export const uuidParam: RequestParamHandler = (req, res, next, value) => {
  if (isUuid(value)) {
    next();
    return;
  }
  res.status(404).json({ error: "找不到資料" });
};
