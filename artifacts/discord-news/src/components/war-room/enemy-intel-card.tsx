import { Eye, TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { WarCampaignDetail } from "@workspace/api-client-react";
import { formatBigNumber } from "@/components/military-shared";
import { armyTrendSummary } from "@/lib/armyTrend";
import { ArmySparkline } from "@/components/army-sparkline";

// ── 敵情 ──────────────────────────────────────────────────────

export function EnemyIntelCard({ detail }: { detail: WarCampaignDetail }) {
  const e = detail.enemy;
  return (
    <div className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Eye className="h-4 w-4 text-purple-300" />
          敵情估計
        </div>
        <span className="rounded bg-purple-500/20 px-2 py-0.5 text-xs text-purple-200">
          偵查等級 {e.reconLevel}/3
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
        <IntelStat label="軍團數" value={String(e.legionCount)} />
        <IntelStat label="兵力（約）" value={formatBigNumber(e.totalTroops)} />
        <IntelStat label="傷兵（約）" value={formatBigNumber(e.totalWounded)} />
        <IntelStat label="平均士氣（約）" value={String(e.averageMorale)} />
      </div>
      <ArmyTrendLine detail={detail} />
      <p className="mt-2 text-xs text-white/45">
        數值為模糊估計；本週期提交越多偵查指令，下週期敵情越精確。
      </p>
    </div>
  );
}

/** Task #417 — 對手全國軍力走勢（近數回合快照，已依偵查等級模糊化）。 */
function ArmyTrendLine({ detail }: { detail: WarCampaignDetail }) {
  const trend = detail.enemy.armyTrend;
  const summary = armyTrendSummary(trend);
  if (!summary) return null;
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm"
      data-testid="enemy-army-trend"
    >
      <span className="text-xs text-white/50">全國軍力走勢（約）</span>
      <span
        className={`inline-flex items-center gap-1 tabular-nums ${
          summary.kind === "up"
            ? "text-red-400"
            : summary.kind === "down"
              ? "text-emerald-400"
              : "text-white/70"
        }`}
        title="近數回合全國軍力快照走勢（依偵查等級模糊化）"
      >
        {summary.kind === "up" ? (
          <TrendingUp className="h-3.5 w-3.5" />
        ) : summary.kind === "down" ? (
          <TrendingDown className="h-3.5 w-3.5" />
        ) : (
          <Minus className="h-3.5 w-3.5" />
        )}
        {summary.kind === "up"
          ? `擴軍中 +${Math.abs(summary.pct).toFixed(0)}%`
          : summary.kind === "down"
            ? `縮編中 −${Math.abs(summary.pct).toFixed(0)}%`
            : "軍力持平"}
      </span>
      <ArmySparkline
        trend={trend}
        width={84}
        height={20}
        className="shrink-0 text-purple-300/80"
      />
    </div>
  );
}

function IntelStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
      <div className="text-xs text-white/50">{label}</div>
      <div className="font-mono text-base font-bold">{value}</div>
    </div>
  );
}
