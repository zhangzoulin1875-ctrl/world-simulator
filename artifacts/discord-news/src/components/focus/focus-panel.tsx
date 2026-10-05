import { useState } from "react";
import { AlertTriangle, Coins, Flag, Loader2, Lock, Scale, Swords, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  TRACK_LABEL, TRACK_STYLE, groupByTrack, leanPct, progressPct, remainingText,
  useCancelFocus, useFocus, useStartFocus,
  type ActiveFocus, type FocusCard, type FocusView,
} from "@/lib/focus";
import { FocusTree } from "./focus-tree";
import { FocusStoryBlock } from "./focus-story";

function Stat({ icon: Icon, label, value, hint, testId }: {
  icon: React.ElementType; label: string; value: string; hint?: string; testId: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-3" data-testid={testId}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-amber-200">
        <Icon className="h-3.5 w-3.5" />{label}
      </div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-white/55">{hint}</div>}
    </div>
  );
}

function LeanBar({ label, value, color, testId }: { label: string; value: number; color: string; testId: string }) {
  return (
    <div data-testid={testId}>
      <div className="mb-1 flex justify-between text-[11px] text-white/70">
        <span>{label}</span><span className="tabular-nums">{Math.round(value)}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={leanPct(value)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full ${color} transition-all`} style={{ width: `${leanPct(value)}%` }} />
      </div>
    </div>
  );
}

function ActiveRow({ a, onCancel, busy, stories }: { a: ActiveFocus; onCancel: (a: ActiveFocus) => void; busy: boolean; stories: FocusView["stories"] }) {
  const pct = progressPct(a.progress, a.totalTurns);
  return (
    <div className="rounded-lg border border-amber-300/30 bg-amber-500/10 p-3" data-testid={`active-${a.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-bold">{a.title}</div>
          <div className="text-[11px] text-white/60">
            {a.slot === "main" ? "主要槽位" : "次要槽位"} · {remainingText(a.remainingTurns)}
          </div>
        </div>
        <button
          type="button" disabled={busy} onClick={() => onCancel(a)}
          className="flex shrink-0 items-center gap-1 rounded-md border border-white/20 bg-black/40 px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-50"
          data-testid={`button-cancel-${a.id}`}
        >
          <X className="h-3 w-3" />取消(退 {a.refundOnCancel} 點)
        </button>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full bg-amber-400 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <FocusStoryBlock stories={stories} focusId={a.id} isActive />
    </div>
  );
}

function FocusCardView({ f, onStart, busy, stories }: { f: FocusCard; onStart: (f: FocusCard) => void; busy: boolean; stories: FocusView["stories"] }) {
  const dim = f.status === "locked" || f.status === "completed";
  return (
    <div
      className={`rounded-lg border p-3 ${f.status === "available" ? "border-white/20 bg-black/40" : "border-white/10 bg-black/25"} ${dim ? "opacity-75" : ""}`}
      data-testid={`focus-${f.id}`} data-status={f.status}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-bold">{f.title}</span>
            {f.milestone && <span className="rounded border border-amber-300/40 bg-amber-500/15 px-1.5 text-[10px] text-amber-200">里程碑</span>}
            {f.status === "completed" && <span className="rounded border border-emerald-400/40 bg-emerald-500/15 px-1.5 text-[10px] text-emerald-200">已完成</span>}
            {f.status === "active" && <span className="rounded border border-amber-300/40 bg-amber-500/15 px-1.5 text-[10px] text-amber-200">進行中</span>}
          </div>
          <div className="mt-0.5 text-[11px] text-white/60">
            {f.cost} 點 · {f.turns} 回合 · {f.slot === "main" ? "主要槽位" : "次要槽位"}
          </div>
        </div>
        {f.status === "available" && (
          <button
            type="button" disabled={busy} onClick={() => onStart(f)}
            className="shrink-0 rounded-md border border-amber-300/50 bg-amber-500/20 px-3 py-1 text-xs font-bold text-amber-100 hover:bg-amber-500/30 disabled:opacity-50"
            data-testid={`button-start-${f.id}`}
          >
            推行
          </button>
        )}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-white/70">{f.description}</p>
      {f.status === "completed" && <FocusStoryBlock stories={stories} focusId={f.id} isActive={false} />}

      {f.transitionTo && (
        <div className="mt-2 flex items-center gap-1.5 rounded border border-sky-300/30 bg-sky-500/10 px-2 py-1 text-xs text-sky-100">
          <Flag className="h-3.5 w-3.5" />政體將變為「{f.transitionTo}」
        </div>
      )}

      {f.conditions.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-white/65">
          {f.conditions.map((c) => <li key={c}>· 需要:{c}</li>)}
        </ul>
      )}
      {(f.benefits.length > 0 || f.costs.length > 0) && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {f.benefits.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-emerald-200">{f.benefits.map((b) => <li key={b}>＋ {b}</li>)}</ul>
          )}
          {f.costs.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-red-200">{f.costs.map((c) => <li key={c}>－ {c}</li>)}</ul>
          )}
        </div>
      )}

      {f.status === "locked" && f.lockedReason && (
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-white/70" data-testid={`locked-reason-${f.id}`}>
          <Lock className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{f.lockedReason}{f.permanentlyLocked ? "(永久)" : ""}</span>
        </div>
      )}
    </div>
  );
}

export function FocusPanel() {
  const { toast } = useToast();
  const q = useFocus();
  const start = useStartFocus();
  const cancel = useCancelFocus();
  const busy = start.isPending || cancel.isPending;
  const [showLocked, setShowLocked] = useState(false);

  if (q.isLoading) {
    return (
      <section className="mb-4 flex items-center gap-2 rounded-2xl border border-white/15 bg-black/55 p-4 text-sm text-white/70 backdrop-blur" data-testid="section-focus">
        <Loader2 className="h-4 w-4 animate-spin" />載入國策樹…
      </section>
    );
  }
  if (q.isError || !q.data) {
    return (
      <section className="mb-4 rounded-2xl border border-white/15 bg-black/55 p-4 text-sm text-red-200 backdrop-blur" data-testid="section-focus">
        <AlertTriangle className="mr-1 inline h-4 w-4" />國策樹讀取失敗:{q.error instanceof Error ? q.error.message : "未知錯誤"}
      </section>
    );
  }
  const v: FocusView = q.data;

  const onStart = (f: FocusCard) => {
    const warn = f.transitionTo
      ? `這會把政體變為「${f.transitionTo}」,且無法輕易回頭。\n\n代價:${f.costs.join("、") || "無"}\n\n確定要推行「${f.title}」?`
      : `確定要花 ${f.cost} 點推行「${f.title}」?`;
    if (!window.confirm(warn)) return;
    start.mutate(f.id, {
      onSuccess: () => toast({ title: "國策已啟動", description: `${f.title}(約 ${f.turns} 回合)` }),
      onError: (err) => toast({ title: "無法推行", description: err.message, variant: "destructive" }),
    });
  };
  const onCancel = (a: ActiveFocus) => {
    if (!window.confirm(`取消「${a.title}」?只會退還 ${a.refundOnCancel} 點,已累積的進度會消失。`)) return;
    cancel.mutate(a.id, {
      onSuccess: () => toast({ title: "已取消", description: `退還 ${a.refundOnCancel} 點` }),
      onError: (err) => toast({ title: "取消失敗", description: err.message, variant: "destructive" }),
    });
  };

  const visible = v.focuses.filter((f) => f.status !== "active");
  const shown = showLocked ? visible : visible.filter((f) => f.status === "available" || f.status === "completed");
  const hiddenCount = visible.length - shown.length;
  const groups = groupByTrack(shown);

  return (
    <section className="mb-4 rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur" data-testid="section-focus">
      <div className="mb-3 flex items-center gap-2.5">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/20">
          <Scale className="h-5 w-5 text-amber-300" />
        </div>
        <div>
          <h2 className="font-serif text-base font-bold">國策樹</h2>
          <p className="text-[11px] text-white/60">花政治點數推行國策;議會滿意度越高,完成越快。</p>
        </div>
      </div>

      {v.policyLockTurns > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-500/15 p-2.5 text-xs font-semibold text-red-200" data-testid="banner-focus-lock">
          <Lock className="h-4 w-4 shrink-0" />政變後政策鎖定中(剩 {v.policyLockTurns} 回合):無法啟動國策,進行中的國策進度也會暫停。
        </div>
      )}
      {v.stalled && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-amber-300/40 bg-amber-500/15 p-2.5 text-xs text-amber-100" data-testid="banner-focus-stalled">
          <AlertTriangle className="h-4 w-4 shrink-0" />議會滿意度過低,國策進度已停擺;政治點數仍會照常累積。
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat icon={Coins} label="政治點數" value={`${v.points} / ${v.pointsCap}`} hint={`每回合 +${v.pointsPerTurn}`} testId="stat-points" />
        <Stat icon={Swords} label="完成速度" value={`×${v.speedMultiplier.toFixed(1)}`} hint={`議會滿意度 ${Math.round(v.parliamentSatisfaction)}`} testId="stat-speed" />
        <div className="space-y-2 rounded-lg border border-white/10 bg-black/30 p-3">
          <LeanBar label="黑線傾向值" value={v.blackLean} color="bg-zinc-300" testId="lean-black" />
          <LeanBar label="紅線傾向值" value={v.redLean} color="bg-red-400" testId="lean-red" />
        </div>
      </div>

      {v.active.length > 0 && (
        <div className="mt-4 space-y-2">
          <h3 className="text-xs font-bold text-amber-200">進行中</h3>
          {v.active.map((a) => <ActiveRow key={a.id} a={a} onCancel={onCancel} busy={busy} stories={v.stories} />)}
        </div>
      )}

      <FocusTree view={v} busy={busy} onStart={onStart} />

      <div className="mt-4 space-y-4">
        {groups.length === 0 && (
          <p className="text-xs text-white/60" data-testid="focus-empty">目前沒有可推行的國策。</p>
        )}
        {groups.map((g) => (
          <div key={g.track} data-testid={`track-${g.track}`}>
            <div className="mb-2 flex items-center gap-2">
              <span className={`rounded border px-2 py-0.5 text-[11px] font-bold ${TRACK_STYLE[g.track]}`}>{TRACK_LABEL[g.track]}</span>
            </div>
            <div className="grid gap-2 lg:grid-cols-2">
              {g.items.map((f) => <FocusCardView key={f.id} f={f} onStart={onStart} busy={busy} stories={v.stories} />)}
            </div>
          </div>
        ))}
        {(hiddenCount > 0 || showLocked) && (
          <button
            type="button" onClick={() => setShowLocked((x) => !x)}
            className="text-[11px] text-white/60 underline underline-offset-2 hover:text-white"
            data-testid="button-toggle-locked"
          >
            {showLocked ? "隱藏暫時無法推行的國策" : `顯示另外 ${hiddenCount} 個暫時無法推行的國策(含原因)`}
          </button>
        )}
      </div>
    </section>
  );
}
