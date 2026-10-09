import React, { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Anchor, Loader2, LogIn, Lock, Shield, Swords, Trophy } from "lucide-react";
import { useGetPlayerNation, getGetPlayerNationQueryKey } from "@workspace/api-client-react";
import { useCurrentUser, startDiscordLogin } from "@/lib/current-user";
import { GameNotifications } from "@/components/game-notifications";
import {
  actionFor, buildFleetPayload, formatCountdown, myRoleFor, OIL_ERROR_HINT, OUTCOME_LABEL,
  type FleetInput, type OilCampaignView, type OilOverview, type OilRigView, type ShipView,
} from "@/lib/oilRigs";

// 非 Vite 環境(單元/渲染測試)沒有 import.meta.env,退回根路徑。
const BASE: string = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
const DEFAULT_BG = `${BASE}game/home-bg-default.webp`;
const API = `${BASE}api`.replace(/\/{2,}/g, "/");

class ApiError extends Error {
  constructor(message: string, public code?: string, public status?: number) { super(message); }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { credentials: "include", ...init });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const j = json as { error?: string; code?: string };
    throw new ApiError(j.error ?? (j.code && OIL_ERROR_HINT[j.code]) ?? "操作失敗", j.code, res.status);
  }
  return json as T;
}

function Shell({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center text-white" style={{ backgroundImage: `url(${bg})` }}>
      <div className="fixed inset-0 bg-black/65" />
      <div className="relative min-h-full">{children}</div>
    </div>
  );
}
function CenterCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center shadow-2xl backdrop-blur">{children}</div>
    </div>
  );
}

export default function GameOil() {
  const { data: me, isLoading: loadingMe } = useCurrentUser();
  const authenticated = me?.authenticated === true;
  const { data: nationEnv } = useGetPlayerNation({
    query: { queryKey: getGetPlayerNationQueryKey(), enabled: authenticated, staleTime: 30_000 },
  });
  const nation = nationEnv?.nation ?? null;
  const noNation = nationEnv != null && !nationEnv.hasNation;
  const bg = nation?.backgroundUrl || DEFAULT_BG;

  // 總覽(排行榜/凍結)是公開資訊,但頁面要登入才看得到戰役與動作
  if (loadingMe) return <Shell bg={bg}><CenterCard><Loader2 className="mx-auto h-6 w-6 animate-spin" /></CenterCard></Shell>;
  if (!authenticated) {
    return (
      <Shell bg={bg}>
        <CenterCard>
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#5865f2]"><LogIn className="h-7 w-7" /></div>
          <h1 className="mb-2 font-serif text-xl font-bold">油井爭奪</h1>
          <p className="mb-6 text-sm text-white/70">請先以 Discord 登入。</p>
          <button onClick={() => startDiscordLogin()} className="w-full rounded-lg bg-[#5865f2] px-4 py-2.5 text-sm font-semibold hover:bg-[#4752c4]">使用 Discord 登入</button>
        </CenterCard>
      </Shell>
    );
  }
  if (noNation) {
    return (
      <Shell bg={bg}>
        <CenterCard>
          <Shield className="mx-auto mb-3 h-10 w-10 text-white/40" />
          <h1 className="mb-2 font-serif text-xl font-bold">尚未建國</h1>
          <Link href="/game" className="block w-full rounded-lg bg-amber-500/85 px-4 py-2.5 text-sm font-bold text-black hover:bg-amber-400">前往建國</Link>
        </CenterCard>
      </Shell>
    );
  }
  return <OilScreen bg={bg} myNationId={nation?.id ?? null} />;
}

function OilScreen({ bg, myNationId }: { bg: string; myNationId: string | null }) {
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ["oil-overview"], queryFn: () => request<OilOverview>("/oil-rigs"), refetchInterval: 60_000 });
  const campaigns = useQuery({
    queryKey: ["oil-campaigns"], refetchInterval: 30_000,
    queryFn: () => request<{ delayHours: number; campaigns: OilCampaignView[] }>("/oil-campaigns"),
  });
  const fleet = useQuery({ queryKey: ["oil-my-fleet"], queryFn: () => request<{ ships: ShipView[] }>("/oil-campaigns/my-fleet") });
  const [selected, setSelected] = useState<string | null>(null);

  const activeBySlug = useMemo(() => {
    const m = new Map<string, OilCampaignView>();
    for (const c of campaigns.data?.campaigns ?? []) if (c.status === "active") m.set(c.rigSlug, c);
    return m;
  }, [campaigns.data]);
  const recent = (campaigns.data?.campaigns ?? []).filter((c) => c.status !== "active").slice(0, 8);

  const refreshAll = () => Promise.all([
    qc.invalidateQueries({ queryKey: ["oil-overview"] }), qc.invalidateQueries({ queryKey: ["oil-campaigns"] }),
    qc.invalidateQueries({ queryKey: ["oil-my-fleet"] }), qc.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() }),
  ]);

  const o = overview.data;
  const rigName = (slug: string) => o?.rigs.find((r) => r.slug === slug)?.name ?? slug;
  const sel = o?.rigs.find((r) => r.slug === selected) ?? null;

  return (
    <Shell bg={bg}>
      <div className="mx-auto max-w-6xl p-3 md:p-6">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Link href="/game" className="rounded-lg border border-white/15 bg-black/45 p-2 backdrop-blur hover:bg-white/15" title="回玩家首頁"><ArrowLeft className="h-4 w-4" /></Link>
            <div className="flex items-center gap-2.5 rounded-lg border border-white/15 bg-black/45 px-3 py-1.5 backdrop-blur">
              <Anchor className="h-5 w-5 text-sky-300" />
              <span className="font-serif text-base font-bold md:text-lg">油井爭奪</span>
              {o?.season && <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-white/70">第 {o.season.season_number} 賽季</span>}
            </div>
          </div>
          <GameNotifications />
        </header>

        {overview.isError && (
          <div className="mb-4 rounded-xl border border-red-400/40 bg-red-500/15 p-4 text-sm">
            無法載入油井資料。<button className="ml-2 underline" onClick={() => overview.refetch()}>重試</button>
          </div>
        )}
        {overview.isLoading && <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin" /></div>}

        {o && (
          <>
            {o.frozen && (
              <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-400/50 bg-amber-500/15 p-4" data-testid="oil-frozen-banner">
                <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                <div className="text-sm">
                  <div className="font-bold text-amber-200">本賽季已結束,遊戲凍結中</div>
                  <div className="text-white/80">
                    {o.season?.winner_nation_name ? `勝者:${o.season.winner_nation_name}(${Math.round(Number(o.season.winner_score ?? 0))} 分)。` : ""}
                    你可以查看排行榜與地圖,請等待管理員重置新賽季。
                  </div>
                </div>
              </div>
            )}

            <div className="grid gap-4 lg:grid-cols-3">
              <section className="lg:col-span-2">
                <h2 className="mb-2 flex items-center gap-2 font-serif text-base font-bold"><Anchor className="h-4 w-4" /> 16 座油井</h2>
                <div className="grid gap-2 sm:grid-cols-2" data-testid="oil-rig-list">
                  {o.rigs.map((rig) => (
                    <RigCard key={rig.slug} rig={rig} campaign={activeBySlug.get(rig.slug)} myNationId={myNationId}
                      active={selected === rig.slug} onSelect={() => setSelected(selected === rig.slug ? null : rig.slug)} />
                  ))}
                </div>
              </section>

              <aside className="space-y-4">
                <section className="rounded-xl border border-white/15 bg-black/50 p-4 backdrop-blur">
                  <h2 className="mb-2 flex items-center gap-2 font-serif text-base font-bold"><Trophy className="h-4 w-4 text-amber-300" /> 排行榜(目標 {o.winScore.toLocaleString()} 分)</h2>
                  {o.leaderboard.length === 0 ? <p className="text-sm text-white/60">尚無積分。佔領油井後每小時計分。</p> : (
                    <ol className="space-y-1.5" data-testid="oil-leaderboard">
                      {o.leaderboard.map((r, i) => (
                        <li key={r.nationId} className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm ${r.nationId === myNationId ? "bg-amber-500/20" : "bg-white/5"}`}>
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="w-5 text-white/50">{i + 1}</span>
                            <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: r.color ?? "#888" }} />
                            <span className="truncate">{r.name}</span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className="font-semibold">{Math.floor(r.score).toLocaleString()}</span>
                            <span className="ml-1.5 text-xs text-white/55">{r.heldRigs} 座 · +{r.pointsPerHour}/時</span>
                          </span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>

                {recent.length > 0 && (
                  <section className="rounded-xl border border-white/15 bg-black/50 p-4 backdrop-blur">
                    <h2 className="mb-2 font-serif text-base font-bold">近期戰果</h2>
                    <ul className="space-y-1 text-sm">
                      {recent.map((c) => (
                        <li key={c.id} className="flex justify-between gap-2 rounded bg-white/5 px-2 py-1">
                          <span className="truncate">{rigName(c.rigSlug)}</span>
                          <span className="shrink-0 text-white/70">{c.outcome ? OUTCOME_LABEL[c.outcome] ?? c.outcome : "—"}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </aside>
            </div>

            {sel && (
              <ActionPanel key={sel.slug} rig={sel} campaign={activeBySlug.get(sel.slug)} myNationId={myNationId}
                frozen={o.frozen} ships={fleet.data?.ships ?? []} fleetLoading={fleet.isLoading} onDone={refreshAll} />
            )}
          </>
        )}
      </div>
    </Shell>
  );
}

/** 匯出僅供渲染測試使用。 */
export function RigCard({ rig, campaign, myNationId, active, onSelect }: {
  rig: OilRigView; campaign?: OilCampaignView; myNationId: string | null; active: boolean; onSelect: () => void;
}) {
  const role = myRoleFor(rig, campaign, myNationId);
  return (
    <button onClick={onSelect} data-testid={`oil-rig-${rig.slug}`}
      className={`rounded-xl border p-3 text-left backdrop-blur transition ${active ? "border-sky-300/70 bg-sky-500/20" : "border-white/15 bg-black/50 hover:bg-white/10"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-semibold">{rig.name}</div>
          <div className="text-xs text-white/55">{rig.sea}</div>
        </div>
        {role !== "none" && (
          <span className="shrink-0 rounded bg-amber-500/25 px-1.5 py-0.5 text-xs text-amber-200">
            {{ holder: "我持有", attacker: "我進攻", defender: "我防守" }[role]}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2 text-sm">
        <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: rig.holder?.color ?? "#555" }} />
        <span className="truncate text-white/85">{rig.holder ? rig.holder.name ?? "未知" : "無人佔領"}</span>
      </div>
      {campaign && (
        <div className="mt-2 flex items-center justify-between rounded bg-red-500/20 px-2 py-1 text-xs text-red-100">
          <span className="flex items-center gap-1"><Swords className="h-3 w-3" /> 戰役中</span>
          <span>{formatCountdown(campaign.settleAt)}</span>
        </div>
      )}
    </button>
  );
}

export function ActionPanel({ rig, campaign, myNationId, frozen, ships, fleetLoading, onDone }: {
  rig: OilRigView; campaign?: OilCampaignView; myNationId: string | null; frozen: boolean;
  ships: ShipView[]; fleetLoading: boolean; onDone: () => Promise<unknown>;
}) {
  const role = myRoleFor(rig, campaign, myNationId);
  const action = actionFor(role, campaign, frozen);
  const elig = useQuery({
    queryKey: ["oil-elig", rig.slug], enabled: action === "attack", staleTime: 15_000,
    queryFn: () => request<{ eligible: boolean; reason?: string; message?: string }>(`/oil-campaigns/eligibility/${encodeURIComponent(rig.slug)}`),
  });
  const [input, setInput] = useState<FleetInput>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const usable = ships.filter((s) => s.available > 0);
  const parsed = buildFleetPayload(input, usable);

  async function submit() {
    if (!parsed.ok || busy) return;
    setBusy(true); setResult(null);
    try {
      if (action === "attack") {
        await request(`/oil-campaigns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rigSlug: rig.slug, fleet: parsed.fleet }) });
        setResult({ ok: true, text: `已出兵 ${parsed.total} 艘,6 小時後結算。` });
      } else if (action === "reinforce" && campaign) {
        await request(`/oil-campaigns/${campaign.id}/reinforce`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fleet: parsed.fleet }) });
        setResult({ ok: true, text: `已追加 ${parsed.total} 艘。` });
      }
      setInput({});
      await onDone();
    } catch (e) {
      const err = e as ApiError;
      setResult({ ok: false, text: err.message || (err.code && OIL_ERROR_HINT[err.code]) || "操作失敗" });
    } finally { setBusy(false); }
  }

  return (
    <section className="mt-4 rounded-xl border border-sky-300/40 bg-black/60 p-4 backdrop-blur" data-testid="oil-action-panel">
      <h2 className="mb-1 font-serif text-lg font-bold">{rig.name}</h2>
      <p className="mb-3 text-xs text-white/55">掛靠地區:{rig.anchorRegions.length ? rig.anchorRegions.join("、") : "—"}</p>

      {campaign && (
        <div className="mb-3 rounded-lg bg-white/5 p-3 text-sm" data-testid="oil-campaign-info">
          <div className="mb-1 flex justify-between"><span>戰役進行中</span><span className="font-semibold">剩餘 {formatCountdown(campaign.settleAt)}</span></div>
          <div className="grid grid-cols-2 gap-2 text-center">
            <div className="rounded bg-red-500/15 p-2"><div className="text-xs text-white/60">攻方</div><div>{campaign.attackerShips} 艘</div><div className="text-xs text-white/60">戰力 {campaign.attackerPower.toLocaleString()}</div></div>
            <div className="rounded bg-sky-500/15 p-2"><div className="text-xs text-white/60">守方{campaign.defenderShips === 0 ? "(守軍)" : ""}</div><div>{campaign.defenderShips} 艘</div><div className="text-xs text-white/60">戰力 {campaign.defenderPower.toLocaleString()}(含地利)</div></div>
          </div>
          <div className="mt-2 text-center text-xs text-white/70">
            以目前投入,現在結算會是 <b className="text-white">{OUTCOME_LABEL[campaign.forecast]}</b>(追加後可能改變)
          </div>
        </div>
      )}

      {action === "none" && (
        <p className="text-sm text-white/70" data-testid="oil-no-action">
          {frozen ? "賽季已結束,僅供查看。" : role === "holder" ? "你已持有這座油井。有人來攻時才能追加防守艦隊。" : campaign ? "別國正在爭奪,你無法介入。" : "目前無法操作。"}
        </p>
      )}

      {action === "attack" && elig.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
      {action === "attack" && elig.data && !elig.data.eligible && (
        <p className="rounded-lg bg-red-500/15 p-3 text-sm text-red-100" data-testid="oil-ineligible">{elig.data.message ?? "目前不符合資格。"}</p>
      )}

      {(action === "reinforce" || (action === "attack" && elig.data?.eligible)) && (
        <div data-testid="oil-fleet-form">
          <h3 className="mb-2 text-sm font-semibold">{action === "attack" ? "出兵(投入的艦隊在戰役期間不能用於陸戰)" : "追加艦隊"}</h3>
          {fleetLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : usable.length === 0 ? (
            <p className="text-sm text-white/60">你沒有可派遣的艦船。</p>
          ) : (
            <div className="space-y-2">
              {usable.map((s) => (
                <label key={s.templateId} className="flex items-center justify-between gap-3 rounded bg-white/5 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">{s.name}<span className="ml-2 text-xs text-white/55">可派 {s.available} / 持有 {s.owned}</span></span>
                  <input inputMode="numeric" placeholder="0" value={input[s.templateId] ?? ""} data-testid={`oil-qty-${s.templateId}`}
                    onChange={(e) => setInput((p) => ({ ...p, [s.templateId]: e.target.value }))}
                    className="w-20 rounded border border-white/20 bg-black/40 px-2 py-1 text-right" />
                </label>
              ))}
            </div>
          )}
          {!parsed.ok && Object.values(input).some((v) => String(v).trim() !== "") && <p className="mt-2 text-xs text-red-300" data-testid="oil-input-error">{parsed.error}</p>}
          <button onClick={submit} disabled={!parsed.ok || busy} data-testid="oil-submit"
            className="mt-3 w-full rounded-lg bg-red-500/85 px-4 py-2.5 text-sm font-bold hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? "送出中…" : action === "attack" ? `出兵${parsed.ok ? `(${parsed.total} 艘)` : ""}` : `追加${parsed.ok ? `(${parsed.total} 艘)` : ""}`}
          </button>
        </div>
      )}

      {result && <p className={`mt-3 rounded-lg p-3 text-sm ${result.ok ? "bg-emerald-500/20 text-emerald-100" : "bg-red-500/20 text-red-100"}`} data-testid="oil-result">{result.text}</p>}
    </section>
  );
}
