import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Send, Trash2, Users } from "lucide-react";
import {
  useListDiplomacyLobbyMessages,
  getListDiplomacyLobbyMessagesQueryKey,
  listDiplomacyLobbyMessages,
  useSendDiplomacyLobbyMessage,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken, useIsAdmin } from "@/lib/admin-token";
import { apiErrorMessage } from "@/components/military-shared";

type LobbyMessage = {
  id: number;
  senderNationId: string;
  senderNationName?: string | null;
  fromMe: boolean;
  body: string;
  createdAt: string;
};

export function LobbyPane({ onBackMobile }: { onBackMobile: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isAdmin = useIsAdmin();
  const [draft, setDraft] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 最新一頁（含輪詢）；不帶 before 游標，queryKey 維持穩定。
  const { data, isLoading } = useListDiplomacyLobbyMessages(undefined, {
    query: {
      queryKey: getListDiplomacyLobbyMessagesQueryKey(),
      refetchInterval: 5_000,
    },
  });
  const liveMessages = data?.messages ?? [];
  const livesHasMore = data?.hasMore ?? false;

  // 以游標載入的更舊訊息（累積於前端；與輪詢的最新頁合併去重）。
  const [older, setOlder] = useState<LobbyMessage[]>([]);
  const [olderHasMore, setOlderHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const messages = useMemo(() => {
    const seen = new Set<number>();
    const merged: LobbyMessage[] = [];
    for (const m of [...older, ...liveMessages]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
    merged.sort((a, b) => a.id - b.id);
    return merged;
  }, [older, liveMessages]);

  // 只要最新頁本身還有更舊資料，或已載入的更舊頁仍有更舊資料，就顯示「載入更多」。
  const canLoadMore = messages.length > 0 && (older.length > 0 ? olderHasMore : livesHasMore);

  const loadMore = async () => {
    if (loadingMore || messages.length === 0) return;
    setLoadingMore(true);
    const before = messages[0]!.id;
    const container = scrollRef.current;
    const prevHeight = container?.scrollHeight ?? 0;
    try {
      const res = await listDiplomacyLobbyMessages({ before });
      setOlder((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const next = [...prev];
        for (const m of res.messages) {
          if (!seen.has(m.id)) next.push(m);
        }
        return next;
      });
      setOlderHasMore(res.hasMore);
      // 載入更舊訊息後維持捲動位置（避免跳到頂端）。
      requestAnimationFrame(() => {
        if (container) {
          container.scrollTop = container.scrollHeight - prevHeight;
        }
      });
    } catch (err) {
      toast({ title: "載入失敗", description: apiErrorMessage(err) });
    } finally {
      setLoadingMore(false);
    }
  };

  const send = useSendDiplomacyLobbyMessage({
    mutation: {
      onSuccess: () => {
        setDraft("");
        void queryClient.invalidateQueries({
          queryKey: getListDiplomacyLobbyMessagesQueryKey(),
        });
      },
      onError: (err) =>
        toast({ title: "傳送失敗", description: apiErrorMessage(err) }),
    },
  });

  // 僅在最新訊息變動時自動捲到底（載入更舊訊息時不觸發）。
  const newestId = messages.length > 0 ? messages[messages.length - 1]!.id : 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [newestId]);

  const doSend = () => {
    const body = draft.trim();
    if (!body || send.isPending) return;
    send.mutate({ data: { body } });
  };

  // 管理員刪除大廳訊息：二次確認後帶管理金鑰呼叫管理端點；成功後同時讓最新頁
  // 查詢失效並從前端累積的「更舊訊息」狀態移除該則，確保畫面立即更新。
  const doDelete = async (id: number) => {
    if (deletingId !== null) return;
    if (!window.confirm("確定要刪除這則大廳訊息嗎？此動作無法復原。")) return;
    setDeletingId(id);
    try {
      const token = getAdminToken();
      const res = await fetch(`/api/diplomacy/lobby/messages/${id}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        let message = "刪除失敗";
        try {
          const body = await res.json();
          if (body?.error) message = String(body.error);
        } catch {
          // 忽略解析錯誤，沿用預設訊息
        }
        throw new Error(message);
      }
      // 立即從畫面移除：同時剔除前端累積的更舊訊息，以及最新頁 query cache 中的該則，
      // 不必等輪詢 refetch 回來（達成「當前畫面立即消失」）。
      setOlder((prev) => prev.filter((m) => m.id !== id));
      queryClient.setQueryData(
        getListDiplomacyLobbyMessagesQueryKey(),
        (prev: typeof data) =>
          prev
            ? { ...prev, messages: prev.messages.filter((m) => m.id !== id) }
            : prev,
      );
      await queryClient.invalidateQueries({
        queryKey: getListDiplomacyLobbyMessagesQueryKey(),
      });
    } catch (err) {
      toast({ title: "刪除失敗", description: apiErrorMessage(err) });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-white/10 bg-black/50 px-4 py-2.5 backdrop-blur">
        <button
          onClick={onBackMobile}
          className="rounded-lg p-1.5 text-white/70 hover:bg-white/10 md:hidden"
          data-testid="button-back-list"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-amber-300/30 bg-amber-500/20">
          <Users className="h-4 w-4 text-amber-200" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-bold">玩家大廳</div>
          <div className="text-[11px] text-white/55">
            所有玩家共用的群聊，發言不會發出通知
          </div>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-white/60">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入訊息中…
          </div>
        ) : messages.length === 0 ? (
          <div className="py-8 text-center text-sm text-white/45">
            大廳裡還沒有訊息，來說第一句話吧。
          </div>
        ) : (
          <>
            {canLoadMore && (
              <div className="flex justify-center pb-1">
                <button
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs text-white/70 transition hover:bg-white/10 disabled:opacity-40"
                  data-testid="button-load-more-lobby"
                >
                  {loadingMore ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  載入更多
                </button>
              </div>
            )}
            {messages.map((m) => (
            <div
              key={m.id}
              className={`group flex items-center gap-1.5 ${m.fromMe ? "justify-end" : "justify-start"}`}
            >
              {isAdmin && m.fromMe && (
                <button
                  onClick={() => void doDelete(m.id)}
                  disabled={deletingId !== null}
                  title="刪除此訊息（管理員）"
                  aria-label="刪除此訊息"
                  className="shrink-0 rounded-md p-1.5 text-white/40 transition hover:bg-red-500/20 hover:text-red-300 disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100"
                  data-testid={`button-delete-lobby-${m.id}`}
                >
                  {deletingId === m.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
              <div className="max-w-[75%]">
                {!m.fromMe && (
                  <div className="mb-0.5 px-1 text-[11px] font-semibold text-amber-200/90">
                    {m.senderNationName ?? "（未命名）"}
                  </div>
                )}
                <div
                  className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm shadow ${
                    m.fromMe
                      ? "rounded-br-sm bg-amber-500/90 text-black"
                      : "rounded-bl-sm bg-white/15 text-white backdrop-blur"
                  }`}
                >
                  {m.body}
                  <div
                    className={`mt-0.5 text-right text-[10px] ${m.fromMe ? "text-black/50" : "text-white/40"}`}
                  >
                    {new Date(m.createdAt).toLocaleString("zh-TW", {
                      month: "numeric",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              </div>
              {isAdmin && !m.fromMe && (
                <button
                  onClick={() => void doDelete(m.id)}
                  disabled={deletingId !== null}
                  title="刪除此訊息（管理員）"
                  aria-label="刪除此訊息"
                  className="shrink-0 rounded-md p-1.5 text-white/40 transition hover:bg-red-500/20 hover:text-red-300 disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100"
                  data-testid={`button-delete-lobby-${m.id}`}
                >
                  {deletingId === m.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
            ))}
          </>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-white/10 bg-black/50 p-3 backdrop-blur">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                doSend();
              }
            }}
            rows={1}
            maxLength={2000}
            placeholder="在大廳發言…（Enter 送出）"
            className="max-h-32 min-h-[42px] flex-1 resize-y rounded-lg border border-white/15 bg-white/10 px-3 py-2.5 text-sm text-white placeholder:text-white/40 focus:border-amber-400 focus:outline-none"
            data-testid="input-lobby-message"
          />
          <button
            onClick={doSend}
            disabled={send.isPending || draft.trim() === ""}
            className="flex h-[42px] items-center gap-1.5 rounded-lg bg-amber-500/90 px-4 text-sm font-bold text-black transition hover:bg-amber-400 disabled:opacity-40"
            data-testid="button-send-lobby-message"
          >
            {send.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            送出
          </button>
        </div>
      </div>
    </div>
  );
}
