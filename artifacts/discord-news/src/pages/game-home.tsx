import { Bot } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AutopilotPanel } from "@/components/autopilot-panel";
import React from "react";
import { Link, useLocation } from "wouter";
import {
  Swords,
  Coins,
  Landmark,
  Map,
  Handshake,
  Settings,
  FlaskConical,
  Factory,
  Users,
  Bandage,
  CalendarDays,
  Shield,
  ShieldCheck,
  Flame,
  HeartCrack,
  Flag,
  LogIn,
  Loader2,
  MapPinned,
  BookOpen,
  Siren,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useIsRestoring } from "@tanstack/react-query";
import {
  useGetPlayerNation,
  getGetPlayerNationQueryKey,
  useGetWorldGameState,
  getGetWorldGameStateQueryKey,
} from "@workspace/api-client-react";
import type { PlayerNation } from "@workspace/api-client-react";
import { useCurrentUser, startDiscordLogin } from "@/lib/current-user";
import { GameFounding } from "@/components/game-founding";
import { GameNotifications } from "@/components/game-notifications";
import { GameNews } from "@/components/game-news";
import { GameMusicPlayer } from "@/components/game-music-player";
import { GameSettingsDialog } from "@/components/game-settings";
import { GameAdvisor } from "@/components/game-advisor";
import { formatBigNumber } from "@/components/military-shared";
import {
  StatBreakdownDialog,
  type BreakdownStatKey,
} from "@/components/game-stat-breakdown";
import { populationLoadState, populationLoadTextClass } from "@/lib/populationLoad";
import { useEncyclopedia } from "@/components/encyclopedia-context";
import {
  GameOnboarding,
  type OnboardingPhase,
} from "@/components/game-onboarding";
import {
  useHelpScope,
  isOnboardingDone,
  markOnboardingDone,
} from "@/lib/help-storage";
import { useAiQueueStatus, formatWaitMs } from "@/hooks/use-ai-queue";

const BASE = import.meta.env.BASE_URL;
const DEFAULT_BG = `${BASE}game/home-bg-default.webp`;
const DEFAULT_KANBAN = `${BASE}game/kanban-default.webp`;

/** "1900-01-01" → "1900年1月1日"（無效格式時原樣顯示）。 */
function formatGameDate(iso: string): string {
  const m = /^(\d{1,4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * 底部資訊欄常駐的 AI 排隊狀態（取代原先只在忙碌時才浮現的角落徽章——
 * 玩家反映看不到，因為閒置時它會自動隱藏。現在永遠顯示一行文字，
 * 閒置時明確告知「無需等待」，忙碌時顯示排隊件數與預計等待時間，
 * 玩家不會誤以為卡住。手機版文字會自動截斷換行、不會把版面撐爛。
 */
function AiQueueStatusLine() {
  const { data } = useAiQueueStatus();
  const busy = !!data && (data.active + data.queued > 0);
  const label = !data
    ? "AI 狀態：讀取中…"
    : busy
      ? `AI 處理中：${data.active + data.queued} 筆排隊，新操作預計要等 ${formatWaitMs(data.estNewWaitMs)}`
      : "AI 狀態：暢通，無需等待";
  return (
    <div
      className="order-last flex w-full min-w-0 items-center justify-center gap-1.5 border-t border-white/10 pt-2 text-[11px] text-white/50 sm:text-xs"
      data-testid="ai-queue-status"
      aria-live="polite"
    >
      {busy && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

/** 右下角遊戲時間時鐘（年/月/日）。載入中或失敗時不顯示。 */
function GameClock() {
  const { data } = useGetWorldGameState({
    query: {
      queryKey: getGetWorldGameStateQueryKey(),
      staleTime: 1000 * 60,
    },
  });
  if (!data?.gameDate) return null;
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-white/15 bg-black/50 px-2 py-1.5 backdrop-blur sm:px-3 sm:py-2"
      title="遊戲時間"
      data-testid="game-clock"
    >
      <CalendarDays className="h-4 w-4 shrink-0 text-amber-300" />
      <div className="leading-tight">
        <div className="text-[10px] text-white/60">遊戲時間</div>
        <div
          className="whitespace-nowrap font-serif text-sm font-bold tabular-nums"
          data-testid="text-game-date"
        >
          {formatGameDate(data.gameDate)}
        </div>
      </div>
    </div>
  );
}

export default function GameHome() {
  // 還原本機持久化快取的短暫期間；此時查詢尚未提供快取資料。
  const isRestoring = useIsRestoring();
  const { data: me, isLoading: loadingMe } = useCurrentUser();
  const authenticated = me?.authenticated === true;

  const {
    data: nationEnvelope,
    isLoading: loadingNation,
    isError: nationError,
    isFetching: fetchingNation,
    refetch: refetchNation,
  } = useGetPlayerNation({
    query: {
      queryKey: getGetPlayerNationQueryKey(),
      enabled: authenticated,
      staleTime: 1000 * 30,
    },
  });

  // 只有在「完全沒有任何快取、且仍在首次抓取（或還原中）」時才顯示全螢幕載入。
  // 一旦本機有可用快取，畫面會直接以快取內容渲染，背景再靜默更新為最新值。
  if (isRestoring || loadingMe || (authenticated && loadingNation)) {
    return (
      <FullscreenShell>
        <div className="flex h-full items-center justify-center">
          <div className="flex items-center gap-3 rounded-xl bg-black/60 px-6 py-4 text-white backdrop-blur">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>載入國家資料中…</span>
          </div>
        </div>
      </FullscreenShell>
    );
  }

  if (authenticated && nationError) {
    return (
      <FullscreenShell>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <h1 className="mb-2 font-serif text-xl font-bold">無法載入國家資料</h1>
            <p className="mb-6 text-sm text-white/70">
              讀取國家資料時發生錯誤，請稍後再試。
            </p>
            <button
              onClick={() => refetchNation()}
              className="w-full rounded-lg bg-white/15 px-4 py-2.5 text-sm font-semibold transition hover:bg-white/25"
              data-testid="button-retry-nation"
            >
              重新載入
            </button>
          </div>
        </div>
      </FullscreenShell>
    );
  }

  if (!authenticated) {
    return (
      <FullscreenShell>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#5865f2]">
              <LogIn className="h-7 w-7" />
            </div>
            <h1 className="mb-2 font-serif text-xl font-bold">玩家首頁</h1>
            <p className="mb-6 text-sm text-white/70">
              請先以 Discord 登入，才能進入你的國家。
            </p>
            <button
              onClick={() => startDiscordLogin()}
              className="w-full rounded-lg bg-[#5865f2] px-4 py-2.5 text-sm font-semibold transition hover:bg-[#4752c4]"
              data-testid="button-game-login"
            >
              使用 Discord 登入
            </button>
          </div>
        </div>
      </FullscreenShell>
    );
  }

  const nation = nationEnvelope?.nation ?? null;

  // 尚未建國 → 顯示建國引導畫面
  if (!nation) {
    return (
      <FullscreenShell>
        <GameFounding />
      </FullscreenShell>
    );
  }

  return <GameScreen nation={nation} refreshing={fetchingNation} />;
}

function FullscreenShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-cover bg-center pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      style={{ backgroundImage: `url(${DEFAULT_BG})` }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative h-full">{children}</div>
    </div>
  );
}

function GameScreen({
  nation,
  refreshing = false,
}: {
  nation: PlayerNation;
  refreshing?: boolean;
}) {
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [autopilotOpen, setAutopilotOpen] = React.useState(false);
  const [breakdownStat, setBreakdownStat] =
    React.useState<BreakdownStatKey | null>(null);
  const [, navigate] = useLocation();

  // 遊戲百科 + 新手教學（首次進入自動觸發歡迎導覽）
  const { openEncyclopedia, setOnboardingStarter } = useEncyclopedia();
  const [onboardPhase, setOnboardPhase] =
    React.useState<OnboardingPhase>(null);
  const helpScope = useHelpScope();
  const onboardingTriggered = React.useRef(false);

  React.useEffect(() => {
    if (onboardingTriggered.current) return;
    // 等取得真正的玩家身分後再判定，避免用匿名範圍誤判首次狀態。
    if (helpScope === "anon") return;
    onboardingTriggered.current = true;
    if (!isOnboardingDone(helpScope)) setOnboardPhase("welcome");
  }, [helpScope]);

  // 向全域百科註冊「開啟新手教學」的實作，讓其他頁面也能觸發（導回首頁後執行）。
  React.useEffect(() => {
    setOnboardingStarter(() => setOnboardPhase("welcome"));
    return () => setOnboardingStarter(null);
  }, [setOnboardingStarter]);

  const bg = nation.backgroundUrl || DEFAULT_BG;
  const kanban = nation.kanbanUrl || DEFAULT_KANBAN;

  const stats: Array<{
    key: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    iconClass: string;
    value: string;
    extra: string | null;
    /** extra 文字顏色(預設綠)。 */
    extraClass?: string;
    /** 滑鼠懸停提示。 */
    title?: string;
  }> = [
    {
      key: "tech",
      label: "科技點數",
      icon: FlaskConical,
      iconClass: "text-sky-300",
      value: formatBigNumber(nation.techPoints),
      // 每回合科技成長（由掌控地區即時計算；未掌控任何地區時為 +0）
      extra: `+${formatBigNumber(nation.techPerTurn)}`,
    },
    {
      key: "production",
      label: "生產力",
      icon: Factory,
      iconClass: "text-orange-300",
      // Task #179 — 剩餘可用 / 本回合總量（e.g. 545/1000）
      value: `${formatBigNumber(nation.production)}/${formatBigNumber(nation.productionTotal)}`,
      extra: null,
    },
    {
      key: "population",
      label: "總人口",
      icon: Users,
      iconClass: "text-emerald-300",
      value: formatBigNumber(nation.population),
      // 每回合人口「實際淨成長率」（出生率套上土地承載量後）。
      // 顏色與提示依負載狀態:成長中(綠)/接近上限(黃)/超載回落(紅)。
      extra:
        nation.populationGrowthPct !== 0
          ? `${nation.populationGrowthPct > 0 ? "+" : ""}${nation.populationGrowthPct}%`
          : null,
      extraClass: populationLoadTextClass(nation.populationLoadRatio),
      title: `人口 ${formatBigNumber(nation.population)} / 承載量 ${formatBigNumber(nation.populationCapacity)}（${Math.round(nation.populationLoadRatio * 100)}%）・${populationLoadState(nation.populationLoadRatio).label}`,
    },
    {
      key: "money",
      label: "金錢",
      icon: Coins,
      iconClass: "text-yellow-300",
      value: formatBigNumber(nation.money),
      extra: null,
    },
    // Task #43 — 內政三數值（有效值 = 基底 + 生效中內政條目加減成）
    {
      key: "stability",
      label: "穩定度",
      icon: ShieldCheck,
      iconClass: "text-teal-300",
      value: String(nation.stability),
      extra: null,
    },
    {
      key: "unrest",
      label: "暴動度",
      icon: Flame,
      iconClass: "text-red-300",
      value: String(nation.unrest),
      extra: null,
    },
    {
      key: "warweariness",
      label: "厭戰度",
      icon: HeartCrack,
      iconClass: "text-rose-300",
      value: String(nation.warWeariness),
      extra: null,
    },
    // Task #105 — 傷兵總數（全國傷兵池 + 前線傷兵；隨結算迴圈逐步歸隊）
    {
      key: "wounded",
      label: "傷兵",
      icon: Bandage,
      iconClass: "text-pink-300",
      value: formatBigNumber(nation.woundedTotal),
      extra: null,
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white"
      style={{ backgroundImage: `url(${bg})` }}
      data-testid="page-game-home"
    >
      {/* readability overlays */}
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/55 via-transparent to-black/65" />

      <div className="relative flex min-h-full flex-col md:h-full md:min-h-0">
        {/* ── Top bar ─────────────────────────────────────── */}
        <header className="relative flex flex-col gap-3 p-3 md:flex-row md:items-start md:justify-between md:p-4">
          {/* top-center: 遊戲百科（問號） */}
          <button
            type="button"
            onClick={() => openEncyclopedia()}
            className="absolute left-1/2 top-3 z-30 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white/85 backdrop-blur transition hover:bg-black/75 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            title="遊戲百科"
            aria-label="開啟遊戲百科"
            data-testid="button-encyclopedia"
          >
            <BookOpen className="h-5 w-5" />
          </button>
          {/* top-left: flag + name */}
          <div className="flex items-center gap-3" data-testid="header-nation">
            <div className="flex items-center gap-2.5 rounded-lg border border-white/15 bg-black/45 px-3 py-1.5 backdrop-blur">
              {nation.flagUrl ? (
                <img
                  src={nation.flagUrl}
                  alt="國旗"
                  className="h-7 w-10 rounded-sm border border-white/20 object-cover"
                />
              ) : (
                <div className="flex h-7 w-10 items-center justify-center rounded-sm border border-dashed border-white/25 bg-white/5">
                  <Flag className="h-3.5 w-3.5 text-white/40" />
                </div>
              )}
              <span
                className="max-w-[40vw] truncate font-serif text-sm font-bold md:max-w-[240px] md:text-base"
                data-testid="text-nation-name"
              >
                {nation.name ?? ""}
              </span>
            </div>
          </div>

          {/* top-right: bell + stats */}
          <div className="flex items-start gap-2">
            {refreshing && (
              <div
                className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-black/50 px-2 py-1.5 text-[11px] text-white/70 backdrop-blur"
                title="正在背景更新最新資料"
                data-testid="indicator-refreshing"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span className="hidden sm:inline">更新中…</span>
              </div>
            )}
            <GameNews />
            <GameNotifications />
            <div
              className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:flex md:items-center"
              data-testid="stats-bar"
            >
              {stats.map((s) => {
                // Task #179 — 金錢 → 前往經濟頁；傷兵不可點；其餘開啟來源明細彈窗。
                const onActivate =
                  s.key === "money"
                    ? () => navigate("/game/economy")
                    : s.key === "wounded"
                      ? undefined
                      : () => setBreakdownStat(s.key as BreakdownStatKey);
                const inner = (
                  <>
                    <s.icon
                      className={`h-4 w-4 shrink-0 md:h-5 md:w-5 ${s.iconClass}`}
                    />
                    <div className="min-w-0 leading-tight">
                      <div className="text-[10px] text-white/60">{s.label}</div>
                      <div className="flex items-baseline gap-1">
                        <span className="text-sm font-bold tabular-nums md:text-base">
                          {s.value}
                        </span>
                        {s.extra && (
                          <span
                            className={`text-[11px] font-bold ${s.extraClass ?? "text-green-400"}`}
                          >
                            {s.extra}
                          </span>
                        )}
                      </div>
                    </div>
                  </>
                );
                const cellClass =
                  "flex items-center gap-2 rounded-lg border border-white/15 bg-black/50 px-3 py-2 text-left backdrop-blur";
                if (!onActivate) {
                  return (
                    <div
                      key={s.key}
                      className={cellClass}
                      title={s.title}
                      data-testid={`stat-${s.key}`}
                    >
                      {inner}
                    </div>
                  );
                }
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={onActivate}
                    className={`${cellClass} transition-colors hover:border-white/40 hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60`}
                    title={s.title}
                    data-testid={`stat-${s.key}`}
                    aria-label={
                      s.key === "money" ? "前往財政頁" : `${s.label} 來源明細`
                    }
                  >
                    {inner}
                  </button>
                );
              })}
            </div>
          </div>
        </header>

        {/* ── Middle: buttons (left) + kanban (right) ─────── */}
        <div className="relative flex flex-1 flex-col md:flex-row md:items-stretch">
          {/* 看板顧問 — anchored right；可點擊開啟設定，旁邊顯示漫畫提醒泡泡 */}
          <GameAdvisor
            nation={nation}
            kanban={kanban}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          {/* left action buttons */}
          <div className="order-2 px-4 py-4 md:order-none md:flex md:w-[400px] md:shrink-0 md:items-center md:px-6 md:py-0">
            {/* desktop: arc layout */}
            <div className="relative hidden h-[440px] w-[340px] md:block">
              <ArcButton
                label="地圖"
                icon={Map}
                center
                style={{ left: 52, top: 128 }}
                href="/game/map"
              />
              <ArcButton
                label="科技"
                icon={FlaskConical}
                style={{ left: 8, top: 300 }}
                href="/game/technology"
              />
              <ArcButton
                label="軍事"
                icon={Swords}
                style={{ left: 118, top: 8 }}
                href="/game/military"
              />
              <ArcButton
                label="超事件"
                icon={Siren}
                style={{ left: 8, top: 8 }}
                href="/game/super-events"
              />
              <ArcButton
                label="經濟"
                icon={Coins}
                style={{ left: 216, top: 100 }}
                href="/game/economy"
              />
              <ArcButton
                label="政治"
                icon={Landmark}
                style={{ left: 216, top: 244 }}
                href="/game/politics"
              />
              <ArcButton
                label="外交"
                icon={Handshake}
                style={{ left: 118, top: 338 }}
                href="/game/diplomacy"
              />
            </div>

            {/* mobile: button row, map in the middle & bigger */}
            <div className="flex flex-wrap items-end justify-center gap-x-2.5 gap-y-3 md:hidden">
              <MobileButton label="軍事" icon={Swords} href="/game/military" />
              <MobileButton label="經濟" icon={Coins} href="/game/economy" />
              <MobileButton label="地圖" icon={Map} center href="/game/map" />
              <MobileButton
                label="科技"
                icon={FlaskConical}
                href="/game/technology"
              />
              <MobileButton label="政治" icon={Landmark} href="/game/politics" />
              <MobileButton label="外交" icon={Handshake} href="/game/diplomacy" />
              <MobileButton label="超事件" icon={Siren} href="/game/super-events" />
            </div>
          </div>
        </div>

        {/* ── Bottom bar: name + emblem + government ──────── */}
        <footer className="relative flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-black/60 px-3 py-3 backdrop-blur sm:px-4 md:px-6">
          <AiQueueStatusLine />
          <div className="flex min-w-0 items-center gap-3" data-testid="footer-nation">
            {nation.emblemUrl ? (
              <img
                src={nation.emblemUrl}
                alt="國徽"
                className="h-10 w-10 shrink-0 rounded-full border border-white/25 object-cover"
              />
            ) : (
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-dashed border-white/25 bg-white/5">
                <Shield className="h-4.5 w-4.5 text-white/40" />
              </div>
            )}
            <div className="min-w-0 leading-tight">
              <div
                className="truncate font-serif text-base font-bold md:text-lg"
                data-testid="text-footer-nation-name"
              >
                {nation.name ?? "尚未建國"}
              </div>
              <div className="truncate text-xs text-white/60" data-testid="text-government">
                {nation.government ?? "政體未定"}
              </div>
            </div>
            <ControlledRegionsPanel regions={nation.regions} />
          </div>

          {/* bottom-right: music player + game clock + settings */}
          <div className="ml-auto flex min-w-0 shrink items-center gap-2 md:gap-3">
            <button
              onClick={() => setAutopilotOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-black/50 px-3 py-2 text-xs font-semibold text-amber-300 transition hover:bg-amber-500/20"
              title="AI 託管"
              data-testid="button-autopilot"
            >
              <Bot className="h-4 w-4 text-amber-400" />
              <span className="hidden sm:inline">AI 託管</span>
            </button>
            <GameMusicPlayer />
            <GameClock />
            <button
              onClick={() => setSettingsOpen(true)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/20 bg-black/50 transition hover:rotate-45 hover:bg-black/75"
              title="國家設定"
              data-testid="button-settings"
            >
              <Settings className="h-5 w-5" />
            </button>
          </div>
        </footer>
      </div>

      <Dialog open={autopilotOpen} onOpenChange={setAutopilotOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="sr-only">AI 全權託管</DialogTitle>
          </DialogHeader>
          <AutopilotPanel />
        </DialogContent>
      </Dialog>

      <GameSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        nation={nation}
      />

      <StatBreakdownDialog
        statKey={breakdownStat}
        onOpenChange={(open) => {
          if (!open) setBreakdownStat(null);
        }}
      />

      <GameOnboarding
        phase={onboardPhase}
        onPhaseChange={setOnboardPhase}
        onFinish={() => markOnboardingDone(helpScope)}
      />
    </div>
  );
}

/** Circular gear-style command button (desktop arc). */
function ArcButton({
  label,
  icon: Icon,
  center = false,
  style,
  onClick,
  href,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  center?: boolean;
  style: React.CSSProperties;
  onClick?: () => void;
  href?: string;
}) {
  const size = center ? "h-[136px] w-[136px]" : "h-[104px] w-[104px]";
  const ring = center
    ? "border-amber-300/80 shadow-[0_0_28px_rgba(251,191,36,0.35)]"
    : "border-white/35";
  const inner = (
    <span
      className={`flex h-full w-full flex-col items-center justify-center gap-1 rounded-full border-2 border-dashed transition group-hover:scale-105 group-hover:border-solid ${
        center
          ? "border-amber-200/70 bg-gradient-to-b from-amber-500/25 to-black/60"
          : "border-white/25 bg-black/55 group-hover:bg-black/70"
      }`}
    >
      <Icon className={center ? "h-9 w-9 text-amber-200" : "h-7 w-7 text-white/90"} />
      <span
        className={`font-serif font-bold tracking-widest ${
          center ? "text-xl text-amber-100" : "text-base"
        }`}
      >
        {label}
      </span>
    </span>
  );
  const cls = `group absolute ${size} rounded-full border-4 ${ring} bg-black/35 p-1.5 backdrop-blur transition hover:scale-105`;
  if (href) {
    return (
      <Link href={href} className={cls} style={style} data-testid={`button-nav-${label}`}>
        {inner}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={cls} style={style} data-testid={`button-nav-${label}`}>
      {inner}
    </button>
  );
}

/** Compact circular button for the mobile row. */
function MobileButton({
  label,
  icon: Icon,
  center = false,
  onClick,
  href,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  center?: boolean;
  onClick?: () => void;
  href?: string;
}) {
  const size = center ? "h-[84px] w-[84px]" : "h-[64px] w-[64px]";
  const inner = (
    <span
      className={`flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-full border-2 border-dashed ${
        center
          ? "border-amber-200/70 bg-gradient-to-b from-amber-500/25 to-black/60"
          : "border-white/25 bg-black/55"
      }`}
    >
      <Icon className={center ? "h-6 w-6 text-amber-200" : "h-5 w-5 text-white/90"} />
      <span className={`font-serif font-bold ${center ? "text-sm text-amber-100" : "text-xs"}`}>
        {label}
      </span>
    </span>
  );
  const cls = `${size} shrink-0 rounded-full border-[3px] p-1 backdrop-blur transition active:scale-95 ${
    center
      ? "border-amber-300/80 bg-black/35 shadow-[0_0_20px_rgba(251,191,36,0.3)]"
      : "border-white/35 bg-black/35"
  }`;
  if (href) {
    return (
      <Link href={href} className={`block ${cls}`} data-testid={`button-nav-m-${label}`}>
        {inner}
      </Link>
    );
  }
  return (
    <button onClick={onClick} className={cls} data-testid={`button-nav-m-${label}`}>
      {inner}
    </button>
  );
}

/**
 * Task #28 — 掌控地區清單（唯讀）。footer 按鈕 + popover：
 * 依大區分組列出本國掌控地區與比例；未掌控任何地區時顯示提示文字。
 */
function ControlledRegionsPanel({
  regions,
}: {
  regions: PlayerNation["regions"];
}) {
  // 依大區分組（後端已依種子順序排序，分組保留原順序）
  const groups: { macroRegion: string; items: typeof regions }[] = [];
  for (const r of regions) {
    const last = groups[groups.length - 1];
    if (last && last.macroRegion === r.macroRegion) {
      last.items.push(r);
    } else {
      groups.push({ macroRegion: r.macroRegion, items: [r] });
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/15 bg-black/50 px-2.5 py-1.5 text-xs text-white/80 backdrop-blur transition hover:bg-black/75 hover:text-white"
          title="掌控地區"
          data-testid="button-controlled-regions"
        >
          <MapPinned className="h-3.5 w-3.5 text-lime-300" />
          <span className="hidden sm:inline">掌控地區</span>
          <span className="font-bold tabular-nums" data-testid="text-region-count">
            {regions.length}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 border-white/15 bg-zinc-900/95 p-0 text-white backdrop-blur"
        data-testid="popover-controlled-regions"
      >
        <div className="border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2 font-serif text-sm font-bold">
            <MapPinned className="h-4 w-4 text-lime-300" />
            掌控地區
            <span className="text-xs font-normal text-white/50">
              共 {regions.length} 個
            </span>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-white/50">
            人口、生產力與科技成長皆由掌控地區依比例即時計算。
          </p>
        </div>
        {regions.length === 0 ? (
          <div
            className="px-4 py-6 text-center text-sm text-white/60"
            data-testid="text-no-regions"
          >
            目前尚未掌控任何地區。
            <br />
            <span className="text-xs text-white/45">
              地區歸屬由管理員指派，指派後你的國家數值將由地區即時計算。
            </span>
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto px-2 py-2" data-testid="list-controlled-regions">
            {groups.map((g) => (
              <div key={g.macroRegion} className="mb-1.5 last:mb-0">
                <div className="px-2 py-1 text-[11px] font-bold tracking-wide text-white/45">
                  {g.macroRegion}
                </div>
                {g.items.map((r) => (
                  <div
                    key={r.regionId}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-white/5"
                    data-testid={`region-row-${r.regionId}`}
                  >
                    <span className="min-w-0 truncate text-sm">{r.name}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
                        <span
                          className="block h-full rounded-full bg-lime-400/80"
                          style={{ width: `${r.percent}%` }}
                        />
                      </span>
                      <span className="w-10 text-right text-xs font-bold tabular-nums text-lime-300">
                        {r.percent}%
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
