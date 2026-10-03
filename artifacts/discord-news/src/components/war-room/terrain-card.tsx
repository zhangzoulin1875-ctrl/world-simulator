import { Loader2, Map as MapIcon } from "lucide-react";
import type { WarCampaignDetail } from "@workspace/api-client-react";

// ── 地形敘述 ──────────────────────────────────────────────────

export function TerrainCard({ detail }: { detail: WarCampaignDetail }) {
  return (
    <div className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <MapIcon className="h-4 w-4 text-amber-300" />
        戰場地理
      </div>
      {detail.terrainBrief ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/75" data-testid="text-terrain-brief">
          {detail.terrainBrief}
        </p>
      ) : (
        <p className="flex items-center gap-2 text-sm text-white/50">
          <Loader2 className="h-4 w-4 animate-spin" />
          AI 正在生成戰場地理敘述……
        </p>
      )}
    </div>
  );
}
