import type React from "react";
import type { MapRegionEntry, MapCityEntry } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { X, MountainSnow, Landmark, Flag, Pencil, Crown } from "lucide-react";
import {
  politicalNationLabel,
  type PoliticalNationEntry,
  type RegionEraStatsEntry,
} from "./shared";
import { RegionEraStatsBlock } from "./region-era-stats-block";
import { RegionBuildingsBlock } from "./region-buildings-block";

/** 選定地區的詳情卡（接壤、控制國家、歷史城市、時代數據）。 */
export function RegionDetailCard({
  selected,
  setSelectedId,
  controlsByRegionId,
  nationById,
  colorByNation,
  citiesByRegionId,
  enableCityRename,
  myNationId,
  setRenameCity,
  setRenameValue,
  statsById,
  activeEraLabel,
  eraIndex,
  isCurrentEra,
  statsLoading,
}: {
  selected: MapRegionEntry;
  setSelectedId: React.Dispatch<React.SetStateAction<number | null>>;
  controlsByRegionId: Map<number, { nationId: string; percent: number }[]>;
  nationById: Map<string, PoliticalNationEntry>;
  colorByNation: Map<string, string>;
  citiesByRegionId: Map<number, MapCityEntry[]>;
  enableCityRename: boolean;
  myNationId: string | null;
  setRenameCity: React.Dispatch<React.SetStateAction<MapCityEntry | null>>;
  setRenameValue: React.Dispatch<React.SetStateAction<string>>;
  statsById: Map<number, RegionEraStatsEntry>;
  activeEraLabel: string | null;
  eraIndex: number;
  isCurrentEra: boolean;
  statsLoading: boolean;
}) {
  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="p-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h2 className="text-2xl font-serif font-bold">{selected.name}</h2>
              <Badge variant="secondary">{selected.macroRegion}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {selected.hasNoLandBorder
                ? "此地區沒有任何陸地接壤。"
                : `與 ${selected.neighbors.length} 個地區陸地接壤。`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="text-muted-foreground hover:text-foreground shrink-0"
            aria-label="關閉詳情"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {selected.hasNoLandBorder || selected.neighbors.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-secondary/50 border border-border rounded-md px-3 py-2 w-fit">
            <MountainSnow className="w-4 h-4" />
            無陸地接壤
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {selected.neighbors.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => setSelectedId(n.id)}
                className="px-3 py-1.5 text-sm rounded-full border bg-background border-border hover:border-primary/60 hover:text-primary transition-colors"
                title={n.macroRegion}
              >
                {n.name}
                <span className="ml-1.5 text-xs text-muted-foreground">{n.macroRegion}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-5 pt-5 border-t border-border/70">
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <Flag className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium">控制國家</span>
          </div>
          {(controlsByRegionId.get(selected.id)?.length ?? 0) === 0 ? (
            <div className="text-sm text-muted-foreground bg-secondary/50 border border-border rounded-md px-3 py-2 w-fit">
              無人控制
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {controlsByRegionId.get(selected.id)!.map((c) => {
                const n = nationById.get(c.nationId);
                return (
                  <span
                    key={c.nationId}
                    className="px-3 py-1.5 text-sm rounded-full border bg-background border-border inline-flex items-center gap-1.5"
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-full inline-block border border-border/60"
                      style={{ background: colorByNation.get(c.nationId) ?? "#999999" }}
                    />
                    {n ? politicalNationLabel(n) : c.nationId}
                    {n?.isNpc && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                        NPC
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {c.percent}%
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        {(citiesByRegionId.get(selected.id)?.length ?? 0) > 0 && (
          <div className="mt-5 pt-5 border-t border-border/70">
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <Landmark className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium">歷史城市</span>
              <span className="text-sm text-muted-foreground tabular-nums">
                {citiesByRegionId.get(selected.id)!.length} 座
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {citiesByRegionId.get(selected.id)!.map((c) => {
                const ownedByMe =
                  enableCityRename &&
                  myNationId !== null &&
                  c.ownerNationId === myNationId;
                return (
                  <span
                    key={c.id}
                    className="px-3 py-1.5 text-sm rounded-full border bg-background border-border inline-flex items-center gap-1.5"
                  >
                    <span className="w-2 h-2 rounded-full bg-[#b91c1c] inline-block" />
                    {c.name}
                    {c.ownerNationName && (
                      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                        <Crown className="w-3 h-3" />
                        {c.ownerNationName}
                      </span>
                    )}
                    {ownedByMe && (
                      <button
                        type="button"
                        className="ml-0.5 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
                        title="更名城市"
                        data-testid={`button-rename-city-${c.id}`}
                        onClick={() => {
                          setRenameCity(c);
                          setRenameValue(
                            c.name === c.defaultName ? "" : c.name,
                          );
                        }}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        {enableCityRename && (
          <RegionBuildingsBlock
            regionId={selected.id}
            myNationId={myNationId}
          />
        )}
        <RegionEraStatsBlock
          region={selected}
          stats={statsById.get(selected.id) ?? null}
          eraLabel={activeEraLabel}
          eraIndex={eraIndex}
          isCurrentEra={isCurrentEra}
          isLoading={statsLoading}
        />
      </CardContent>
    </Card>
  );
}
