import { Shield } from "lucide-react";
import type { PoliticsOverview } from "@workspace/api-client-react";

/** Task #402 — 軍方面板：服從度、軍隊占人口比與風險等級。 */
export function MilitaryPanel({ overview }: { overview: PoliticsOverview }) {
  const mil = overview.military;
  const milDirection = overview.directions.find(
    (d) => d.direction === "military",
  );
  const riskColor =
    mil.riskLevel === "high"
      ? "border-red-400/40 bg-red-500/15 text-red-300"
      : mil.riskLevel === "medium"
        ? "border-amber-400/40 bg-amber-500/15 text-amber-300"
        : "border-emerald-400/40 bg-emerald-500/15 text-emerald-300";
  const overThreshold = mil.armyPopulationRatioPct > mil.thresholdPct;

  return (
    <section
      className="mb-4 rounded-xl border border-white/15 bg-black/45 p-4 backdrop-blur"
      data-testid="panel-military"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-red-300" />
          <h3 className="font-serif text-sm font-bold md:text-base">軍方</h3>
        </div>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${riskColor}`}
          data-testid="text-military-risk"
        >
          {mil.riskLabel}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
        {milDirection && (
          <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
            <div className="text-white/50">軍方滿意度</div>
            <div
              className="mt-0.5 text-sm font-bold"
              data-testid="text-military-satisfaction"
            >
              {milDirection.satisfaction}%
            </div>
          </div>
        )}
        <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
          <div className="text-white/50">軍方服從度</div>
          <div
            className="mt-0.5 text-sm font-bold"
            data-testid="text-military-obedience"
          >
            {mil.obedience}%
          </div>
          <div className="mt-0.5 text-[10px] text-white/40">
            新建軍團的初始士氣
          </div>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/30 px-3 py-2">
          <div className="text-white/50">軍隊占人口比</div>
          <div
            className={`mt-0.5 text-sm font-bold ${overThreshold ? "text-red-300" : ""}`}
            data-testid="text-military-ratio"
          >
            {mil.armyPopulationRatioPct}%
          </div>
          <div className="mt-0.5 text-[10px] text-white/40">
            超過 {mil.thresholdPct}% 可能觸發軍隊越權
          </div>
        </div>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-white/40">
        軍方滿意度與服從度皆過低時可能發生逃兵潮，甚至軍事政變；維護費欠餉會降低軍方滿意度，和平時期兩者每回合緩慢回升。
      </p>
    </section>
  );
}
