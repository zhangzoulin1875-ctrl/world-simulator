import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useListMapRegions,
  useGetWorldEraStats,
  useListMapCities,
  useGetMapPolitical,
  useGetPlayerNation,
  getGetPlayerNationQueryKey,
  useRenameMapCity,
  getListMapCitiesQueryKey,
} from "@workspace/api-client-react";
import { GameNotifications } from "@/components/game-notifications";
import { resolveCurrentEraLabel } from "@/lib/eraLabel";
import { formatPopulation } from "@/lib/formatNumber";
import type { MapRegionEntry, MapCityEntry } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Map as MapIcon, Search, X } from "lucide-react";
import {
  WorldDistrictMap,
  type MapLegend,
  type MapSwatchLegend,
  type MapCityPoint,
} from "@/components/world-district-map";
import {
  VIEW_MODES,
  NATION_SORTS,
  VIEW_COLORS,
  VIEW_LABELS,
  NATION_COLORS,
  PRODUCTION_VIEW_COLOR,
  politicalNationLabel,
  tintFromWhite,
  dimFill,
  makeRankScale,
  formatMetric,
  type ViewMode,
  type NationSort,
  type MapSuperEvent,
  type PoliticalNationEntry,
  type RegionEraStatsEntry,
} from "@/components/world-map/shared";
import { buildWarFronts, warFrontLabel } from "@/lib/warFronts";
import { MapControlBar } from "@/components/world-map/map-control-bar";
import { NationPanel } from "@/components/world-map/nation-panel";
import { RegionDetailCard } from "@/components/world-map/region-detail-card";
import { RegionList } from "@/components/world-map/region-list";
import { RenameCityDialog } from "@/components/world-map/rename-city-dialog";
import { ResetCityNamesButton } from "@/components/world-map/reset-city-names-button";

/** 初始狀態可由網址參數帶入（?view=population&era=modern&labels=1&values=1&cities=0）。 */
function readInitialParams() {
  const sp = new URLSearchParams(window.location.search);
  const view = sp.get("view");
  const sort = sp.get("sort");
  return {
    view: (VIEW_MODES.some((m) => m.key === view) ? view : "normal") as ViewMode,
    era: sp.get("era"),
    labels: sp.get("labels") === "1",
    values: sp.get("values") === "1",
    // 預設顯示城市；?cities=0 可關閉
    cities: sp.get("cities") !== "0",
    sort: (NATION_SORTS.some((s) => s.key === sort) ? sort : "default") as NationSort,
    nationQuery: sp.get("nq") ?? "",
  };
}

/**
 * 世界地圖頁的鈴鐺通知：僅在已登入且已建國時顯示（與其他遊戲頁一致）。
 * 未登入時 getPlayerNation 會 401 — 不重試、不顯示，避免對訪客報錯。
 */
function WorldMapNotifications() {
  const { data } = useGetPlayerNation({
    query: {
      queryKey: getGetPlayerNationQueryKey(),
      staleTime: 1000 * 30,
      retry: false,
    },
  });
  if (!data?.hasNation) return null;
  return <GameNotifications variant="light" />;
}

/** 管理端獨立頁（儀表板內、AdminOnly）。 */
export default function WorldMap() {
  return (
    <WorldMapExplorer
      headerExtra={
        // Task #503 — 恢復城市預設名按鈕僅在管理端 wrapper 傳入；
        // 玩家端 /game/map 與未登入唯讀地圖不會出現。
        <div className="flex items-center gap-3">
          <ResetCityNamesButton />
          <WorldMapNotifications />
        </div>
      }
    />
  );
}

/** 世界地圖瀏覽器 — 可嵌入遊戲子頁或管理端頁面共用。 */
export function WorldMapExplorer({
  headerExtra,
  linkNationsToDiplomacy = false,
  enableCityRename = false,
}: {
  /** 頁首右側附加內容（如 /world-map 的鈴鐺通知）。 */
  headerExtra?: React.ReactNode;
  /**
   * 登入後的 /game/map：讓國情面板每列可點選，導向 /game/diplomacy 並選中該國。
   * 唯讀的 /world-map（未登入／管理員）維持 false，不導向。
   */
  linkNationsToDiplomacy?: boolean;
  /**
   * Task #311 — 登入後的 /game/map：允許玩家為「自己歸屬」的城市更名。
   * 唯讀的 /world-map 維持 false（僅顯示歸屬，不提供更名）。
   */
  enableCityRename?: boolean;
} = {}) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useListMapRegions();
  const {
    data: worldStats,
    isLoading: statsLoading,
    isError: statsError,
  } = useGetWorldEraStats();
  const { data: citiesData } = useListMapCities();
  const { data: politicalData, isError: politicalError } = useGetMapPolitical();

  // 超事件圖層（公開唯讀，非 spec — 以原始 fetch 讀取）。
  const { data: superEventData, isError: superEventError } = useQuery({
    queryKey: ["map-super-events"],
    queryFn: async (): Promise<{ events: MapSuperEvent[] }> => {
      const res = await fetch(`${import.meta.env.BASE_URL}api/map/super-events`);
      if (!res.ok) throw new Error("failed to load super events");
      return (await res.json()) as { events: MapSuperEvent[] };
    },
    staleTime: 1000 * 20,
  });

  // 進行中戰役（公開唯讀，非 spec）；60 秒輪詢。
  const { data: activeCampaignsData } = useQuery({
    queryKey: ["active-campaigns-map"],
    queryFn: async (): Promise<{
      campaigns: {
        id: number;
        attackerRegionId: number;
        defenderRegionId: number;
        attackerNationName: string;
        defenderNationName: string;
      }[];
    }> => {
      const res = await fetch(`${import.meta.env.BASE_URL}api/war/active-campaigns-map`);
      if (!res.ok) throw new Error("failed to load active campaigns");
      return (await res.json()) as {
        campaigns: {
          id: number;
          attackerRegionId: number;
          defenderRegionId: number;
          attackerNationName: string;
          defenderNationName: string;
        }[];
      };
    },
    staleTime: 1000 * 60,
    refetchInterval: 1000 * 60,
  });

  // Task #311 — 更名功能需知道自己的國家 id（僅 /game/map 啟用）。
  const { data: myNationData } = useGetPlayerNation({
    query: {
      queryKey: getGetPlayerNationQueryKey(),
      enabled: enableCityRename,
      staleTime: 1000 * 30,
      retry: false,
    },
  });
  const myNationId = myNationData?.nation?.id ?? null;

  // 更名對話框狀態。
  const [renameCity, setRenameCity] = useState<MapCityEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameMutation = useRenameMapCity({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListMapCitiesQueryKey() });
        toast({ title: "已更新城市名稱" });
        setRenameCity(null);
      },
      onError: (err: unknown) => {
        const msg =
          err instanceof Error ? err.message : "更名失敗，請稍後再試";
        toast({ title: "更名失敗", description: msg, variant: "destructive" });
      },
    },
  });

  const [initial] = useState(readInitialParams);
  const [qInput, setQInput] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // null = 跟隨全域當前時代；一旦選擇即固定，切換地區不重設
  const [eraChoice, setEraChoice] = useState<string | null>(initial.era);
  const [viewMode, setViewMode] = useState<ViewMode>(initial.view);
  const [showLabels, setShowLabels] = useState(initial.labels);
  const [showValues, setShowValues] = useState(initial.values);
  const [showCities, setShowCities] = useState(initial.cities);
  const [showWarMarkers, setShowWarMarkers] = useState(true);
  const [nationSort, setNationSort] = useState<NationSort>(initial.sort);
  const [nationQuery, setNationQuery] = useState(initial.nationQuery);

  // 地圖控制項寫回網址（?view=&era=&labels=&values=&cities=&sort=&nq=）；
  // 預設值移除參數，其餘查詢字串照舊保留。
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (viewMode === "normal") sp.delete("view");
    else sp.set("view", viewMode);
    if (eraChoice == null) sp.delete("era");
    else sp.set("era", eraChoice);
    if (showLabels) sp.set("labels", "1");
    else sp.delete("labels");
    if (showValues) sp.set("values", "1");
    else sp.delete("values");
    // 城市預設顯示；僅在關閉時寫入 cities=0
    if (showCities) sp.delete("cities");
    else sp.set("cities", "0");
    if (nationSort === "default") sp.delete("sort");
    else sp.set("sort", nationSort);
    const nq = nationQuery.trim();
    if (nq === "") sp.delete("nq");
    else sp.set("nq", nq);
    const qs = sp.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`,
    );
  }, [viewMode, eraChoice, showLabels, showValues, showCities, nationSort, nationQuery]);

  const q = qInput.trim();

  const regionById = useMemo(() => {
    const m = new Map<number, MapRegionEntry>();
    for (const group of data?.macroRegions ?? []) {
      for (const r of group.regions) m.set(r.id, r);
    }
    return m;
  }, [data]);

  const regionByName = useMemo(() => {
    const m = new Map<string, MapRegionEntry>();
    for (const r of regionById.values()) m.set(r.name, r);
    return m;
  }, [regionById]);

  // 進行中戰役的交戰地區名稱集合（由 regionId → name 轉換）。
  const activeWarRegionNames = useMemo(() => {
    const s = new Set<string>();
    for (const c of activeCampaignsData?.campaigns ?? []) {
      const ar = regionById.get(c.attackerRegionId);
      const dr = regionById.get(c.defenderRegionId);
      if (ar) s.add(ar.name);
      if (dr) s.add(dr.name);
    }
    return s;
  }, [activeCampaignsData, regionById]);

  // 戰線（攻方地區 → 守方地區）；regionId 找不到的戰役略過。
  const warFronts = useMemo(() => {
    const nameById = new Map<number, string>();
    for (const [id, r] of regionById) nameById.set(id, r.name);
    return buildWarFronts(activeCampaignsData?.campaigns ?? [], nameById);
  }, [activeCampaignsData, regionById]);

  // ── 歷史城市 ──
  const cityPoints = useMemo((): MapCityPoint[] => {
    return (citiesData?.cities ?? []).map((c) => ({
      name: c.name,
      lat: c.lat,
      lng: c.lng,
      regionName: c.regionName,
      ownerNationName: c.ownerNationName,
    }));
  }, [citiesData]);

  const citiesByRegionId = useMemo(() => {
    const m = new Map<number, MapCityEntry[]>();
    for (const c of citiesData?.cities ?? []) {
      const list = m.get(c.regionId) ?? [];
      list.push(c);
      m.set(c.regionId, list);
    }
    return m;
  }, [citiesData]);

  // ── 時代狀態（頁面層級） ──
  const eras = worldStats?.eras ?? [];
  const activeEraSlug = useMemo(() => {
    if (eraChoice && eras.some((e) => e.era === eraChoice)) return eraChoice;
    return worldStats?.currentEra ?? null;
  }, [eraChoice, eras, worldStats]);
  const eraIndex = activeEraSlug ? eras.findIndex((e) => e.era === activeEraSlug) : -1;
  const activeEraLabel = eraIndex >= 0 ? eras[eraIndex]!.label : null;
  const isCurrentEra = activeEraSlug != null && activeEraSlug === worldStats?.currentEra;
  // 科技水準固定以「目前世界時代」表示，不受上方時代篩選（eraChoice）影響。
  const currentEraLabel = useMemo(
    () => resolveCurrentEraLabel(eras, worldStats?.currentEra),
    [eras, worldStats?.currentEra],
  );

  const statsById = useMemo(() => {
    const m = new Map<number, RegionEraStatsEntry>();
    for (const r of worldStats?.regions ?? []) {
      m.set(r.id, {
        population: r.population,
        productivity: r.productivity,
        techPoints: r.techPoints,
      });
    }
    return m;
  }, [worldStats]);

  // ── 政治視圖資料 ──
  const politicalNations = useMemo(
    () => politicalData?.nations ?? [],
    [politicalData],
  );

  const nationById = useMemo(() => {
    const m = new Map<string, PoliticalNationEntry>();
    for (const n of politicalNations) m.set(n.id, n);
    return m;
  }, [politicalNations]);

  /** 玩家自訂顏色優先；未設定時依國家建立順序分配固定顏色（與管理頁一致）。 */
  const colorByNation = useMemo(() => {
    const m = new Map<string, string>();
    politicalNations.forEach((n, i) => {
      m.set(n.id, n.mapColor ?? NATION_COLORS[i % NATION_COLORS.length]!);
    });
    return m;
  }, [politicalNations]);

  /** 各地區的控制清單（依比例高→低排序）。 */
  const controlsByRegionId = useMemo(() => {
    const m = new Map<number, { nationId: string; percent: number; populationBonus: number }[]>();
    for (const c of politicalData?.controls ?? []) {
      const list = m.get(c.regionId) ?? [];
      list.push({ nationId: c.nationId, percent: c.percent, populationBonus: c.populationBonus });
      m.set(c.regionId, list);
    }
    for (const list of m.values()) list.sort((a, b) => b.percent - a.percent);
    return m;
  }, [politicalData]);

  // ── choropleth 填色與數值 ──
  const { fills, valueByName, legend, swatchLegend } = useMemo((): {
    fills: Map<string, string> | null;
    valueByName: Map<string, string> | null;
    legend: MapLegend | null;
    swatchLegend: MapSwatchLegend | null;
  } => {
    if (viewMode === "political") {
      if (!politicalData) {
        return { fills: null, valueByName: null, legend: null, swatchLegend: null };
      }
      const fillMap = new Map<string, string>();
      const valueMap = new Map<string, string>();
      const nationsWithLand = new Set<string>();
      for (const [regionId, list] of controlsByRegionId) {
        const region = regionById.get(regionId);
        if (!region || list.length === 0) continue;
        for (const c of list) nationsWithLand.add(c.nationId);
        const top = list[0]!;
        const color = colorByNation.get(top.nationId);
        if (color) {
          fillMap.set(region.name, tintFromWhite(color, 0.25 + 0.75 * (top.percent / 100)));
        }
        valueMap.set(
          region.name,
          list
            .map((c) => {
              const n = nationById.get(c.nationId);
              return `${n ? politicalNationLabel(n) : c.nationId} ${c.percent}%`;
            })
            .join("、"),
        );
      }
      return {
        fills: fillMap,
        valueByName: valueMap,
        legend: null,
        swatchLegend: {
          title: "各國領土",
          items: politicalNations
            .filter((n) => nationsWithLand.has(n.id))
            .map((n) => ({
              color: colorByNation.get(n.id) ?? "#999999",
              label: `${politicalNationLabel(n)}${n.isNpc ? "（NPC）" : ""}`,
            })),
          emptyText: "目前沒有任何國家控制地區",
        },
      };
    }
    if (viewMode === "superEvents") {
      const events = superEventData?.events ?? [];
      const fillMap = new Map<string, string>();
      const valueMap = new Map<string, string>();
      // 各地區彙整影響它的區域型事件（取最高嚴重度上色，並列出事件名稱）。
      const perRegion = new Map<number, { severity: number; titles: string[] }>();
      let globalCount = 0;
      for (const ev of events) {
        if (ev.scope === "global" || ev.regionIds.length === 0) {
          globalCount += 1;
          continue;
        }
        for (const rid of ev.regionIds) {
          const cur = perRegion.get(rid) ?? { severity: 0, titles: [] };
          cur.severity = Math.max(cur.severity, ev.severity);
          cur.titles.push(ev.title);
          perRegion.set(rid, cur);
        }
      }
      for (const [rid, info] of perRegion) {
        const region = regionById.get(rid);
        if (!region) continue;
        // 嚴重度 1–100 → 由淺橙到深紅。
        fillMap.set(
          region.name,
          tintFromWhite("#b91c1c", 0.2 + 0.8 * (info.severity / 100)),
        );
        valueMap.set(region.name, info.titles.join("、"));
      }
      const regionalCount = events.length - globalCount;
      return {
        fills: fillMap,
        valueByName: valueMap,
        legend: null,
        swatchLegend: {
          title: "進行中的超事件",
          items: [
            { color: tintFromWhite("#b91c1c", 1), label: "嚴重度高" },
            { color: tintFromWhite("#b91c1c", 0.4), label: "嚴重度低" },
            ...(globalCount > 0
              ? [{ color: "#6b7280", label: `全球事件 ${globalCount} 件（影響所有地區）` }]
              : []),
          ],
          emptyText:
            events.length === 0
              ? "目前沒有進行中的超事件"
              : `區域事件影響 ${perRegion.size} 個地區` +
                (regionalCount === 0 ? "" : `（${regionalCount} 件）`),
        },
      };
    }
    if (viewMode === "fertility") {
      // 肥沃度為固定屬性（0–120），不隨時代變動；資料來自 /api/map/regions。
      const entries = [...regionById.values()]
        .filter((r) => r.soilFertility != null)
        .map((r) => ({ name: r.name, v: r.soilFertility! }));
      if (entries.length === 0) {
        return { fills: null, valueByName: null, legend: null, swatchLegend: null };
      }
      const scale = makeRankScale(entries.map((e) => e.v));
      const target = "#166534"; // 深綠：良田
      const fillMap = new Map<string, string>();
      const valueMap = new Map<string, string>();
      let min = Infinity;
      let max = -Infinity;
      for (const e of entries) {
        fillMap.set(e.name, tintFromWhite(target, 0.06 + 0.94 * scale(e.v)));
        valueMap.set(e.name, e.v.toLocaleString("zh-TW"));
        if (e.v < min) min = e.v;
        if (e.v > max) max = e.v;
      }
      return {
        fills: fillMap,
        valueByName: valueMap,
        legend: {
          title: "土壤肥沃度（固定屬性）",
          from: tintFromWhite(target, 0.06),
          to: target,
          minLabel: Number.isFinite(min) ? min.toLocaleString("zh-TW") : "—",
          maxLabel: Number.isFinite(max) ? max.toLocaleString("zh-TW") : "—",
        },
        swatchLegend: null,
      };
    }
    if (viewMode === "production") {
      if (!worldStats || eraIndex < 0) {
        return { fills: null, valueByName: null, legend: null, swatchLegend: null };
      }
      const fillMap = new Map<string, string>();
      const valueMap = new Map<string, string>();
      const entries = worldStats.regions.map((r) => {
        const baseProductivity = r.productivity[eraIndex] ?? 0;
        const regionPop = r.population[eraIndex] ?? 0;
        // 與後端公式一致：FLOOR(productivity × population / 10,000)
        const production = Math.floor((baseProductivity * regionPop) / 10_000);
        return { name: r.name, v: production, productivityQuality: baseProductivity, regionPop };
      });
      const scale = makeRankScale(entries.map((e) => e.v));
      let min = Infinity;
      let max = -Infinity;
      for (const e of entries) {
        fillMap.set(e.name, tintFromWhite(PRODUCTION_VIEW_COLOR, 0.06 + 0.94 * scale(e.v)));
        valueMap.set(
          e.name,
          `生產力 ${e.v.toLocaleString("zh-TW")}（素質 ${e.productivityQuality.toLocaleString("zh-TW")}，人口 ${formatPopulation(e.regionPop)}）`,
        );
        if (e.v < min) min = e.v;
        if (e.v > max) max = e.v;
      }
      return {
        fills: fillMap,
        valueByName: valueMap,
        legend: {
          title: `生產力（${activeEraLabel ?? ""}）`,
          from: tintFromWhite(PRODUCTION_VIEW_COLOR, 0.06),
          to: PRODUCTION_VIEW_COLOR,
          minLabel: Number.isFinite(min) ? min.toLocaleString("zh-TW") : "—",
          maxLabel: Number.isFinite(max) ? max.toLocaleString("zh-TW") : "—",
        },
        swatchLegend: null,
      };
    }
    if (viewMode === "normal" || !worldStats || eraIndex < 0) {
      return { fills: null, valueByName: null, legend: null, swatchLegend: null };
    }
    const metric = viewMode;
    const entries = worldStats.regions.map((r) => ({
      name: r.name,
      v: r[metric][eraIndex] ?? 0,
    }));
    const scale = makeRankScale(entries.map((e) => e.v));
    const target = VIEW_COLORS[metric];
    const fillMap = new Map<string, string>();
    const valueMap = new Map<string, string>();
    let min = Infinity;
    let max = -Infinity;
    for (const e of entries) {
      // 最淺保留一點色調，與底圖的純白/灰有區隔
      fillMap.set(e.name, tintFromWhite(target, 0.06 + 0.94 * scale(e.v)));
      valueMap.set(e.name, formatMetric(metric, e.v));
      if (e.v < min) min = e.v;
      if (e.v > max) max = e.v;
    }
    return {
      fills: fillMap,
      valueByName: valueMap,
      legend: {
        title: `${VIEW_LABELS[metric]}（${activeEraLabel ?? ""}）`,
        from: tintFromWhite(target, 0.06),
        to: target,
        minLabel: Number.isFinite(min) ? formatMetric(metric, min) : "—",
        maxLabel: Number.isFinite(max) ? formatMetric(metric, max) : "—",
      },
      swatchLegend: null,
    };
  }, [
    viewMode,
    worldStats,
    eraIndex,
    activeEraLabel,
    politicalData,
    controlsByRegionId,
    regionById,
    colorByNation,
    nationById,
    politicalNations,
    superEventData,
  ]);

  // 政治視圖：每個被控制地區 → 主控國（比例最高）的國旗與國名，供地圖標籤旁渲染。
  const regionFlagByName = useMemo(() => {
    if (viewMode !== "political") return null;
    const m = new Map<string, { flagUrl: string | null; label: string }>();
    for (const [regionId, list] of controlsByRegionId) {
      const region = regionById.get(regionId);
      if (!region || list.length === 0) continue;
      const top = list[0]!;
      const n = nationById.get(top.nationId);
      m.set(region.name, {
        flagUrl: n?.flagUrl ?? null,
        label: n ? politicalNationLabel(n) : top.nationId,
      });
    }
    return m;
  }, [viewMode, controlsByRegionId, regionById, nationById]);

  // 政治視圖：目前有控制領土的國家清單（依建立順序），供地圖下方國情面板。
  const nationPanel = useMemo(() => {
    const nationsWithLand = new Set<string>();
    for (const list of controlsByRegionId.values()) {
      for (const c of list) nationsWithLand.add(c.nationId);
    }
    const rows = politicalNations
      .filter((n) => nationsWithLand.has(n.id))
      .map((n) => ({
        id: n.id,
        label: politicalNationLabel(n),
        color: colorByNation.get(n.id) ?? "#999999",
        flagUrl: n.flagUrl ?? null,
        government: n.government ?? null,
        population: n.population ?? 0,
        armyPopulation: n.armyPopulation ?? 0,
        woundedPopulation: n.woundedPopulation ?? 0,
        committedPopulation: n.committedPopulation ?? 0,
        armyTrend: n.armyTrend ?? [],
        money: n.money ?? 0,
        techPoints: n.techPoints ?? 0,
        isNpc: n.isNpc,
        isUnowned: n.isUnowned ?? false,
      }));
    // 建立順序（default）保留原陣列順序；其餘為高→低穩定排序。
    if (nationSort === "military") {
      rows.sort((a, b) => b.armyPopulation - a.armyPopulation);
    } else if (nationSort === "population") {
      rows.sort((a, b) => b.population - a.population);
    } else if (nationSort === "money") {
      rows.sort((a, b) => b.money - a.money);
    } else if (nationSort === "techPoints") {
      rows.sort((a, b) => b.techPoints - a.techPoints);
    }
    return rows;
  }, [politicalNations, controlsByRegionId, colorByNation, nationSort]);

  // 名稱搜尋：空字串顯示全部；比對不分大小寫。
  const nationQ = nationQuery.trim().toLowerCase();
  const filteredNationPanel = useMemo(() => {
    if (!nationQ) return nationPanel;
    return nationPanel.filter((n) => n.label.toLowerCase().includes(nationQ));
  }, [nationPanel, nationQ]);

  // 政治視圖搜尋時：符合國名的國家掌控地區維持原色，其餘淡化。
  // 空白搜尋或非政治視圖時沿用原始 fills，不重打 API。
  const displayFills = useMemo(() => {
    if (viewMode !== "political" || !nationQ || !fills) return fills;
    const matchedIds = new Set<string>();
    for (const n of politicalNations) {
      if (politicalNationLabel(n).toLowerCase().includes(nationQ)) {
        matchedIds.add(n.id);
      }
    }
    if (matchedIds.size === 0) return fills;
    const highlightNames = new Set<string>();
    for (const [regionId, list] of controlsByRegionId) {
      if (!list.some((c) => matchedIds.has(c.nationId))) continue;
      const region = regionById.get(regionId);
      if (region) highlightNames.add(region.name);
    }
    const out = new Map<string, string>();
    for (const [name, color] of fills) {
      out.set(name, highlightNames.has(name) ? color : dimFill(color, 0.8));
    }
    return out;
  }, [viewMode, nationQ, fills, politicalNations, controlsByRegionId, regionById]);

  const filteredGroups = useMemo(() => {
    if (!data) return [];
    if (!q) return data.macroRegions;
    return data.macroRegions
      .map((g) => ({
        ...g,
        regions: g.regions.filter(
          (r) =>
            r.name.includes(q) ||
            g.macroRegion.includes(q) ||
            r.neighbors.some((n) => n.name.includes(q)),
        ),
      }))
      .filter((g) => g.regions.length > 0);
  }, [data, q]);

  const selected = selectedId != null ? regionById.get(selectedId) ?? null : null;

  const neighborNames = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(selected.neighbors.map((n) => n.name));
  }, [selected]);

  const selectRegion = (id: number) => {
    setSelectedId((prev) => (prev === id ? null : id));
  };

  const selectRegionByName = (name: string) => {
    const region = regionByName.get(name);
    if (region) selectRegion(region.id);
  };

  return (
    <div className="space-y-8 pb-12 animate-in fade-in duration-500">
      <div className="border-b border-border pb-6">
        <div className="flex items-start justify-between gap-3">
          <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground mb-2 flex items-center gap-3">
            <MapIcon className="w-8 h-8 text-primary" />
            世界地圖
          </h1>
          {headerExtra && <div className="shrink-0 pt-1">{headerExtra}</div>}
        </div>
        <p className="text-muted-foreground text-lg">
          {data
            ? `全世界共 ${data.totalRegions} 個地區，分屬 ${data.macroRegions.length} 個大區。點選任一地區即可查看其陸地接壤關係。`
            : "瀏覽世界各大區與地區的陸地接壤關係。"}
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="搜尋地區或大區名稱…"
          className="pl-9 pr-9"
        />
        {qInput && (
          <button
            type="button"
            onClick={() => setQInput("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="清除搜尋"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {!isLoading && !isError && (
        <div className="space-y-3">
          {/* 地圖控制列：時代、視圖、標示 */}
          <MapControlBar
            statsError={statsError}
            eras={eras}
            activeEraSlug={activeEraSlug}
            setEraChoice={setEraChoice}
            worldStats={worldStats}
            isCurrentEra={isCurrentEra}
            viewMode={viewMode}
            setViewMode={setViewMode}
            politicalError={politicalError}
            superEventError={superEventError}
            showLabels={showLabels}
            setShowLabels={setShowLabels}
            showCities={showCities}
            setShowCities={setShowCities}
            showValues={showValues}
            setShowValues={setShowValues}
            showWarMarkers={showWarMarkers}
            setShowWarMarkers={setShowWarMarkers}
          />

          <WorldDistrictMap
            selectedName={selected?.name ?? null}
            neighborNames={neighborNames}
            onSelect={selectRegionByName}
            fills={displayFills}
            showLabels={showLabels}
            showValues={showValues}
            valueByName={valueByName}
            legend={legend}
            swatchLegend={swatchLegend}
            cities={cityPoints}
            showCities={showCities}
            regionFlags={regionFlagByName}
            activeWarRegionNames={showWarMarkers && viewMode === "political" ? activeWarRegionNames : null}
            warFronts={showWarMarkers && viewMode === "political" ? warFronts : null}
          />

          {showWarMarkers && viewMode === "political" && warFronts.length > 0 && (
            <section
              className="rounded-xl border bg-card p-3 space-y-2"
              aria-label="進行中戰事"
            >
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <span aria-hidden>⚔</span>
                進行中戰事（{warFronts.length}）
              </h3>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {warFronts.map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      className="w-full text-left rounded-lg border px-3 py-2 text-sm hover:bg-muted/60 transition-colors"
                      onClick={() => selectRegionByName(f.defenderRegionName)}
                    >
                      <div className="font-medium">{warFrontLabel(f)}</div>
                      <div className="text-xs text-muted-foreground">
                        {f.attackerRegionName} → {f.defenderRegionName}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {viewMode === "political" && (
            <NationPanel
              politicalError={politicalError}
              currentEraLabel={currentEraLabel}
              nationPanel={nationPanel}
              nationQuery={nationQuery}
              setNationQuery={setNationQuery}
              nationSort={nationSort}
              setNationSort={setNationSort}
              filteredNationPanel={filteredNationPanel}
              linkNationsToDiplomacy={linkNationsToDiplomacy}
              navigate={navigate}
            />
          )}
        </div>
      )}

      {selected && (
        <RegionDetailCard
          selected={selected}
          setSelectedId={setSelectedId}
          controlsByRegionId={controlsByRegionId}
          nationById={nationById}
          colorByNation={colorByNation}
          citiesByRegionId={citiesByRegionId}
          enableCityRename={enableCityRename}
          myNationId={myNationId}
          setRenameCity={setRenameCity}
          setRenameValue={setRenameValue}
          statsById={statsById}
          activeEraLabel={activeEraLabel}
          eraIndex={eraIndex}
          isCurrentEra={isCurrentEra}
          statsLoading={statsLoading}
        />
      )}

      <RegionList
        isLoading={isLoading}
        isError={isError}
        filteredGroups={filteredGroups}
        selectedId={selectedId}
        selected={selected}
        selectRegion={selectRegion}
      />

      {/* Task #311 — 城市更名對話框（僅歸屬玩家可用；留空還原預設名） */}
      <RenameCityDialog
        renameCity={renameCity}
        setRenameCity={setRenameCity}
        renameValue={renameValue}
        setRenameValue={setRenameValue}
        renameMutation={renameMutation}
      />
    </div>
  );
}
