import React from "react";
import { formatPopulation } from "@/lib/formatNumber";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Flag,
  Users,
  Landmark,
  Swords,
  Coins,
  Cpu,
  TrendingUp,
  TrendingDown,
  Minus,
} from "lucide-react";
import { NATION_SORTS, type NationSort } from "./shared";
import { armyTrendSummary, type ArmyTrendPoint } from "@/lib/armyTrend";
import { ArmySparkline } from "@/components/army-sparkline";

export type { ArmyTrendPoint };

export interface NationPanelRow {
  id: string;
  label: string;
  color: string;
  flagUrl: string | null;
  government: string | null;
  population: number;
  armyPopulation: number;
  woundedPopulation: number;
  committedPopulation: number;
  armyTrend: ArmyTrendPoint[];
  money: number;
  techPoints: number;
  isNpc: boolean;
  isUnowned: boolean;
}

/** 軍力趨勢與狀態列：趨勢標記＋迷你走勢圖＋傷兵中／前線中比例。 */
function ArmyStatusLine({ n }: { n: NationPanelRow }) {
  const summary = armyTrendSummary(n.armyTrend);
  const woundedPct =
    n.armyPopulation > 0 ? (n.woundedPopulation / n.armyPopulation) * 100 : 0;
  const committedPct =
    n.armyPopulation > 0
      ? (n.committedPopulation / n.armyPopulation) * 100
      : 0;
  const hasStatus = woundedPct >= 0.5 || committedPct >= 0.5;
  if (!summary && !hasStatus) return null;
  return (
    <div
      className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
      data-testid={`nation-army-status-${n.id}`}
    >
      {summary && (
        <span
          className={`inline-flex items-center gap-1 tabular-nums ${
            summary.kind === "up"
              ? "text-red-500"
              : summary.kind === "down"
                ? "text-emerald-600"
                : ""
          }`}
          title="近期軍力趨勢（依每回合軍力快照比較）"
        >
          {summary.kind === "up" ? (
            <TrendingUp className="h-3 w-3" />
          ) : summary.kind === "down" ? (
            <TrendingDown className="h-3 w-3" />
          ) : (
            <Minus className="h-3 w-3" />
          )}
          {summary.kind === "up"
            ? `擴軍中 +${Math.abs(summary.pct).toFixed(0)}%`
            : summary.kind === "down"
              ? `縮編中 −${Math.abs(summary.pct).toFixed(0)}%`
              : "軍力持平"}
        </span>
      )}
      {summary && <ArmySparkline trend={n.armyTrend} />}
      {woundedPct >= 0.5 && (
        <span
          className="inline-flex items-center gap-1 tabular-nums text-amber-600"
          title="傷兵占軍隊人口比例（傷兵恢復中，暫不可作戰）"
        >
          傷兵中 {woundedPct.toFixed(0)}%
        </span>
      )}
      {committedPct >= 0.5 && (
        <span
          className="inline-flex items-center gap-1 tabular-nums text-orange-600"
          title="前線占軍隊人口比例（戰役中，無法另行調度）"
        >
          前線中 {committedPct.toFixed(0)}%
        </span>
      )}
    </div>
  );
}

/** 政治視圖：地圖下方各國國情面板。 */
export function NationPanel({
  politicalError,
  currentEraLabel,
  nationPanel,
  nationQuery,
  setNationQuery,
  nationSort,
  setNationSort,
  filteredNationPanel,
  linkNationsToDiplomacy,
  navigate,
}: {
  politicalError: boolean;
  currentEraLabel: string | null;
  nationPanel: NationPanelRow[];
  nationQuery: string;
  setNationQuery: React.Dispatch<React.SetStateAction<string>>;
  nationSort: NationSort;
  setNationSort: React.Dispatch<React.SetStateAction<NationSort>>;
  filteredNationPanel: NationPanelRow[];
  linkNationsToDiplomacy: boolean;
  navigate: (to: string) => void;
}) {
  return politicalError ? (
    <div className="rounded-xl border border-border bg-secondary/20 px-4 py-3 text-sm text-muted-foreground">
      無法載入國情資料，請稍後重新整理再試一次。
    </div>
  ) : (
    <div className="rounded-xl border border-border bg-secondary/20 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Flag className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">各國國情</span>
        <Badge
          variant="outline"
          className="border-primary/30 bg-primary/10 text-primary"
        >
          科技水準：{currentEraLabel ?? "—"}
        </Badge>
        <span className="text-xs text-muted-foreground">
          科技水準以目前世界所處時代表示
        </span>
        {nationPanel.length > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Input
              value={nationQuery}
              onChange={(e) => setNationQuery(e.target.value)}
              placeholder="搜尋國名…"
              className="h-8 w-[10rem] text-xs"
              data-testid="nation-search-input"
            />
            <span className="text-xs text-muted-foreground">排序</span>
            <Select
              value={nationSort}
              onValueChange={(v) => setNationSort(v as NationSort)}
            >
              <SelectTrigger
                className="h-8 w-[9.5rem] text-xs"
                data-testid="nation-sort-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NATION_SORTS.map((s) => (
                  <SelectItem key={s.key} value={s.key} className="text-xs">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      {nationPanel.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          目前沒有任何國家控制地區。
        </div>
      ) : filteredNationPanel.length === 0 ? (
        <div
          className="text-sm text-muted-foreground"
          data-testid="nation-search-empty"
        >
          找不到符合「{nationQuery.trim()}」的國家。
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {filteredNationPanel.map((n) => (
            <div
              key={n.id}
              className={`flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-2 ${
                linkNationsToDiplomacy
                  ? "cursor-pointer text-left transition hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  : ""
              }`}
              data-testid={`nation-panel-${n.id}`}
              {...(linkNationsToDiplomacy
                ? {
                    role: "button" as const,
                    tabIndex: 0,
                    title: `前往外交：${n.label}`,
                    onClick: () =>
                      navigate(
                        `/game/diplomacy?nation=${encodeURIComponent(n.id)}`,
                      ),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        navigate(
                          `/game/diplomacy?nation=${encodeURIComponent(n.id)}`,
                        );
                      }
                    },
                  }
                : {})}
            >
              {n.flagUrl ? (
                <img
                  src={n.flagUrl}
                  alt=""
                  className="h-6 w-9 shrink-0 rounded-sm border border-border/60 object-cover"
                />
              ) : (
                <span
                  className="flex h-6 w-9 shrink-0 items-center justify-center rounded-sm border border-border/60"
                  style={{ background: n.color }}
                  aria-hidden
                >
                  <Flag className="h-3 w-3 text-white/90" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-border/60"
                    style={{ background: n.color }}
                  />
                  <span className="truncate text-sm font-medium">
                    {n.label}
                  </span>
                  {n.isNpc && (
                    <Badge
                      variant="secondary"
                      className="px-1.5 py-0 text-[10px]"
                    >
                      NPC
                    </Badge>
                  )}
                  {n.isUnowned && (
                    <Badge
                      variant="outline"
                      className="px-1.5 py-0 text-[10px]"
                    >
                      無主
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Landmark className="h-3 w-3" />
                    {n.government?.trim() || "未定政體"}
                  </span>
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <Users className="h-3 w-3" />
                    {formatPopulation(n.population)}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 tabular-nums"
                    title="軍隊人口數（現役部隊＋傷兵占用的人口總數）"
                  >
                    <Swords className="h-3 w-3" />
                    {n.armyPopulation > 0
                      ? formatPopulation(n.armyPopulation)
                      : "無常備軍"}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 tabular-nums"
                    title="國庫金錢"
                  >
                    <Coins className="h-3 w-3" />
                    {n.money.toLocaleString("zh-TW")}
                  </span>
                  <span
                    className="inline-flex items-center gap-1 tabular-nums"
                    title="科技點數"
                  >
                    <Cpu className="h-3 w-3" />
                    {n.techPoints.toLocaleString("zh-TW")}
                  </span>
                </div>
                <ArmyStatusLine n={n} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
