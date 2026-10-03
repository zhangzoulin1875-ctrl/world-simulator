import { Castle } from "lucide-react";
import type {
  WarCampaignDetail,
  WarCityStateView,
} from "@workspace/api-client-react";

// ── 城市防線 ──────────────────────────────────────────────────

export function CityStateCards({ detail }: { detail: WarCampaignDetail }) {
  const entries: {
    regionName: string;
    sideLabel: string;
    state: WarCityStateView;
    mine: boolean;
  }[] = [];
  if (detail.attackerCityState) {
    entries.push({
      regionName: detail.attackerRegionName,
      sideLabel: "進攻方領地",
      state: detail.attackerCityState,
      mine: detail.role === "attacker",
    });
  }
  if (detail.defenderCityState) {
    entries.push({
      regionName: detail.defenderRegionName,
      sideLabel: "防守方領地",
      state: detail.defenderCityState,
      mine: detail.role === "defender",
    });
  }
  if (entries.length === 0) return null;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {entries.map((en) => (
        <div
          key={en.sideLabel}
          className={`rounded-2xl border p-4 backdrop-blur ${
            en.mine
              ? "border-emerald-400/40 bg-emerald-950/30"
              : "border-red-400/40 bg-red-950/25"
          }`}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Castle className="h-4 w-4 text-amber-300" />
              {en.regionName}
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`rounded px-2 py-0.5 text-xs font-semibold ${
                  en.mine
                    ? "bg-emerald-500/25 text-emerald-200"
                    : "bg-red-500/25 text-red-200"
                }`}
              >
                {en.mine ? "我方" : "敵方"}
              </span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-white/70">
                {en.sideLabel}
              </span>
              {en.state.garrisoned && (
                <span className="rounded bg-blue-500/20 px-2 py-0.5 text-xs text-blue-200">
                  已駐防
                </span>
              )}
            </div>
          </div>
          {en.state.cities.length === 0 ? (
            <p className="text-xs text-white/50">此地區無城市防線。</p>
          ) : (
            <div className="space-y-3">
              {en.state.cities.map((city) => (
                <CityDurabilityRow key={city.cityId} city={city} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 單城耐久列：城名＋城牆階級＋耐久數字＋進度條（Task #150）。 */
function CityDurabilityRow({
  city,
}: {
  city: WarCityStateView["cities"][number];
}) {
  const pct = Math.max(0, Math.min(100, city.durabilityPct));
  const fallen = city.durability <= 0;
  return (
    <div className={fallen ? "opacity-60" : ""}>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 font-medium text-white/85">
          {city.name}
          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">
            {city.wallTierLabel}
          </span>
        </span>
        <span
          className={`tabular-nums ${fallen ? "font-bold text-red-300" : "text-white/60"}`}
        >
          {city.durability.toLocaleString("en-US")} /{" "}
          {city.maxDurability.toLocaleString("en-US")}（{pct}%）
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${
            pct <= 25 ? "bg-red-500" : pct <= 60 ? "bg-amber-400" : "bg-emerald-500"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {fallen && (
        <p className="mt-1 text-[11px] font-bold text-red-300">城牆已被攻破！</p>
      )}
    </div>
  );
}
