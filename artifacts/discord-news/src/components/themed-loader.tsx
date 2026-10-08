import React from "react";

/**
 * 主題載入指示：旋轉羅盤 + 打字機式提示文字，取代單調的轉圈圈。
 * 純 CSS 動畫（見 index.css 的 .themed-loader-*），尊重 prefers-reduced-motion。
 */
export function ThemedLoader({
  label = "載入中",
  className = "",
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center gap-3 rounded-xl bg-black/60 px-8 py-6 text-amber-50 backdrop-blur ${className}`}
    >
      <svg
        className="themed-loader-compass"
        width="56"
        height="56"
        viewBox="0 0 64 64"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="32" cy="32" r="29" stroke="currentColor" strokeWidth="2" opacity="0.55" />
        <circle cx="32" cy="32" r="24" stroke="currentColor" strokeWidth="1" opacity="0.3" />
        {[0, 90, 180, 270].map((deg) => (
          <line
            key={deg}
            x1="32"
            y1="4"
            x2="32"
            y2="10"
            stroke="currentColor"
            strokeWidth="2"
            transform={`rotate(${deg} 32 32)`}
          />
        ))}
        <g className="themed-loader-needle">
          <polygon points="32,10 36,32 32,30 28,32" fill="#f59e0b" />
          <polygon points="32,54 28,32 32,34 36,32" fill="currentColor" opacity="0.6" />
        </g>
        <circle cx="32" cy="32" r="2.5" fill="currentColor" />
      </svg>
      <div className="text-sm tracking-wide">
        {label}
        <span className="themed-loader-dots" aria-hidden="true">
          <i>.</i>
          <i>.</i>
          <i>.</i>
        </span>
      </div>
    </div>
  );
}
