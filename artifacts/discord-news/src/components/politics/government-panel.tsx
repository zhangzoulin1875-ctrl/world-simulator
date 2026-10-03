import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Crown,
  Gavel,
  Hourglass,
  Loader2,
  Lock,
  Sparkles,
  X,
} from "lucide-react";
import {
  getGetPlayerNationQueryKey,
  getGetPoliticsOverviewQueryKey,
  getGetPoliticsHistoryQueryKey,
  useSubmitGovernmentDecision,
  useWithdrawGovernmentDecision,
  useChangeGovernment,
} from "@workspace/api-client-react";
import type { PoliticsOverview } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";

function Meter({
  label,
  value,
  hint,
  colorClass,
  testId,
}: {
  label: string;
  value: number;
  hint?: string;
  colorClass: string;
  testId: string;
}) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div data-testid={testId}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-semibold text-white/70">{label}</span>
        <span className="text-sm font-bold tabular-nums">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${colorClass}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {hint && <p className="mt-1 text-[10px] text-white/45">{hint}</p>}
    </div>
  );
}

export function GovernmentPanel({ overview }: { overview: PoliticsOverview }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [decision, setDecision] = useState("");
  const [targetGov, setTargetGov] = useState("");

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getGetPoliticsOverviewQueryKey(),
    });
    queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPoliticsHistoryQueryKey() });
  };

  const submitDecision = useSubmitGovernmentDecision({
    mutation: {
      onSuccess: () => {
        setDecision("");
        toast({
          title: "已送出政府決策",
          description: "回合結算時將依政體、政治支持度與政治註記判定成敗。",
        });
        invalidate();
      },
      onError: (err) =>
        toast({
          title: "送出失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });
  const withdrawDecision = useWithdrawGovernmentDecision({
    mutation: {
      onSuccess: () => {
        toast({ title: "已撤回政府決策" });
        invalidate();
      },
      onError: (err) =>
        toast({
          title: "撤回失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });
  const changeGovernment = useChangeGovernment({
    mutation: {
      onSuccess: () => {
        setTargetGov("");
        toast({
          title: "政體變更成功",
          description: "已順應民意變更政體，政治支持度重設、接受度歸零。",
        });
        invalidate();
      },
      onError: (err) =>
        toast({
          title: "政體變更失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });

  const pending = overview.pendingDecision;
  const unlocked = overview.social.unlockedGovernments;
  const canChangeGovernment = overview.governmentChangeAcceptance >= 100;
  const changeTargets = unlocked.filter(
    (g) => g.label !== overview.government,
  );

  return (
    <section
      className="mb-4 rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur"
      data-testid="section-government"
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        {/* 政體 + 政治註記 */}
        <div className="space-y-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/20">
              <Crown className="h-5 w-5 text-amber-300" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-white/50">
                目前政體
              </div>
              <div
                className="truncate font-serif text-lg font-bold text-amber-100"
                data-testid="text-government"
              >
                {overview.government}
              </div>
              <div className="text-[11px] text-white/50">
                決策難度 {Math.round(overview.decisionDifficulty * 10) / 10}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-white/10 bg-black/30 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-sky-200">
              <Sparkles className="h-3.5 w-3.5" />
              政治註記
            </div>
            <p
              className="whitespace-pre-wrap text-xs leading-relaxed text-white/75"
              data-testid="text-political-note"
            >
              {overview.politicalNote ?? "尚未產生政治註記（回合結算或政體變更時自動生成）。"}
            </p>
          </div>

          {unlocked.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold text-white/60">
                可切換政體（社會關鍵科技已解鎖）
              </div>
              <div className="flex flex-wrap gap-1.5">
                {unlocked.map((g) => (
                  <span
                    key={g.slug}
                    className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                      g.label === overview.government
                        ? "bg-amber-500/25 text-amber-200"
                        : "bg-white/10 text-white/70"
                    }`}
                    data-testid={`chip-gov-${g.slug}`}
                  >
                    {g.label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 支持度 / 接受度 + 政府決策 */}
        <div className="space-y-3">
          <Meter
            label="政治支持度"
            value={overview.politicalSupport}
            hint="影響政府決策成功率；過低時易觸發反效果事件。"
            colorClass={
              overview.politicalSupport >= 60
                ? "bg-emerald-400"
                : overview.politicalSupport >= 35
                  ? "bg-amber-400"
                  : "bg-red-500"
            }
            testId="meter-support"
          />
          <Meter
            label="政體變更接受度"
            value={overview.governmentChangeAcceptance}
            hint="累積至 100 時，可主動變更政體（限社會關鍵科技已解鎖者）。"
            colorClass="bg-purple-400"
            testId="meter-acceptance"
          />

          {canChangeGovernment && (
            <div
              className="rounded-lg border border-purple-300/30 bg-purple-500/10 p-3"
              data-testid="section-government-change"
            >
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-purple-200">
                <Crown className="h-3.5 w-3.5" />
                主動政體變更
              </div>
              {changeTargets.length === 0 ? (
                <p
                  className="text-xs leading-relaxed text-white/60"
                  data-testid="text-no-change-targets"
                >
                  接受度已達 100，但目前沒有其他可切換的政體。請透過社會關鍵科技解鎖新政體後再試。
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs leading-relaxed text-white/65">
                    接受度已達 100，可順應民意變更政體。變更後政治支持度將重設、接受度歸零。
                  </p>
                  <select
                    value={targetGov}
                    onChange={(e) => setTargetGov(e.target.value)}
                    className="w-full rounded-lg border border-white/20 bg-black/40 p-2 text-sm text-white focus:border-purple-300/60 focus:outline-none"
                    data-testid="select-target-government"
                  >
                    <option value="">選擇目標政體…</option>
                    {changeTargets.map((g) => (
                      <option key={g.slug} value={g.slug}>
                        {g.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() =>
                      changeGovernment.mutate({
                        data: { government: targetGov },
                      })
                    }
                    disabled={
                      changeGovernment.isPending || targetGov.length === 0
                    }
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-purple-500/85 px-4 py-2 text-sm font-bold text-white transition hover:bg-purple-400 disabled:opacity-50"
                    data-testid="button-change-government"
                  >
                    {changeGovernment.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    變更政體
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="rounded-lg border border-white/10 bg-black/30 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-amber-200">
              <Gavel className="h-3.5 w-3.5" />
              政府決策
            </div>
            {overview.coupPolicyLockTurns > 0 && (
              <div
                className="mb-2 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-500/15 p-2.5 text-xs font-semibold text-red-200"
                data-testid="banner-coup-decision-lock"
              >
                <Lock className="h-4 w-4 shrink-0" />
                政變後政局動盪，暫時無法下達政府決策（剩餘{" "}
                {overview.coupPolicyLockTurns} 回合）
              </div>
            )}
            {pending ? (
              <div className="space-y-2">
                <div className="rounded-lg border border-amber-300/30 bg-amber-500/10 p-2.5">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-amber-200">
                    <Hourglass className="h-3.5 w-3.5" />
                    等待回合結算判定
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-white/85">
                    {pending.decision}
                  </p>
                </div>
                <button
                  onClick={() => withdrawDecision.mutate()}
                  disabled={withdrawDecision.isPending}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm font-semibold transition hover:bg-white/20 disabled:opacity-50"
                  data-testid="button-withdraw-decision"
                >
                  {withdrawDecision.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                  撤回決策
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  value={decision}
                  onChange={(e) => setDecision(e.target.value)}
                  maxLength={overview.decisionMaxLength}
                  disabled={overview.coupPolicyLockTurns > 0}
                  rows={3}
                  placeholder="下達一項國家級決策，回合結算時由內閣（AI）依政體、支持度與政治註記判定成敗與後果…"
                  className="w-full resize-none rounded-lg border border-white/20 bg-black/40 p-2.5 text-sm text-white placeholder:text-white/35 focus:border-amber-300/60 focus:outline-none"
                  data-testid="input-government-decision"
                />
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-white/45">
                    {decision.length}/{overview.decisionMaxLength} 字
                  </span>
                  <button
                    onClick={() =>
                      submitDecision.mutate({ data: { decision } })
                    }
                    disabled={
                      submitDecision.isPending ||
                      decision.trim().length === 0 ||
                      overview.coupPolicyLockTurns > 0
                    }
                    className="flex items-center gap-1.5 rounded-lg bg-amber-500/85 px-4 py-2 text-sm font-bold text-black transition hover:bg-amber-400 disabled:opacity-50"
                    data-testid="button-submit-decision"
                  >
                    {submitDecision.isPending && (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    )}
                    下達決策
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
