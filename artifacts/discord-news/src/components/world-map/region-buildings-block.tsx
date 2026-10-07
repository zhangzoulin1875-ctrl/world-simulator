import { useQueryClient } from "@tanstack/react-query";
import { Hammer, Mountain, Trees, Factory, ArrowUpCircle, Trash2 } from "lucide-react";
import {
  useListRegionBuildings,
  getListRegionBuildingsQueryKey,
  useBuildRegionBuilding,
  useUpgradeRegionBuilding,
  useDemolishRegionBuilding,
  getGetPlayerNationQueryKey,
  getGetEconomyOverviewQueryKey,
} from "@workspace/api-client-react";
import type { RegionBuilding } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

function apiErrorMessage(err: unknown): string {
  const anyErr = err as { response?: { data?: { error?: string } } };
  return anyErr?.response?.data?.error ?? "操作失敗，請稍後再試";
}

const BUILDING_META = {
  lumber_mill: { label: "伐木場", icon: Trees, iconClass: "text-lime-600" },
  mine: { label: "礦場", icon: Mountain, iconClass: "text-stone-500" },
  munitions_plant: { label: "軍工廠", icon: Factory, iconClass: "text-red-500" },
} as const;

/** 兩種外觀：card ＝ 世界地圖地區詳情（淺色語意色板）；dark ＝ 經濟頁玻璃暗卡。 */
const VARIANT_STYLES = {
  card: {
    container: "mt-5 pt-5 border-t border-border/70",
    titleIcon: "w-4 h-4 text-primary",
    title: "text-sm font-medium",
    counter: "text-xs text-muted-foreground tabular-nums",
    note: "mb-3 text-xs text-muted-foreground",
    row: "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-background px-3 py-2 text-sm",
    rowMeta: "text-xs text-muted-foreground tabular-nums",
    upgradeBtn:
      "ml-auto inline-flex items-center gap-1 rounded-md border border-primary/40 px-2.5 py-1 text-xs font-semibold text-primary transition hover:bg-primary/10 disabled:opacity-40",
    demolishBtn:
      "inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2.5 py-1 text-xs font-semibold text-destructive transition hover:bg-destructive/10 disabled:opacity-40",
    maxed: "ml-auto text-xs text-muted-foreground",
    buildBtn:
      "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm transition hover:border-primary/60 hover:text-primary disabled:opacity-40",
  },
  dark: {
    container: "mt-4 pt-4 border-t border-white/10",
    titleIcon: "w-4 h-4 text-amber-300",
    title: "text-sm font-medium text-white/85",
    counter: "text-xs text-white/50 tabular-nums",
    note: "mb-3 text-xs text-white/50",
    row: "flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/85",
    rowMeta: "text-xs text-white/50 tabular-nums",
    upgradeBtn:
      "ml-auto inline-flex items-center gap-1 rounded-md border border-amber-300/40 bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-100 transition hover:bg-amber-500/25 disabled:opacity-40",
    demolishBtn:
      "inline-flex items-center gap-1 rounded-md border border-red-400/40 bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-200 transition hover:bg-red-500/20 disabled:opacity-40",
    maxed: "ml-auto text-xs text-white/45",
    buildBtn:
      "inline-flex items-center gap-1.5 rounded-md border border-white/20 bg-white/5 px-3 py-1.5 text-sm text-white/80 transition hover:border-amber-300/60 hover:text-amber-200 disabled:opacity-40",
  },
} as const;

/**
 * Task #406 — 地區詳情內的建築區塊：只在玩家掌控該地區時顯示，
 * 列出既有建築（等級／產量／工人／升級），並提供建造按鈕。
 * Task #471 — 也嵌入經濟頁「地區」分頁的地區卡（variant="dark"）；
 * 兩處共用同一組 OpenAPI hooks 與 query keys，任一處操作後自動同步。
 */
export function RegionBuildingsBlock({
  regionId,
  myNationId,
  variant = "card",
}: {
  regionId: number;
  myNationId: string | null;
  variant?: keyof typeof VARIANT_STYLES;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const enabled = myNationId !== null;
  const { data } = useListRegionBuildings({
    query: {
      queryKey: getListRegionBuildingsQueryKey(),
      enabled,
      staleTime: 30_000,
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getListRegionBuildingsQueryKey(),
    });
    // 建造／升級會花金錢與生產力 → 同步國家與經濟總覽（經濟頁入口需要）。
    queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetEconomyOverviewQueryKey(),
    });
  };

  const buildMutation = useBuildRegionBuilding({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: "建造完成",
          description: `${res.building.regionName}的${res.building.buildingLabel}已落成`,
        });
      },
      onError: (err) =>
        toast({
          title: "建造失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });
  const upgradeMutation = useUpgradeRegionBuilding({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: "升級完成",
          description: `${res.building.buildingLabel}升到 ${res.building.level} 級`,
        });
      },
      onError: (err) =>
        toast({
          title: "升級失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });
  const demolishMutation = useDemolishRegionBuilding({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: "拆除完成",
          description:
            res.releasedProduction > 0
              ? `已釋放 ${res.releasedProduction.toLocaleString()} 生產力占用`
              : "建築已拆除",
        });
      },
      onError: (err) =>
        toast({
          title: "拆除失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });

  if (!enabled || !data) return null;
  const controlsRegion = data.regions.some((r) => r.regionId === regionId);
  if (!controlsRegion) return null;

  const s = VARIANT_STYLES[variant];
  const regionBuildings = data.buildings.filter(
    (b) => b.regionId === regionId,
  );
  const existingTypes = new Set(regionBuildings.map((b) => b.buildingType));
  const busy =
    buildMutation.isPending ||
    upgradeMutation.isPending ||
    demolishMutation.isPending;

  return (
    <div className={s.container}>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <Hammer className={s.titleIcon} />
        <span className={s.title}>資源建築</span>
        <span className={s.counter}>
          工人 {data.workers.toLocaleString()} / {data.workerCap.toLocaleString()}
        </span>
      </div>
      <p className={s.note}>
        木材 {data.wood.toLocaleString()}・礦石 {data.ore.toLocaleString()}・彈藥{" "}
        {data.ammo.toLocaleString()}・每座每級產出 50／回合、占用工人 1,000、維護 100
        金錢／回合（上限 {data.maxLevel} 級）。
      </p>
      <p className={s.note}>
        軍工廠生產彈藥：火藥時代起，軍隊在戰役中每個週期都要消耗彈藥與口糧；缺糧缺彈的
        部隊補給會下降，跌破 20 後組織崩潰、戰力近乎歸零。彈藥庫存上限＝軍工廠總等級 ×
        5,000。
      </p>
      <div className="flex flex-col gap-2">
        {regionBuildings.map((b: RegionBuilding) => {
          const meta = BUILDING_META[b.buildingType];
          const Icon = meta?.icon ?? Hammer;
          return (
            <div
              key={b.id}
              className={s.row}
              data-testid={`building-${b.id}`}
            >
              <span className="inline-flex items-center gap-1.5 font-medium">
                <Icon className={`w-4 h-4 ${meta?.iconClass ?? ""}`} />
                {b.buildingLabel}
                <span className={s.rowMeta}>Lv.{b.level}</span>
              </span>
              <span className={s.rowMeta}>
                產出 {b.outputPerTurn}/回合
              </span>
              <span className={s.rowMeta}>
                工人 {b.workers.toLocaleString()}
              </span>
              <span className={s.rowMeta}>
                維護 {b.upkeepPerTurn}/回合
              </span>
              {b.upgradeCost ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => upgradeMutation.mutate({ id: b.id })}
                  className={s.upgradeBtn}
                  data-testid={`button-upgrade-building-${b.id}`}
                >
                  <ArrowUpCircle className="w-3.5 h-3.5" />
                  升級（金錢 {b.upgradeCost.money.toLocaleString()}・生產力{" "}
                  {b.upgradeCost.production.toLocaleString()}）
                </button>
              ) : (
                <span className={s.maxed}>已達上限</span>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `確定要拆除${b.buildingLabel}（Lv.${b.level}）嗎？金錢不退還，占用的生產力與工人將立即釋放。`,
                    )
                  ) {
                    demolishMutation.mutate({ id: b.id });
                  }
                }}
                className={s.demolishBtn}
                data-testid={`button-demolish-building-${b.id}`}
              >
                <Trash2 className="w-3.5 h-3.5" />
                拆除
              </button>
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          {(Object.keys(BUILDING_META) as Array<keyof typeof BUILDING_META>)
            .filter((type) => !existingTypes.has(type))
            .map((type) => {
              const meta = BUILDING_META[type];
              const Icon = meta.icon;
              return (
                <button
                  key={type}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    buildMutation.mutate({
                      data: { regionId, buildingType: type },
                    })
                  }
                  className={s.buildBtn}
                  data-testid={`button-build-${type}-${regionId}`}
                >
                  <Icon className={`w-4 h-4 ${meta.iconClass}`} />
                  建造{meta.label}（金錢 {data.buildCost.money.toLocaleString()}・生產力{" "}
                  {data.buildCost.production.toLocaleString()}）
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}
