import React, { useState } from "react";
import { useLocation } from "wouter";
import { Bell, BellOff, Loader2, Check, Handshake, Swords, Landmark, Globe, Hourglass, Crown, Gift } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { zhTW } from "date-fns/locale";
import {
  useListPlayerNotifications,
  getListPlayerNotificationsQueryKey,
  useMarkPlayerNotificationsRead,
  useUpdatePlayerNation,
  useGetPlayerNation,
  getGetPlayerNationQueryKey,
} from "@workspace/api-client-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";

/**
 * 遊戲頁面共用的鈴鐺通知中心（首頁、軍事、外交、政治頁 header 都掛這顆）。
 * - 30 秒輪詢站內通知（player_notifications）；未讀數顯示在鈴鐺徽章。
 * - 打開面板即全部標為已讀（未讀數歸零）。
 * - 面板底部提供 Discord 私訊通知開關（同步國家設定對話框的同一欄位，
 *   共用 getPlayerNation 快取）。站內通知不受此開關影響。
 * - 國家資料由元件自行透過 getPlayerNation 快取讀取（與各頁共用同一
 *   queryKey，不會多打 API），使用端只需 `<GameNotifications />`。
 * - `variant`：預設 `dark`（深色遊戲頁）；淺色儀表板頁（如 /world-map）
 *   用 `light` 讓鈴鐺按鈕配合亮色版面，面板本身維持深色通知中心樣式。
 */
/** 依通知 type 顯示的圖示與標籤（未知 type 用鈴鐺）。 */
const NOTIFICATION_TYPE_META: Record<
  string,
  { label: string; Icon: typeof Bell; className: string }
> = {
  diplomacy: { label: "外交", Icon: Handshake, className: "text-sky-300" },
  military: { label: "軍事", Icon: Swords, className: "text-red-300" },
  politics: { label: "政治", Icon: Landmark, className: "text-violet-300" },
  cabinet: { label: "內閣", Icon: Crown, className: "text-amber-200" },
  world: { label: "世界", Icon: Globe, className: "text-emerald-300" },
  turn: { label: "回合", Icon: Hourglass, className: "text-amber-300" },
  gift: { label: "獎勵", Icon: Gift, className: "text-pink-300" },
};

function notificationTypeMeta(type: string) {
  return (
    NOTIFICATION_TYPE_META[type] ?? {
      label: "通知",
      Icon: Bell,
      className: "text-white/60",
    }
  );
}

export function GameNotifications({
  variant = "dark",
}: {
  variant?: "dark" | "light";
}) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: nationEnvelope } = useGetPlayerNation({
    query: {
      queryKey: getGetPlayerNationQueryKey(),
      staleTime: 1000 * 30,
    },
  });
  const nation = nationEnvelope?.nation ?? null;

  const listQuery = useListPlayerNotifications(undefined, {
    query: {
      queryKey: getListPlayerNotificationsQueryKey(),
      refetchInterval: 30_000,
    },
  });

  const unreadCount = listQuery.data?.unreadCount ?? 0;
  const notifications = listQuery.data?.notifications ?? [];

  const markRead = useMarkPlayerNotificationsRead({
    mutation: {
      onSuccess: () => {
        queryClient.setQueryData(
          getListPlayerNotificationsQueryKey(),
          (prev: typeof listQuery.data) =>
            prev
              ? {
                  unreadCount: 0,
                  notifications: prev.notifications.map((n) => ({
                    ...n,
                    read: true,
                  })),
                }
              : prev,
        );
      },
    },
  });

  const dmDiplomacy = nation?.dmDiplomacyEnabled ?? true;
  const dmPolitics = nation?.dmPoliticsEnabled ?? true;
  const dmMutation = useUpdatePlayerNation({
    mutation: {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetPlayerNationQueryKey(), data);
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          title: "更新通知設定失敗",
          description: apiErrorMessage(err),
        });
      },
    },
  });

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (v && unreadCount > 0) {
      markRead.mutate({ data: {} });
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition ${
            variant === "light"
              ? "border-border bg-background text-foreground shadow-sm hover:bg-secondary/60"
              : "border-white/20 bg-black/45 backdrop-blur hover:bg-black/70"
          }`}
          title="通知中心"
          data-testid="button-notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span
              className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white"
              data-testid="badge-unread-count"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 border-white/15 bg-zinc-900 p-0 text-white"
        data-testid="panel-notifications"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
          <span className="text-sm font-bold">通知中心</span>
          {notifications.some((n) => !n.read) && (
            <button
              type="button"
              onClick={() => markRead.mutate({ data: {} })}
              disabled={markRead.isPending}
              className="flex items-center gap-1 text-[11px] text-white/60 transition hover:text-white disabled:opacity-50"
              data-testid="button-mark-all-read"
            >
              <Check className="h-3 w-3" />
              全部標為已讀
            </button>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto" data-testid="list-notifications">
          {listQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-white/50">
              <Loader2 className="h-4 w-4 animate-spin" />
              載入中…
            </div>
          ) : notifications.length === 0 ? (
            <div
              className="px-3 py-6 text-center text-sm text-white/50"
              data-testid="text-no-notifications"
            >
              目前沒有通知
            </div>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  if (n.linkPath) {
                    setOpen(false);
                    navigate(n.linkPath);
                  }
                }}
                className={`block w-full border-b border-white/5 px-3 py-2.5 text-left transition last:border-b-0 ${
                  n.linkPath ? "hover:bg-white/5" : "cursor-default"
                } ${n.read ? "" : "bg-amber-500/10"}`}
                data-testid={`notification-${n.id}`}
              >
                {(() => {
                  const meta = notificationTypeMeta(n.type);
                  return (
                    <>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5 text-xs font-bold">
                          {!n.read && (
                            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                          )}
                          <meta.Icon
                            className={`h-3.5 w-3.5 shrink-0 ${meta.className}`}
                            aria-label={meta.label}
                            data-testid={`icon-notification-type-${n.type}`}
                          />
                          <span className="truncate">{n.title}</span>
                        </span>
                        <span className="shrink-0 text-[10px] text-white/45">
                          {formatDistanceToNow(new Date(n.createdAt), {
                            addSuffix: true,
                            locale: zhTW,
                          })}
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-xs text-white/70">
                        {n.body}
                      </div>
                    </>
                  );
                })()}
              </button>
            ))
          )}
        </div>

        {/* Discord 私訊通知開關（外交／內政各自獨立；與國家設定對話框同一欄位；
            站內通知不受影響）。國家資料尚未載入時隱藏，避免對不存在的國家送出 PATCH */}
        {nation && (
        <div className="border-t border-white/10">
          <div className="px-3 pt-2 text-[10px] text-white/40">
            Discord 私訊通知（關閉後仍會收到站內通知）
          </div>
          <div className="flex items-center gap-2 px-3 py-2">
            {dmDiplomacy ? (
              <Bell className="h-4 w-4 shrink-0 text-amber-300/90" />
            ) : (
              <BellOff className="h-4 w-4 shrink-0 text-white/40" />
            )}
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-xs font-semibold">外交私訊</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={dmDiplomacy}
              disabled={dmMutation.isPending}
              onClick={() =>
                dmMutation.mutate({
                  data: { dmDiplomacyEnabled: !dmDiplomacy },
                })
              }
              className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
                dmDiplomacy ? "bg-amber-500/85" : "bg-white/20"
              }`}
              data-testid="toggle-dm-diplomacy"
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                  dmDiplomacy ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
          </div>
          <div className="flex items-center gap-2 px-3 pb-2.5">
            {dmPolitics ? (
              <Bell className="h-4 w-4 shrink-0 text-amber-300/90" />
            ) : (
              <BellOff className="h-4 w-4 shrink-0 text-white/40" />
            )}
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-xs font-semibold">內政私訊</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={dmPolitics}
              disabled={dmMutation.isPending}
              onClick={() =>
                dmMutation.mutate({
                  data: { dmPoliticsEnabled: !dmPolitics },
                })
              }
              className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
                dmPolitics ? "bg-amber-500/85" : "bg-white/20"
              }`}
              data-testid="toggle-dm-politics"
            >
              <span
                className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                  dmPolitics ? "left-[22px]" : "left-0.5"
                }`}
              />
            </button>
          </div>
        </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
