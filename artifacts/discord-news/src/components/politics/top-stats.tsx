import { Flame, HeartCrack, ShieldCheck, Users } from "lucide-react";
import type { PoliticsOverview } from "@workspace/api-client-react";
import { signed } from "./shared";

export function TopStats({ overview }: { overview: PoliticsOverview }) {
  const stats = [
    {
      key: "stability",
      label: "穩定度",
      icon: ShieldCheck,
      iconClass: "text-teal-300",
      value: String(overview.stability),
      extra: `${signed(overview.stabilityBonusPct)}% 科技/生產`,
      extraClass:
        overview.stabilityBonusPct >= 0 ? "text-green-400" : "text-red-400",
    },
    {
      key: "unrest",
      label: "暴動度",
      icon: Flame,
      iconClass: "text-red-300",
      value: String(overview.unrest),
      extra: null,
      extraClass: "",
    },
    {
      key: "warweariness",
      label: "厭戰度",
      icon: HeartCrack,
      iconClass: "text-rose-300",
      value: String(overview.warWeariness),
      extra: `${signed(overview.attackModifierPct)}% 攻擊`,
      extraClass:
        overview.attackModifierPct >= 0 ? "text-green-400" : "text-red-400",
    },
    {
      key: "populationgrowth",
      label: "人口增長率",
      icon: Users,
      iconClass: "text-emerald-300",
      value: `${signed(overview.populationGrowthRatePct)}%`,
      extra: "每回合",
      extraClass: "text-white/50",
    },
  ];
  return (
    <div
      className="grid grid-cols-3 gap-2 md:flex md:items-center"
      data-testid="politics-stats-bar"
    >
      {stats.map((s) => (
        <div
          key={s.key}
          className="flex items-center gap-2 rounded-lg border border-white/15 bg-black/50 px-3 py-2 backdrop-blur"
          data-testid={`politics-stat-${s.key}`}
        >
          <s.icon className={`h-4 w-4 shrink-0 ${s.iconClass}`} />
          <div className="min-w-0 leading-tight">
            <div className="text-[10px] text-white/60">{s.label}</div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-bold tabular-nums">{s.value}</span>
              {s.extra && (
                <span className={`text-[10px] font-bold ${s.extraClass}`}>
                  {s.extra}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
