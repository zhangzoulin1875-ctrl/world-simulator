import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Coins,
  Loader2,
  Lock,
  Map as MapIcon,
  Wrench,
} from "lucide-react";
import type { EconomyRegions } from "@workspace/api-client-react";
import {
  useGetPlayerNation,
  getGetPlayerNationQueryKey,
  getGetEconomyOverviewQueryKey,
  useGetEconomyRegions,
  getGetEconomyRegionsQueryKey,
  useBuildCityBuilding,
  useDemolishCityBuilding,
  useUpgradeCityWall,
  useInvestRegionProductivity,
} from "@workspace/api-client-react";
import { apiErrorMessage, formatBigNumber } from "@/components/military-shared";
import { useToast } from "@/hooks/use-toast";
import { RegionCard } from "./region-card";
import { BuildDialog } from "./build-dialog";

export function RegionsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [buildTarget, setBuildTarget] = useState<{
    cityId: number;
    cityName: string;
  } | null>(null);

  const { data, isLoading, isError, refetch } = useGetEconomyRegions({
    query: {
      queryKey: getGetEconomyRegionsQueryKey(),
      staleTime: 1000 * 30,
    },
  });
  const { data: nation } = useGetPlayerNation({
    query: { queryKey: getGetPlayerNationQueryKey() },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetEconomyRegionsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetEconomyOverviewQueryKey(),
    });
  };

  const buildMutation = useBuildCityBuilding({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: "建造完成",
          description: `已興建「${res.building.name}」`,
        });
        setBuildTarget(null);
      },
      onError: (err) =>
        toast({
          title: "建造失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });

  const demolishMutation = useDemolishCityBuilding({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "已拆除建築" });
      },
      onError: (err) =>
        toast({
          title: "拆除失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });

  const investMutation = useInvestRegionProductivity({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: "投資完成",
          description: `生產素質 +1（累積 +${res.investmentBonus}），花費 ${formatBigNumber(res.cost)} 金錢`,
        });
      },
      onError: (err) =>
        toast({
          title: "投資失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });

  const upgradeWallMutation = useUpgradeCityWall({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: "城牆升級完成",
          description: `已升級為「${res.tierLabel}」城牆`,
        });
      },
      onError: (err) =>
        toast({
          title: "城牆升級失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });

  if (isLoading) {
    return (
      <section className="flex items-center gap-2 rounded-2xl border border-white/15 bg-black/55 p-6 text-sm text-white/60 backdrop-blur">
        <Loader2 className="h-4 w-4 animate-spin" />
        載入地區資料中…
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section className="rounded-2xl border border-white/15 bg-black/55 p-8 text-center backdrop-blur">
        <p className="mb-4 text-sm text-white/60">讀取地區資料時發生錯誤，請稍後再試。</p>
        <button
          onClick={() => refetch()}
          className="rounded-lg bg-white/15 px-4 py-2 text-sm font-semibold transition hover:bg-white/25"
          data-testid="button-retry-regions"
        >
          重新載入
        </button>
      </section>
    );
  }

  if (data.regions.length === 0) {
    return (
      <section className="rounded-2xl border border-white/15 bg-black/55 p-10 text-center backdrop-blur">
        <MapIcon className="mx-auto mb-3 h-10 w-10 text-white/35" />
        <h2 className="mb-2 font-serif text-lg font-bold text-white/85">尚無掌控地區</h2>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-white/55">
          你目前沒有任何掌控地區，因此沒有可興建的城市。
        </p>
      </section>
    );
  }

  const cityCount = data.regions.reduce((n, r) => n + r.cities.length, 0);
  const upkeepByType = new Map(
    data.availableBuildings.map((b) => [b.type, b.upkeep]),
  );
  let totalUpkeep = 0;
  let builtCount = 0;
  for (const region of data.regions) {
    for (const city of region.cities) {
      for (const b of city.buildings) {
        totalUpkeep += upkeepByType.get(b.type) ?? 0;
        builtCount += 1;
      }
    }
  }
  const money = nation?.nation?.money ?? 0;

  return (
    <div className="space-y-4" data-testid="regions-tab">
      <RegionEconomySection data={data} />

      {!data.buildingSlotsEnabled && (
        <section
          className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur"
          data-testid="regions-locked"
        >
          <Lock className="h-5 w-5 shrink-0 text-white/35" />
          <p className="flex-1 text-xs leading-relaxed text-white/55">
            城市建築槽需先研發社會關鍵技術「部落革新」才會啟用（起始 5 格，上限{" "}
            {data.buildingSlotsMax} 格）。解鎖前仍可對掌控地區進行生產力投資。
          </p>
          <Link
            href="/game/military/research"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold transition hover:bg-white/20"
            data-testid="link-to-research"
          >
            前往科技研發
          </Link>
        </section>
      )}

      <section className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-amber-300" />
          <h2 className="font-serif text-sm font-bold text-white/85">城市建築槽</h2>
        </div>
        <p className="flex-1 text-xs leading-relaxed text-white/55">
          每座城市有
          <span className="mx-1 font-bold text-amber-200">{data.buildingSlotsPerCity}</span>
          格建築槽（上限 {data.buildingSlotsMax}），由已解鎖的社會關鍵技術決定。建築種類由生產科技解鎖，於下方城市槽位建造，每回合結算扣除維護費。
        </p>
        <div
          className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2"
          data-testid="building-upkeep-summary"
          title="建築維護費彙總（回合結算時扣除；風車技術可減免）"
        >
          <Wrench className="h-4 w-4 shrink-0 text-emerald-300" />
          <div className="leading-tight">
            <div className="text-[10px] text-white/55">建築維護費／回合</div>
            <div className="text-sm font-bold tabular-nums text-emerald-200">
              {formatBigNumber(totalUpkeep)}
              <span className="ml-1 text-[10px] font-normal text-white/45">
                （{cityCount} 座城市，{builtCount} 座建築）
              </span>
            </div>
          </div>
        </div>
      </section>

      {data.regions.map((region) => (
        <RegionCard
          key={region.regionId}
          region={region}
          slotsPerCity={data.buildingSlotsPerCity}
          availableBuildings={data.availableBuildings}
          cityWallEnabled={data.cityWallEnabled}
          wallTiers={data.wallTiers}
          demolishPending={demolishMutation.isPending}
          upgradeWallPending={upgradeWallMutation.isPending}
          money={money}
          investPending={investMutation.isPending}
          myNationId={nation?.nation?.id ?? null}
          onInvest={(regionId) =>
            investMutation.mutate({ data: { regionId } })
          }
          onBuildSlot={(cityId, cityName) =>
            setBuildTarget({ cityId, cityName })
          }
          onDemolish={(id) => demolishMutation.mutate({ id })}
          onUpgradeWall={(cityId, tier) =>
            upgradeWallMutation.mutate({ cityId, data: { tier } })
          }
        />
      ))}

      <BuildDialog
        target={buildTarget}
        availableBuildings={data.availableBuildings}
        money={money}
        pending={buildMutation.isPending}
        onBuild={(buildingType) =>
          buildTarget &&
          buildMutation.mutate({
            data: { cityId: buildTarget.cityId, buildingType },
          })
        }
        onClose={() => setBuildTarget(null)}
      />
    </div>
  );
}

type RegionSortKey =
  | "percent"
  | "population"
  | "taxContribution"
  | "productionQuality"
  | "productionContribution";

/** 地區經濟貢獻表：各掌控地區的人口／稅收貢獻／生產素質（數據時代）。 */
function RegionEconomySection({ data }: { data: EconomyRegions }) {
  const eco = data.economy;
  const [sortKey, setSortKey] = useState<RegionSortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  if (data.regions.length === 0) return null;
  const popTotal = data.regions.reduce((n, r) => n + r.population, 0);
  const taxTotal = data.regions.reduce((n, r) => n + r.taxContribution, 0);
  const prodTotal = data.regions.reduce(
    (n, r) => n + r.productionContribution,
    0,
  );
  const sortedRegions = sortKey
    ? [...data.regions].sort((a, b) => {
        const av = a[sortKey] ?? -Infinity;
        const bv = b[sortKey] ?? -Infinity;
        return sortDir === "asc" ? av - bv : bv - av;
      })
    : data.regions;
  const toggleSort = (key: RegionSortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };
  const sortIndicator = (key: RegionSortKey) =>
    sortKey === key ? (sortDir === "desc" ? " ▼" : " ▲") : "";
  const sortableHeader = (
    key: RegionSortKey,
    label: string,
    extraClass = "",
  ) => (
    <th className={`py-2 text-right font-normal ${extraClass}`}>
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className={`cursor-pointer transition hover:text-white/85 ${sortKey === key ? "font-semibold text-white/85" : ""}`}
        title="點擊排序"
        data-testid={`sort-region-${key}`}
      >
        {label}
        {sortIndicator(key)}
      </button>
    </th>
  );
  return (
    <section
      className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur"
      data-testid="region-economy-section"
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-amber-300" />
          <h2 className="font-serif text-sm font-bold text-white/85">
            地區經濟貢獻
          </h2>
        </div>
        <p className="flex-1 text-xs leading-relaxed text-white/55">
          依「{eco.statsEraLabel}」數據計算。稅收貢獻依各地區人口比例分配，加總等於財政分頁的每回合稅收（稅率 {eco.taxRatePct}%、效率 {eco.taxEfficiencyPct}%）。
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-xs">
          <thead>
            <tr className="border-b border-white/15 text-white/55">
              <th className="py-2 pr-3 font-normal">地區</th>
              <th className="py-2 pr-3 font-normal">大區</th>
              {sortableHeader("percent", "掌控", "pr-3")}
              {sortableHeader("population", "人口", "pr-3")}
              {sortableHeader("taxContribution", "稅收貢獻／回合", "pr-3")}
              {sortableHeader("productionQuality", "生產素質", "pr-3")}
              {sortableHeader("productionContribution", "生產力貢獻")}
            </tr>
          </thead>
          <tbody>
            {sortedRegions.map((r) => (
              <tr
                key={r.regionId}
                className="border-b border-white/5 text-white/80"
                data-testid={`region-economy-row-${r.regionId}`}
              >
                <td className="py-1.5 pr-3 font-semibold">{r.name}</td>
                <td className="py-1.5 pr-3 text-white/55">{r.macroRegion}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {r.percent}%
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {formatBigNumber(r.population)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-amber-200">
                  {formatBigNumber(r.taxContribution)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {r.productionQuality == null ? "—" : r.productionQuality}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatBigNumber(r.productionContribution)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="text-white/85">
              <td className="py-2 pr-3 font-bold" colSpan={3}>
                合計（全國人口 {formatBigNumber(eco.totalPopulation)}）
              </td>
              <td className="py-2 pr-3 text-right font-bold tabular-nums">
                {formatBigNumber(popTotal)}
              </td>
              <td
                className="py-2 pr-3 text-right font-bold tabular-nums text-amber-200"
                data-testid="region-economy-tax-total"
              >
                {formatBigNumber(taxTotal)}
              </td>
              <td className="py-2 pr-3" />
              <td className="py-2 text-right font-bold tabular-nums">
                {formatBigNumber(prodTotal)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-white/40">
        每回合稅收合計 {formatBigNumber(eco.taxIncomePerTurn)}（與財政分頁一致）。人口含各地區累積成長量；生產素質為該地區在數據時代的原始數值。
      </p>
    </section>
  );
}
