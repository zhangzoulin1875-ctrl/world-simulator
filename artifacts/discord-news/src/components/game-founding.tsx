import React, { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Crown,
  Factory,
  Flag,
  FlaskConical,
  Hourglass,
  Loader2,
  MapPin,
  Ruler,
  Shield,
  Sprout,
  Upload,
  Users,
  X,
} from "lucide-react";
import {
  useListMapRegions,
  useListClaimedRegions,
  getListClaimedRegionsQueryKey,
  useListUnownedNations,
  getListUnownedNationsQueryKey,
  useFoundNation,
  useClaimUnownedNation,
  useGetMapRegionEraStats,
  getGetMapRegionEraStatsQueryKey,
  useGetWorldEraStats,
  getGetWorldEraStatsQueryKey,
  getGetPlayerNationQueryKey,
  useListFoundingGovernments,
  getListFoundingGovernmentsQueryKey,
} from "@workspace/api-client-react";
import {
  VIEW_COLORS,
  tintFromWhite,
  makeRankScale,
} from "@/components/world-map/shared";
import type {
  MapRegionEntry,
  UnownedNation,
  WorldEraStatsRegion,
  FoundNationRequestGovernment,
} from "@workspace/api-client-react";
import { WorldDistrictMap } from "@/components/world-district-map";
import { useToast } from "@/hooks/use-toast";
import { uploadPlayerImage } from "@/lib/player-image-upload";
import { formatPopulation } from "@/lib/formatNumber";
import { apiErrorMessage } from "@/components/military-shared";

const CLAIMED_FILL = "#6b7280";

/** 建國地圖可切換的視圖（子集，不含生産力／政治／超事件）。 */
type FoundingViewMode = "normal" | "population" | "productivity" | "techPoints" | "fertility";

const FOUNDING_VIEW_MODES: { key: FoundingViewMode; label: string }[] = [
  { key: "normal", label: "一般" },
  { key: "population", label: "人口" },
  { key: "productivity", label: "生産素質" },
  { key: "techPoints", label: "科技點數" },
  { key: "fertility", label: "肥沃度" },
];

// Task #433 — 決策難易度提示（0–100，越高越難通過決策）；數值由 API（後端 SSOT）提供。
function decisionDifficultyTier(value: number): {
  label: string;
  className: string;
} {
  if (value <= 30) return { label: "容易", className: "text-emerald-300" };
  if (value <= 55) return { label: "中等", className: "text-amber-300" };
  return { label: "偏難", className: "text-rose-300" };
}

type Mode = "create" | "claim";

/** 尚未建國的玩家看到的建國引導畫面（全螢幕，取代遊戲首頁）。 */
export function GameFounding() {
  const [mode, setMode] = useState<Mode>("create");

  return (
    <div
      className="relative flex h-full flex-col overflow-y-auto text-white"
      data-testid="page-game-founding"
    >
      <header className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="font-serif text-xl font-bold md:text-2xl">建立你的國家</h1>
            <p className="text-xs text-white/65 md:text-sm">
              你尚未擁有國家。選擇一塊起始地區自創國家，或接手一個無主國家。
            </p>
          </div>
        </div>
        <div className="flex gap-2" data-testid="founding-mode-tabs">
          <button
            onClick={() => setMode("create")}
            className={`rounded-lg border px-4 py-2 text-sm font-semibold backdrop-blur transition ${
              mode === "create"
                ? "border-amber-300/80 bg-amber-500/25 text-amber-100"
                : "border-white/20 bg-black/45 text-white/80 hover:bg-black/70"
            }`}
            data-testid="tab-create-nation"
          >
            自創國家
          </button>
          <button
            onClick={() => setMode("claim")}
            className={`rounded-lg border px-4 py-2 text-sm font-semibold backdrop-blur transition ${
              mode === "claim"
                ? "border-amber-300/80 bg-amber-500/25 text-amber-100"
                : "border-white/20 bg-black/45 text-white/80 hover:bg-black/70"
            }`}
            data-testid="tab-claim-nation"
          >
            接手無主國家
          </button>
        </div>
      </header>

      <div className="flex-1 px-4 pb-8">
        {mode === "create" ? <CreateNationFlow /> : <ClaimNationFlow />}
      </div>
    </div>
  );
}

/** 圖片選擇欄位：上傳＋預覽＋清除。 */
function ImageField({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string | null;
  onChange: (url: string | null) => void;
  testId: string;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const url = await uploadPlayerImage(file);
      onChange(url);
    } catch (err) {
      toast({
        variant: "destructive",
        title: `${label}上傳失敗`,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <div className="mb-1 text-xs text-white/65">{label}（選填）</div>
      <div className="flex items-center gap-2">
        {value ? (
          <img
            src={value}
            alt={label}
            className="h-10 w-14 rounded border border-white/25 object-cover"
          />
        ) : (
          <div className="flex h-10 w-14 items-center justify-center rounded border border-dashed border-white/25 bg-white/5">
            <Flag className="h-4 w-4 text-white/35" />
          </div>
        )}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/45 px-3 py-1.5 text-xs font-semibold transition hover:bg-black/70 disabled:opacity-50"
          data-testid={`upload-${testId}`}
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          上傳圖片
        </button>
        {value && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="flex items-center gap-1 rounded-lg border border-white/15 bg-black/35 px-2 py-1.5 text-xs text-white/70 transition hover:bg-black/60"
            data-testid={`clear-${testId}`}
          >
            <X className="h-3.5 w-3.5" />
            清除
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

/** 建國資料面板的單一數據格。 */
function FoundingStatTile({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-2">
      <div className="mb-0.5 flex items-center gap-1 text-[11px] text-white/55">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold tabular-nums leading-tight text-white/90">
        {value}
      </div>
    </div>
  );
}

/**
 * 選定起始地區後顯示該地塊的基本資料（人口／生產素質／科技點數／土壤肥沃度／面積），
 * 數值以世界目前的數據時代呈現。僅在選定地區時掛載。
 */
function RegionStatsPanel({ region }: { region: MapRegionEntry }) {
  const { data, isLoading, isError } = useGetMapRegionEraStats(region.id);

  if (isLoading) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-xs text-white/55">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        載入地塊資料中…
      </div>
    );
  }

  const currentEraEntry =
    data?.eras.find((e) => e.isCurrent) ??
    data?.eras.find((e) => e.era === data.currentEra) ??
    null;

  if (isError || !data || !currentEraEntry) {
    return (
      <div className="mt-3 rounded-xl border border-white/10 bg-black/30 px-3 py-3 text-xs text-amber-300/90">
        無法載入地塊資料，請稍後再試。
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-white/75">
        <Hourglass className="h-3.5 w-3.5 text-amber-300" />
        地塊資料
        <span className="font-normal text-white/50">（{currentEraEntry.label}）</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <FoundingStatTile
          icon={<Users className="h-3 w-3" />}
          label="人口"
          value={formatPopulation(currentEraEntry.population)}
        />
        <FoundingStatTile
          icon={<Factory className="h-3 w-3" />}
          label="生產素質"
          value={currentEraEntry.productivity.toLocaleString("zh-TW")}
        />
        <FoundingStatTile
          icon={<FlaskConical className="h-3 w-3" />}
          label="科技點數"
          value={currentEraEntry.techPoints.toLocaleString("zh-TW")}
        />
        <FoundingStatTile
          icon={<Sprout className="h-3 w-3" />}
          label="土壤肥沃度"
          value={region.soilFertility != null ? String(region.soilFertility) : "—"}
        />
        <FoundingStatTile
          icon={<Ruler className="h-3 w-3" />}
          label="領土面積"
          value={
            region.areaKm2 != null
              ? `${region.areaKm2.toLocaleString("zh-TW")} km²`
              : "—"
          }
        />
      </div>
    </div>
  );
}

/**
 * 依控制比例彙整無主國家掌控地區於指定時代的數據：
 * 人口／科技點數為 Σ(percent/100 × 地區數值)，生產素質為以 percent 加權的平均值，
 * 與遊戲內國家數值的計算方式一致（僅未套用安定度等後續修正）。
 */
function aggregateNationStats(
  regions: UnownedNation["regions"],
  statsById: Map<number, WorldEraStatsRegion>,
  eraIdx: number,
): { population: number; productivity: number; techPoints: number } | null {
  if (eraIdx < 0) return null;
  let population = 0;
  let techPoints = 0;
  let productivityWeighted = 0;
  let percentSum = 0;
  let matched = 0;
  for (const r of regions) {
    const s = statsById.get(r.id);
    if (!s) continue;
    matched += 1;
    const pop = s.population[eraIdx] ?? 0;
    const tech = s.techPoints[eraIdx] ?? 0;
    const prod = s.productivity[eraIdx] ?? 0;
    population += (r.percent / 100) * pop;
    techPoints += (r.percent / 100) * tech;
    productivityWeighted += r.percent * prod;
    percentSum += r.percent;
  }
  if (matched === 0) return null;
  return {
    population: Math.round(population),
    productivity: percentSum > 0 ? Math.round(productivityWeighted / percentSum) : 0,
    techPoints: Math.round(techPoints),
  };
}

/** 無主國家卡片上的彙整地塊數據（人口／生產素質／科技點數）。 */
function ClaimNationStats({
  nation,
  statsById,
  eraIdx,
  eraLabel,
  isLoading,
  isError,
}: {
  nation: UnownedNation;
  statsById: Map<number, WorldEraStatsRegion>;
  eraIdx: number;
  eraLabel: string | null;
  isLoading: boolean;
  isError: boolean;
}) {
  if (nation.regions.length === 0) return null;

  if (isLoading) {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] text-white/55">
        <Loader2 className="h-3 w-3 animate-spin" />
        載入地塊資料中…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mt-3 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] text-amber-300/90">
        無法載入地塊資料，請稍後再試。
      </div>
    );
  }

  const agg = aggregateNationStats(nation.regions, statsById, eraIdx);
  if (!agg) {
    return (
      <div className="mt-3 rounded-lg border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] text-white/50">
        暫無地塊資料。
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-2.5">
      <div className="mb-1.5 flex items-center gap-1 text-[11px] font-semibold text-white/70">
        <Hourglass className="h-3 w-3 text-amber-300" />
        地塊資料
        {eraLabel && <span className="font-normal text-white/45">（{eraLabel}）</span>}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <FoundingStatTile
          icon={<Users className="h-3 w-3" />}
          label="人口"
          value={formatPopulation(agg.population)}
        />
        <FoundingStatTile
          icon={<Factory className="h-3 w-3" />}
          label="生產素質"
          value={agg.productivity.toLocaleString("zh-TW")}
        />
        <FoundingStatTile
          icon={<FlaskConical className="h-3 w-3" />}
          label="科技點數"
          value={agg.techPoints.toLocaleString("zh-TW")}
        />
      </div>
    </div>
  );
}

/** 已選地區的生產力列表面板（最多 5 塊）。 */
function SelectedRegionsPanel({
  selectedIds,
  regionById,
  worldEra,
  productionCap,
  onRemove,
}: {
  selectedIds: Set<number>;
  regionById: Map<number, MapRegionEntry>;
  worldEra: string | null;
  productionCap: number | null;
  onRemove: (id: number) => void;
}) {
  const ids = [...selectedIds];
  // React hooks 不能在迴圈內呼叫，固定展開 5 個（多出的設 enabled: false）
  const id1 = ids[0] ?? null;
  const id2 = ids[1] ?? null;
  const id3 = ids[2] ?? null;
  const id4 = ids[3] ?? null;
  const id5 = ids[4] ?? null;

  const { data: d1 } = useGetMapRegionEraStats(id1!, {
    query: { enabled: id1 != null, queryKey: getGetMapRegionEraStatsQueryKey(id1!) },
  });
  const { data: d2 } = useGetMapRegionEraStats(id2!, {
    query: { enabled: id2 != null, queryKey: getGetMapRegionEraStatsQueryKey(id2!) },
  });
  const { data: d3 } = useGetMapRegionEraStats(id3!, {
    query: { enabled: id3 != null, queryKey: getGetMapRegionEraStatsQueryKey(id3!) },
  });
  const { data: d4 } = useGetMapRegionEraStats(id4!, {
    query: { enabled: id4 != null, queryKey: getGetMapRegionEraStatsQueryKey(id4!) },
  });
  const { data: d5 } = useGetMapRegionEraStats(id5!, {
    query: { enabled: id5 != null, queryKey: getGetMapRegionEraStatsQueryKey(id5!) },
  });

  const eraStatByRegionId = useMemo(() => {
    const m = new Map<number, number>();
    for (const [id, d] of [
      [id1, d1],
      [id2, d2],
      [id3, d3],
      [id4, d4],
      [id5, d5],
    ] as [number | null, typeof d1][]) {
      if (id == null || !d) continue;
      const entry = d.eras.find((e) => e.isCurrent) ?? d.eras.find((e) => e.era === d.currentEra);
      if (entry) {
        m.set(id, Math.floor((entry.productivity * entry.population) / 10_000));
      }
    }
    return m;
  }, [id1, id2, id3, id4, id5, d1, d2, d3, d4, d5]);

  if (ids.length === 0) return null;

  const total = ids.reduce((sum, id) => sum + (eraStatByRegionId.get(id) ?? 0), 0);
  const hasAll = ids.every((id) => eraStatByRegionId.has(id));
  const capExceeded = productionCap != null && total > productionCap;

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-white/75">
        <MapPin className="h-3.5 w-3.5 text-amber-300" />
        已選地區（{ids.length}/5）
      </div>
      <div className="space-y-1.5">
        {ids.map((id) => {
          const region = regionById.get(id);
          const prod = eraStatByRegionId.get(id);
          return (
            <div
              key={id}
              className="flex items-center justify-between rounded-lg border border-white/10 bg-black/25 px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-white/90">
                  {region?.name ?? `地區 ${id}`}
                </div>
                <div className="text-[11px] text-white/50">
                  {prod != null ? (
                    <>
                      <Factory className="mr-0.5 inline h-2.5 w-2.5" />
                      生產力 {prod.toLocaleString("zh-TW")}
                    </>
                  ) : (
                    "載入中…"
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onRemove(id)}
                className="ml-2 shrink-0 rounded border border-white/15 bg-black/40 p-1 text-white/60 transition hover:bg-red-900/40 hover:text-red-300"
                title="移除"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      {ids.length >= 2 && hasAll && productionCap != null && (
        <div
          className={`mt-2 flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-xs ${
            capExceeded
              ? "border-red-400/40 bg-red-900/20 text-red-300"
              : "border-emerald-400/30 bg-emerald-900/15 text-emerald-300"
          }`}
        >
          <span>生產力合計</span>
          <span className="font-semibold tabular-nums">
            {total.toLocaleString("zh-TW")} / {productionCap.toLocaleString("zh-TW")}
          </span>
        </div>
      )}
    </div>
  );
}

const SELECTED_FILL = "#d97706"; // amber-600 — 已選地區高亮色

function CreateNationFlow() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: regionData, isLoading: regionsLoading } = useListMapRegions();
  const { data: claimedData, isLoading: claimedLoading } = useListClaimedRegions({
    query: { queryKey: getListClaimedRegionsQueryKey() },
  });
  const { data: worldStats } = useGetWorldEraStats({
    query: { queryKey: getGetWorldEraStatsQueryKey() },
  });

  // 多選起始地區（最多 5 塊）
  const [selectedRegionIds, setSelectedRegionIds] = useState<Set<number>>(new Set());
  const [name, setName] = useState("");
  const [leaderName, setLeaderName] = useState("");
  const [flagUrl, setFlagUrl] = useState<string | null>(null);
  const [emblemUrl, setEmblemUrl] = useState<string | null>(null);
  const [government, setGovernment] =
    useState<FoundNationRequestGovernment | null>(null);
  const [foundingViewMode, setFoundingViewMode] = useState<FoundingViewMode>("normal");

  const activeEraIndex = useMemo(() => {
    if (!worldStats) return -1;
    return worldStats.eras.findIndex((e) => e.era === worldStats.currentEra);
  }, [worldStats]);

  const worldEra = worldStats?.currentEra ?? null;

  const regionById = useMemo(() => {
    const m = new Map<number, MapRegionEntry>();
    for (const group of regionData?.macroRegions ?? []) {
      for (const r of group.regions) m.set(r.id, r);
    }
    return m;
  }, [regionData]);

  const regionByName = useMemo(() => {
    const m = new Map<string, MapRegionEntry>();
    for (const r of regionById.values()) m.set(r.name, r);
    return m;
  }, [regionById]);

  const claimedSet = useMemo(
    () => new Set(claimedData?.regionIds ?? []),
    [claimedData],
  );

  /**
   * 地圖填色：
   * - 非 normal 視圖時以 choropleth 為底（人口/生産素質/科技/肥沃度）
   * - 已被掌控的地區永遠以灰色蓋掉（不可選為起始地）
   * - 已選地區以琥珀色高亮顯示（覆蓋在 choropleth 之上，但在已掌控之下）
   */
  const fills = useMemo(() => {
    const m = new Map<string, string>();

    if (foundingViewMode !== "normal" && worldStats && activeEraIndex >= 0) {
      if (foundingViewMode === "fertility") {
        const entries = [...regionById.values()]
          .filter((r) => r.soilFertility != null)
          .map((r) => ({ name: r.name, v: r.soilFertility! }));
        if (entries.length > 0) {
          const scale = makeRankScale(entries.map((e) => e.v));
          const target = "#166534";
          for (const e of entries) {
            m.set(e.name, tintFromWhite(target, 0.06 + 0.94 * scale(e.v)));
          }
        }
      } else {
        const metric = foundingViewMode;
        const entries = worldStats.regions.map((r) => ({
          name: r.name,
          v: r[metric][activeEraIndex] ?? 0,
        }));
        const scale = makeRankScale(entries.map((e) => e.v));
        const target = VIEW_COLORS[metric];
        for (const e of entries) {
          m.set(e.name, tintFromWhite(target, 0.06 + 0.94 * scale(e.v)));
        }
      }
    }

    // 已選地區：琥珀色高亮
    for (const id of selectedRegionIds) {
      const r = regionById.get(id);
      if (r) m.set(r.name, SELECTED_FILL);
    }

    // 已被掌控地區：灰色（最高優先）
    for (const id of claimedSet) {
      const r = regionById.get(id);
      if (r) m.set(r.name, CLAIMED_FILL);
    }
    return m;
  }, [foundingViewMode, worldStats, activeEraIndex, claimedSet, selectedRegionIds, regionById]);

  const selectedRegionNames = useMemo(() => {
    const s = new Set<string>();
    for (const id of selectedRegionIds) {
      const name = regionById.get(id)?.name;
      if (name) s.add(name);
    }
    return s;
  }, [selectedRegionIds, regionById]);

  const { data: foundingGovData, isLoading: foundingGovLoading } =
    useListFoundingGovernments({
      query: { queryKey: getListFoundingGovernmentsQueryKey() },
    });
  const foundingGovernments = foundingGovData?.governments ?? [];
  const foundingProductionCap = foundingGovData?.foundingProductionCap ?? null;

  const foundMutation = useFoundNation({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetPlayerNationQueryKey(), data);
        queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
        const firstId = [...selectedRegionIds][0];
        const firstName = firstId != null ? (regionById.get(firstId)?.name ?? "起始地區") : "起始地區";
        toast({
          title: "建國成功！",
          description: `${data.nation?.name ?? "你的國家"} 已建立（${selectedRegionIds.size} 塊起始領土，以 ${firstName} 為首）。`,
        });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "建國失敗",
          description: apiErrorMessage(err),
        });
        // 地區可能剛被別人佔走，重新整理已掌控地區
        queryClient.invalidateQueries({
          queryKey: getListClaimedRegionsQueryKey(),
        });
      },
    },
  });

  // 選 ≥2 塊時，以實際生產力（productivity × population / 1,000,000）加總做即時前端驗證
  const selectedProductionTotal = useMemo(() => {
    if (!worldStats || activeEraIndex < 0) return null;
    const regionStatsMap = new Map(worldStats.regions.map((r) => [r.name, r]));
    let total = 0;
    for (const id of selectedRegionIds) {
      const region = regionById.get(id);
      if (!region) continue;
      const stats = regionStatsMap.get(region.name);
      if (!stats) continue;
      const productivity = stats.productivity[activeEraIndex] ?? 0;
      const population = stats.population[activeEraIndex] ?? 0;
      total += Math.floor((productivity * population) / 10_000);
    }
    return total;
  }, [selectedRegionIds, worldStats, activeEraIndex, regionById]);

  const productionLimitExceeded =
    selectedRegionIds.size >= 2 &&
    selectedProductionTotal != null &&
    foundingProductionCap != null &&
    selectedProductionTotal > foundingProductionCap;

  const formError = useMemo((): string | null => {
    if (selectedRegionIds.size === 0) return "請在地圖上選擇起始地區（最多 5 塊）";
    if (productionLimitExceeded && selectedProductionTotal != null && foundingProductionCap != null)
      return `所選地區生產力合計（${selectedProductionTotal.toLocaleString("zh-TW")}）超過上限 ${foundingProductionCap.toLocaleString("zh-TW")}，請減少地區或改選生產力較低的地塊`;
    if (!name.trim()) return "請填寫國名";
    if (name.trim().length > 40) return "國名不可超過 40 字";
    if (!leaderName.trim()) return "請填寫領導者名稱";
    if (leaderName.trim().length > 40) return "領導者名稱不可超過 40 字";
    if (!government) return "請選擇建國政體";
    return null;
  }, [selectedRegionIds, productionLimitExceeded, selectedProductionTotal, foundingProductionCap, name, leaderName, government]);

  const submit = () => {
    if (formError || selectedRegionIds.size === 0 || government == null) {
      if (formError) {
        toast({ variant: "destructive", title: "尚未完成", description: formError });
      }
      return;
    }
    foundMutation.mutate({
      data: {
        name: name.trim(),
        leaderName: leaderName.trim(),
        regionIds: [...selectedRegionIds],
        government,
        flagUrl,
        emblemUrl,
      },
    });
  };

  const busy = regionsLoading || claimedLoading;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      {/* 地圖選地區 */}
      <div className="rounded-2xl border border-white/15 bg-black/55 p-3 backdrop-blur">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <MapPin className="h-4 w-4 text-amber-300" />
            選擇起始地區（最多 5 塊）
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-white/50">視圖</span>
            <div className="flex rounded-lg border border-white/15 overflow-hidden">
              {FOUNDING_VIEW_MODES.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onClick={() => setFoundingViewMode(v.key)}
                  disabled={
                    v.key !== "normal" && v.key !== "fertility" && (!worldStats || activeEraIndex < 0)
                  }
                  className={`px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    foundingViewMode === v.key
                      ? "bg-amber-500/70 text-white font-semibold"
                      : "bg-black/35 text-white/65 hover:bg-black/55"
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
          <span className="text-[11px] text-white/45">
            點一下選取，再點一下取消；灰色地區已被掌控；橙色為已選
          </span>
        </div>
        {busy ? (
          <div className="flex h-64 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-white/60" />
          </div>
        ) : (
          <WorldDistrictMap
            selectedName={null}
            neighborNames={new Set()}
            checkmarkRegionNames={selectedRegionNames}
            onSelect={(regionName) => {
              const r = regionByName.get(regionName);
              if (!r) return;
              if (claimedSet.has(r.id)) {
                toast({
                  title: "這個地區已被掌控",
                  description: "請選擇一塊尚未被任何國家掌控的地區。",
                });
                return;
              }
              setSelectedRegionIds((prev) => {
                const next = new Set(prev);
                if (next.has(r.id)) {
                  next.delete(r.id);
                } else if (next.size < 5) {
                  next.add(r.id);
                } else {
                  toast({
                    title: "已達上限",
                    description: "最多可選 5 塊起始地區，請先取消已選的地區再選新地區。",
                  });
                }
                return next;
              });
            }}
            fills={fills}
          />
        )}
        <div className="mt-2 text-xs text-white/55" data-testid="text-selected-region">
          {selectedRegionIds.size === 0 ? (
            "尚未選擇起始地區"
          ) : (
            <span className="text-white/80">
              已選 <span className="font-semibold text-amber-300">{selectedRegionIds.size}</span> 塊地區
              {selectedRegionIds.size === 1 && "（選一塊不受生產力上限限制）"}
              {selectedRegionIds.size >= 2 && selectedProductionTotal != null && foundingProductionCap != null && (
                <span className={productionLimitExceeded ? " text-red-400" : ""}>
                  ，生產力合計 {selectedProductionTotal.toLocaleString("zh-TW")}/{foundingProductionCap.toLocaleString("zh-TW")}
                </span>
              )}
            </span>
          )}
        </div>
        {selectedRegionIds.size > 0 && (
          <SelectedRegionsPanel
            selectedIds={selectedRegionIds}
            regionById={regionById}
            worldEra={worldEra}
            productionCap={foundingProductionCap}
            onRemove={(id) =>
              setSelectedRegionIds((prev) => {
                const next = new Set(prev);
                next.delete(id);
                return next;
              })
            }
          />
        )}
        {/* 若只選了一塊，顯示舊版的詳細統計卡片 */}
        {selectedRegionIds.size === 1 && (() => {
          const onlyId = [...selectedRegionIds][0]!;
          const onlyRegion = regionById.get(onlyId) ?? null;
          return onlyRegion ? <RegionStatsPanel region={onlyRegion} /> : null;
        })()}
      </div>

      {/* 國家資訊表單 */}
      <div className="space-y-4 rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Crown className="h-4 w-4 text-amber-300" />
          國家資訊
        </div>

        <div>
          <div className="mb-1 text-xs text-white/65">國名</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="例如：奧蘭多聯合王國"
            className="w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm outline-none placeholder:text-white/30 focus:border-amber-300/70"
            data-testid="input-nation-name"
          />
        </div>

        <div>
          <div className="mb-1 text-xs text-white/65">領導者名稱</div>
          <input
            value={leaderName}
            onChange={(e) => setLeaderName(e.target.value)}
            maxLength={40}
            placeholder="你的玩家名稱"
            className="w-full rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-sm outline-none placeholder:text-white/30 focus:border-amber-300/70"
            data-testid="input-leader-name"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ImageField label="國旗" value={flagUrl} onChange={setFlagUrl} testId="flag" />
          <ImageField
            label="國徽"
            value={emblemUrl}
            onChange={setEmblemUrl}
            testId="emblem"
          />
        </div>

        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-white/75">
            <Crown className="h-3.5 w-3.5 text-amber-300" />
            選擇政體（三選一）
          </div>
          <div className="space-y-2">
            {foundingGovLoading && (
              <div
                className="flex items-center gap-2 rounded-lg border border-white/15 bg-black/30 p-3 text-xs text-white/50"
                data-testid="loading-founding-governments"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                載入政體選項中…
              </div>
            )}
            {foundingGovernments.map((g) => {
              const selected = government === g.slug;
              const tier = decisionDifficultyTier(g.decisionDifficulty);
              return (
                <button
                  key={g.slug}
                  type="button"
                  onClick={() => setGovernment(g.slug)}
                  className={`w-full rounded-lg border p-3 text-left text-xs leading-relaxed transition ${
                    selected
                      ? "border-amber-300/80 bg-amber-500/15 text-white/90"
                      : "border-white/15 bg-black/30 text-white/60 hover:border-white/35"
                  }`}
                  data-testid={`option-government-${g.slug}`}
                >
                  <div className="mb-0.5 flex items-center justify-between gap-2">
                    <span
                      className={`font-semibold ${
                        selected ? "text-amber-200" : "text-white/80"
                      }`}
                    >
                      {g.label}
                    </span>
                    <span
                      className="flex shrink-0 items-center gap-1 rounded-full border border-white/15 bg-black/40 px-2 py-0.5 text-[10px]"
                      title="政治決策的通過難度（0–100，越高越難通過決策）"
                      data-testid={`badge-decision-difficulty-${g.slug}`}
                    >
                      <span className="text-white/55">決策難易度</span>
                      <span className={`font-semibold ${tier.className}`}>
                        {tier.label} {g.decisionDifficulty}
                      </span>
                    </span>
                  </div>
                  {g.description}
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 text-[11px] leading-relaxed text-white/45">
            決策難易度愈高，政治決策愈需要協商共識、愈難直接通過；愈低則政令愈暢通。
          </div>
          <div className="mt-1.5 text-[11px] leading-relaxed text-white/45">
            其他政體日後可透過「政治」介面改制取得。
          </div>
        </div>

        {formError && <div className="text-xs text-amber-300/90">{formError}</div>}

        <button
          onClick={submit}
          disabled={Boolean(formError) || foundMutation.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500/85 px-4 py-2.5 text-sm font-bold text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="button-found-nation"
        >
          {foundMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          建立國家
        </button>
      </div>
    </div>
  );
}

function ClaimNationFlow() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const { data, isLoading } = useListUnownedNations({
    query: { queryKey: getListUnownedNationsQueryKey() },
  });

  const {
    data: eraStats,
    isLoading: eraStatsLoading,
    isError: eraStatsError,
  } = useGetWorldEraStats({
    query: { queryKey: getGetWorldEraStatsQueryKey() },
  });

  const eraIdx = useMemo(() => {
    if (!eraStats) return -1;
    return eraStats.eras.findIndex((e) => e.era === eraStats.currentEra);
  }, [eraStats]);

  const eraLabel = useMemo(
    () => eraStats?.eras.find((e) => e.era === eraStats.currentEra)?.label ?? null,
    [eraStats],
  );

  const regionStatsById = useMemo(
    () => new Map((eraStats?.regions ?? []).map((r) => [r.id, r])),
    [eraStats],
  );

  const claimMutation = useClaimUnownedNation({
    mutation: {
      onSuccess: (result) => {
        queryClient.setQueryData(getGetPlayerNationQueryKey(), result);
        queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
        toast({
          title: "接手成功！",
          description: `你現在是 ${result.nation?.name ?? "這個國家"} 的領導者。`,
        });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "接手失敗",
          description: apiErrorMessage(err),
        });
        setConfirmingId(null);
        queryClient.invalidateQueries({
          queryKey: getListUnownedNationsQueryKey(),
        });
      },
    },
  });

  const nations = data?.nations ?? [];

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-white/60" />
      </div>
    );
  }

  if (nations.length === 0) {
    return (
      <div className="rounded-2xl border border-white/15 bg-black/55 p-8 text-center backdrop-blur">
        <Shield className="mx-auto mb-3 h-10 w-10 text-white/30" />
        <div className="font-serif text-lg font-bold">目前沒有無主國家</div>
        <p className="mt-1 text-sm text-white/60">
          當其他玩家退出國家後，他們的國家會出現在這裡供人接手。你可以先切換到「自創國家」。
        </p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="unowned-nation-list">
      {nations.map((n: UnownedNation) => (
        <div
          key={n.id}
          className="flex flex-col rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur"
          data-testid={`unowned-nation-${n.id}`}
        >
          <div className="flex items-center gap-3">
            {n.flagUrl ? (
              <img
                src={n.flagUrl}
                alt="國旗"
                className="h-9 w-13 rounded-sm border border-white/20 object-cover"
              />
            ) : (
              <div className="flex h-9 w-13 items-center justify-center rounded-sm border border-dashed border-white/25 bg-white/5 px-2">
                <Flag className="h-4 w-4 text-white/40" />
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate font-serif text-base font-bold">
                {n.name ?? "（未命名國家）"}
              </div>
              <div className="truncate text-xs text-white/60">
                {n.government ?? "政體未定"}
                {n.leaderName ? `・前領導者：${n.leaderName}` : ""}
              </div>
            </div>
            {n.emblemUrl && (
              <img
                src={n.emblemUrl}
                alt="國徽"
                className="ml-auto h-8 w-8 shrink-0 rounded-full border border-white/25 object-cover"
              />
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {n.regions.length === 0 ? (
              <span className="text-xs text-white/50">（無掌控地區）</span>
            ) : (
              n.regions.map((r) => (
                <span
                  key={r.id}
                  className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-white/75"
                >
                  {r.name} {r.percent}%
                </span>
              ))
            )}
          </div>

          <ClaimNationStats
            nation={n}
            statsById={regionStatsById}
            eraIdx={eraIdx}
            eraLabel={eraLabel}
            isLoading={eraStatsLoading}
            isError={eraStatsError}
          />

          <div className="mt-auto pt-3">
            {confirmingId === n.id ? (
              <div className="space-y-2">
                <div className="text-xs text-amber-200/90">
                  確定接手 {n.name ?? "這個國家"}？接手後你將成為其領導者。
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => claimMutation.mutate({ id: n.id })}
                    disabled={claimMutation.isPending}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-amber-500/85 px-3 py-2 text-xs font-bold text-black transition hover:bg-amber-400 disabled:opacity-50"
                    data-testid={`confirm-claim-${n.id}`}
                  >
                    {claimMutation.isPending && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    )}
                    確定接手
                  </button>
                  <button
                    onClick={() => setConfirmingId(null)}
                    className="rounded-lg border border-white/20 bg-black/45 px-3 py-2 text-xs font-semibold transition hover:bg-black/70"
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingId(n.id)}
                className="w-full rounded-lg border border-amber-300/50 bg-amber-500/15 px-3 py-2 text-xs font-bold text-amber-100 transition hover:bg-amber-500/30"
                data-testid={`button-claim-${n.id}`}
              >
                接手這個國家
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
