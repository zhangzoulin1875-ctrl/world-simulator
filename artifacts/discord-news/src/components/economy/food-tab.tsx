import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Loader2,
  ShieldCheck,
  Sprout,
  UtensilsCrossed,
  Wheat,
} from "lucide-react";
import {
  useGetFoodOverview,
  getGetFoodOverviewQueryKey,
  useUpdateFoodPolicies,
} from "@workspace/api-client-react";
import type { FoodOverview } from "@workspace/api-client-react";
import { apiErrorMessage, formatBigNumber } from "@/components/military-shared";
import { useToast } from "@/hooks/use-toast";

export function FoodTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useGetFoodOverview({
    query: {
      queryKey: getGetFoodOverviewQueryKey(),
      staleTime: 1000 * 15,
    },
  });

  const policyMutation = useUpdateFoodPolicies({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetFoodOverviewQueryKey(),
        });
        toast({ title: "糧食政策已更新" });
      },
      onError: (err) =>
        toast({
          title: "政策更新失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-white/15 bg-black/50 py-16 backdrop-blur">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        <span>載入糧食資料中…</span>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-xl border border-white/15 bg-black/50 p-8 text-center backdrop-blur">
        <p className="mb-4 text-sm text-white/70">無法載入糧食資料。</p>
        <button
          onClick={() => refetch()}
          className="rounded-lg bg-white/15 px-4 py-2 text-sm font-semibold transition hover:bg-white/25"
          data-testid="button-retry-food"
        >
          重新載入
        </button>
      </div>
    );
  }

  return <FoodContent overview={data} onTogglePolicy={(p) => policyMutation.mutate({ data: p })} toggling={policyMutation.isPending} />;
}

function FoodContent({
  overview,
  onTogglePolicy,
  toggling,
}: {
  overview: FoodOverview;
  onTogglePolicy: (p: { mobilization?: boolean; rationing?: boolean }) => void;
  toggling: boolean;
}) {
  const surplus = overview.balance >= 0;

  return (
    <div className="space-y-4" data-testid="food-tab">
      {/* 飢荒警示 */}
      {overview.famine && (
        <div
          className="flex items-start gap-3 rounded-xl border border-rose-400/50 bg-rose-950/60 p-4 backdrop-blur"
          data-testid="food-famine-alert"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-300" />
          <div>
            <div className="font-serif font-bold text-rose-200">飢荒警報</div>
            <p className="text-sm text-rose-100/80">
              糧食產出不足以養活全國人口！本回合人口將減少{" "}
              {overview.currentFamineLossPct}%
              ，並拖累各階級滿意度與政治支持度。請提高農民比例、啟用糧食政策或縮減軍隊。
            </p>
            {overview.consecutiveFamineTurns > 0 && (
              <p
                className="mt-1 text-sm text-rose-100/80"
                data-testid="food-famine-consecutive"
              >
                已連續饑荒 {overview.consecutiveFamineTurns} 回合
                {overview.currentFamineLossPct <
                  overview.faminePopulationLossPct &&
                  `，扣幅已自全額 ${overview.faminePopulationLossPct}% 遞減至 ${overview.currentFamineLossPct}%`}
                。
              </p>
            )}
            <p className="mt-1 text-xs text-rose-100/60">
              緩衝機制：連續饑荒前 2 回合全額扣 {overview.faminePopulationLossPct}
              %，之後每回合減半（下限 2%）；生還者保底——饑荒不會把人口扣到低於{" "}
              {formatBigNumber(overview.famineSurvivorFloor)} 人。
            </p>
          </div>
        </div>
      )}

      {/* 總覽卡 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard
          testId="food-stat-production"
          icon={<Wheat className="h-4 w-4 text-amber-300" />}
          label="糧食產出/回合"
          value={formatBigNumber(overview.production.total)}
          extra={
            overview.treaty.inflow > 0 || overview.treaty.outflow > 0
              ? `條約輸入 +${formatBigNumber(overview.treaty.inflow)}｜條約輸出 −${formatBigNumber(overview.treaty.outflow)}`
              : undefined
          }
        />
        <StatCard
          testId="food-stat-consumption"
          icon={<UtensilsCrossed className="h-4 w-4 text-orange-300" />}
          label="糧食消耗/回合"
          value={formatBigNumber(overview.consumption.total)}
          extra={`平民 ${formatBigNumber(overview.consumption.civilian)}｜軍隊 ${formatBigNumber(overview.consumption.military)}`}
        />
        <StatCard
          testId="food-stat-balance"
          icon={
            surplus ? (
              <ShieldCheck className="h-4 w-4 text-emerald-300" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-rose-300" />
            )
          }
          label="結餘/回合"
          value={`${surplus ? "+" : "−"}${formatBigNumber(Math.abs(overview.balance))}`}
          valueClass={surplus ? "text-emerald-300" : "text-rose-300"}
          extra="非累積資源，每回合重新計算"
        />
        <StatCard
          testId="food-stat-farmers"
          icon={<Sprout className="h-4 w-4 text-lime-300" />}
          label="農民比例"
          value={`${overview.farmerPct}%`}
          extra={`平民 ${formatBigNumber(overview.civilians)}｜軍人 ${formatBigNumber(overview.soldiers)}`}
        />
      </div>

      {/* 政策開關 */}
      <div className="rounded-xl border border-white/15 bg-black/50 p-4 backdrop-blur">
        <h3 className="mb-1 font-serif text-base font-bold">糧食政策</h3>
        <p className="mb-3 text-xs text-white/60">
          政策啟用期間，每回合四階級滿意度各 −
          {overview.policies.satisfactionCostPerTurn}（每項政策）。
        </p>
        <div className="grid gap-2 md:grid-cols-2">
          <PolicyCard
            testId="food-policy-mobilization"
            title="增產動員"
            description={`糧食產出 +${overview.policies.outputBonusPct}%`}
            active={overview.policies.mobilization}
            disabled={toggling}
            onToggle={() =>
              onTogglePolicy({ mobilization: !overview.policies.mobilization })
            }
          />
          <PolicyCard
            testId="food-policy-rationing"
            title="節約配給"
            description={`平民糧食消耗 −${overview.policies.rationSavingPct}%`}
            active={overview.policies.rationing}
            disabled={toggling}
            onToggle={() =>
              onTogglePolicy({ rationing: !overview.policies.rationing })
            }
          />
        </div>
      </div>

      {/* 逐地區明細 */}
      <div className="rounded-xl border border-white/15 bg-black/50 p-4 backdrop-blur">
        <h3 className="mb-3 font-serif text-base font-bold">
          各地區糧食產出
          <span className="ml-2 text-xs font-normal text-white/50">
            產出 = 控制面積 × 肥沃度 × 時代指數（{overview.eraIndex}）× 農民比例
          </span>
        </h3>
        {overview.regions.length === 0 ? (
          <p className="text-sm text-white/60">尚未掌控任何地區。</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="food-region-table">
              <thead>
                <tr className="border-b border-white/15 text-left text-xs text-white/60">
                  <th className="py-1.5 pr-3">地區</th>
                  <th className="py-1.5 pr-3 text-right">控制面積 km²</th>
                  <th className="py-1.5 pr-3 text-right">肥沃度</th>
                  <th className="py-1.5 pr-3 text-right">控制人口</th>
                  <th className="py-1.5 pr-3 text-right">農民數</th>
                  <th className="py-1.5 text-right">糧食產出</th>
                </tr>
              </thead>
              <tbody>
                {overview.regions.map((r) => (
                  <tr
                    key={r.regionId}
                    className="border-b border-white/5 last:border-0"
                    data-testid={`food-region-${r.regionId}`}
                  >
                    <td className="py-1.5 pr-3">{r.name}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {formatBigNumber(r.controlledAreaKm2)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {r.fertility ?? "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {formatBigNumber(r.controlledPopulation)}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {formatBigNumber(r.farmers)}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatBigNumber(r.output)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  testId,
  icon,
  label,
  value,
  valueClass = "",
  extra,
}: {
  testId: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClass?: string;
  extra?: string;
}) {
  return (
    <div
      className="rounded-lg border border-white/15 bg-black/50 px-3 py-2.5 backdrop-blur"
      data-testid={testId}
    >
      <div className="flex items-center gap-1.5 text-[11px] text-white/60">
        {icon}
        {label}
      </div>
      <div className={`mt-0.5 text-lg font-bold tabular-nums ${valueClass}`}>
        {value}
      </div>
      {extra && <div className="text-[10px] text-white/50">{extra}</div>}
    </div>
  );
}

function PolicyCard({
  testId,
  title,
  description,
  active,
  disabled,
  onToggle,
}: {
  testId: string;
  title: string;
  description: string;
  active: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`flex items-center justify-between rounded-lg border px-3 py-2.5 ${
        active
          ? "border-amber-300/60 bg-amber-500/15"
          : "border-white/15 bg-black/40"
      }`}
      data-testid={testId}
    >
      <div>
        <div className="text-sm font-bold">{title}</div>
        <div className="text-xs text-white/60">{description}</div>
      </div>
      <button
        onClick={onToggle}
        disabled={disabled}
        className={`rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-50 ${
          active
            ? "bg-rose-500/80 hover:bg-rose-500"
            : "bg-emerald-500/80 text-black hover:bg-emerald-400"
        }`}
        data-testid={`${testId}-toggle`}
      >
        {active ? "停用" : "啟用"}
      </button>
    </div>
  );
}
