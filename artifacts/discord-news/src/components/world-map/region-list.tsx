import type { MapRegionEntry, MapMacroRegionGroup } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, AlertTriangle, MountainSnow } from "lucide-react";

/** 底部：地區清單（載入中／錯誤／依大區分組的 chip 清單）。 */
export function RegionList({
  isLoading,
  isError,
  filteredGroups,
  selectedId,
  selected,
  selectRegion,
}: {
  isLoading: boolean;
  isError: boolean;
  filteredGroups: MapMacroRegionGroup[];
  selectedId: number | null;
  selected: MapRegionEntry | null;
  selectRegion: (id: number) => void;
}) {
  return isLoading ? (
    <div className="space-y-6">
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-3">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ))}
    </div>
  ) : isError ? (
    <div className="flex flex-col items-center justify-center py-20 px-4 border border-dashed rounded-xl bg-destructive/5">
      <div className="bg-destructive/10 text-destructive p-4 rounded-full mb-4">
        <AlertTriangle className="w-7 h-7" />
      </div>
      <h2 className="text-xl font-serif font-semibold mb-2">無法載入地圖資料</h2>
      <p className="text-muted-foreground text-center max-w-md">請稍後重新整理再試一次。</p>
    </div>
  ) : filteredGroups.length === 0 ? (
    <div className="flex flex-col items-center justify-center py-20 px-4 border border-dashed rounded-xl bg-secondary/20">
      <div className="bg-secondary text-muted-foreground p-4 rounded-full mb-4">
        <Search className="w-7 h-7" />
      </div>
      <h2 className="text-xl font-serif font-semibold mb-2">找不到符合的地區</h2>
      <p className="text-muted-foreground text-center max-w-md">試著換個關鍵字。</p>
    </div>
  ) : (
    <div className="space-y-8">
      {filteredGroups.map((group) => (
        <section key={group.macroRegion}>
          <div className="flex items-baseline gap-2 mb-3">
            <h3 className="text-lg font-bold font-sans text-foreground uppercase tracking-wider">
              {group.macroRegion}
            </h3>
            <span className="text-sm text-muted-foreground tabular-nums">
              {group.regions.length} 個地區
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {group.regions.map((region) => {
              const isSelected = selectedId === region.id;
              const isNeighborOfSelected =
                selected != null && selected.neighbors.some((n) => n.id === region.id);
              return (
                <button
                  key={region.id}
                  type="button"
                  onClick={() => selectRegion(region.id)}
                  className={`px-3 py-1.5 text-sm rounded-full border transition-colors inline-flex items-center gap-1.5 ${
                    isSelected
                      ? "bg-primary text-primary-foreground border-primary"
                      : isNeighborOfSelected
                        ? "bg-primary/10 text-primary border-primary/50"
                        : "bg-background text-foreground/80 border-border hover:border-primary/50"
                  }`}
                >
                  {region.name}
                  {region.hasNoLandBorder && (
                    <MountainSnow
                      className={`w-3.5 h-3.5 ${isSelected ? "opacity-90" : "text-muted-foreground"}`}
                      aria-label="無陸地接壤"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
