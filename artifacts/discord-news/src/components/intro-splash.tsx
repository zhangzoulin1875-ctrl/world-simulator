import React from "react";

const INTRO_SRC = `${import.meta.env.BASE_URL}intro/intro.mp4`;
const FADE_MS = 500;

/** 使用者系統設定為「減少動態效果」時不自動播放開場動畫。 */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * 開場動畫：每次載入頁面（點開遊戲、重新整理）都會播放，點按畫面任一處可跳過。
 *
 * - 先嘗試「有聲」播放；瀏覽器擋下自動有聲播放（需使用者互動）時退回靜音播放，
 *   並提示玩家這次是靜音。點畫面一律是「跳過」（不另做開聲按鈕，維持單一行為）。
 *   靜音播放也被擋就直接放行，不卡住玩家。
 * - 播完、載入失敗（網路／檔案不存在）一律自動收起，永遠不會把遊戲擋在動畫後面。
 * - 遊戲本體在動畫底下照常載入，動畫收起即可操作。
 */
export function IntroSplash() {
  const [active, setActive] = React.useState(() => !prefersReducedMotion());
  const [leaving, setLeaving] = React.useState(false);
  const [mutedByBrowser, setMutedByBrowser] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const doneRef = React.useRef(false);

  const finish = React.useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setLeaving(true);
    window.setTimeout(() => setActive(false), FADE_MS);
  }, []);

  React.useEffect(() => {
    if (!active) return;
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    v.muted = false;
    v.play().catch(() => {
      if (cancelled) return;
      // 有聲自動播放被擋：改靜音播放，並提示可點一下開聲音。
      v.muted = true;
      setMutedByBrowser(true);
      v.play().catch(() => {
        if (!cancelled) finish();
      });
    });
    return () => {
      cancelled = true;
    };
  }, [active, finish]);

  // 動畫播放時鎖住背景捲動，結束後還原。
  React.useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);

  // 鍵盤也能跳過（Esc／Enter／空白）。
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, finish]);

  if (!active) return null;

  return (
    <div
      role="dialog"
      aria-label="開場動畫，點按畫面可跳過"
      onClick={finish}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000,
        background: "#000",
        cursor: "pointer",
        opacity: leaving ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
      }}
    >
      <video
        ref={videoRef}
        src={INTRO_SRC}
        playsInline
        preload="auto"
        onEnded={finish}
        onError={finish}
        style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
      />
      <div
        style={{
          position: "absolute",
          right: 16,
          bottom: 16,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 6,
          color: "rgba(255,255,255,0.75)",
          fontSize: 13,
          textShadow: "0 1px 3px rgba(0,0,0,0.9)",
          pointerEvents: "none",
        }}
      >
        {mutedByBrowser && !leaving ? <span>瀏覽器限制：本次開場為靜音播放</span> : null}
        <span>點按畫面跳過</span>
      </div>
    </div>
  );
}
