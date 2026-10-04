import { useQueryClient } from "@tanstack/react-query";
import { Flag, Loader2 } from "lucide-react";
import {
  useListDiplomacyWars,
  getListDiplomacyWarsQueryKey,
  useProposeCeasefire,
  useAcceptCeasefire,
  getListWarCampaignsQueryKey,
} from "@workspace/api-client-react";
import type { DiplomacyNation } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";

// Task #235 — 停戰提案卡片：只在與選定國家有進行中戰爭時顯示，沿用既有的
// 提出停戰／接受停戰端點（以該場戰爭的 id 呼叫）。停戰入口統一在締約分頁。
export function CeasefireCard({ nation }: { nation: DiplomacyNation }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data } = useListDiplomacyWars({
    query: {
      queryKey: getListDiplomacyWarsQueryKey(),
      refetchInterval: 30_000,
    },
  });
  // 找出「與選定國家進行中」的戰爭（伺服器只回傳未結束的戰爭）。
  const war = (data?.wars ?? []).find(
    (w) =>
      w.involvesMe &&
      (w.nationAId === nation.id || w.nationBId === nation.id),
  );

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: getListDiplomacyWarsQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getListWarCampaignsQueryKey(),
    });
    // 若玩家同時開著某場戰役室（詳情鍵含戰役 id），一併使其失效即時更新。
    void queryClient.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey[0];
        return (
          typeof key === "string" && key.startsWith("/api/war/campaigns/")
        );
      },
    });
  };

  const propose = useProposeCeasefire({
    mutation: {
      onSuccess: () => {
        toast({ title: "已提出停戰", description: "等待對方回應停戰提案。" });
        invalidate();
      },
      onError: (err) =>
        toast({ title: "停戰提案失敗", description: apiErrorMessage(err) }),
    },
  });
  const accept = useAcceptCeasefire({
    mutation: {
      onSuccess: () => {
        toast({
          title: "停戰成立",
          description: "戰爭已結束，所有相關戰役即刻終止。",
        });
        invalidate();
      },
      onError: (err) =>
        toast({ title: "接受停戰失敗", description: apiErrorMessage(err) }),
    },
  });

  // 與選定國家沒有進行中的戰爭 → 不顯示這張卡片。
  if (!war) return null;

  return (
    <section
      className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4 backdrop-blur"
      data-testid="ceasefire-card"
    >
      <h3 className="mb-1 flex items-center gap-1.5 text-sm font-bold text-emerald-200">
        <Flag className="h-4 w-4" />
        停戰提案
      </h3>
      <p className="mb-3 text-[11px] text-white/60">
        你正與 {nation.name} 交戰。停戰成立後，這場戰爭與所有相關戰役都會立刻結束。
      </p>
      {war.ceasefireProposedByMe ? (
        <span
          className="inline-block rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/60"
          data-testid="text-ceasefire-waiting"
        >
          已提出停戰，等待對方回應
        </span>
      ) : war.ceasefireProposedByNationId ? (
        <button
          onClick={() => {
            if (
              window.confirm(
                "接受停戰後，這場戰爭與所有相關戰役都會立刻結束。確定接受？",
              )
            ) {
              accept.mutate({ id: war.id });
            }
          }}
          disabled={accept.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-emerald-400/50 bg-emerald-600/25 px-3 py-1.5 text-xs font-bold text-emerald-100 transition hover:bg-emerald-600/40 disabled:opacity-50"
          data-testid="button-accept-ceasefire"
        >
          {accept.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Flag className="h-3.5 w-3.5" />
          )}
          對方提議停戰──接受停戰
        </button>
      ) : (
        <button
          onClick={() => {
            if (window.confirm("向對方提出停戰提案？對方接受後戰爭立即結束。")) {
              propose.mutate({ id: war.id });
            }
          }}
          disabled={propose.isPending}
          className="flex items-center gap-1.5 rounded-lg border border-emerald-400/40 bg-emerald-600/20 px-3 py-1.5 text-xs font-bold text-emerald-100 transition hover:bg-emerald-600/35 disabled:opacity-50"
          data-testid="button-propose-ceasefire"
        >
          {propose.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Flag className="h-3.5 w-3.5" />
          )}
          提出停戰
        </button>
      )}
    </section>
  );
}
