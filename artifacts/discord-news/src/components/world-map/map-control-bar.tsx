import type React from "react";
import type {
  WorldEraStatsResponse,
  WorldEraStatsEraDef,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Hourglass } from "lucide-react";
import { VIEW_MODES, type ViewMode } from "./shared";

/** 地圖控制列：時代、視圖、標示。 */
export function MapControlBar({
  statsError,
  eras,
  activeEraSlug,
  setEraChoice,
  worldStats,
  isCurrentEra,
  viewMode,
  setViewMode,
  politicalError,
  superEventError,
  showLabels,
  setShowLabels,
  showCities,
  setShowCities,
  showValues,
  setShowValues,
  showWarMarkers,
  setShowWarMarkers,
}: {
  statsError: boolean;
  eras: WorldEraStatsEraDef[];
  activeEraSlug: string | null;
  setEraChoice: React.Dispatch<React.SetStateAction<string | null>>;
  worldStats: WorldEraStatsResponse | undefined;
  isCurrentEra: boolean;
  viewMode: ViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  politicalError: boolean;
  superEventError: boolean;
  showLabels: boolean;
  setShowLabels: React.Dispatch<React.SetStateAction<boolean>>;
  showCities: boolean;
  setShowCities: React.Dispatch<React.SetStateAction<boolean>>;
  showValues: boolean;
  setShowValues: React.Dispatch<React.SetStateAction<boolean>>;
  showWarMarkers: boolean;
  setShowWarMarkers: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-border bg-secondary/20 px-4 py-3">
      <div className="flex items-center gap-2">
        <Hourglass className="w-4 h-4 text-primary" />
        <span className="text-sm font-medium">時代</span>
        {statsError ? (
          <span className="text-sm text-muted-foreground">無法載入時代數據</span>
        ) : eras.length === 0 ? (
          <Skeleton className="h-9 w-[240px]" />
        ) : (
          <Select
            value={activeEraSlug ?? undefined}
            onValueChange={(v) => setEraChoice(v)}
          >
            <SelectTrigger className="w-[240px] h-9" aria-label="選擇時代">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {eras.map((e) => (
                <SelectItem key={e.era} value={e.era}>
                  {e.label}
                  {e.era === worldStats?.currentEra ? "（當前時代）" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {isCurrentEra && (
          <Badge
            className="bg-primary/15 text-primary border-primary/30"
            variant="outline"
          >
            當前時代
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">視圖</span>
        <div className="flex rounded-lg border border-border overflow-hidden">
          {VIEW_MODES.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setViewMode(m.key)}
              disabled={
                m.key === "political"
                  ? politicalError
                  : m.key === "superEvents"
                    ? superEventError
                    : m.key === "production"
                      ? politicalError || (statsError || eras.length === 0)
                      : m.key !== "normal" &&
                        m.key !== "fertility" &&
                        (statsError || eras.length === 0)
              }
              className={`px-3 py-1.5 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                viewMode === m.key
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-foreground/80 hover:bg-secondary/60"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="show-labels"
            checked={showLabels}
            onCheckedChange={(v) => setShowLabels(v === true)}
          />
          <Label htmlFor="show-labels" className="text-sm font-normal cursor-pointer">
            顯示地區標籤
          </Label>
        </div>
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="show-cities"
            checked={showCities}
            onCheckedChange={(v) => setShowCities(v === true)}
          />
          <Label htmlFor="show-cities" className="text-sm font-normal cursor-pointer">
            顯示城市
          </Label>
        </div>
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="show-values"
            checked={showValues && viewMode !== "normal" && viewMode !== "political"}
            disabled={viewMode === "normal" || viewMode === "political"}
            onCheckedChange={(v) => setShowValues(v === true)}
          />
          <Label
            htmlFor="show-values"
            className={`text-sm font-normal cursor-pointer ${
              viewMode === "normal" || viewMode === "political"
                ? "text-muted-foreground"
                : ""
            }`}
            title={
              viewMode === "normal" || viewMode === "political"
                ? "請先選擇人口／生產素質／科技點數／肥沃度視圖"
                : undefined
            }
          >
            顯示數值
          </Label>
        </div>
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="show-war-markers"
            checked={showWarMarkers}
            onCheckedChange={(v) => setShowWarMarkers(v === true)}
          />
          <Label htmlFor="show-war-markers" className="text-sm font-normal cursor-pointer">
            顯示交戰標記
          </Label>
        </div>
      </div>
    </div>
  );
}
