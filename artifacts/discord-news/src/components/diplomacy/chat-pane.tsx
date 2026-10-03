import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { History, Loader2, Send } from "lucide-react";
import {
  useListDiplomacyMessages,
  getListDiplomacyMessagesQueryKey,
  useSendDiplomacyMessage,
  getListDiplomacyNationsQueryKey,
  useListDiplomacyRelationEvents,
  getListDiplomacyRelationEventsQueryKey,
} from "@workspace/api-client-react";
import type { DiplomacyNation } from "@workspace/api-client-react";
import { formatDistanceToNow } from "date-fns";
import { zhTW } from "date-fns/locale";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";
import { PaneHeader } from "./shared";

// NPC 於對話中即時採取的動作結果（由後端回傳，暫存於本次對話顯示）。
type NpcChatActionResult = {
  type: string;
  targetId: string;
  targetName: string | null;
  ok: boolean;
  detail: string;
  proposalId?: number | null;
  proposalNationId?: string | null;
};

const CHAT_ACTION_LABELS: Record<string, string> = {
  declare_war: "宣戰",
  initiate_campaign: "出兵",
  ceasefire: "停戰",
  propose_treaty: "締約",
  alliance: "結盟",
  gift: "送禮",
  exchange: "交換",
};

function chatActionLabel(type: string): string {
  return CHAT_ACTION_LABELS[type] ?? type;
}

export function ChatPane({
  nation,
  aiChatRemaining,
  aiChatCap,
  onBackMobile,
}: {
  nation: DiplomacyNation;
  aiChatRemaining: number;
  aiChatCap: number;
  onBackMobile: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const isNpc = nation.isNpc;
  const canChat = isNpc || nation.ownerDiscordUserId !== null;
  // NPC 對話後由回應即時帶回剩餘次數；否則沿用國家清單的值。
  const [remaining, setRemaining] = useState(aiChatRemaining);
  useEffect(() => setRemaining(aiChatRemaining), [aiChatRemaining]);
  const quotaExhausted = isNpc && remaining <= 0;
  // NPC 於本次對話即時採取的動作（暫存顯示；切換對話對象時清空）。
  const [lastActions, setLastActions] = useState<NpcChatActionResult[]>([]);

  const { data, isLoading, isPlaceholderData } = useListDiplomacyMessages(
    nation.id,
    {
      query: {
        queryKey: getListDiplomacyMessagesQueryKey(nation.id),
        enabled: canChat,
        // NPC 由回應即時更新，不需輪詢；玩家↔玩家維持 5 秒輪詢。
        refetchInterval: isNpc ? false : 5_000,
        // 切換對話時保留前一筆資料，避免整片變成載入骨架而閃爍。
        placeholderData: keepPreviousData,
      },
    },
  );
  // placeholder 屬於「前一個對話」的訊息，不可顯示以免混淆；
  // 此時視為仍在載入，只有真正首次載入才顯示載入畫面。
  const showLoading = (isLoading || isPlaceholderData) && canChat;
  const messages = isPlaceholderData ? [] : (data?.messages ?? []);

  // 切換對話對象時重置輸入草稿與動作提示，避免把上一段狀態帶到新對話。
  useEffect(() => {
    setDraft("");
    setLastActions([]);
  }, [nation.id]);

  const send = useSendDiplomacyMessage({
    mutation: {
      onSuccess: (r) => {
        setDraft("");
        void queryClient.invalidateQueries({
          queryKey: getListDiplomacyMessagesQueryKey(nation.id),
        });
        if (isNpc) {
          if (typeof r.aiChatRemaining === "number") {
            setRemaining(r.aiChatRemaining);
          }
          setLastActions(
            Array.isArray(r.actions) ? (r.actions as NpcChatActionResult[]) : [],
          );
          // NPC 可能對其他玩家／NPC 動作，連動戰爭與聯盟狀態，一併刷新。
          void queryClient.invalidateQueries({
            queryKey: getListDiplomacyNationsQueryKey(),
          });
          void queryClient.invalidateQueries({
            queryKey: getListDiplomacyRelationEventsQueryKey(nation.id),
          });
          if (typeof r.relationDelta === "number") {
            const d = r.relationDelta;
            toast({
              title: "外交回應已送達",
              description:
                (d > 0 ? `關係值 +${d}` : d < 0 ? `關係值 ${d}` : "關係值無變化") +
                (typeof r.relationScore === "number"
                  ? `（目前 ${r.relationScore > 0 ? "+" : ""}${r.relationScore}）`
                  : ""),
            });
          }
        }
      },
      onError: (err) =>
        toast({ title: "傳送失敗", description: apiErrorMessage(err) }),
    },
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
  }, [nation.id, messages.length]);

  if (!canChat) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PaneHeader nation={nation} onBackMobile={onBackMobile} />
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="rounded-xl bg-black/50 px-6 py-4 text-center text-sm text-white/60 backdrop-blur">
            這是無主國家，沒有玩家可以對話。
          </div>
        </div>
      </div>
    );
  }

  const doSend = () => {
    const body = draft.trim();
    if (!body || send.isPending || quotaExhausted) return;
    send.mutate({ nationId: nation.id, data: { body } });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader
        nation={nation}
        onBackMobile={onBackMobile}
        subtitle={
          isNpc ? `本回合剩餘對話 ${remaining}/${aiChatCap}` : undefined
        }
      />
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {isNpc && <RelationEventsTimeline nation={nation} />}
        {showLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-white/60">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入訊息中…
          </div>
        ) : messages.length === 0 ? (
          <div className="py-8 text-center text-sm text-white/45">
            還沒有訊息，來開啟第一段外交對話吧。
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`flex ${m.fromMe ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[75%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm shadow ${
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
          ))
        )}
        {isNpc && lastActions.length > 0 && (
          <div className="rounded-xl border border-white/10 bg-black/40 p-3 backdrop-blur">
            <div className="mb-1.5 text-[11px] font-medium text-white/60">
              本回合對方採取的行動
            </div>
            <div className="flex flex-wrap gap-1.5">
              {lastActions.map((a, i) => {
                // Task #341 — 帶提案 id 的成功動作可點擊 → 跳到締約分頁、選定提案方 NPC、高亮該提案。
                const clickable =
                  a.ok &&
                  typeof a.proposalId === "number" &&
                  typeof a.proposalNationId === "string";
                const chipClass = `inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] ${
                  a.ok
                    ? "border-amber-400/40 bg-amber-500/15 text-amber-100"
                    : "border-white/15 bg-white/5 text-white/45"
                }${
                  clickable
                    ? " cursor-pointer transition hover:bg-amber-500/30 hover:border-amber-300/60"
                    : ""
                }`;
                const inner = (
                  <>
                    <span className="font-semibold">
                      {chatActionLabel(a.type)}
                    </span>
                    {a.targetName && (
                      <span className="opacity-80">→ {a.targetName}</span>
                    )}
                    <span className="truncate opacity-70">・{a.detail}</span>
                    {clickable && (
                      <span className="opacity-80">・查看提案 ›</span>
                    )}
                  </>
                );
                const key = `${a.type}-${a.targetId}-${i}`;
                if (clickable) {
                  return (
                    <button
                      key={key}
                      type="button"
                      title={a.detail}
                      onClick={() =>
                        navigate(
                          `/game/diplomacy?tab=treaty&nation=${encodeURIComponent(
                            a.proposalNationId as string,
                          )}&treaty=${a.proposalId}`,
                        )
                      }
                      className={chipClass}
                      data-testid={`chip-action-${a.proposalId}`}
                    >
                      {inner}
                    </button>
                  );
                }
                return (
                  <span key={key} title={a.detail} className={chipClass}>
                    {inner}
                  </span>
                );
              })}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="border-t border-white/10 bg-black/50 p-3 backdrop-blur">
        {isNpc && (
          <p className="mb-1.5 text-[11px] text-white/45">
            {quotaExhausted
              ? "本回合與 NPC 的對話次數已用盡，下回合重置。"
              : `與 NPC 對話由 AI 即時回覆並判定關係值增減（本回合剩餘 ${remaining}/${aiChatCap}，所有 NPC 合計）。`}
          </p>
        )}
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
            disabled={quotaExhausted}
            placeholder={
              quotaExhausted ? "本回合對話次數已用盡" : "輸入訊息…（Enter 送出）"
            }
            className="max-h-32 min-h-[42px] flex-1 resize-y rounded-lg border border-white/15 bg-white/10 px-3 py-2.5 text-sm text-white placeholder:text-white/40 focus:border-amber-400 focus:outline-none disabled:opacity-50"
            data-testid="input-chat-message"
          />
          <button
            onClick={doSend}
            disabled={send.isPending || draft.trim() === "" || quotaExhausted}
            className="flex h-[42px] items-center gap-1.5 rounded-lg bg-amber-500/90 px-4 text-sm font-bold text-black transition hover:bg-amber-400 disabled:opacity-40"
            data-testid="button-send-message"
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

/** Task #92 — 與選定國家的近期互動時間軸（雙向關係動作紀錄）。 */
function RelationEventsTimeline({ nation }: { nation: DiplomacyNation }) {
  const events = useListDiplomacyRelationEvents(nation.id, {
    query: {
      queryKey: getListDiplomacyRelationEventsQueryKey(nation.id),
      staleTime: 30_000,
    },
  });
  const list = events.data?.events ?? [];

  return (
    <div
      className="rounded-xl border border-white/10 bg-black/45 p-4 backdrop-blur"
      data-testid="relation-events-timeline"
    >
      <div className="mb-2 flex items-center gap-2 text-sm font-bold">
        <History className="h-4 w-4 text-white/60" />
        近期互動紀錄
      </div>
      {events.isLoading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-white/50">
          <Loader2 className="h-4 w-4 animate-spin" />
          載入中…
        </div>
      ) : events.isError ? (
        <p className="py-2 text-xs text-red-300">
          互動紀錄載入失敗：{apiErrorMessage(events.error)}
        </p>
      ) : list.length === 0 ? (
        <p className="py-2 text-xs text-white/50" data-testid="relation-events-empty">
          最近 30 天內沒有互動紀錄。與該國對話或推動締約，開啟兩國往來吧。
        </p>
      ) : (
        <ul className="space-y-2" data-testid="relation-events-list">
          {list.map((e) => (
            <li
              key={e.id}
              className="flex items-center gap-2.5 rounded-lg border border-white/5 bg-white/5 px-2.5 py-2"
              data-testid={`relation-event-${e.id}`}
            >
              <span
                className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-bold ${
                  e.byMe
                    ? "bg-sky-500/20 text-sky-200"
                    : "bg-purple-500/20 text-purple-200"
                }`}
              >
                {e.byMe ? "我方" : "對方"}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-white/85">
                {e.byMe
                  ? `我方對 ${nation.name} ${e.actionLabel}`
                  : `${nation.name} 對我方 ${e.actionLabel}`}
              </span>
              <span
                className={`shrink-0 text-[11px] font-bold tabular-nums ${
                  e.delta >= 0 ? "text-emerald-300" : "text-red-300"
                }`}
              >
                {e.delta >= 0 ? "+" : ""}
                {e.delta}
              </span>
              <span className="shrink-0 text-[10px] text-white/40">
                {formatDistanceToNow(new Date(e.createdAt), {
                  addSuffix: true,
                  locale: zhTW,
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[10px] text-white/35">
        僅保留最近 30 天的互動紀錄（最多顯示 30 筆）。
      </p>
    </div>
  );
}
