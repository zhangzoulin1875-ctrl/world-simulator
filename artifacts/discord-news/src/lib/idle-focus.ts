import { focusManager } from "@tanstack/react-query";

/**
 * 省 Neon 用量：使用者「閒置」時停止所有背景輪詢。
 *
 * 全站常駐有 ~12 個 5~60 秒的 refetchInterval（通知、外交、內閣、新聞、
 * AI 託管、AI 排隊…）。只要有一個分頁開著，後端就每分鐘被打十幾次，
 * Neon 永遠無法在 5 分鐘閒置後休眠（免費版 100 CU 小時/月會月中爆）。
 *
 * TanStack Query 預設 refetchIntervalInBackground=false：「失焦」時
 * 輪詢自動暫停。這裡把「失焦」重新定義為：
 *   分頁被隱藏，或超過 IDLE_MS 沒有任何滑鼠/鍵盤/觸控/捲動操作。
 * 一有操作就恢復為聚焦，TanStack 會立刻補抓過期資料並重啟輪詢。
 *
 * 不動任何個別查詢的程式碼。
 */
export const IDLE_MS = 2 * 60 * 1000;

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "wheel",
  "scroll",
] as const;

export function installIdleFocus(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  focusManager.setEventListener((handleFocus) => {
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idle = false;
    let lastMove = 0;

    const apply = () => handleFocus(!idle && document.visibilityState === "visible");

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idle = true;
        apply();
      }, IDLE_MS);
    };

    const onActivity = () => {
      // mousemove/scroll 很頻繁：每秒最多處理一次。
      const now = Date.now();
      if (now - lastMove < 1000) return;
      lastMove = now;
      const wasIdle = idle;
      idle = false;
      armIdle();
      if (wasIdle) apply();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        idle = false;
        armIdle();
      }
      apply();
    };

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    document.addEventListener("visibilitychange", onVisibility);
    armIdle();
    apply();

    return () => {
      if (idleTimer) clearTimeout(idleTimer);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  });
}
