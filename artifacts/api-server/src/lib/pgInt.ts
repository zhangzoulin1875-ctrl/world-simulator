/** Postgres int4 上限;路由參數超過此值送進查詢會觸發 22003 → 500。 */
export const PG_INT4_MAX = 2_147_483_647;

/** 是否為可安全放進 int4 欄位查詢的正整數 id。 */
export function isPgInt4Id(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= PG_INT4_MAX;
}
