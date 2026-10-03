import { createHash } from "node:crypto";

/**
 * AI 閒時預產（v3）— 輸入雜湊（純計算，無任何依賴，供 worker／結算／測試共用）。
 * 把所有會進 prompt 的欄位序列化（鍵排序，消除物件欄位順序的雜訊）後 SHA-256：
 * 玩家改了想法 → 輸入不同 → 雜湊不同 → 預產快取自動失效。
 */
export function hashPregenInput(input: Record<string, unknown>): string {
  const stable = JSON.stringify(input, (_k, v) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
  return createHash("sha256").update(stable).digest("hex");
}
