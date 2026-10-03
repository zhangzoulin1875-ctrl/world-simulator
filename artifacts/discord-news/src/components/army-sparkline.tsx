import type { ArmyTrendPoint } from "@/lib/armyTrend";

/** 迷你折線圖（純 SVG，無互動）：呈現近期軍力快照走勢（可自訂尺寸）。 */
export function ArmySparkline({
  trend,
  width = 56,
  height = 16,
  className = "shrink-0 text-primary/70",
}: {
  trend: ArmyTrendPoint[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (trend.length < 2) return null;
  const w = width;
  const h = height;
  const values = trend.map((p) => p.armyPopulation);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * (w - 2) + 1;
      const y = h - 2 - ((v - min) / span) * (h - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className={className}
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
