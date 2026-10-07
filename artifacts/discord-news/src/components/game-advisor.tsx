import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  X,
  Bell,
  Handshake,
  Newspaper,
  Landmark,
  Lightbulb,
  AlertTriangle,
} from "lucide-react";
import {
  useListPlayerNotifications,
  getListPlayerNotificationsQueryKey,
  useListDiplomacyNations,
  getListDiplomacyNationsQueryKey,
  useListGameNews,
  getListGameNewsQueryKey,
} from "@workspace/api-client-react";
import type { PlayerNation } from "@workspace/api-client-react";
import { resolveTipPool } from "../lib/advisorTips";

/**
 * Task #303 — 看板顧問（原「看板娘」）。
 * - 首頁角色可點擊 → 開啟國家設定（更換照片／背景／說話風格）。
 * - 角色旁以「漫畫對話泡泡」顯示真實事件提醒（未讀通知／未讀外交訊息／
 *   新聞事件／內閣待批准），以及依國家現況即時計算的「狀態警示」（動亂度
 *   過高／穩定度偏低／厭戰度過高／滿意度不足／國庫見底），與提醒共用同一
 *   優先序。泡泡可叉掉（同一階段不再重複跳出）、點擊會導覽到對應頁面。
 * - 沒有任何待辦、回到首頁時，隨機彈出一則小tip 泡泡（優先用玩家自訂風格
 *   產生的 advisorTips，否則用內建題庫）。提醒的優先順序高於閒置小tip。
 * - 桌面與手機皆可運作。
 */

type BubbleKind =
  | "notif"
  | "diplomacy"
  | "news"
  | "cabinet"
  | "warning"
  | "tip";

interface Bubble {
  kind: BubbleKind;
  /** 去重用的穩定鍵：內容改變時鍵也改變，才會重新跳出。 */
  dedupeKey: string;
  text: string;
  /** 點擊泡泡導覽的路徑；null = 不導覽（純提示）。 */
  linkPath: string | null;
}

const KIND_META: Record<
  BubbleKind,
  { Icon: typeof Bell; ring: string; badge: string }
> = {
  notif: { Icon: Bell, ring: "border-amber-300/60", badge: "text-amber-300" },
  diplomacy: {
    Icon: Handshake,
    ring: "border-sky-300/60",
    badge: "text-sky-300",
  },
  news: {
    Icon: Newspaper,
    ring: "border-emerald-300/60",
    badge: "text-emerald-300",
  },
  cabinet: {
    Icon: Landmark,
    ring: "border-violet-300/60",
    badge: "text-violet-300",
  },
  warning: {
    Icon: AlertTriangle,
    ring: "border-red-400/70",
    badge: "text-red-400",
  },
  tip: { Icon: Lightbulb, ring: "border-white/30", badge: "text-amber-200" },
};

const DISMISS_KEY = "advisor-dismissed-bubbles";

function loadDismissed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(DISMISS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(set: Set<string>) {
  try {
    sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...set]));
  } catch {
    /* sessionStorage 不可用時忽略（提醒改為每次都跳出）。 */
  }
}

interface CabinetOverviewLite {
  pendingApprovals: { id: number; summary: string; domainLabel: string }[];
}

export function GameAdvisor({
  nation,
  kanban,
  onOpenSettings,
}: {
  nation: PlayerNation;
  kanban: string;
  onOpenSettings: () => void;
}) {
  const [, navigate] = useLocation();
  const [dismissed, setDismissed] = useState<Set<string>>(() => loadDismissed());

  // ── 資料來源（共用 TanStack Query 快取，輪詢保持新鮮） ──
  const notifQuery = useListPlayerNotifications(undefined, {
    query: {
      queryKey: getListPlayerNotificationsQueryKey(),
      refetchInterval: 90_000,
    },
  });
  const diploQuery = useListDiplomacyNations(undefined, {
    query: {
      queryKey: getListDiplomacyNationsQueryKey(),
      refetchInterval: 90_000,
    },
  });
  const newsQuery = useListGameNews(undefined, {
    query: { queryKey: getListGameNewsQueryKey(), refetchInterval: 180_000 },
  });
  const parliamentQuery = useQuery({
    queryKey: ["parliament", "advisor"],
    queryFn: async (): Promise<{ satisfaction: number; tier: string }> => {
      const res = await fetch("/api/parliament", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { satisfaction: number; tier: string };
    },
    staleTime: 15_000,
    refetchInterval: 90_000,
    retry: false,
  });
  const cabinetQuery = useQuery({
    queryKey: ["cabinet", "overview"],
    queryFn: async (): Promise<CabinetOverviewLite> => {
      const res = await fetch("/api/cabinet/overview", {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as CabinetOverviewLite;
    },
    staleTime: 15_000,
    refetchInterval: 90_000,
    retry: false,
  });

  // ── 由資料組出「提醒泡泡」（依優先序） ──
  const reminders = useMemo<Bubble[]>(() => {
    const out: Bubble[] = [];

    const notifications = notifQuery.data?.notifications ?? [];
    const firstUnread = notifications.find((n) => !n.read);
    const unreadCount = notifQuery.data?.unreadCount ?? 0;
    if (firstUnread && unreadCount > 0) {
      const extra = unreadCount > 1 ? `（還有 ${unreadCount - 1} 則未讀）` : "";
      out.push({
        kind: "notif",
        dedupeKey: `notif:${firstUnread.id}:${unreadCount}`,
        text: `📣 ${firstUnread.title}${extra}`,
        linkPath: firstUnread.linkPath ?? "/game",
      });
    }

    const nations = diploQuery.data?.nations ?? [];
    const totalUnread = nations.reduce((s, n) => s + n.unreadCount, 0);
    if (totalUnread > 0) {
      const senders = nations.filter((n) => n.unreadCount > 0);
      const lead = senders[0]?.name ?? "";
      const more = senders.length > 1 ? `等 ${senders.length} 國` : "";
      out.push({
        kind: "diplomacy",
        dedupeKey: `dip:${totalUnread}`,
        text: `來自 ${lead}${more}的外交訊息，共 ${totalUnread} 則未讀。`,
        linkPath: "/game/diplomacy",
      });
    }

    // ── 依國家現況組出「狀態警示」（動亂／穩定／厭戰／滿意度／金錢） ──
    // 桶化數值（每 10 一階）當去重鍵，叉掉後同一階內不再重複跳出，
    // 但情況明顯惡化（跨階）時會重新提醒。
    const bucket = (v: number) => Math.floor(v / 10);

    if (nation.money <= 0) {
      out.push({
        kind: "warning",
        dedupeKey: "warn:money:empty",
        text: "⚠️ 國庫已見底！到財政頁調整稅率或縮減預算，否則軍隊維護費會持續累積赤字。",
        linkPath: "/game/economy",
      });
    }

    if (nation.unrest >= 60) {
      out.push({
        kind: "warning",
        dedupeKey: `warn:unrest:${bucket(nation.unrest)}`,
        text: `⚠️ 暴動度高達 ${Math.round(nation.unrest)}，民心浮動，到政治頁安撫局勢以免情勢失控。`,
        linkPath: "/game/politics",
      });
    }

    if (nation.stability <= 30) {
      out.push({
        kind: "warning",
        dedupeKey: `warn:stability:${bucket(nation.stability)}`,
        text: `⚠️ 穩定度僅 ${Math.round(nation.stability)}，生產力與科技都會被拖累，內政得盡快補強。`,
        linkPath: "/game/politics",
      });
    }

    if (nation.warWeariness >= 60) {
      out.push({
        kind: "warning",
        dedupeKey: `warn:weariness:${bucket(nation.warWeariness)}`,
        text: `⚠️ 厭戰度已達 ${Math.round(nation.warWeariness)}，軍隊士氣低落，考慮停火休養一段時間。`,
        linkPath: "/game/military",
      });
    }

    // 議會滿意度(獨裁橡皮圖章不提醒;歸零即強制革命)
    const parl = parliamentQuery.data;
    if (parl && parl.tier !== "autocracy" && parl.satisfaction < 30) {
      out.push({
        kind: "warning",
        dedupeKey: `warn:parliament:${bucket(parl.satisfaction)}`,
        text: `議會滿意度過低 ${Math.round(parl.satisfaction)},歸零將引發革命`,
        linkPath: "/game/parliament",
      });
    }

    const pending = cabinetQuery.data?.pendingApprovals ?? [];
    if (pending.length > 0) {
      const first = pending[0]!;
      const more = pending.length > 1 ? `（另有 ${pending.length - 1} 項）` : "";
      out.push({
        kind: "cabinet",
        dedupeKey: `cab:${first.id}:${pending.length}`,
        text: `內閣待批准：${first.domainLabel}「${first.summary}」${more}`,
        linkPath: "/game/cabinet",
      });
    }

    const news = newsQuery.data?.news ?? [];
    const latest = news[0];
    if (latest) {
      out.push({
        kind: "news",
        dedupeKey: `news:${latest.id}`,
        text: `世界新聞：${latest.title}`,
        linkPath: "/game/news",
      });
    }

    return out;
  }, [
    nation,
    notifQuery.data,
    diploQuery.data,
    cabinetQuery.data,
    parliamentQuery.data,
    newsQuery.data,
  ]);

  const activeReminder = useMemo(
    () => reminders.find((b) => !dismissed.has(b.dedupeKey)) ?? null,
    [reminders, dismissed],
  );

  // ── 閒置小tip：沒有提醒時，回到首頁隨機挑一則（本次掛載固定一則） ──
  const tipPool = useMemo(
    () => resolveTipPool(nation.advisorTips),
    [nation.advisorTips],
  );
  const [idleTip] = useState(
    () => tipPool[Math.floor(Math.random() * tipPool.length)] ?? "",
  );
  const [tipDismissed, setTipDismissed] = useState(false);

  const bubble: Bubble | null = activeReminder
    ? activeReminder
    : !tipDismissed && idleTip
      ? { kind: "tip", dedupeKey: "tip", text: idleTip, linkPath: null }
      : null;

  const dismiss = useCallback(
    (key: string, kind: BubbleKind) => {
      if (kind === "tip") {
        setTipDismissed(true);
        return;
      }
      setDismissed((prev) => {
        const next = new Set(prev);
        next.add(key);
        saveDismissed(next);
        return next;
      });
    },
    [],
  );

  // 提醒鍵不再出現在清單時，從已叉掉集合清掉（避免無限膨脹）。
  useEffect(() => {
    const liveKeys = new Set(reminders.map((b) => b.dedupeKey));
    setDismissed((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const k of prev) {
        if (liveKeys.has(k)) next.add(k);
        else changed = true;
      }
      if (changed) saveDismissed(next);
      return changed ? next : prev;
    });
  }, [reminders]);

  const meta = bubble ? KIND_META[bubble.kind] : null;

  return (
    <div className="pointer-events-none order-1 flex flex-col items-center md:absolute md:bottom-0 md:right-[4%] md:order-none md:items-end">
      {/* 漫畫對話泡泡 */}
      {bubble && meta && (
        <div
          className={`pointer-events-auto relative mb-2 max-w-[78vw] md:mb-3 md:max-w-[320px]`}
          data-testid="advisor-bubble"
          data-bubble-kind={bubble.kind}
        >
          <div
            role={bubble.linkPath ? "button" : undefined}
            tabIndex={bubble.linkPath ? 0 : undefined}
            onClick={() => bubble.linkPath && navigate(bubble.linkPath)}
            onKeyDown={(e) => {
              if (bubble.linkPath && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                navigate(bubble.linkPath);
              }
            }}
            className={`relative rounded-2xl border-2 bg-white/95 px-3.5 py-2.5 pr-8 text-sm font-medium leading-snug text-zinc-900 shadow-[0_6px_20px_rgba(0,0,0,0.45)] ${meta.ring} ${
              bubble.linkPath
                ? "cursor-pointer transition hover:bg-white"
                : ""
            }`}
          >
            <div className="mb-0.5 flex items-center gap-1.5">
              <meta.Icon className={`h-3.5 w-3.5 ${meta.badge}`} />
              <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                {bubble.kind === "tip"
                  ? "顧問小提示"
                  : bubble.kind === "warning"
                    ? "狀態警示"
                    : "提醒"}
              </span>
            </div>
            <p className="break-words">{bubble.text}</p>
            {bubble.linkPath && (
              <span className="mt-1 block text-[10px] font-semibold text-amber-600">
                點我前往 →
              </span>
            )}
            {/* 泡泡尾巴（指向角色） */}
            <span className="absolute -bottom-2 right-8 h-4 w-4 rotate-45 border-b-2 border-r-2 border-inherit bg-white/95" />
          </div>
          {/* 叉掉按鈕 */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              dismiss(bubble.dedupeKey, bubble.kind);
            }}
            className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900/10 text-zinc-600 transition hover:bg-zinc-900/25"
            aria-label="關閉提醒"
            data-testid="advisor-bubble-dismiss"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* 角色本體：可點擊 → 開啟顧問設定 */}
      <button
        type="button"
        onClick={onOpenSettings}
        className="group pointer-events-auto relative cursor-pointer focus:outline-none"
        aria-label="開啟看板顧問設定"
        data-testid="advisor-character"
        title="點我更換照片、背景與說話風格"
      >
        <img
          src={kanban}
          alt="看板顧問"
          className="mx-auto max-h-[38vh] object-contain drop-shadow-[0_8px_24px_rgba(0,0,0,0.55)] transition-transform duration-200 group-hover:scale-[1.02] md:mx-0 md:max-h-[78vh] md:max-w-[46vw]"
          data-testid="img-kanban"
        />
        <span className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-3 py-1 text-[10px] font-semibold text-white/90 opacity-0 backdrop-blur transition group-hover:opacity-100 md:bottom-6">
          點我設定看板顧問
        </span>
      </button>
    </div>
  );
}
