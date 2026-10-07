import React from "react";

const INTRO_SRC = `${import.meta.env.BASE_URL}intro/intro.mp4`;
const FADE_MS = 500;

type Phase =
  | "loading" // 嘗試自動播放中
  | "playing" // 正在播放（可能是靜音）
  | "needs-tap"; // 瀏覽器擋住自動播放（iOS 低耗電模式、嚴格政策等）：等玩家點一下

/**
 * 開場動畫：每次載入頁面（點開遊戲、重新整理）都會出現，點按畫面可跳過。
 *
 * 自動播放策略（手機 Safari 尤其嚴格）：
 *   1. 先試「有聲」播放；被擋就改試「靜音」播放（muted 同時寫成 HTML 屬性，iOS 只認屬性）。
 *   2. 兩種都被擋（iOS 低耗電模式、關閉自動播放等）時，**不放棄**：顯示「點一下播放」畫面，
 *      玩家的點擊是有效手勢，可直接有聲播放；旁邊有「跳過」可直接進遊戲。
 *   3. 只有影片「載入失敗」（網路／檔案不存在）才直接放行，避免把遊戲擋在動畫後面。
 * 放行／失敗原因寫入 console（[intro] 開頭），方便回報。
 */
export function IntroSplash() {
  const [active, setActive] = React.useState(true);
  const [leaving, setLeaving] = React.useState(false);
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [mutedPlay, setMutedPlay] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const doneRef = React.useRef(false);

  const finish = React.useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setLeaving(true);
    window.setTimeout(() => setActive(false), FADE_MS);
  }, []);

  // 自動播放：有聲 → 靜音 → 等玩家點。
  React.useEffect(() => {
    if (!active) return;
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;

    const tryPlay = async () => {
      try {
        v.muted = false;
        await v.play();
        if (!cancelled) setPhase("playing");
        return;
      } catch (err) {
        console.info("[intro] 有聲自動播放被擋，改試靜音：", (err as Error)?.name);
      }
      if (cancelled) return;
      try {
        v.muted = true;
        v.setAttribute("muted", "");
        await v.play();
        if (!cancelled) {
          setMutedPlay(true);
          setPhase("playing");
        }
      } catch (err) {
        console.info("[intro] 靜音自動播放也被擋，等玩家點擊播放：", (err as Error)?.name);
        if (!cancelled) setPhase("needs-tap");
      }
    };
    void tryPlay();
    return () => {
      cancelled = true;
    };
  }, [active]);

  // 玩家點「播放」：這是有效手勢，優先嘗試有聲，不行再靜音。
  const startByTap = React.useCallback(async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.muted = false;
      v.removeAttribute("muted");
      await v.play();
      setMutedPlay(false);
      setPhase("playing");
    } catch {
      try {
        v.muted = true;
        await v.play();
        setMutedPlay(true);
        setPhase("playing");
      } catch (err) {
        console.warn("[intro] 手動播放失敗，略過開場動畫：", err);
        finish();
      }
    }
  }, [finish]);

  // 動畫期間鎖住背景捲動，結束後還原。
  React.useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);

  // 鍵盤跳過（Esc／Enter／空白）。
  React.useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, finish]);

  if (!active) return null;

  const needsTap = phase === "needs-tap";

  return (
    <div
      role="dialog"
      aria-label="開場動畫，點按畫面可跳過"
      // 播放中：點畫面＝跳過。等待點擊時：點畫面＝開始播放（跳過用右下角按鈕）。
      onClick={needsTap ? startByTap : finish}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483000,
        background: "#000",
        cursor: "pointer",
        opacity: leaving ? 0 : 1,
        transition: `opacity ${FADE_MS}ms ease`,
        WebkitTapHighlightColor: "transparent",
      }}
    >
      <video
        ref={videoRef}
        src={INTRO_SRC}
        muted
        playsInline
        // 舊版 iOS Safari 需要 webkit-playsinline 才不會強制全螢幕
        webkit-playsinline="true"
        preload="auto"
        onEnded={finish}
        onError={(e) => {
          console.warn("[intro] 影片載入失敗，略過開場動畫：", (e.currentTarget as HTMLVideoElement).error);
          finish();
        }}
        style={{ width: "100%", height: "100%", objectFit: "contain", background: "#000" }}
      />

      {needsTap ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            background: "rgba(0,0,0,0.55)",
            color: "#fff",
          }}
        >
          <div
            style={{
              width: 84,
              height: 84,
              borderRadius: "50%",
              border: "3px solid rgba(255,255,255,0.9)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                marginLeft: 8,
                borderStyle: "solid",
                borderWidth: "16px 0 16px 26px",
                borderColor: "transparent transparent transparent #fff",
              }}
            />
          </div>
          <span style={{ fontSize: 18, letterSpacing: 1 }}>點一下播放開場動畫</span>
        </div>
      ) : null}

      <div
        style={{
          position: "absolute",
          right: 16,
          bottom: "max(16px, env(safe-area-inset-bottom))",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 8,
          color: "rgba(255,255,255,0.8)",
          fontSize: 13,
          textShadow: "0 1px 3px rgba(0,0,0,0.9)",
        }}
      >
        {phase === "playing" && mutedPlay && !leaving ? (
          <span style={{ pointerEvents: "none" }}>瀏覽器限制：本次開場為靜音播放</span>
        ) : null}
        {needsTap ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              finish();
            }}
            style={{
              padding: "8px 18px",
              borderRadius: 999,
              border: "1px solid rgba(255,255,255,0.6)",
              background: "rgba(0,0,0,0.5)",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            跳過
          </button>
        ) : (
          <span style={{ pointerEvents: "none" }}>點按畫面跳過</span>
        )}
      </div>
    </div>
  );
}
