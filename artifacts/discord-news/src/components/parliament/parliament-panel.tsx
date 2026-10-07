import { Link } from "wouter";
import { useMemo, useState } from "react";
import { Landmark, Loader2, Megaphone, ScrollText, AlertTriangle, Gavel, Vote, Users, Globe2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  layoutHemicycle, useParliament, useSubmitReport, useDecideVeto, useCampaign,
  type ParliamentView, type ParliamentParty, type ElectionAction,
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

const RISK_LABEL = { low: "穩固", mid: "有隱憂", high: "岌岌可危" } as const;
const RISK_STYLE = {
  low: "border-emerald-400/40 bg-emerald-500/15 text-emerald-300",
  mid: "border-amber-400/40 bg-amber-500/15 text-amber-300",
  high: "border-red-400/50 bg-red-500/20 text-red-300",
} as const;

/** 執政聯合政府:議會自己組,玩家只能看。政策由成員黨折衷,看守政府施政無力。 */
function GovernmentCard({ view }: { view: ParliamentView }) {
  const g = view.government;
  if (!g || !g.enabled || g.kind === "none") return null;
  const names = g.members.map((m) => m.name).join("、");
  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-black/30 p-3" data-testid="card-government">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold"><Users className="h-4 w-4 text-sky-300" />
          {g.kind === "caretaker" ? "看守政府" : g.kind === "coalition" ? "聯合政府" : "執政黨"}</div>
        {g.kind === "coalition" ? (
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${RISK_STYLE[g.risk]}`} data-testid="text-coalition-risk">
            聯盟{RISK_LABEL[g.risk]}</span>) : null}
      </div>
      {g.kind === "caretaker" ? (
        <p className="text-xs text-red-300" data-testid="text-caretaker">
          沒有任何黨能組成過半政府,由看守政府暫時執政:政策更難通過,議會滿意度每回合小幅下滑。
          再失敗 {g.failuresLeft} 次將提前大選。</p>
      ) : (
        <>
          <p className="text-xs text-white/75" data-testid="text-government-members">
            {names}<span className="ml-1 text-white/45">合計 {g.seats} 席</span></p>
          <p className="mt-1 text-[11px] text-white/50">
            {g.kind === "coalition"
              ? "聯合政府由議會自行組成,政策態度由成員黨按席次折衷。成員立場差距大時容易裂解、倒閣。"
              : view.tier === "semi" ? "半專制由現任執政黨掌權,不需過半。" : "執政黨單獨過半。"}</p>
        </>
      )}
    </div>
  );
}

const ATTENTION_LABEL = { high: "高風險", watched: "關注中", none: "未受關注" } as const;
const ATTENTION_STYLE = {
  high: "border-red-400/50 bg-red-500/20 text-red-300",
  watched: "border-amber-400/40 bg-amber-500/15 text-amber-300",
  none: "border-white/15 bg-white/5 text-white/60",
} as const;
const ORG_LEVEL_LABEL = { weak: "勢力微弱", growing: "勢力成長中", strong: "勢力強大" } as const;

/**
 * 國際組織動向:組織由 AI/規則自行決策,玩家不能操作,只能看預告並用既有手段(安撫議會、
 * 提高穩定度、處理事件)讓它的行動落空。預告只給模糊時間。
 */
function OrgCard({ view }: { view: ParliamentView }) {
  const orgs = view.orgs ?? [];
  if (orgs.length === 0) return null;
  return (
    <div className="mt-4 space-y-3" data-testid="card-intl-orgs">
      {orgs.map((o) => (
        <div key={o.slug} className="rounded-lg border border-white/10 bg-black/30 p-3" data-testid={`card-org-${o.slug}`}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold"><Globe2 className="h-4 w-4 text-rose-300" />{o.name}
              <span className="text-[11px] font-normal text-white/50">{ORG_LEVEL_LABEL[o.level]}</span></div>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${ATTENTION_STYLE[o.attention]}`}
              data-testid={`text-org-attention-${o.slug}`}>你的國家:{ATTENTION_LABEL[o.attention]}</span>
          </div>
          {o.forYou.length > 0 ? (
            <ul className="mt-1 space-y-1" data-testid={`list-org-foryou-${o.slug}`}>
              {o.forYou.map((p, i) => (
                <li key={i} className="text-xs text-red-300">
                  預告:{o.name}預計 <b>{p.eta}</b> 對你的國家進行「{p.action}」。提高議會滿意度與穩定度可以讓它落空。</li>))}
            </ul>
          ) : (
            <p className="text-xs text-white/60">目前沒有針對你的行動預告。</p>
          )}
          {o.elsewhere.length > 0 ? (
            <p className="mt-1 text-[11px] text-white/45">它也在盤算對其他國家的行動({o.elsewhere.length} 項)。</p>) : null}
          <p className="mt-1 text-[11px] text-white/45">
            目前能做的事:{o.capabilities.length > 0 ? o.capabilities.join("、") : "只能按兵不動"}</p>
          <Link href="/game/politics?tab=orgs" className="mt-1.5 inline-block text-[11px] text-sky-300 hover:underline" data-testid={`link-org-detail-${o.slug}`}>
            查看國際組織詳情 →</Link>
          {o.recent.length > 0 ? (
            <div className="mt-2 border-t border-white/10 pt-2">
              <p className="mb-1 text-[11px] font-semibold text-white/55">最近對你的行動</p>
              <ul className="space-y-0.5">{o.recent.map((r, i) => (
                <li key={i} className="text-[11px] text-white/60">{r.summary}</li>))}</ul>
            </div>) : null}
        </div>
      ))}
    </div>
  );
}

const ACTION_HINT: Record<ElectionAction, string> = {
  canvass: "合法拉票,小幅提高支持",
  bribe: "大幅提高支持,但可能東窗事發",
  suppress: "壓低對手支持,可能反被同情",
};

/** 大選:倒數、競選期操作(拉票/買票/打壓)、已執行的操作。專制沒有選舉不顯示。 */
function ElectionCard({ view }: { view: ParliamentView }) {
  const { toast } = useToast();
  const camp = useCampaign();
  const el = view.election;
  if (!el || !el.enabled) return null;
  const inCampaign = el.phase === "campaign";
  const done = (partyId: number, a: ElectionAction) =>
    el.actions.some((x) => x.partyId === String(partyId) && x.action === a);
  const go = (partyId: number, action: ElectionAction) =>
    camp.mutate({ partyId, action }, {
      onSuccess: (r) => toast({
        title: r.caught ? `${el.prices[action].label}「${r.partyName}」東窗事發` : `已${el.prices[action].label}「${r.partyName}」`,
        description: r.caught ? `醜聞傳開,效果反轉,議會滿意度降至 ${r.satisfactionAfter ?? "?"}` : `花費 ${r.cost.toLocaleString("en-US")} 金錢`,
        variant: r.caught ? "destructive" : undefined,
      }),
      onError: (e: any) => toast({ title: "操作失敗", description: e?.message ?? "請稍後再試", variant: "destructive" }),
    });
  const nameOf = (id: string) => view.parties.find((p) => String(p.id) === id)?.name ?? "?";
  return (
    <div className="mt-4 rounded-lg border border-white/10 bg-black/30 p-3" data-testid="card-election">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold"><Vote className="h-4 w-4 text-sky-300" />大選</div>
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${inCampaign ? "border-amber-400/40 bg-amber-500/15 text-amber-300" : "border-white/20 bg-white/5 text-white/70"}`}
          data-testid="text-election-phase">
          {inCampaign ? `競選期 · ${el.turnsUntil} 回合後開票` : `${el.turnsUntil} 回合後進入大選(競選期 ${el.campaignTurns} 回合)`}
        </span>
      </div>
      <p className="text-xs text-white/60">
        每 {el.interval} 個議會回合改選一次,席次依民意與你的競選操作重新分配,可能政權輪替。
        {view.tier === "semi" ? "半專制的選舉不自由:操縱便宜、風險低,但結果偏向現任執政黨。" : "民主國家的操縱一旦被抓,議會滿意度會大跌。"}
      </p>
      {inCampaign ? (
        <ul className="mt-2 space-y-1.5" data-testid="list-campaign">
          {view.parties.map((p) => (
            <li key={p.id} className="rounded-md bg-white/5 p-2 text-xs">
              <div className="mb-1 flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
                {p.isRuling && <Gavel className="h-3.5 w-3.5 text-amber-300" aria-label="執政黨" />}
                <span className="tabular-nums text-white/60">{p.seats} 席</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {(["canvass", "bribe", "suppress"] as ElectionAction[]).map((a) => {
                  const price = el.prices[a];
                  const used = done(p.id, a);
                  return (
                    <button key={a} type="button" disabled={used || camp.isPending} onClick={() => go(p.id, a)}
                      title={ACTION_HINT[a]} data-testid={`button-campaign-${a}-${p.id}`}
                      className="rounded border border-white/15 bg-black/30 px-1.5 py-1 text-center hover:bg-white/10 disabled:opacity-40">
                      <div className="font-semibold">{used ? `已${price.label}` : price.label}</div>
                      <div className="text-[10px] text-white/55">
                        {price.cost.toLocaleString("en-US")}
                        {price.caughtChance > 0 ? ` · 風險${Math.round(price.caughtChance * 100)}%` : ""}
                      </div>
                    </button>);
                })}
              </div>
            </li>))}
        </ul>
      ) : null}
      {el.actions.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-[11px] text-white/55" data-testid="list-campaign-actions">
          {el.actions.map((a) => (
            <li key={a.id}>
              {el.prices[a.action].label}「{nameOf(a.partyId)}」
              <span className={a.caught ? "text-red-300" : "text-white/70"}>{a.caught ? "(已敗露)" : "(進行中)"}</span>
            </li>))}
        </ul>
      ) : null}
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
            <li key={p.id} className="rounded-md bg-white/5 px-2.5 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: p.color }} />
                <span className="min-w-0 flex-1 truncate">{p.name}<span className="ml-1 text-white/45">{p.stanceLabel}</span></span>
                {p.isRuling && <Gavel className="h-3.5 w-3.5 text-amber-300" aria-label="執政黨" />}
                {p.inCoalition && !p.isRuling && <Users className="h-3.5 w-3.5 text-sky-300" aria-label="執政聯盟成員" />}
                <span className="font-semibold tabular-nums">{p.seats}</span>
              </div>
              {p.description ? <p className="mt-0.5 pl-[18px] text-[11px] leading-snug text-white/50" data-testid={`text-party-desc-${p.id}`}>{p.description}</p> : null}
            </li>))}
        </ul>

        <GovernmentCard view={v} />
        <OrgCard view={v} />
        <ElectionCard view={v} />

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
