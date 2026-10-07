import { useMemo, useState } from "react";
import { Landmark, Loader2, Megaphone, ScrollText, AlertTriangle, Gavel } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  layoutHemicycle, useParliament, useSubmitReport, useDecideVeto,
  type ParliamentView, type ParliamentParty,
} from "@/lib/parliament";

const ALERT_STYLE = {
  ok: "border-emerald-400/40 bg-emerald-500/15 text-emerald-300",
  warn: "border-amber-400/40 bg-amber-500/15 text-amber-300",
  critical: "border-red-400/50 bg-red-500/20 text-red-300",
  revolt: "border-red-400/50 bg-red-500/25 text-red-200",
} as const;
const ALERT_LABEL = { ok: "穩定", warn: "警戒", critical: "危急", revolt: "革命" } as const;
const LEVEL_LABEL: Record<string, string> = { complied: "遵守", minor: "輕度違背", major: "明確違背", severe: "嚴重違背" };
const LEVEL_STYLE: Record<string, string> = {
  complied: "text-emerald-300", minor: "text-amber-200", major: "text-orange-300", severe: "text-red-300",
};

/** 半圓席次圖(純 SVG):每個點是一席,顏色 = 政黨。 */
export function Hemicycle({ parties }: { parties: ParliamentParty[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const dots = useMemo(() => layoutHemicycle(parties.map((p) => p.seats)), [parties]);
  const R = 200, DOT = 7;
  const active = hover !== null ? parties[hover] : null;
  return (
    <div className="relative mx-auto w-full max-w-md" data-testid="chart-hemicycle">
      <svg viewBox={`${-R - 14} ${-R - 14} ${2 * R + 28} ${R + 34}`} className="w-full" role="img" aria-label="議會席次圖">
        {dots.map((d, i) => {
          const p = parties[d.partyIndex]!;
          const dim = hover !== null && hover !== d.partyIndex;
          return (
            <circle key={i} cx={d.x * R} cy={-d.y * R} r={DOT} fill={p.color}
              opacity={dim ? 0.22 : 1} onMouseEnter={() => setHover(d.partyIndex)} onMouseLeave={() => setHover(null)}>
              <title>{`${p.name} · ${p.seats} 席`}</title>
            </circle>
          );
        })}
        <text x="0" y="-6" textAnchor="middle" className="fill-white" fontSize="34" fontWeight="700">
          {active ? active.seats : parties.reduce((a, p) => a + p.seats, 0)}
        </text>
        <text x="0" y="16" textAnchor="middle" className="fill-white/60" fontSize="13">
          {active ? active.name : "總席次"}
        </text>
      </svg>
    </div>
  );
}

function SatisfactionBar({ v, alert }: { v: number; alert: ParliamentView["alert"] }) {
  const color = alert === "ok" ? "bg-emerald-400" : alert === "warn" ? "bg-amber-400" : "bg-red-500";
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${color} transition-all`} style={{ width: `${Math.max(0, Math.min(100, v))}%` }} />
    </div>
  );
}

const STAND_STYLE = { for: "text-emerald-300", against: "text-red-300", abstain: "text-white/45" } as const;
const STAND_LABEL = { for: "贊成", against: "反對", abstain: "棄權" } as const;

/** 政策被議會否決:列出各黨表態,讓玩家選「強行通過」(扣議會滿意度)或「接受否決」。 */
function VetoCard({ veto, satisfaction }: { veto: NonNullable<ParliamentView["pendingVeto"]>; satisfaction: number }) {
  const { toast } = useToast();
  const decide = useDecideVeto();
  const after = Math.max(0, satisfaction - veto.overridePenalty);
  const go = (d: "override" | "accept") =>
    decide.mutate(d, {
      onSuccess: (r) => toast({
        title: d === "override" ? "已強行通過" : "已接受否決",
        description: d === "override" ? `「${r.title}」生效,議會滿意度降至 ${r.satisfactionAfter ?? after}` : `「${r.title}」已套用`,
      }),
      onError: (e: any) => toast({ title: "處理失敗", description: e?.message ?? "請稍後再試", variant: "destructive" }),
    });
  return (
    <div className="mb-3 rounded-lg border border-red-400/40 bg-red-500/10 p-3" data-testid="card-veto">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-red-200"><Gavel className="h-4 w-4" />政策遭議會否決</div>
      <p className="mb-2 text-xs text-white/75">你的政策想法「{veto.idea.length > 60 ? `${veto.idea.slice(0, 60)}…` : veto.idea}」未獲議會通過。
        贊成 {veto.seatsFor} 席 · 反對 {veto.seatsAgainst} 席 · 棄權 {veto.seatsAbstain} 席。</p>
      <ul className="mb-2 grid gap-1 sm:grid-cols-2" data-testid="list-veto-votes">
        {veto.votes.map((x) => (
          <li key={x.partyId} className="flex items-center justify-between rounded bg-black/30 px-2 py-1 text-xs">
            <span className="truncate">{x.name}<span className="ml-1 text-white/45">{x.seats} 席</span></span>
            <span className={`font-semibold ${STAND_STYLE[x.stand]}`}>{STAND_LABEL[x.stand]}</span>
          </li>))}
      </ul>
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" disabled={decide.isPending} onClick={() => go("override")} data-testid="button-veto-override"
          className="rounded-md border border-amber-400/50 bg-amber-500/20 px-3 py-2 text-left text-xs hover:bg-amber-500/30 disabled:opacity-50">
          <div className="font-semibold text-amber-200">強行通過</div>
          <div className="text-white/70">政策照常生效(「{veto.successTitle}」),但議會滿意度 −{veto.overridePenalty}(剩約 {after})</div>
        </button>
        <button type="button" disabled={decide.isPending} onClick={() => go("accept")} data-testid="button-veto-accept"
          className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-left text-xs hover:bg-white/10 disabled:opacity-50">
          <div className="font-semibold text-white/90">接受否決</div>
          <div className="text-white/70">改為套用失敗結果(「{veto.failureTitle}」),議會滿意度不變</div>
        </button>
      </div>
      <p className="mt-2 text-[11px] text-white/50">下個回合結算前不決定,視同接受否決。</p>
    </div>
  );
}

function ReportBox({ view }: { view: ParliamentView }) {
  const { toast } = useToast();
  const submit = useSubmitReport();
  const [text, setText] = useState("");
  const r = view.report;
  if (!r.allowed) return null;
  const cooling = r.cooldownLeft > 0;
  const tooShort = text.trim().length < 20;
  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-black/30 p-3" data-testid="box-report">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Megaphone className="h-4 w-4 text-amber-300" />國情報告</div>
      <p className="mb-2 text-xs text-white/60">
        向議會報告國情,回應他們的抗議與要求。好的報告能安撫議會;空話或操縱只會激怒他們。
        每次花費 {r.cost} 金錢,冷卻 {r.cooldownTicks} 個議會回合。
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={600} rows={4} disabled={cooling || submit.isPending}
        placeholder="寫下你對議會的報告(至少 20 字)…" data-testid="input-report"
        className="w-full resize-none rounded-md border border-white/15 bg-black/40 p-2 text-sm text-white placeholder:text-white/35 disabled:opacity-50" />
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-white/45">{text.trim().length}/600</span>
        <button type="button" data-testid="button-submit-report" disabled={cooling || tooShort || submit.isPending}
          onClick={() => submit.mutate(text.trim(), {
            onSuccess: (res) => {
              setText("");
              toast({ title: `議會評分 ${res.score}`, description: `${res.feedback}(議會滿意度 ${res.delta >= 0 ? "+" : ""}${res.delta})` });
            },
            onError: (e) => toast({ title: "提交失敗", description: (e as Error).message, variant: "destructive" }),
          })}
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/85 px-3 py-1.5 text-xs font-bold text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40">
          {submit.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {cooling ? `冷卻中(${r.cooldownLeft})` : "提交報告"}
        </button>
      </div>
      {r.lastFeedback && <p className="mt-2 text-xs text-white/60" data-testid="text-report-feedback">上次評語:{r.lastFeedback}</p>}
    </div>
  );
}

export function ParliamentPanel() {
  const { data: v, isLoading, isError } = useParliament();
  if (isLoading) return <section className="mb-4 rounded-xl border border-white/15 bg-black/45 p-4 text-sm text-white/60"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" />議會載入中…</section>;
  if (isError || !v) return null;
  const autocracy = v.tier === "autocracy";
  return (
    <section className="mb-4 rounded-xl border border-white/15 bg-black/45 p-4 backdrop-blur" data-testid="panel-parliament">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Landmark className="h-4 w-4 text-sky-300" /><h3 className="font-serif text-sm font-bold md:text-base">議會</h3>
          <span className="text-[11px] text-white/50">{v.tierLabel}</span></div>
        <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${ALERT_STYLE[v.alert]}`} data-testid="text-parliament-alert">
          議會滿意度 {v.satisfaction} · {ALERT_LABEL[v.alert]}
        </span>
      </div>

      {!v.ready ? <p className="text-sm text-white/60">議會尚未成立,下一次回合結算後會召開第一次會議。</p> : (<>
        {v.pendingVeto ? <VetoCard veto={v.pendingVeto} satisfaction={v.satisfaction} /> : null}
        <SatisfactionBar v={v.satisfaction} alert={v.alert} />
        {v.alert === "warn" || v.alert === "critical" ? (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-red-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {v.alert === "critical" ? "議會瀕臨崩潰!再惡化將爆發革命,地區會脫離並對你宣戰。這時提交國情報告效果加倍。" : "議會不滿正在累積,請留意他們的要求。"}</p>) : null}

        <div className="mt-3"><Hemicycle parties={v.parties} /></div>
        <ul className="mt-2 grid gap-1.5 sm:grid-cols-2" data-testid="list-parties">
          {v.parties.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-md bg-white/5 px-2.5 py-1.5 text-xs">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
              <span className="min-w-0 flex-1 truncate">{p.name}<span className="ml-1 text-white/45">{p.stanceLabel}</span></span>
              {p.isRuling && <Gavel className="h-3.5 w-3.5 text-amber-300" aria-label="執政黨" />}
              <span className="font-semibold tabular-nums">{p.seats}</span>
            </li>))}
        </ul>

        {autocracy ? (
          <p className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3 text-xs text-white/65" data-testid="text-rubber-stamp">
            {v.protest || "議會一致擁護領袖。"}這個議會只是橡皮圖章,你只需要留意軍方的滿意度。</p>
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-white/10 bg-black/30 p-3" data-testid="box-protest">
              <div className="mb-1 text-xs font-semibold text-red-300">抗議內容</div>
              <p className="text-sm text-white/85">{v.protest || "議會目前沒有抗議。"}</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-black/30 p-3" data-testid="box-demand">
              <div className="mb-1 text-xs font-semibold text-sky-300">政策要求{v.demand ? `(${v.demand.stanceLabel})` : ""}</div>
              {v.demand ? (<>
                <p className="text-sm text-white/85">{v.demand.text}</p>
                <p className="mt-2 text-[11px] text-white/50">進度 {v.demand.turnsElapsed}/{v.demand.turnsTotal} 回合 · 每回合依國家實際政策與狀態判定(不需要每回合頒布新政策);本期最多扣 {v.maxPenalty} 點。滿意度掉了可以用國情報告補救</p>
                {v.demand.levels.length > 0 && <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                  {v.demand.levels.map((l, i) => <span key={i} className={LEVEL_STYLE[l] ?? "text-white/60"}>第{i + 1}回合:{LEVEL_LABEL[l] ?? l}</span>)}</div>}
              </>) : <p className="text-sm text-white/55">目前沒有進行中的要求,議會每 3 回合會提出新的要求。</p>}
            </div>
          </div>)}

        <ReportBox view={v} />

        {v.log.length > 0 && (
          <details className="mt-3 text-xs text-white/70">
            <summary className="flex cursor-pointer items-center gap-1.5 text-white/80"><ScrollText className="h-3.5 w-3.5" />議會紀錄</summary>
            <ul className="mt-2 space-y-1" data-testid="list-parliament-log">
              {v.log.map((l) => (<li key={l.id} className="flex gap-2">
                <span className="shrink-0 text-white/35">#{l.tick}</span><span className="flex-1">{l.summary}</span>
                {l.satDelta !== 0 && <span className={l.satDelta > 0 ? "text-emerald-300" : "text-red-300"}>{l.satDelta > 0 ? "+" : ""}{l.satDelta}</span>}
              </li>))}
            </ul>
          </details>)}
      </>)}
    </section>
  );
}
