import React, { useState } from "react";
import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, LogIn, Lock, Rocket, Shield } from "lucide-react";
import { useGetPlayerNation, getGetPlayerNationQueryKey } from "@workspace/api-client-react";
import { useCurrentUser, startDiscordLogin } from "@/lib/current-user";
import { formatBigNumber } from "@/components/military-shared";
import { GameNotifications } from "@/components/game-notifications";

const BASE = import.meta.env.BASE_URL;
const DEFAULT_BG = `${BASE}game/home-bg-default.webp`;
const API = `${BASE}api`.replace(/\/{2,}/g, "/");

type MissileInfo = {
  unlocked: boolean;
  unlockYear: number;
  gameDate: string;
  money: number;
  minTreasury: number;
  firedThisTurn: boolean;
  missiles: { type: string; label: string; costPct: number; damagePct: number; cost: number; affordable: boolean }[];
  targets: { nationId: string; nationName: string | null; regionId: number; regionName: string; percent: number }[];
};
type Strike = {
  id: number;
  direction: "outgoing" | "incoming";
  attackerName: string;
  targetName: string;
  regionName: string;
  missileLabel: string;
  costMoney: number;
  populationLost: number;
  buildingsDowngraded: number;
  buildingsDestroyed: number;
  createdAt: string;
};

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { credentials: "include" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: string }).error ?? "讀取失敗");
  return json as T;
}

function Shell({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center text-white" style={{ backgroundImage: `url(${bg})` }}>
      <div className="fixed inset-0 bg-black/60" />
      <div className="relative min-h-full">{children}</div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center shadow-2xl backdrop-blur">{children}</div>
    </div>
  );
}

export default function GameMissile() {
  const qc = useQueryClient();
  const { data: me, isLoading: loadingMe } = useCurrentUser();
  const authenticated = me?.authenticated === true;
  const { data: nationEnv } = useGetPlayerNation({
    query: { queryKey: getGetPlayerNationQueryKey(), enabled: authenticated, staleTime: 30_000 },
  });
  const nation = nationEnv?.nation ?? null;
  const noNation = nationEnv != null && !nationEnv.hasNation;
  const bg = nation?.backgroundUrl || DEFAULT_BG;

  const info = useQuery({
    queryKey: ["missiles"],
    queryFn: () => getJson<MissileInfo>("/player/missiles"),
    enabled: authenticated && !noNation,
    staleTime: 10_000,
  });
  const history = useQuery({
    queryKey: ["missiles-history"],
    queryFn: () => getJson<{ strikes: Strike[] }>("/player/missiles/history"),
    enabled: authenticated && !noNation,
    staleTime: 10_000,
  });

  const [type, setType] = useState("medium");
  const [regionId, setRegionId] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (loadingMe || (authenticated && !noNation && info.isLoading)) {
    return (
      <Shell bg={bg}>
        <Card>
          <Loader2 className="mx-auto h-6 w-6 animate-spin" />
        </Card>
      </Shell>
    );
  }
  if (!authenticated) {
    return (
      <Shell bg={bg}>
        <Card>
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#5865f2]">
            <LogIn className="h-7 w-7" />
          </div>
          <h1 className="mb-2 font-serif text-xl font-bold">導彈系統</h1>
          <p className="mb-6 text-sm text-white/70">請先以 Discord 登入。</p>
          <button onClick={() => startDiscordLogin()} className="w-full rounded-lg bg-[#5865f2] px-4 py-2.5 text-sm font-semibold hover:bg-[#4752c4]">
            使用 Discord 登入
          </button>
        </Card>
      </Shell>
    );
  }
  if (noNation) {
    return (
      <Shell bg={bg}>
        <Card>
          <Shield className="mx-auto mb-3 h-10 w-10 text-white/40" />
          <h1 className="mb-2 font-serif text-xl font-bold">尚未建國</h1>
          <Link href="/game" className="block w-full rounded-lg bg-amber-500/85 px-4 py-2.5 text-sm font-bold text-black hover:bg-amber-400">
            前往建國
          </Link>
        </Card>
      </Shell>
    );
  }
  if (info.isError || !info.data) {
    return (
      <Shell bg={bg}>
        <Card>
          <h1 className="mb-2 font-serif text-xl font-bold">無法載入導彈資料</h1>
          <button onClick={() => info.refetch()} className="w-full rounded-lg bg-white/15 px-4 py-2.5 text-sm font-semibold hover:bg-white/25">
            重新載入
          </button>
        </Card>
      </Shell>
    );
  }

  const d = info.data;
  const selected = d.missiles.find((m) => m.type === type)!;
  const target = d.targets.find((t) => t.regionId === regionId) ?? null;
  const belowThreshold = d.money < d.minTreasury;
  const canFire = d.unlocked && !d.firedThisTurn && !belowThreshold && target != null && !busy;

  async function fire() {
    if (!target) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/player/missiles/launch`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ missileType: type, targetRegionId: target.regionId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "發射失敗");
      setResult({
        ok: true,
        text: `${json.missileLabel}命中 ${json.targetName} 的 ${json.regionName}：人口損失 ${formatBigNumber(json.populationLost)}，${json.buildingsDowngraded} 座建築受損、${json.buildingsDestroyed} 座被摧毀。花費 ${formatBigNumber(json.cost)} 金。`,
      });
      setRegionId(null);
      await Promise.all([info.refetch(), history.refetch(), qc.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() })]);
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : "發射失敗" });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <Shell bg={bg}>
      <div className="mx-auto max-w-4xl px-3 pb-12 md:px-6">
        <header className="flex items-center justify-between gap-3 py-4">
          <div className="flex items-center gap-3">
            <Link href="/game/military" className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/20 bg-black/45 backdrop-blur hover:bg-black/65" title="回軍事介面" data-testid="button-back-military">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-2.5 rounded-lg border border-white/15 bg-black/45 px-3 py-1.5 backdrop-blur">
              <Rocket className="h-5 w-5 text-red-300" />
              <span className="font-serif text-base font-bold md:text-lg">導彈系統</span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-white/70">{d.gameDate}</span>
            </div>
          </div>
          <GameNotifications />
        </header>

        {!d.unlocked ? (
          <div className="rounded-2xl border border-white/15 bg-black/60 p-8 text-center backdrop-blur" data-testid="missile-locked">
            <Lock className="mx-auto mb-3 h-10 w-10 text-white/40" />
            <h2 className="mb-1 font-serif text-lg font-bold">導彈系統尚未解鎖</h2>
            <p className="text-sm text-white/70">遊戲年份達 {d.unlockYear} 年後開放。目前是 {d.gameDate}。</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 rounded-2xl border border-white/15 bg-black/60 p-4 backdrop-blur md:grid-cols-3">
              <div>
                <div className="text-xs text-white/60">國庫</div>
                <div className="font-serif text-lg font-bold">{formatBigNumber(d.money)}</div>
              </div>
              <div>
                <div className="text-xs text-white/60">發射門檻（國庫至少）</div>
                <div className={`font-serif text-lg font-bold ${belowThreshold ? "text-red-300" : ""}`}>{formatBigNumber(d.minTreasury)}</div>
              </div>
              <div>
                <div className="text-xs text-white/60">本回合</div>
                <div className={`font-serif text-lg font-bold ${d.firedThisTurn ? "text-amber-300" : "text-emerald-300"}`}>{d.firedThisTurn ? "已發射（每回合限一發）" : "可發射"}</div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/15 bg-black/60 p-4 backdrop-blur">
              <h2 className="mb-3 font-serif text-base font-bold">1. 選擇導彈</h2>
              <div className="grid gap-2 md:grid-cols-3">
                {d.missiles.map((m) => (
                  <button
                    key={m.type}
                    onClick={() => setType(m.type)}
                    className={`rounded-xl border p-3 text-left transition ${type === m.type ? "border-red-400 bg-red-500/20" : "border-white/15 bg-white/5 hover:bg-white/10"}`}
                    data-testid={`missile-type-${m.type}`}
                  >
                    <div className="font-serif font-bold">{m.label}</div>
                    <div className="mt-1 text-xs text-white/70">花費國庫 {m.costPct}%（約 {formatBigNumber(m.cost)}）</div>
                    <div className="text-xs text-white/70">炸毀目標地區人口與建築 {m.damagePct}%</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-white/15 bg-black/60 p-4 backdrop-blur">
              <h2 className="mb-3 font-serif text-base font-bold">2. 選擇目標（交戰國的領土）</h2>
              {d.targets.length === 0 ? (
                <p className="text-sm text-white/60">目前沒有交戰中的國家，無法發射。</p>
              ) : (
                <div className="grid max-h-72 gap-2 overflow-y-auto md:grid-cols-2">
                  {d.targets.map((t) => (
                    <button
                      key={`${t.nationId}-${t.regionId}`}
                      onClick={() => setRegionId(t.regionId)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition ${regionId === t.regionId ? "border-red-400 bg-red-500/20" : "border-white/15 bg-white/5 hover:bg-white/10"}`}
                      data-testid={`missile-target-${t.regionId}`}
                    >
                      <span className="font-bold">{t.regionName}</span>
                      <span className="ml-2 text-xs text-white/60">{t.nationName ?? "（未命名）"} · 控制 {t.percent}%</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-white/15 bg-black/60 p-4 backdrop-blur">
              {belowThreshold && <p className="mb-2 text-sm text-red-300">國庫低於發射門檻，無法發射。</p>}
              {!confirming ? (
                <button
                  disabled={!canFire}
                  onClick={() => setConfirming(true)}
                  className="w-full rounded-lg bg-red-600 px-4 py-3 font-serif font-bold transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
                  data-testid="button-missile-arm"
                >
                  {target ? `準備對 ${target.regionName} 發射${selected.label}` : "請先選擇目標"}
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm">
                    確定發射<b>{selected.label}</b>攻擊 <b>{target?.regionName}</b>？將扣除國庫約 <b>{formatBigNumber(selected.cost)}</b>（{selected.costPct}%），無法撤回。
                  </p>
                  <div className="flex gap-2">
                    <button onClick={fire} disabled={busy} className="flex-1 rounded-lg bg-red-600 px-4 py-2.5 font-bold hover:bg-red-500 disabled:opacity-50" data-testid="button-missile-fire">
                      {busy ? "發射中…" : "確認發射"}
                    </button>
                    <button onClick={() => setConfirming(false)} disabled={busy} className="rounded-lg bg-white/15 px-4 py-2.5 font-semibold hover:bg-white/25">
                      取消
                    </button>
                  </div>
                </div>
              )}
              {result && <p className={`mt-3 text-sm ${result.ok ? "text-emerald-300" : "text-red-300"}`} data-testid="missile-result">{result.text}</p>}
            </div>
          </div>
        )}

        <div className="mt-4 rounded-2xl border border-white/15 bg-black/60 p-4 backdrop-blur">
          <h2 className="mb-3 font-serif text-base font-bold">發射紀錄</h2>
          {!history.data || history.data.strikes.length === 0 ? (
            <p className="text-sm text-white/60">還沒有紀錄。</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {history.data.strikes.map((s) => (
                <li key={s.id} className="rounded-lg bg-white/5 px-3 py-2">
                  <span className={s.direction === "outgoing" ? "text-amber-300" : "text-red-300"}>{s.direction === "outgoing" ? "我方發射" : "遭到襲擊"}</span>
                  <span className="ml-2">{s.attackerName} → {s.targetName} · {s.regionName} · {s.missileLabel}</span>
                  <div className="text-xs text-white/60">人口 −{formatBigNumber(s.populationLost)}，建築受損 {s.buildingsDowngraded}、摧毀 {s.buildingsDestroyed}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Shell>
  );
}
