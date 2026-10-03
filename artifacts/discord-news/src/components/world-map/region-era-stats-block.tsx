import React from "react";
import { formatPopulation } from "@/lib/formatNumber";
import type { MapRegionEntry } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users,
  Factory,
  FlaskConical,
  Sprout,
  Ruler,
  Hourglass,
} from "lucide-react";
import type { RegionEraStatsEntry } from "./shared";

function StatTile({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background/70 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        {icon}
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums leading-tight">{value}</div>
      {hint && <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

/** 選定地區的時代數據區塊（時代由頁面層級控制，不再自帶下拉）。 */
export function RegionEraStatsBlock({
  region,
  stats,
  eraLabel,
  eraIndex,
  isCurrentEra,
  isLoading,
}: {
  region: MapRegionEntry;
  stats: RegionEraStatsEntry | null;
  eraLabel: string | null;
  eraIndex: number;
  isCurrentEra: boolean;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="mt-5 pt-5 border-t border-border/70">
        <Skeleton className="h-6 w-56 mb-3" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-[72px] rounded-lg" />
          ))}
        </div>
      </div>
    );
  }
  if (!stats || eraIndex < 0 || eraLabel == null) {
    return (
      <div className="mt-5 pt-5 border-t border-border/70 text-sm text-muted-foreground">
        無法載入時代數據。
      </div>
    );
  }

  return (
    <div className="mt-5 pt-5 border-t border-border/70">
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <Hourglass className="w-4 h-4 text-primary" />
        <span className="text-sm font-medium">時代數據</span>
        <span className="text-sm text-muted-foreground">{eraLabel}</span>
        {isCurrentEra && (
          <Badge className="bg-primary/15 text-primary border-primary/30" variant="outline">
            當前時代
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <StatTile
          icon={<Users className="w-3.5 h-3.5" />}
          label="人口"
          value={formatPopulation(stats.population[eraIndex] ?? 0)}
        />
        <StatTile
          icon={<Factory className="w-3.5 h-3.5" />}
          label="生產素質"
          value={(stats.productivity[eraIndex] ?? 0).toLocaleString("zh-TW")}
        />
        <StatTile
          icon={<FlaskConical className="w-3.5 h-3.5" />}
          label="科技點數"
          value={(stats.techPoints[eraIndex] ?? 0).toLocaleString("zh-TW")}
        />
        <StatTile
          icon={<Sprout className="w-3.5 h-3.5" />}
          label="土壤肥沃度"
          value={region.soilFertility != null ? String(region.soilFertility) : "—"}
          hint="固定屬性"
        />
        <StatTile
          icon={<Ruler className="w-3.5 h-3.5" />}
          label="領土面積"
          value={region.areaKm2 != null ? `${region.areaKm2.toLocaleString("zh-TW")} km²` : "—"}
          hint="固定屬性"
        />
      </div>
    </div>
  );
}
