import { useEffect, useState } from "react";
import { ScrollText, Loader2, Lock, CheckCircle2, XCircle, AlertTriangle, Scale } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  useConstitution, useSaveDraft, useSubmitConstitution, canSubmitNow, draftHint, seatsNeeded, tallyForDisplay,
  VOTE_LABEL, type ConstitutionView, type ReviewRecord, type VoteChoice,
} from "@/lib/constitution";

const VOTE_STYLE: Record<VoteChoice, string> = {
  yes: "text-emerald-300", no: "text-red-300", abstain: "text-white/55",
};

/** 各黨投票結果 + 贊成席次進度條(有一條標示過半線)。 */
export function VoteResult({ review }: { review: ReviewRecord }) {
  const total = review.totalSeats || 1;
  const t = tallyForDisplay(review.votes);
  const need = seatsNeeded(total);
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div data-testid="box-votes">
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-white/10" role="img"
        aria-label={`贊成 ${t.yes} 席，反對 ${t.no} 席，棄權 ${t.abstain} 席，需要 ${need} 席`}>
        <div className="absolute inset-y-0 left-0 flex w-full">
          <div className="h-full bg-emerald-400" style={{ width: pct(t.yes) }} />
          <div className="h-full bg-red-500" style={{ width: pct(t.no) }} />
          <div className="h-full bg-white/25" style={{ width: pct(t.abstain) }} />
        </div>
        <div className="absolute inset-y-0 w-0.5 bg-amber-300" style={{ left: pct(need) }} title={`過半需 ${need} 席`} />
      </div>
      <p className="mt-1 text-[11px] text-white/55">
        贊成 {t.yes} · 反對 {t.no} · 棄權 {t.abstain}（共 {total} 席，贊成需達 {need} 席才通過）
      </p>
      <ul className="mt-2 space-y-1" data-testid="list-votes">
        {review.votes.map((v) => (
          <li key={v.partyName} className="rounded-md bg-white/5 px-2.5 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">
                {v.partyName}<span className="ml-1 text-white/45">{v.stanceLabel} · {v.seats} 席</span>
              </span>
              <span className={`shrink-0 font-semibold ${VOTE_STYLE[v.vote]}`}>{VOTE_LABEL[v.vote]}</span>
            </div>
            {v.reason && <p className="mt-0.5 text-white/60">{v.reason}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewBox({ review }: { review: ReviewRecord }) {
  const ok = review.outcome === "ratified";
  const title = ok ? "憲法通過" : review.outcome === "rejected_vote" ? "議會否決" : "審查退回";
  return (
    <div className={`mt-3 rounded-lg border p-3 ${ok ? "border-emerald-400/30 bg-emerald-500/10" : "border-red-400/30 bg-red-500/10"}`}
      data-testid="box-review">
      <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
        {ok ? <CheckCircle2 className="h-4 w-4 text-emerald-300" /> : <XCircle className="h-4 w-4 text-red-300" />}
        {title}<span className="ml-auto text-[11px] font-normal text-white/55">品質 {review.qualityScore} 分</span>
      </div>
      <p className="text-xs text-white/80" data-testid="text-review-feedback">{review.feedback}</p>
      {review.flaws.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-amber-200/90" data-testid="list-review-flaws">
          {review.flaws.map((f, i) => <li key={i}>{f}</li>)}
        </ul>)}
      {review.votes.length > 0 && <div className="mt-3"><VoteResult review={review} /></div>}
    </div>
  );
}

function Editor({ v }: { v: ConstitutionView }) {
  const { toast } = useToast();
  const save = useSaveDraft();
  const submit = useSubmitConstitution();
  const [text, setText] = useState(v.draftText);
  // 伺服器草稿變了（例如別的分頁存檔）且本地沒有未儲存修改時，同步進來。
  const dirty = text !== v.draftText;
  useEffect(() => { if (!dirty) setText(v.draftText); }, [v.draftText]); // eslint-disable-line react-hooks/exhaustive-deps
  const editable = v.status === "draft" || v.status === "none";
  const len = text.trim().length;
  const cooling = v.submit.cooldownLeft > 0;
  const canSubmit = canSubmitNow(v, text.trim().length, dirty);

  return (
    <div className="mt-3">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} maxLength={v.limits.maxLen}
        disabled={!editable || save.isPending} data-testid="input-constitution"
        placeholder="在這裡寫下國家的憲法：權力如何分配、領袖與議會的關係、人民的權利、軍隊歸誰指揮、如何修憲、緊急狀態怎麼辦…"
        className="w-full resize-y rounded-md border border-white/15 bg-black/40 p-2 text-sm leading-relaxed text-white placeholder:text-white/35 disabled:opacity-50" />
      <div className="mt-1 flex items-center justify-between text-[11px] text-white/50">
        <span data-testid="text-constitution-hint">{draftHint(len, v.limits)}</span>
        <span>{len}/{v.limits.maxLen}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        <button type="button" data-testid="button-save-draft" disabled={!editable || !dirty || save.isPending}
          onClick={() => save.mutate(text, {
            onSuccess: () => toast({ title: "草稿已儲存" }),
            onError: (e) => toast({ title: "儲存失敗", description: (e as Error).message, variant: "destructive" }),
          })}
          className="inline-flex items-center gap-1.5 rounded-md border border-white/25 px-3 py-1.5 text-xs font-semibold transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40">
          {save.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}儲存草稿
        </button>
        <button type="button" data-testid="button-submit-constitution" disabled={!canSubmit || submit.isPending}
          onClick={() => {
            if (!window.confirm(`送審需花費 ${v.submit.cost} 金錢，被退回或否決也不退費。確定送審嗎？`)) return;
            submit.mutate(undefined, {
              onSuccess: () => toast({ title: "已送交議會審議", description: "審議需要一點時間，結果會自動更新。" }),
              onError: (e) => toast({ title: "送審失敗", description: (e as Error).message, variant: "destructive" }),
            });
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/85 px-3 py-1.5 text-xs font-bold text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40">
          {submit.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {cooling ? `冷卻中（${v.submit.cooldownLeft}）` : dirty ? "請先儲存草稿" : `送審（${v.submit.cost} 金錢）`}
        </button>
      </div>
    </div>
  );
}

export function ConstitutionPanel() {
  const { data: v, isLoading, isError } = useConstitution();
  if (isLoading) return <section className="mb-4 rounded-xl border border-white/15 bg-black/45 p-4 text-sm text-white/60"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />憲法載入中…</section>;
  if (isError || !v) return null;
  // 專制政體的議會只是橡皮圖章，沒有憲法這回事（已通過的除外，保留讓人看）。
  if (!v.required && v.status !== "ratified") return null;

  return (
    <section className="mb-4 rounded-xl border border-white/15 bg-black/45 p-4 backdrop-blur" data-testid="panel-constitution">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Scale className="h-4 w-4 text-amber-300" /><h3 className="font-serif text-sm font-bold md:text-base">憲法</h3></div>
        <span className="rounded-full border border-white/20 bg-white/5 px-2.5 py-0.5 text-[11px] font-semibold" data-testid="text-constitution-status">
          {v.status === "ratified" ? "已生效" : v.status === "reviewing" ? "審議中" : v.status === "draft" ? "草稿" : "尚未制定"}
        </span>
      </div>

      {v.status === "ratified" ? (<>
        <p className="mb-2 flex items-center gap-1.5 text-xs text-emerald-300">
          <Lock className="h-3.5 w-3.5" />憲法已生效，不可修改。條文裡的含糊與缺漏，日後可能成為政治爭議的導火線。
        </p>
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-white/10 bg-black/30 p-3 text-sm leading-relaxed text-white/85" data-testid="text-constitution-final">
          {v.finalText}
        </div>
        {v.lastReview && <ReviewBox review={v.lastReview} />}
      </>) : v.status === "reviewing" ? (<>
        <div className="flex items-center gap-2 rounded-lg border border-sky-400/30 bg-sky-500/10 p-3 text-sm" data-testid="box-reviewing">
          <Loader2 className="h-4 w-4 animate-spin text-sky-300" />
          議會正在審議你的憲法草案，結果出來後會自動更新。
        </div>
        <div className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-md border border-white/10 bg-black/30 p-3 text-sm text-white/70">{v.draftText}</div>
      </>) : (<>
        <p className="text-xs text-white/60">
          憲法要先通過品質審查，再交由議會各黨投票，贊成席次過半才會生效。一旦通過就永遠不能修改，所以寫之前想清楚。
          送審花費 {v.submit.cost} 金錢，被退回或否決不退費，之後要隔 {v.submit.cooldownTicks} 個議會回合才能再送。
        </p>
        {v.penalty && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-200" data-testid="text-constitution-penalty">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            沒有憲法，議會滿意度每回合都會下降 {v.penalty.perTick} 點（最低降到 {v.penalty.floor}）。
          </p>)}
        <Editor key={v.status} v={v} />
        {v.lastReview && <ReviewBox review={v.lastReview} />}
      </>)}
      {v.status !== "ratified" && v.submissions > 0 && (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-white/40"><ScrollText className="h-3 w-3" />已送審 {v.submissions} 次</p>)}
    </section>
  );
}
