import { Swords, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useMilitaryDemand, useRespondDemand } from "@/lib/militaryDemand";

/** 軍方要求進攻卡片:有待回應的要求時才顯示;民主國家永遠不會出現。 */
export function MilitaryDemandCard() {
  const { data } = useMilitaryDemand();
  const respond = useRespondDemand();
  const { toast } = useToast();
  const pending = data?.pending;
  if (!data || !pending) return null;

  const act = (accept: boolean) =>
    respond.mutate({ id: pending.id, accept }, {
      onSuccess: (r) => toast({
        title: accept ? (r.warStarted ? "已下令進攻" : "已同意") : "已拒絕軍方要求",
        description: accept ? undefined : `軍方滿意度降至 ${r.newSatisfaction ?? "?"}`,
      }),
      onError: (e) => toast({ title: "無法處理", description: e instanceof Error ? e.message : "請稍後再試", variant: "destructive" }),
    });

  return (
    <section className="mb-4 rounded-xl border border-red-400/40 bg-red-500/10 p-4 backdrop-blur" data-testid="card-military-demand">
      <div className="mb-2 flex items-center gap-2">
        <Swords className="h-4 w-4 text-red-300" />
        <h3 className="font-serif text-sm font-bold md:text-base">軍方要求進攻</h3>
      </div>
      <p className="text-sm text-white/90" data-testid="text-military-demand-target">
        軍方要求進攻「{pending.regionName}」{pending.targetNationName ? `(${pending.targetNationName})` : "(無主地)"}。
      </p>
      <p className="mt-1 text-xs text-white/60">
        拒絕將使軍方滿意度 -{data.refusePenalty}(目前 {data.satisfaction}%)。
        低於 {data.autoWarBelow}% 軍方將不再請示直接開戰,低於 {data.coupBelow}% 可能發動政變。
      </p>
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={respond.isPending} onClick={() => act(true)}
          className="inline-flex items-center gap-1.5 rounded-md border border-red-400/50 bg-red-500/25 px-3 py-1.5 text-xs font-semibold text-red-100 hover:bg-red-500/35 disabled:opacity-50"
          data-testid="button-military-demand-accept">
          {respond.isPending && <Loader2 className="h-3 w-3 animate-spin" />}同意進攻
        </button>
        <button type="button" disabled={respond.isPending} onClick={() => act(false)}
          className="rounded-md border border-white/20 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white/80 hover:bg-white/10 disabled:opacity-50"
          data-testid="button-military-demand-refuse">
          拒絕(-{data.refusePenalty})
        </button>
      </div>
    </section>
  );
}
