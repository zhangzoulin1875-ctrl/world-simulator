import React from "react";
import { useLocation } from "wouter";

/** 翻頁總時長（毫秒）。需與 index.css 的 .page-flip 動畫時長一致。 */
const FLIP_MS = 720;

/**
 * 頁面切換過場：書頁翻過。
 *
 * 路由一變就在畫面上蓋一張「羊皮紙書頁」，以書脊（左緣）為軸向左翻起，
 * 翻開後露出已在底下渲染好的新頁面。新頁面不等動畫、立即掛載，所以不增加任何等待；
 * 動畫層 pointer-events: none，翻頁期間也不擋點擊。
 *
 * - 首次載入不觸發（已有開場影片）。
 * - 只在 /game 系列頁之間觸發；後台管理頁維持即時切換。
 * - 尊重 prefers-reduced-motion：由 CSS 改成單純淡出。
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const prevRef = React.useRef(location);
  const [flip, setFlip] = React.useState<{ key: number } | null>(null);

  React.useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = location;
    if (prev === location) return;
    // 只有「新舊路徑都在 /game 底下」才翻頁；查詢字串/hash 不算換頁（wouter 的 location 本就不含）。
    if (!prev.startsWith("/game") || !location.startsWith("/game")) return;
    const key = Date.now();
    setFlip({ key });
    const t = window.setTimeout(() => {
      setFlip((cur) => (cur && cur.key === key ? null : cur));
    }, FLIP_MS + 60);
    return () => window.clearTimeout(t);
  }, [location]);

  return (
    <>
      {children}
      {flip ? (
        <div className="page-flip-stage" aria-hidden="true" key={flip.key}>
          <div className="page-flip-sheet">
            <div className="page-flip-grain" />
            <div className="page-flip-ornament">
              <span />
            </div>
          </div>
          <div className="page-flip-shade" />
        </div>
      ) : null}
    </>
  );
}
