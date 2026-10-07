import { Globe2, Loader2, Lock, ShieldAlert, Unlock } from "lucide-react";
import { useIntlOrgs, type OrgDetail } from "@/lib/parliament";

const ATTENTION_LABEL = { high: "高風險", watched: "關注中", none: "未受關注" } as const;
const ATTENTION_STYLE = {
  high: "border-red-400/50 bg-red-500/20 text-red-300",
  watched: "border-amber-400/40 bg-amber-500/15 text-amber-300",
  none: "border-white/15 bg-white/5 text-white/60",
} as const;
const LEVEL_LABEL = { weak: "勢力微弱", growing: "勢力成長中", strong: "勢力強大" } as const;
const ATTENTION_ADVICE = {
  high: "它已經把你的國家排進行動預告。提高議會滿意度與穩定度,行動執行時就可能落空。",
  watched: "你的國家局勢不穩,已經在它的視野裡。現在改善局勢,能避免被排進預告。",
  none: "你的國家目前局勢穩定,不在它的視野內。",
} as const;

function InfluenceBar({ value, actions }: { value: number; actions: OrgDetail["actions"] }) {
  return (
    <div className="mt-2" data-testid="bar-org-influence">
      <div className="relative h-2.5 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-rose-400/80" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
        {actions.map((a) => (
          <div key={a.action} className="absolute top-0 h-full w-px bg-white/50" style={{ left: `${a.unlockAt}%` }} title={`${a.action} ${a.unlockAt}`} />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-white/40"><span>0</span><span>影響力 {value}</span><span>100</span></div>
    </div>
  );
}

function OrgBlock({ o }: { o: OrgDetail }) {
  return (
    <section className="rounded-xl border border-white/10 bg-black/40 p-4 backdrop-blur" data-testid={`panel-org-${o.slug}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Globe2 className="h-5 w-5 text-rose-300" />
          <h2 className="font-serif text-lg font-bold">{o.name}</h2>
          <span className="text-xs text-white/50">{LEVEL_LABEL[o.level]}</span>
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${ATTENTION_STYLE[o.attention]}`} data-testid={`text-org-attention-${o.slug}`}>
          你的國家:{ATTENTION_LABEL[o.attention]}</span>
      </div>

      <p className="mt-2 text-xs text-white/65">{ATTENTION_ADVICE[o.attention]}</p>
      <p className="mt-1 text-[11px] text-white/40">
        這是世界級的獨立勢力,不受任何玩家控制,也無法結盟或收買。它大約每 {o.decisionEvery} 回合重新盤算一次,行動會提前至少 2 回合預告。</p>

      <InfluenceBar value={o.influence} actions={o.actions} />
      <ul className="mt-2 grid gap-1 sm:grid-cols-2" data-testid={`list-org-actions-${o.slug}`}>
        {o.actions.map((a) => (
          <li key={a.action} className={`flex items-center gap-1.5 text-xs ${a.unlocked ? "text-white/85" : "text-white/35"}`}>
            {a.unlocked ? <Unlock className="h-3.5 w-3.5 text-rose-300" /> : <Lock className="h-3.5 w-3.5" />}
            {a.action}<span className="text-[10px] text-white/35">(影響力 {a.unlockAt})</span></li>
        ))}
      </ul>
      {o.nextUnlock ? (
        <p className="mt-1 text-[11px] text-white/45" data-testid={`text-org-nextunlock-${o.slug}`}>
          影響力達 {o.nextUnlock.at} 將解鎖「{o.nextUnlock.action}」。</p>) : (
        <p className="mt-1 text-[11px] text-red-300/80">所有行動都已解鎖。</p>)}

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-black/30 p-3">
          <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-white/80"><ShieldAlert className="h-3.5 w-3.5 text-red-300" />行動預告</h3>
          {o.forYou.length > 0 ? (
            <ul className="space-y-1" data-testid={`list-org-foryou-${o.slug}`}>
              {o.forYou.map((p, i) => (
                <li key={i} className="text-xs text-red-300">預計 <b>{p.eta}</b> 對你的國家進行「{p.action}」</li>))}
            </ul>) : <p className="text-xs text-white/50">目前沒有針對你的預告。</p>}
          {o.elsewhere.length > 0 ? (
            <p className="mt-1.5 text-[11px] text-white/40" data-testid={`text-org-elsewhere-${o.slug}`}>
              另有 {o.elsewhere.length} 項針對其他國家的預告:{o.elsewhere.map((p) => `${p.action}(${p.eta})`).join("、")}</p>) : null}
        </div>
        <div className="rounded-lg border border-white/10 bg-black/30 p-3">
          <h3 className="mb-1 text-xs font-semibold text-white/80">累計戰績</h3>
          <dl className="grid grid-cols-3 gap-2 text-center" data-testid={`stats-org-${o.slug}`}>
            <div><dt className="text-[10px] text-white/40">已執行</dt><dd className="text-base font-semibold">{o.stats.executedTotal}</dd></div>
            <div><dt className="text-[10px] text-white/40">落空</dt><dd className="text-base font-semibold">{o.stats.fizzled}</dd></div>
            <div><dt className="text-[10px] text-white/40">進行中預告</dt><dd className="text-base font-semibold">{o.stats.plannedTotal}</dd></div>
          </dl>
          <p className="mt-1 text-[10px] text-white/35">「落空」= 目標國及時穩住局勢,行動沒有造成影響。</p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-xs font-semibold text-white/80">世界動態</h3>
          {o.worldRecent.length > 0 ? (
            <ul className="space-y-0.5" data-testid={`list-org-world-${o.slug}`}>
              {o.worldRecent.map((w, i) => (
                <li key={i} className="text-[11px] text-white/60">{w.ago}:「{w.action}」{w.onYou ? <b className="text-red-300"> 針對你的國家</b> : " 針對某國"}</li>))}
            </ul>) : <p className="text-xs text-white/45">它還沒有採取過任何行動。</p>}
        </div>
        <div>
          <h3 className="mb-1 text-xs font-semibold text-white/80">對你的影響紀錄</h3>
          {o.recent.length > 0 ? (
            <ul className="space-y-0.5" data-testid={`list-org-recent-${o.slug}`}>
              {o.recent.map((r, i) => (<li key={i} className="text-[11px] text-white/60">{r.summary}</li>))}
            </ul>) : <p className="text-xs text-white/45">它還沒有對你的國家動手。</p>}
        </div>
      </div>
    </section>
  );
}

/** 政治大分類 → 國際組織子頁:唯讀。組織是世界級 NPC,玩家只能觀察預告並用內政手段應對。 */
export function IntlOrgsPanel() {
  const { data, isLoading, isError } = useIntlOrgs();
  if (isLoading) return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-white/70" data-testid="state-orgs-loading">
      <Loader2 className="h-4 w-4 animate-spin" />載入國際組織…</div>);
  if (isError || !data) return <p className="py-10 text-center text-sm text-white/60" data-testid="state-orgs-error">讀取國際組織資料失敗,請稍後再試。</p>;
  if (data.orgs.length === 0) return <p className="py-10 text-center text-sm text-white/60" data-testid="state-orgs-empty">目前世界上沒有活躍的國際組織。</p>;
  return <div className="mt-1 space-y-4" data-testid="panel-intl-orgs">{data.orgs.map((o) => <OrgBlock key={o.slug} o={o} />)}</div>;
}
