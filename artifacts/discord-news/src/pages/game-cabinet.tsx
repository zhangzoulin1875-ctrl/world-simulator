import React, { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Crown,
  Loader2,
  LogIn,
  Shield,
  Sparkles,
  UserPlus,
  UserX,
  Check,
  X,
  ClipboardList,
  ScrollText,
} from "lucide-react";
import {
  useGetPlayerNation,
  getGetPlayerNationQueryKey,
} from "@workspace/api-client-react";
import { useCurrentUser, startDiscordLogin } from "@/lib/current-user";
import { useToast } from "@/hooks/use-toast";
import { GameNotifications } from "@/components/game-notifications";

const BASE = import.meta.env.BASE_URL;
const DEFAULT_BG = `${BASE}game/home-bg-default.webp`;

/**
 * Task #242 — 內閣介面（地基）。取代先前「政治顧問」佔位。
 * 三位大臣（內政大臣／元帥／外交官）各由 AI 依國土歷史人物生成候選並任命，
 * 玩家可設定每位大臣的常駐方針、代理程度與可授權項目，並審批待批准事項。
 * 各領域的實際代理行動由下游任務在各自的領域模組實作，本頁只呈現地基框架。
 */

interface CabinetStyle {
  overreach: number;
  timidity: number;
  description: string;
}

interface CabinetMinister {
  id: number;
  domain: string;
  name: string;
  origin: string;
  style: CabinetStyle;
  era: string;
  eraLabel: string;
  status: string;
  createdAt: string;
}

interface CabinetCandidate {
  id: number;
  domain: string;
  name: string;
  origin: string;
  style: CabinetStyle;
}

interface CabinetActionKey {
  key: string;
  label: string;
  description?: string;
}

interface CabinetDomainSettings {
  domain: string;
  directive: string;
  agencyLevel: string;
  enabledActions: string[];
}

interface CabinetDomainView {
  domain: string;
  label: string;
  scope: string;
  disabled?: boolean;
  minister: CabinetMinister | null;
  candidates: CabinetCandidate[];
  settings: CabinetDomainSettings;
  actionKeys: CabinetActionKey[];
}

interface CabinetApproval {
  id: number;
  domain: string;
  domainLabel: string;
  actionKey: string;
  summary: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

interface AgencyOption {
  value: string;
  label: string;
}

interface CabinetOverview {
  era: string;
  eraLabel: string;
  agencyLevels: AgencyOption[];
  domains: CabinetDomainView[];
  pendingApprovals: CabinetApproval[];
}

const AGENCY_HINTS: Record<string, string> = {
  conservative: "僅在明確有利且低風險時才代理，其餘進待批准佇列。",
  balanced: "在風險與收益間取平衡，重大決策才需你批准。",
  aggressive: "在授權範圍內主動出擊，果斷把握機會。",
};

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data && typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

const CABINET_QUERY_KEY = ["cabinet", "overview"] as const;

function styleBand(value: number): string {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  if (v < 34) return "低";
  if (v < 67) return "中";
  return "高";
}

export default function GameCabinet() {
  const { data: me, isLoading: loadingMe } = useCurrentUser();
  const authenticated = me?.authenticated === true;

  const { data: nationEnvelope } = useGetPlayerNation({
    query: {
      queryKey: getGetPlayerNationQueryKey(),
      enabled: authenticated,
      staleTime: 1000 * 30,
    },
  });
  const nation = nationEnvelope?.nation ?? null;
  const noNation = nationEnvelope != null && !nationEnvelope.hasNation;

  const {
    data: overview,
    isLoading: loadingOverview,
    isError: overviewError,
    refetch,
  } = useQuery({
    queryKey: CABINET_QUERY_KEY,
    queryFn: () => apiJson<CabinetOverview>("/api/cabinet/overview"),
    enabled: authenticated && !noNation,
    staleTime: 1000 * 15,
  });

  const bg = nation?.backgroundUrl || DEFAULT_BG;

  if (loadingMe || (authenticated && !noNation && loadingOverview)) {
    return (
      <Shell bg={bg}>
        <div className="flex h-full items-center justify-center">
          <div className="flex items-center gap-3 rounded-xl bg-black/60 px-6 py-4 text-white backdrop-blur">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>載入內閣資料中…</span>
          </div>
        </div>
      </Shell>
    );
  }

  if (!authenticated) {
    return (
      <Shell bg={bg}>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#5865f2]">
              <LogIn className="h-7 w-7" />
            </div>
            <h1 className="mb-2 font-serif text-xl font-bold">內閣</h1>
            <p className="mb-6 text-sm text-white/70">
              請先以 Discord 登入，才能管理你的內閣。
            </p>
            <button
              onClick={() => startDiscordLogin()}
              className="w-full rounded-lg bg-[#5865f2] px-4 py-2.5 text-sm font-semibold transition hover:bg-[#4752c4]"
              data-testid="button-cabinet-login"
            >
              使用 Discord 登入
            </button>
            <Link
              href="/game"
              className="mt-4 inline-flex items-center gap-1 text-xs text-white/60 hover:text-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              回玩家首頁
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  if (noNation) {
    return (
      <Shell bg={bg}>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <Shield className="mx-auto mb-3 h-10 w-10 text-white/40" />
            <h1 className="mb-2 font-serif text-xl font-bold">尚未建國</h1>
            <p className="mb-6 text-sm text-white/70">
              你還沒有國家。請先到玩家首頁完成建國，再回來任命內閣。
            </p>
            <Link
              href="/game"
              className="block w-full rounded-lg bg-amber-500/85 px-4 py-2.5 text-sm font-bold text-black transition hover:bg-amber-400"
              data-testid="button-go-founding"
            >
              前往建國
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  if (overviewError || !overview) {
    return (
      <Shell bg={bg}>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <h1 className="mb-2 font-serif text-xl font-bold">無法載入內閣資料</h1>
            <p className="mb-6 text-sm text-white/70">
              讀取內閣資料時發生錯誤，請稍後再試。
            </p>
            <button
              onClick={() => refetch()}
              className="w-full rounded-lg bg-white/15 px-4 py-2.5 text-sm font-semibold transition hover:bg-white/25"
              data-testid="button-retry-cabinet"
            >
              重新載入
            </button>
            <Link
              href="/game"
              className="mt-4 inline-flex items-center gap-1 text-xs text-white/60 hover:text-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              回玩家首頁
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  return <CabinetScreen bg={bg} overview={overview} />;
}

function Shell({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-cover bg-center pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white"
      style={{ backgroundImage: `url(${bg})` }}
    >
      <div className="absolute inset-0 bg-black/55" />
      <div className="relative h-full">{children}</div>
    </div>
  );
}

type CabinetView = "cabinet" | "log";

function CabinetScreen({
  bg,
  overview,
}: {
  bg: string;
  overview: CabinetOverview;
}) {
  const [view, setView] = useState<CabinetView>("cabinet");

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white"
      style={{ backgroundImage: `url(${bg})` }}
      data-testid="page-game-cabinet"
    >
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/65 via-black/45 to-black/70" />

      <div className="relative mx-auto flex min-h-full max-w-6xl flex-col px-3 pb-10 md:px-6">
        <header className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between md:py-4">
          <div className="flex items-center gap-3">
            <Link
              href="/game"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-black/45 backdrop-blur transition hover:bg-black/70"
              title="回玩家首頁"
              data-testid="button-back-game"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-2.5 rounded-lg border border-white/15 bg-black/45 px-3 py-1.5 backdrop-blur">
              <Crown className="h-5 w-5 text-amber-300" />
              <span className="font-serif text-base font-bold md:text-lg">
                內閣
              </span>
              <span className="text-xs text-white/50">{overview.eraLabel}</span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <GameNotifications />
          </div>
        </header>

        <div className="mb-4 flex gap-1.5">
          <button
            onClick={() => setView("cabinet")}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
              view === "cabinet"
                ? "border-amber-300/60 bg-amber-500/25 text-amber-100"
                : "border-white/15 bg-black/40 text-white/60 hover:bg-white/10"
            }`}
            data-testid="tab-cabinet"
          >
            <Crown className="h-3.5 w-3.5" />
            內閣總覽
          </button>
          <button
            onClick={() => setView("log")}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
              view === "log"
                ? "border-amber-300/60 bg-amber-500/25 text-amber-100"
                : "border-white/15 bg-black/40 text-white/60 hover:bg-white/10"
            }`}
            data-testid="tab-action-log"
          >
            <ScrollText className="h-3.5 w-3.5" />
            行動紀錄
          </button>
        </div>

        {view === "cabinet" ? (
          <>
            <p className="mb-4 rounded-lg border border-white/10 bg-black/40 px-4 py-2.5 text-xs leading-relaxed text-white/70 backdrop-blur">
              內閣由三位大臣組成，各由該國掌控領土的歷史人物擔任。每位大臣有其執政風格
              （越權傾向、膽小程度），你可授權其代理事務並下達常駐方針。時代更替時大臣皆會卸任，需重新任命。
            </p>

            {overview.pendingApprovals.length > 0 && (
              <ApprovalsPanel
                approvals={overview.pendingApprovals}
                disabledDomains={overview.domains
                  .filter((d) => d.disabled)
                  .map((d) => d.domain)}
              />
            )}

            <div className="grid gap-4 md:grid-cols-3">
              {overview.domains.map((d) => (
                <DomainCard
                  key={d.domain}
                  domain={d}
                  agencyLevels={overview.agencyLevels}
                />
              ))}
            </div>
          </>
        ) : (
          <ActionLogPanel
            domains={overview.domains.map((d) => ({
              domain: d.domain,
              label: d.label,
            }))}
          />
        )}
      </div>
    </div>
  );
}

function ApprovalsPanel({
  approvals,
  disabledDomains,
}: {
  approvals: CabinetApproval[];
  disabledDomains: string[];
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const resolve = useMutation({
    mutationFn: ({ id, action }: { id: number; action: "approve" | "reject" }) =>
      apiJson(`/api/cabinet/approvals/${id}/${action}`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CABINET_QUERY_KEY });
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "處理失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
      });
    },
  });

  return (
    <div className="mb-4 rounded-xl border border-amber-400/30 bg-black/50 p-4 backdrop-blur">
      <div className="mb-3 flex items-center gap-2">
        <ClipboardList className="h-4 w-4 text-amber-300" />
        <h2 className="font-serif text-sm font-bold text-white/85">
          待批准事項（{approvals.length}）
        </h2>
      </div>
      <div className="space-y-2">
        {approvals.map((a) => {
          const domainDisabled = disabledDomains.includes(a.domain);
          return (
          <div
            key={a.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2"
            data-testid={`approval-${a.id}`}
          >
            <div className="min-w-0">
              <div className="text-[10px] text-amber-200/80">{a.domainLabel}</div>
              <div className="truncate text-sm text-white/85">{a.summary}</div>
              {domainDisabled && (
                <div className="text-[10px] text-rose-300/80">
                  此代理已停用，僅能否決清除
                </div>
              )}
            </div>
            <div className="flex shrink-0 gap-1.5">
              <button
                onClick={() => resolve.mutate({ id: a.id, action: "approve" })}
                disabled={resolve.isPending || domainDisabled}
                className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-500/80 transition hover:bg-emerald-400 disabled:opacity-50"
                title={domainDisabled ? "此代理已停用，無法批准" : "批准"}
                data-testid={`button-approve-${a.id}`}
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                onClick={() => resolve.mutate({ id: a.id, action: "reject" })}
                disabled={resolve.isPending}
                className="flex h-8 w-8 items-center justify-center rounded-md bg-rose-500/80 transition hover:bg-rose-400 disabled:opacity-50"
                title="否決"
                data-testid={`button-reject-${a.id}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}

function DomainCard({
  domain,
  agencyLevels,
}: {
  domain: CabinetDomainView;
  agencyLevels: AgencyOption[];
}) {
  return (
    <div
      className="flex flex-col rounded-xl border border-white/15 bg-black/50 p-4 backdrop-blur"
      data-testid={`cabinet-domain-${domain.domain}`}
    >
      <div className="mb-1 flex items-center gap-2">
        <Crown className="h-4 w-4 text-amber-300" />
        <h2 className="font-serif text-base font-bold text-white/90">
          {domain.label}
        </h2>
        {domain.disabled && (
          <span
            className="rounded-full border border-rose-400/40 bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-200"
            data-testid={`badge-disabled-${domain.domain}`}
          >
            已停用
          </span>
        )}
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-white/50">
        {domain.scope}
      </p>

      {domain.disabled ? (
        <DisabledDomainView domain={domain} />
      ) : domain.minister ? (
        <MinisterView
          domain={domain}
          agencyLevels={agencyLevels}
        />
      ) : (
        <VacantView domain={domain} />
      )}
    </div>
  );
}

function DisabledDomainView({ domain }: { domain: CabinetDomainView }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const minister = domain.minister;

  const dismiss = useMutation({
    mutationFn: () =>
      apiJson(`/api/cabinet/domains/${domain.domain}/dismiss`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast({ title: "已卸任大臣" });
      qc.invalidateQueries({ queryKey: CABINET_QUERY_KEY });
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "卸任失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
      });
    },
  });

  return (
    <div className="flex flex-1 flex-col">
      <p
        className="rounded-lg border border-rose-400/25 bg-rose-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-rose-100/80"
        data-testid={`text-disabled-${domain.domain}`}
      >
        此代理已停用：不再自動代理事務，也無法任命新大臣。相關事務請自行於對應頁面處理。
      </p>

      {minister && (
        <div className="mt-3 rounded-lg border border-white/10 bg-white/5 p-3 opacity-80">
          <div className="flex items-center justify-between gap-2">
            <div className="font-serif text-sm font-bold text-white/70">
              {minister.name}
            </div>
            <button
              onClick={() => {
                if (window.confirm(`確定要卸任「${minister.name}」嗎？`)) {
                  dismiss.mutate();
                }
              }}
              disabled={dismiss.isPending}
              className="flex items-center gap-1 rounded-md border border-white/15 bg-black/40 px-2 py-1 text-[10px] text-white/70 transition hover:bg-rose-500/30 disabled:opacity-50"
              data-testid={`button-dismiss-${domain.domain}`}
            >
              <UserX className="h-3 w-3" />
              卸任
            </button>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-white/50">
            {minister.origin}
          </p>
        </div>
      )}
    </div>
  );
}

function StyleBadges({ style }: { style: CabinetStyle }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70">
        越權傾向 {styleBand(style.overreach)}（{style.overreach}）
      </span>
      <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70">
        膽小程度 {styleBand(style.timidity)}（{style.timidity}）
      </span>
    </div>
  );
}

function MinisterView({
  domain,
  agencyLevels,
}: {
  domain: CabinetDomainView;
  agencyLevels: AgencyOption[];
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const minister = domain.minister!;

  const [directive, setDirective] = useState(domain.settings.directive);
  const [agencyLevel, setAgencyLevel] = useState(domain.settings.agencyLevel);
  const [enabled, setEnabled] = useState<string[]>(
    domain.settings.enabledActions,
  );

  const saveSettings = useMutation({
    mutationFn: () =>
      apiJson(`/api/cabinet/domains/${domain.domain}/settings`, {
        method: "PUT",
        body: JSON.stringify({
          directive,
          agencyLevel,
          enabledActions: enabled,
        }),
      }),
    onSuccess: () => {
      toast({ title: "已儲存內閣設定" });
      qc.invalidateQueries({ queryKey: CABINET_QUERY_KEY });
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "儲存失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
      });
    },
  });

  const dismiss = useMutation({
    mutationFn: () =>
      apiJson(`/api/cabinet/domains/${domain.domain}/dismiss`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast({ title: "已卸任大臣" });
      qc.invalidateQueries({ queryKey: CABINET_QUERY_KEY });
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "卸任失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
      });
    },
  });

  function toggleAction(key: string) {
    setEnabled((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="rounded-lg border border-amber-300/20 bg-amber-500/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="font-serif text-sm font-bold text-amber-100">
            {minister.name}
          </div>
          <button
            onClick={() => {
              if (window.confirm(`確定要卸任「${minister.name}」嗎？`)) {
                dismiss.mutate();
              }
            }}
            disabled={dismiss.isPending}
            className="flex items-center gap-1 rounded-md border border-white/15 bg-black/40 px-2 py-1 text-[10px] text-white/70 transition hover:bg-rose-500/30 disabled:opacity-50"
            data-testid={`button-dismiss-${domain.domain}`}
          >
            <UserX className="h-3 w-3" />
            卸任
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-white/60">
          {minister.origin}
        </p>
        <StyleBadges style={minister.style} />
        {minister.style.description && (
          <p className="mt-2 text-[11px] italic leading-relaxed text-white/55">
            「{minister.style.description}」
          </p>
        )}
      </div>

      <div className="mt-3 space-y-3">
        <div>
          <label className="mb-1 block text-[11px] font-semibold text-white/70">
            常駐方針
          </label>
          <textarea
            value={directive}
            onChange={(e) => setDirective(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="給大臣的長期指示（例如：優先發展經濟、避免衝突）"
            className="w-full resize-none rounded-lg border border-white/15 bg-black/40 px-2.5 py-2 text-xs text-white placeholder:text-white/30 focus:border-amber-300/50 focus:outline-none"
            data-testid={`input-directive-${domain.domain}`}
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold text-white/70">
            代理程度
          </label>
          <div className="flex gap-1.5">
            {agencyLevels.map((lvl) => (
              <button
                key={lvl.value}
                onClick={() => setAgencyLevel(lvl.value)}
                className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] font-semibold transition ${
                  agencyLevel === lvl.value
                    ? "border-amber-300/60 bg-amber-500/25 text-amber-100"
                    : "border-white/15 bg-black/40 text-white/60 hover:bg-white/10"
                }`}
                data-testid={`button-agency-${domain.domain}-${lvl.value}`}
              >
                {lvl.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] leading-relaxed text-white/45">
            {AGENCY_HINTS[agencyLevel] ?? ""}
          </p>
        </div>

        <div>
          <label className="mb-1 block text-[11px] font-semibold text-white/70">
            可授權代理項目
          </label>
          {domain.actionKeys.length === 0 ? (
            <p className="rounded-md border border-white/10 bg-black/30 px-2.5 py-2 text-[11px] text-white/40">
              此領域尚未開放可代理項目（開發中）。
            </p>
          ) : (
            <div className="space-y-1.5">
              {domain.actionKeys.map((a) => (
                <label
                  key={a.key}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-white/10 bg-black/30 px-2.5 py-1.5 text-[11px] transition hover:bg-white/5"
                  data-testid={`action-${domain.domain}-${a.key}`}
                >
                  <input
                    type="checkbox"
                    checked={enabled.includes(a.key)}
                    onChange={() => toggleAction(a.key)}
                    className="mt-0.5 accent-amber-400"
                  />
                  <span className="min-w-0">
                    <span className="font-semibold text-white/80">{a.label}</span>
                    {a.description && (
                      <span className="block text-[10px] text-white/45">
                        {a.description}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() => saveSettings.mutate()}
          disabled={saveSettings.isPending}
          className="w-full rounded-lg bg-amber-500/85 px-3 py-2 text-xs font-bold text-black transition hover:bg-amber-400 disabled:opacity-50"
          data-testid={`button-save-settings-${domain.domain}`}
        >
          {saveSettings.isPending ? "儲存中…" : "儲存設定"}
        </button>
      </div>
    </div>
  );
}

function VacantView({ domain }: { domain: CabinetDomainView }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const generate = useMutation({
    mutationFn: () =>
      apiJson<{ candidates: CabinetCandidate[] }>(
        `/api/cabinet/domains/${domain.domain}/candidates`,
        { method: "POST" },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CABINET_QUERY_KEY });
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "生成人選失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
      });
    },
  });

  const appoint = useMutation({
    mutationFn: (candidateId: number) =>
      apiJson(`/api/cabinet/domains/${domain.domain}/appoint`, {
        method: "POST",
        body: JSON.stringify({ candidateId }),
      }),
    onSuccess: () => {
      toast({ title: "已任命大臣" });
      qc.invalidateQueries({ queryKey: CABINET_QUERY_KEY });
    },
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "任命失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
      });
    },
  });

  if (domain.candidates.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-white/15 bg-black/25 p-6 text-center">
        <UserPlus className="mb-2 h-8 w-8 text-white/30" />
        <div className="mb-1 text-sm font-semibold text-white/60">職位空缺</div>
        <p className="mb-4 text-[11px] leading-relaxed text-white/45">
          由 AI 依你掌控領土的歷史人物，生成三位候選人供你挑選。
        </p>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-amber-500/85 px-3 py-2 text-xs font-bold text-black transition hover:bg-amber-400 disabled:opacity-50"
          data-testid={`button-generate-${domain.domain}`}
        >
          {generate.isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              生成中…
            </>
          ) : (
            <>
              <Sparkles className="h-3.5 w-3.5" />
              生成候選人
            </>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-white/70">
          選擇一位任命
        </span>
        <button
          onClick={() => generate.mutate()}
          disabled={generate.isPending}
          className="flex items-center gap-1 text-[10px] text-white/50 transition hover:text-white/80 disabled:opacity-50"
          data-testid={`button-regenerate-${domain.domain}`}
        >
          {generate.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Sparkles className="h-3 w-3" />
          )}
          重新生成
        </button>
      </div>
      <div className="space-y-2">
        {domain.candidates.map((c) => (
          <div
            key={c.id}
            className="rounded-lg border border-white/12 bg-white/5 p-3"
            data-testid={`candidate-${c.id}`}
          >
            <div className="font-serif text-sm font-bold text-white/90">
              {c.name}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-white/60">
              {c.origin}
            </p>
            <StyleBadges style={c.style} />
            {c.style.description && (
              <p className="mt-1.5 text-[11px] italic leading-relaxed text-white/50">
                「{c.style.description}」
              </p>
            )}
            <button
              onClick={() => appoint.mutate(c.id)}
              disabled={appoint.isPending}
              className="mt-2 w-full rounded-md bg-amber-500/80 px-2.5 py-1.5 text-[11px] font-bold text-black transition hover:bg-amber-400 disabled:opacity-50"
              data-testid={`button-appoint-${c.id}`}
            >
              任命
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface CabinetActionLogEntry {
  id: number;
  domain: string;
  domainLabel: string;
  actionKey: string;
  summary: string;
  mode: "auto" | "approval";
  costAmount: number | null;
  costKind: "money" | "tech" | "production" | null;
  turnDate: string | null;
  createdAt: string;
}

const COST_KIND_LABELS: Record<string, string> = {
  money: "金錢",
  tech: "科技點數",
  production: "生產力",
};

function formatLogTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ActionLogPanel({
  domains,
}: {
  domains: { domain: string; label: string }[];
}) {
  const [filter, setFilter] = useState<string>("");

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["cabinet", "action-log", filter],
    queryFn: () =>
      apiJson<{ logs: CabinetActionLogEntry[] }>(
        `/api/cabinet/action-log${filter ? `?domain=${encodeURIComponent(filter)}` : ""}`,
      ),
    staleTime: 1000 * 15,
  });

  const filterOptions = [{ domain: "", label: "全部" }, ...domains];
  const logs = data?.logs ?? [];

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {filterOptions.map((opt) => (
          <button
            key={opt.domain || "all"}
            onClick={() => setFilter(opt.domain)}
            className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold transition ${
              filter === opt.domain
                ? "border-amber-300/60 bg-amber-500/25 text-amber-100"
                : "border-white/15 bg-black/40 text-white/60 hover:bg-white/10"
            }`}
            data-testid={`filter-log-${opt.domain || "all"}`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/40 p-8 text-sm text-white/60 backdrop-blur">
          <Loader2 className="h-4 w-4 animate-spin" />
          載入行動紀錄中…
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-black/40 p-8 text-center text-sm text-white/60 backdrop-blur">
          <span>讀取行動紀錄時發生錯誤。</span>
          <button
            onClick={() => refetch()}
            className="rounded-lg bg-white/15 px-3 py-1.5 text-xs font-semibold transition hover:bg-white/25"
            data-testid="button-retry-log"
          >
            重新載入
          </button>
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-white/15 bg-black/25 p-10 text-center text-white/45 backdrop-blur">
          <ScrollText className="h-8 w-8 text-white/25" />
          <span className="text-sm">尚無行動紀錄。</span>
          <p className="text-[11px] leading-relaxed">
            當大臣自動執行或提報事項時，會在此留下紀錄。
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {logs.map((l) => (
            <div
              key={l.id}
              className="rounded-lg border border-white/10 bg-black/45 px-3 py-2.5 backdrop-blur"
              data-testid={`log-entry-${l.id}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-200/90">
                  {l.domainLabel}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                    l.mode === "auto"
                      ? "bg-emerald-500/20 text-emerald-200"
                      : "bg-sky-500/20 text-sky-200"
                  }`}
                >
                  {l.mode === "auto" ? "自動執行" : "提報批准"}
                </span>
                {l.costAmount != null && l.costKind && (
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/70">
                    {COST_KIND_LABELS[l.costKind] ?? l.costKind}{" "}
                    {l.costAmount.toLocaleString("en-US")}
                  </span>
                )}
                <span className="ml-auto text-[10px] text-white/40">
                  {l.turnDate ? `${l.turnDate}　` : ""}
                  {formatLogTime(l.createdAt)}
                </span>
              </div>
              <div className="mt-1.5 text-sm leading-relaxed text-white/85">
                {l.summary}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
