import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { History, Hourglass, Loader2, Lock, ScrollText, X } from "lucide-react";
import {
  getGetPlayerNationQueryKey,
  getGetPoliticsOverviewQueryKey,
  useSubmitPolicyIdea,
  useWithdrawPolicyIdea,
  useRepealPoliticsEntry,
} from "@workspace/api-client-react";
import type { PoliticsOverview } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";
import { signed } from "./shared";
import { EntryCard } from "./entry-card";

/** Task #393 — 全國統一政策面板：四方向滿意度總覽＋單一政策想法輸入＋統一條目清單。 */
export function PolicyPanel({ overview }: { overview: PoliticsOverview }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [idea, setIdea] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const ideaMaxLength = overview.ideaMaxLength;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetPoliticsOverviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
  };

  const submitIdea = useSubmitPolicyIdea({
    mutation: {
      onSuccess: () => {
        setIdea("");
        toast({
          title: "已送出政策想法",
          description: "回合結算時將由內閣（AI）判定成效。",
        });
        invalidate();
      },
      onError: (err) =>
        toast({ title: "送出失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });
  const withdrawIdea = useWithdrawPolicyIdea({
    mutation: {
      onSuccess: () => {
        toast({ title: "已撤回想法" });
        invalidate();
      },
      onError: (err) =>
        toast({ title: "撤回失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });
  const repeal = useRepealPoliticsEntry({
    mutation: {
      onSuccess: () => {
        toast({ title: "已廢除", description: "該條目的加減成即刻失效。" });
        invalidate();
      },
      onError: (err) =>
        toast({ title: "廢除失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });

  const entries = showHistory ? overview.history : overview.activeEntries;
  // Task #584 — 政變後政策封鎖：> 0 時鎖定政策想法提交。
  const coupLockTurns = overview.coupPolicyLockTurns;

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      {/* left: satisfactions + idea box */}
      <div className="space-y-4">
        <section className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
          <h2 className="mb-3 font-serif text-sm font-bold text-white/80">
            各面向滿意度
          </h2>
          <div className="space-y-3">
            {overview.directions.map((d) => (
              <div key={d.direction} data-testid={`satisfaction-${d.direction}`}>
                <div className="flex items-baseline justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-white/75">
                    {!d.enabled && <Lock className="h-3 w-3 text-white/40" />}
                    {d.satisfactionLabel}
                  </span>
                  {d.enabled ? (
                    <span className="text-sm font-bold tabular-nums">
                      {d.satisfaction}
                      <span className="ml-1 text-[10px] font-normal text-white/45">
                        / 100（基底 {d.baseSatisfaction}）
                      </span>
                    </span>
                  ) : (
                    <span className="text-[10px] text-white/40">未解鎖</span>
                  )}
                </div>
                {d.enabled && (
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full ${
                        d.satisfaction >= 60
                          ? "bg-emerald-400"
                          : d.satisfaction >= 35
                            ? "bg-amber-400"
                            : "bg-red-500"
                      }`}
                      style={{ width: `${Math.min(100, Math.max(0, d.satisfaction))}%` }}
                    />
                  </div>
                )}
                {d.enabled && d.totals.satisfaction !== 0 && (
                  <span
                    className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      d.totals.satisfaction > 0
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-red-500/20 text-red-300"
                    }`}
                  >
                    加減成 {signed(Math.round(d.totals.satisfaction * 10) / 10)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
          <h2 className="mb-2 flex items-center gap-2 font-serif text-sm font-bold text-white/80">
            <ScrollText className="h-4 w-4 text-amber-300" />
            政策想法
          </h2>
          {coupLockTurns > 0 && (
            <div
              className="mb-3 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-500/15 p-3 text-xs font-semibold text-red-200"
              data-testid="banner-coup-policy-lock"
            >
              <Lock className="h-4 w-4 shrink-0" />
              政變後政局動盪，暫時無法提交政策想法（剩餘 {coupLockTurns} 回合）
            </div>
          )}
          {overview.pendingIdea ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-amber-300/30 bg-amber-500/10 p-3">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-amber-200">
                  <Hourglass className="h-3.5 w-3.5" />
                  等待回合結算判定
                </div>
                <p className="whitespace-pre-wrap text-sm text-white/85">
                  {overview.pendingIdea.idea}
                </p>
              </div>
              <button
                onClick={() => withdrawIdea.mutate()}
                disabled={withdrawIdea.isPending}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm font-semibold transition hover:bg-white/20 disabled:opacity-50"
                data-testid="button-withdraw-idea"
              >
                {withdrawIdea.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <X className="h-4 w-4" />
                )}
                撤回想法
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              <textarea
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                maxLength={ideaMaxLength}
                disabled={coupLockTurns > 0}
                rows={4}
                placeholder="寫下你的政策想法（不分方向），回合結算時由內閣（AI）判定成敗，並決定影響哪些面向…"
                className="w-full resize-none rounded-lg border border-white/20 bg-black/40 p-3 text-sm text-white placeholder:text-white/35 focus:border-amber-300/60 focus:outline-none"
                data-testid="input-policy-idea"
              />
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-white/45">
                  {idea.length}/{ideaMaxLength} 字
                </span>
                <button
                  onClick={() => submitIdea.mutate({ data: { idea } })}
                  disabled={
                    submitIdea.isPending ||
                    idea.trim().length === 0 ||
                    coupLockTurns > 0
                  }
                  className="flex items-center gap-1.5 rounded-lg bg-amber-500/85 px-4 py-2 text-sm font-bold text-black transition hover:bg-amber-400 disabled:opacity-50"
                  data-testid="button-submit-idea"
                >
                  {submitIdea.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  送出想法
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-white/45">
                全國同時只能有一筆待判定想法；判定成功會成為政策，失敗則可能損失金錢。
              </p>
            </div>
          )}
        </section>
      </div>

      {/* right: unified entries */}
      <section className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-serif text-sm font-bold text-white/80">
            <History className="h-4 w-4 text-sky-300" />
            {showHistory ? "全部紀錄" : "生效中的條目"}
          </h2>
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-semibold transition hover:bg-white/20"
            data-testid="button-toggle-history"
          >
            {showHistory ? "只看生效中" : "查看歷史"}
          </button>
        </div>

        {entries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/15 p-8 text-center text-sm text-white/45">
            {showHistory
              ? "還沒有任何紀錄。"
              : "目前沒有生效中的條目。送出政策想法，在回合結算時建立你的第一條政策吧。"}
          </div>
        ) : (
          <ul className="space-y-2.5">
            {entries.map((e) => (
              <EntryCard
                key={e.id}
                entry={e}
                onRepeal={(id) => repeal.mutate({ id })}
                repealing={repeal.isPending}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
