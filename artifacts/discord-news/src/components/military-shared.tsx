import React from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Bandage,
  Coins,
  Compass,
  Factory,
  FlaskConical,
  Loader2,
  LogIn,
  Mountain,
  Ship,
  Shield,
  Trees,
  Users,
} from "lucide-react";
import {
  useGetPlayerNation,
  getGetPlayerNationQueryKey,
  useGetMilitaryOverview,
  getGetMilitaryOverviewQueryKey,
} from "@workspace/api-client-react";
import type {
  MilitaryOverview,
  MilitaryResources,
  MilitaryTechBonus,
  NavalLandingInfo,
} from "@workspace/api-client-react";
import { useCurrentUser, startDiscordLogin } from "@/lib/current-user";

const BASE = import.meta.env.BASE_URL;
export const DEFAULT_MILITARY_BG = `${BASE}game/home-bg-default.webp`;

/** 1234567 → "123.5萬"; 213000000 → "2.13億" */
export function formatBigNumber(v: number): string {
  if (v >= 1e8) {
    const n = v / 1e8;
    return `${n >= 100 ? Math.round(n).toLocaleString("zh-TW") : n.toFixed(2).replace(/\.?0+$/, "")}億`;
  }
  if (v >= 1e4) {
    const n = v / 1e4;
    return `${n >= 100 ? Math.round(n).toLocaleString("zh-TW") : n.toFixed(1).replace(/\.0$/, "")}萬`;
  }
  return v.toLocaleString("zh-TW");
}

/**
 * Task #386 — 研發/設計成本倍率標示：讓玩家看懂成本為何比別人貴/便宜。
 * 倍率 = 本國調整後生產力 ÷ 全球平均生產力（伺服器計算，已取整到 2 位小數）。
 */
export function CostMultiplierBadge({
  multiplier,
  label = "研發成本倍率",
}: {
  multiplier: number;
  label?: string;
}) {
  const hint =
    multiplier > 1.05
      ? "國力高於全球平均，成本較高"
      : multiplier < 0.95
        ? "國力低於全球平均，成本較低"
        : "與全球平均相當";
  const tone =
    multiplier > 1.05
      ? "bg-amber-500/20 text-amber-200"
      : multiplier < 0.95
        ? "bg-emerald-500/20 text-emerald-200"
        : "bg-white/10 text-white/70";
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs tabular-nums ${tone}`}
      title="成本倍率＝本國生產力 ÷ 全球平均生產力，國力越強研發越貴"
      data-testid="badge-cost-multiplier"
    >
      {label} ×{multiplier.toFixed(2)}（{hint}）
    </span>
  );
}

export function apiErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object" && "error" in data) {
      const msg = (data as { error?: unknown }).error;
      if (typeof msg === "string" && msg) return msg;
    }
    if (err instanceof Error && err.message) return err.message;
  }
  return "操作失敗，請稍後再試";
}

export const BONUS_TARGET_LABELS: Record<string, string> = {
  hp: "HP",
  attack: "攻擊",
  defense: "防禦",
  speed: "速度",
  accuracy: "命中",
  prodCost: "生產成本",
  popCost: "人口成本",
  moneyCost: "購買價格",
  upkeep: "維護費",
  recoverySpeed: "傷兵復原速度",
  recoveryRate: "傷兵復原率",
};

export const BONUS_CATEGORY_LABELS: Record<string, string> = {
  infantry: "步兵",
  ranged: "射手",
  armor: "騎兵/裝甲",
  artillery: "火炮",
  ship: "戰船",
  air: "空軍",
  siege: "攻城武器",
};

export function BonusBadge({ bonus }: { bonus: MilitaryTechBonus }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] ${
        bonus.pct >= 0
          ? "bg-emerald-500/20 text-emerald-200"
          : "bg-red-500/20 text-red-200"
      }`}
    >
      {bonus.category
        ? `${BONUS_CATEGORY_LABELS[bonus.category] ?? bonus.category} `
        : "全兵種 "}
      {BONUS_TARGET_LABELS[bonus.target] ?? bonus.target} {bonus.pct >= 0 ? "+" : ""}
      {bonus.pct}%
    </span>
  );
}

export function TechBonusBadges({ bonuses }: { bonuses: MilitaryTechBonus[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {bonuses.map((b, i) => (
        <BonusBadge key={i} bonus={b} />
      ))}
    </div>
  );
}

export function MilitaryShell({
  bg,
  children,
}: {
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-cover bg-center text-white"
      style={{ backgroundImage: `url(${bg})` }}
    >
      <div className="absolute inset-0 bg-black/55" />
      <div className="relative h-full">{children}</div>
    </div>
  );
}

export function ResourceBar({
  resources,
  wounded,
}: {
  resources: MilitaryResources;
  /** Task #105 — 傷兵數與科技復原加成（提供時多顯示一格） */
  wounded?: { total: number; speedPct: number; ratePct: number };
}) {
  const stats: {
    key: string;
    label: string;
    icon: typeof FlaskConical;
    iconClass: string;
    value: string;
    sub?: string | null;
  }[] = [
    {
      key: "tech",
      label: "科技點數",
      icon: FlaskConical,
      iconClass: "text-sky-300",
      value: formatBigNumber(resources.techPoints),
    },
    {
      key: "production",
      label: "生產力",
      icon: Factory,
      iconClass: "text-orange-300",
      value: formatBigNumber(resources.production),
    },
    {
      key: "population",
      label: "人口",
      icon: Users,
      iconClass: "text-emerald-300",
      value: formatBigNumber(resources.population),
    },
    {
      key: "money",
      label: "金錢",
      icon: Coins,
      iconClass: "text-yellow-300",
      value: formatBigNumber(resources.money),
    },
    {
      key: "wood",
      label: "木材",
      icon: Trees,
      iconClass: "text-lime-300",
      value: formatBigNumber(resources.wood),
    },
    {
      key: "ore",
      label: "礦石",
      icon: Mountain,
      iconClass: "text-stone-300",
      value: formatBigNumber(resources.ore),
    },
  ];
  if (wounded) {
    const bonusParts: string[] = [];
    if (wounded.speedPct > 0) bonusParts.push(`復原速度 +${wounded.speedPct}%`);
    if (wounded.ratePct > 0) bonusParts.push(`復原率 +${wounded.ratePct}%`);
    stats.push({
      key: "wounded",
      label: "傷兵",
      icon: Bandage,
      iconClass: "text-pink-300",
      value: formatBigNumber(wounded.total),
      sub: bonusParts.length > 0 ? bonusParts.join("・") : null,
    });
  }
  return (
    <div
      className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:flex md:items-center"
      data-testid="military-stats-bar"
    >
      {stats.map((s) => (
        <div
          key={s.key}
          className="flex items-center gap-2 rounded-lg border border-white/15 bg-black/50 px-3 py-2 backdrop-blur"
          data-testid={`military-stat-${s.key}`}
        >
          <s.icon className={`h-4 w-4 shrink-0 ${s.iconClass}`} />
          <div className="min-w-0 leading-tight">
            <div className="text-[10px] text-white/60">{s.label}</div>
            <div className="text-sm font-bold tabular-nums">{s.value}</div>
            {s.sub ? (
              <div className="text-[10px] text-emerald-300/90">{s.sub}</div>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 海上登陸能力總覽：研發「海戰」後顯示登陸容許量、攻擊力減損，以及是否已解鎖「指南針」跨洋登陸。
 * 未解鎖海戰時不顯示（回傳 null）。
 */
export function NavalLandingBar({ info }: { info: NavalLandingInfo }) {
  if (!info.naval) return null;
  return (
    <div
      className="rounded-lg border border-sky-400/30 bg-sky-500/10 px-4 py-3 backdrop-blur"
      data-testid="panel-naval-landing"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-sky-200">
        <Ship className="h-4 w-4 shrink-0" />
        海上登陸能力
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <div
          className="rounded border border-sky-400/25 bg-black/35 px-2.5 py-1.5 text-sky-100/90"
          data-testid="naval-landing-troop-cap"
        >
          <span className="text-sky-100/60">海上登陸容許量</span>{" "}
          <span className="font-bold tabular-nums text-sky-100">
            {formatBigNumber(info.troopCapacity)}
          </span>
          <span className="text-sky-100/60"> 單位/場</span>
        </div>
        <div
          className="rounded border border-sky-400/25 bg-black/35 px-2.5 py-1.5 text-sky-100/90"
          data-testid="naval-landing-reduction"
        >
          <span className="text-sky-100/60">減損攻擊力</span>{" "}
          <span className="font-bold tabular-nums text-sky-100">
            {info.attackReductionPct}%
          </span>
        </div>
        <div
          className={`flex items-center gap-1.5 rounded border px-2.5 py-1.5 ${
            info.compass
              ? "border-sky-400/25 bg-black/35 text-sky-100/90"
              : "border-white/10 bg-black/25 text-white/45"
          }`}
          data-testid="naval-landing-compass"
        >
          <Compass className="h-3.5 w-3.5 shrink-0" />
          指南針（跨洋登陸）
          <span className="font-bold">
            {info.compass ? "已解鎖" : "未解鎖"}
          </span>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-sky-100/55">
        {info.compass
          ? "已解鎖指南針：可無視距離跨洋登陸，容許量已提升。"
          : "研發「指南針」後可無視距離跨洋登陸，並提升登陸容許量。"}
      </p>
    </div>
  );
}

/**
 * Task #63 — 軍事相關全螢幕頁面的共用守衛：登入 → 建國 → 總覽載入。
 * 全部通過後以 render(overview, bg) 渲染實際頁面內容。
 */
export function MilitaryPageGuard({
  pageTitle,
  loginDescription,
  render,
}: {
  pageTitle: string;
  loginDescription: string;
  render: (overview: MilitaryOverview, bg: string) => React.ReactNode;
}) {
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
    refetch: refetchOverview,
  } = useGetMilitaryOverview({
    query: {
      queryKey: getGetMilitaryOverviewQueryKey(),
      enabled: authenticated,
      staleTime: 1000 * 15,
    },
  });

  const bg = nation?.backgroundUrl || DEFAULT_MILITARY_BG;

  if (loadingMe || (authenticated && loadingOverview)) {
    return (
      <MilitaryShell bg={bg}>
        <div className="flex h-full items-center justify-center">
          <div className="flex items-center gap-3 rounded-xl bg-black/60 px-6 py-4 text-white backdrop-blur">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>載入軍事資料中…</span>
          </div>
        </div>
      </MilitaryShell>
    );
  }

  if (!authenticated) {
    return (
      <MilitaryShell bg={bg}>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#5865f2]">
              <LogIn className="h-7 w-7" />
            </div>
            <h1 className="mb-2 font-serif text-xl font-bold">{pageTitle}</h1>
            <p className="mb-6 text-sm text-white/70">{loginDescription}</p>
            <button
              onClick={() => startDiscordLogin()}
              className="w-full rounded-lg bg-[#5865f2] px-4 py-2.5 text-sm font-semibold transition hover:bg-[#4752c4]"
              data-testid="button-military-login"
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
      </MilitaryShell>
    );
  }

  if (noNation) {
    return (
      <MilitaryShell bg={bg}>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <Shield className="mx-auto mb-3 h-10 w-10 text-white/40" />
            <h1 className="mb-2 font-serif text-xl font-bold">尚未建國</h1>
            <p className="mb-6 text-sm text-white/70">
              你還沒有國家。請先到玩家首頁完成建國，再回來{pageTitle}。
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
      </MilitaryShell>
    );
  }

  if (overviewError || !overview) {
    return (
      <MilitaryShell bg={bg}>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <h1 className="mb-2 font-serif text-xl font-bold">無法載入軍事資料</h1>
            <p className="mb-6 text-sm text-white/70">
              讀取軍事資料時發生錯誤，請稍後再試。
            </p>
            <button
              onClick={() => refetchOverview()}
              className="w-full rounded-lg bg-white/15 px-4 py-2.5 text-sm font-semibold transition hover:bg-white/25"
              data-testid="button-retry-military"
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
      </MilitaryShell>
    );
  }

  return <>{render(overview, bg)}</>;
}
