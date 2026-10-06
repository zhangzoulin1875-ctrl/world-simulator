import React, { useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Coins,
  Loader2,
  LogIn,
  Map as MapIcon,
  Percent,
  ReceiptText,
  Scale,
  Shield,
  TrendingDown,
  TrendingUp,
  Wallet,
  Wheat,
} from "lucide-react";
import {
  useGetPlayerNation,
  getGetPlayerNationQueryKey,
  useGetEconomyOverview,
  getGetEconomyOverviewQueryKey,
} from "@workspace/api-client-react";
import type { EconomyOverview } from "@workspace/api-client-react";
import { useCurrentUser, startDiscordLogin } from "@/lib/current-user";
import { formatBigNumber } from "@/components/military-shared";
import { GameNotifications } from "@/components/game-notifications";
import { HelpButton } from "@/components/help-button";
import { FinanceTab } from "@/components/economy/finance-tab";
import { RegionsTab } from "@/components/economy/regions-tab";
import { EconomyTechTab } from "@/components/economy/economy-tech-tab";
import { FoodTab } from "@/components/economy/food-tab";

const BASE = import.meta.env.BASE_URL;
const DEFAULT_BG = `${BASE}game/home-bg-default.webp`;

type TabKey = "finance" | "food" | "regions" | "tech";

export default function GameEconomy() {
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
  } = useGetEconomyOverview({
    query: {
      queryKey: getGetEconomyOverviewQueryKey(),
      enabled: authenticated && !noNation,
      staleTime: 1000 * 15,
    },
  });

  const bg = nation?.backgroundUrl || DEFAULT_BG;

  if (loadingMe || (authenticated && !noNation && loadingOverview)) {
    return (
      <Shell bg={bg}>
        <div className="flex h-full items-center justify-center">
          <div className="flex items-center gap-3 rounded-xl bg-black/60 px-6 py-4 text-white backdrop-blur">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>載入經濟資料中…</span>
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
            <h1 className="mb-2 font-serif text-xl font-bold">經濟介面</h1>
            <p className="mb-6 text-sm text-white/70">
              請先以 Discord 登入，才能管理你的財政。
            </p>
            <button
              onClick={() => startDiscordLogin()}
              className="w-full rounded-lg bg-[#5865f2] px-4 py-2.5 text-sm font-semibold transition hover:bg-[#4752c4]"
              data-testid="button-economy-login"
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
              你還沒有國家。請先到玩家首頁完成建國，再回來管理經濟。
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
            <h1 className="mb-2 font-serif text-xl font-bold">無法載入經濟資料</h1>
            <p className="mb-6 text-sm text-white/70">
              讀取經濟資料時發生錯誤，請稍後再試。
            </p>
            <button
              onClick={() => refetchOverview()}
              className="w-full rounded-lg bg-white/15 px-4 py-2.5 text-sm font-semibold transition hover:bg-white/25"
              data-testid="button-retry-economy"
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

  return <EconomyScreen bg={bg} overview={overview} />;
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

function TopStats({ overview }: { overview: EconomyOverview }) {
  const surplus = overview.netSurplusPerTurn;
  const stats = [
    {
      key: "money",
      label: "金錢",
      icon: Coins,
      iconClass: "text-yellow-300",
      value: formatBigNumber(overview.money),
      extra: null as string | null,
      extraClass: "",
    },
    {
      key: "taxincome",
      label: "稅收/回合",
      icon: Wallet,
      iconClass: "text-emerald-300",
      value: formatBigNumber(overview.taxIncomePerTurn),
      extra: null,
      extraClass: "",
    },
    {
      key: "surplus",
      label: "結餘/回合",
      icon: surplus >= 0 ? TrendingUp : TrendingDown,
      iconClass: surplus >= 0 ? "text-teal-300" : "text-rose-300",
      value: `${surplus >= 0 ? "+" : "−"}${formatBigNumber(Math.abs(surplus))}`,
      extra: null,
      extraClass: "",
    },
    {
      key: "taxrate",
      label: "稅率",
      icon: Percent,
      iconClass: "text-sky-300",
      value: `${overview.taxRatePct}%`,
      extra: `效率 ${overview.taxEfficiencyPct}%`,
      extraClass: "text-white/50",
    },
  ];
  return (
    <div
      className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:flex md:items-center"
      data-testid="economy-stats-bar"
    >
      {stats.map((s) => (
        <div
          key={s.key}
          className="flex items-center gap-2 rounded-lg border border-white/15 bg-black/50 px-3 py-2 backdrop-blur"
          data-testid={`economy-stat-${s.key}`}
        >
          <s.icon className={`h-4 w-4 shrink-0 ${s.iconClass}`} />
          <div className="min-w-0 leading-tight">
            <div className="text-[10px] text-white/60">{s.label}</div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-bold tabular-nums">{s.value}</span>
              {s.extra && (
                <span className={`text-[10px] font-bold ${s.extraClass}`}>
                  {s.extra}
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EconomyScreen({
  bg,
  overview,
}: {
  bg: string;
  overview: EconomyOverview;
}) {
  const [tab, setTab] = useState<TabKey>("finance");

  const tabs: { key: TabKey; label: string; icon: typeof Scale }[] = [
    { key: "finance", label: "財政", icon: Scale },
    { key: "food", label: "糧食", icon: Wheat },
    { key: "regions", label: "地區", icon: MapIcon },
    { key: "tech", label: "經濟科技", icon: ReceiptText },
  ];

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white"
      style={{ backgroundImage: `url(${bg})` }}
      data-testid="page-game-economy"
    >
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/65 via-black/45 to-black/70" />

      <div className="relative mx-auto flex min-h-full max-w-6xl flex-col px-3 pb-10 md:px-6">
        {/* header */}
        <header className="relative flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between md:py-4">
          <HelpButton helpKey={`economy:${tab}`} />
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
              <Coins className="h-5 w-5 text-yellow-300" />
              <span className="font-serif text-base font-bold md:text-lg">
                經濟介面
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <GameNotifications />
            <TopStats overview={overview} />
          </div>
        </header>

        {/* tabs */}
        <div className="mb-4 flex gap-1.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 rounded-t-lg border border-b-0 px-4 py-2 font-serif text-sm font-bold transition md:px-6 md:text-base ${
                tab === t.key
                  ? "border-amber-300/60 bg-gradient-to-b from-amber-500/25 to-black/60 text-amber-100"
                  : "border-white/15 bg-black/45 text-white/70 hover:bg-black/60"
              }`}
              data-testid={`tab-economy-${t.key}`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>

        {tab === "finance" && <FinanceTab overview={overview} />}
        {tab === "food" && <FoodTab />}
        {tab === "regions" && <RegionsTab />}
        {tab === "tech" && <EconomyTechTab />}
      </div>
    </div>
  );
}
