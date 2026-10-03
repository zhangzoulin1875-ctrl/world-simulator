import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, ScrollText } from "lucide-react";
import {
  useSubmitWarCampaignOrder,
  getGetWarCampaignDetailQueryKey,
} from "@workspace/api-client-react";
import type { WarCampaignDetail } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";

const MAX_LENGTH = 150;

const LEGACY_LABELS: Record<string, string> = {
  strategy: "戰略指示（舊）",
  attack: "進攻指令（舊）",
  defense: "防禦指令（舊）",
  recon: "偵查指令（舊）",
};

export function OrdersPanel({ detail }: { detail: WarCampaignDetail }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const submittedOrder = detail.myOrders.find((o) => o.orderType === "command") ?? null;
  const legacyOrders = detail.myOrders.filter((o) => o.orderType !== "command");

  const [text, setText] = useState(submittedOrder?.body ?? "");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!touched) setText(submittedOrder?.body ?? "");
  }, [submittedOrder?.body]);

  const mutation = useSubmitWarCampaignOrder({
    mutation: {
      onSuccess: () => {
        setTouched(false);
        toast({ title: "作戰指令已提交" });
        queryClient.invalidateQueries({
          queryKey: getGetWarCampaignDetailQueryKey(detail.id),
        });
      },
      onError: (err) =>
        toast({
          variant: "destructive",
          title: "作戰指令提交失敗",
          description: apiErrorMessage(err),
        }),
    },
  });

  const overLimit = text.length > MAX_LENGTH;

  const handleSubmit = () => {
    const body = text.trim();
    if (!body) {
      toast({ variant: "destructive", title: "指令內容不可為空" });
      return;
    }
    if (overLimit) {
      toast({ variant: "destructive", title: `指令不可超過 ${MAX_LENGTH} 字` });
      return;
    }
    mutation.mutate({ id: detail.id, data: { orderType: "command", body } });
  };

  return (
    <div className="space-y-3">
      {/* 新格式：作戰指令 */}
      <div className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <ScrollText className="h-4 w-4 text-amber-300" />
          本週期作戰指令
        </div>
        <p className="mb-3 text-xs text-white/50">
          輸入本週期的作戰方針，結算時 AI 將依雙方指令推演戰況。
        </p>
        <textarea
          value={text}
          rows={4}
          placeholder="輸入作戰方針，例如：集中主力從北翼突破，配合守備部隊牽制敵方正面……"
          onChange={(e) => {
            setText(e.target.value);
            setTouched(true);
          }}
          className="w-full resize-none rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs leading-relaxed text-white outline-none placeholder:text-white/30 focus:border-amber-300/60"
          data-testid="textarea-order-command"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <span className={`text-[10px] ${overLimit ? "text-red-400" : "text-white/35"}`}>
            {text.length}/{MAX_LENGTH}
            {overLimit && "（超出上限）"}
          </span>
          <div className="flex items-center gap-2">
            {submittedOrder != null && !touched && (
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-200">
                已提交
              </span>
            )}
            <button
              onClick={handleSubmit}
              disabled={
                mutation.isPending ||
                !text.trim() ||
                overLimit ||
                (!touched && submittedOrder != null)
              }
              className="flex items-center gap-1 rounded border border-amber-300/50 bg-amber-500/20 px-2.5 py-1 text-xs font-bold text-amber-100 transition hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="button-submit-order-command"
            >
              {mutation.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
              {submittedOrder != null ? "更新指令" : "提交指令"}
            </button>
          </div>
        </div>
      </div>

      {/* 舊格式指令唯讀顯示 */}
      {legacyOrders.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-white/35">
            歷史指令（僅供參考）
          </p>
          <div className="space-y-2">
            {legacyOrders.map((o) => (
              <div key={o.orderType} className="space-y-0.5">
                <p className="text-[10px] text-white/40">
                  {LEGACY_LABELS[o.orderType] ?? o.orderType}
                </p>
                <p className="text-xs leading-relaxed text-white/60">{o.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
