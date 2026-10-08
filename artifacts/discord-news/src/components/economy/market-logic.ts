/**
 * 黑市分頁的純邏輯(不含 React),抽出來才測得到。
 * 後端才是權威(額度、餘額、庫存都會在成交時重驗);這裡只是提前告訴玩家
 * 「為什麼現在按不下去」,避免白打一個 API。
 */

export type Side = "buy" | "sell";

export interface BlockInput {
  side: Side;
  qty: number; // 已解析的數量,無效輸入為 0
  perTradeCap: number;
  left: number; // 本回合此方向剩餘額度
  owned: number; // 持有量(賣出才用)
  affordable: boolean | null; // 試算結果;尚未取得為 null
}

/** 把輸入框文字轉成數量:只接受純數字,其餘(空白 / 小數 / 負號 / 字母)一律 0。 */
export function parseQty(text: string): number {
  return /^\d+$/.test(text) ? Number(text) : 0;
}

/** 回傳「不能送出」的原因;可以送出則為 null。順序即優先順序。 */
export function blockReason(i: BlockInput): string | null {
  const valid = Number.isInteger(i.qty) && i.qty >= 1 && i.qty <= i.perTradeCap;
  if (!valid) return `數量請輸入 1 到 ${i.perTradeCap}`;
  if (i.left <= 0) return "本回合此方向額度已用完";
  if (i.qty > i.left) return `本回合最多還能${i.side === "buy" ? "買" : "賣"} ${i.left}`;
  if (i.side === "sell" && i.qty > i.owned) return `庫存不足（持有 ${i.owned}）`;
  if (i.side === "buy" && i.affordable === false) return "金錢不足";
  return null;
}

/** 「最大」按鈕要填的數量:取單筆上限、剩餘額度(賣出再加持有量)的最小值,至少 1。 */
export function maxQty(side: Side, perTradeCap: number, left: number, owned: number): number {
  const cap = side === "sell" ? Math.min(perTradeCap, left, owned) : Math.min(perTradeCap, left);
  return Math.max(1, cap);
}

/** 價格相對基準價的漲跌百分比(整數顯示用)。基準價無效時為 0。 */
export function pctVsBase(mid: number, base: number): number {
  return base > 0 && Number.isFinite(mid) ? (mid / base - 1) * 100 : 0;
}
