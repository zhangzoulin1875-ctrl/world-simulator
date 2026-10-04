import { useQueryClient } from "@tanstack/react-query";
import { Hourglass, Loader2, X } from "lucide-react";
import {
  getGetMilitaryOverviewQueryKey,
  getGetMilitaryQueueQueryKey,
  getGetPlayerNationQueryKey,
  useCancelMilitaryQueueOrder,
  useGetMilitaryQueue,
} from "@workspace/api-client-react";
import type { MilitaryUnitTemplate } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, formatBigNumber } from "@/components/military-shared";

/**
 * 訓練佇列面板：顯示排隊中的訂單、每回合產能與預估完成回合，可取消（100% 退還）。
 * 功能開關關閉、或佇列是空的時候不渲染任何內容，對未啟用的玩家零影響。
 */
export function TrainingQueuePanel({
  templates,
}: {
  templates: MilitaryUnitTemplate[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // 低頻輪詢：訂單只在回合結算時變動；分頁背景時 react-query 預設會暫停。
  const { data } = useGetMilitaryQueue({
    query: { queryKey: getGetMilitaryQueueQueryKey(), refetchInterval: 60_000 },
  });

  const cancel = useCancelMilitaryQueueOrder({
    mutation: {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getGetMilitaryQueueQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMilitaryOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
        toast({
          title: "已取消訓練",
          description: `退還 ${formatBigNumber(res.refund.refundedUnits)} 單位的全部資源`,
        });
      },
      onError: (err) =>
        toast({ title: "取消失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });

  if (!data || !data.enabled || data.orders.length === 0) return null;

  const nameOf = (id: number) => {
    const t = templates.find((x) => x.id === id);
    return t ? (t.customName ?? t.name) : `兵種 #${id}`;
  };
  const distinct = new Set(data.orders.map((o) => o.templateId)).size;

  return (
    <section
      className="rounded-xl border border-sky-300/30 bg-sky-950/30 p-4"
      data-testid="panel-training-queue"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-sky-100">
          <Hourglass className="h-4 w-4" />
          訓練中（{distinct}/{data.maxTemplates} 種兵種）
        </h3>
        <span className="text-xs text-white/60" data-testid="text-queue-capacity">
          每回合訓練產能 {formatBigNumber(data.capacityPerTurn)} 點
        </span>
      </div>
      <ul className="space-y-2">
        {data.orders.map((o) => {
          const done = o.totalQuantity - o.remaining;
          const pct = o.totalQuantity > 0 ? Math.round((done / o.totalQuantity) * 100) : 0;
          const busy = cancel.isPending && cancel.variables?.data.orderId === o.id;
          return (
            <li
              key={o.id}
              className="rounded-lg border border-white/10 bg-black/40 p-3"
              data-testid={`row-queue-order-${o.id}`}
            >
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-semibold text-white">{nameOf(o.templateId)}</span>
                <span className="text-xs text-white/70">
                  {formatBigNumber(done)} / {formatBigNumber(o.totalQuantity)}
                  {o.turnsToFinish !== null && `（約 ${o.turnsToFinish} 回合完成）`}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full bg-sky-400" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-2 flex justify-end">
                <button
                  onClick={() => cancel.mutate({ data: { orderId: o.id } })}
                  disabled={cancel.isPending}
                  className="flex items-center gap-1 rounded-md border border-white/20 px-2 py-1 text-xs text-white/80 hover:bg-white/10 disabled:opacity-50"
                  title="取消剩餘部分，資源 100% 退還（已完成的單位保留）"
                  data-testid={`button-cancel-queue-${o.id}`}
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                  取消剩餘
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
