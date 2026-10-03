import React, { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  LogIn,
  Shield,
  Siren,
  Globe2,
  MapPin,
  Clock,
  Sparkles,
  Send,
  CheckCircle2,
  Hourglass,
  X,
} from "lucide-react";
import {
  useListSuperEvents,
  getListSuperEventsQueryKey,
  useGetSuperEvent,
  getGetSuperEventQueryKey,
  useSubmitSuperEventResponse,
} from "@workspace/api-client-react";
import type {
  SuperEventListItem,
  SuperEventDetailResponse,
} from "@workspace/api-client-react";
import { useCurrentUser, startDiscordLogin } from "@/lib/current-user";
import { useGetPlayerNation, getGetPlayerNationQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";
import { GameNotifications } from "@/components/game-notifications";

const BASE = import.meta.env.BASE_URL;
const DEFAULT_BG = `${BASE}game/home-bg-default.webp`;

const RESPONSE_MAX = 500;

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** 依嚴重度回傳對應色調（1–100）。 */
function severityTone(severity: number): { label: string; cls: string } {
  if (severity >= 80) return { label: "極重大", cls: "bg-red-500/20 text-red-200 border-red-400/40" };
  if (severity >= 55) return { label: "重大", cls: "bg-orange-500/20 text-orange-200 border-orange-400/40" };
  if (severity >= 30) return { label: "中等", cls: "bg-amber-500/20 text-amber-100 border-amber-400/40" };
  return { label: "輕微", cls: "bg-sky-500/20 text-sky-100 border-sky-400/40" };
}

function causeLabel(cause: string): string {
  if (cause === "admin") return "管理員發動";
  if (cause === "player_decision") return "政治決策引發";
  return "世界局勢";
}

/** 事件階段的中文標籤與色調。 */
function stageInfo(stage: string): { label: string; cls: string } {
  switch (stage) {
    case "outbreak":
      return { label: "爆發", cls: "border-red-400/40 bg-red-500/20 text-red-100" };
    case "spreading":
      return { label: "擴散", cls: "border-orange-400/40 bg-orange-500/20 text-orange-100" };
    case "peak":
      return { label: "高峰", cls: "border-rose-400/50 bg-rose-500/25 text-rose-100" };
    case "receding":
      return { label: "消退", cls: "border-sky-400/40 bg-sky-500/20 text-sky-100" };
    case "ended":
      return { label: "落幕", cls: "border-white/20 bg-white/5 text-white/50" };
    default:
      return { label: stage, cls: "border-white/20 bg-white/5 text-white/60" };
  }
}

/** 事件性質（災難／機會）的中文標籤與色調。 */
function kindInfo(kind: string): { label: string; cls: string } {
  if (kind === "opportunity")
    return { label: "機會", cls: "border-emerald-400/45 bg-emerald-500/20 text-emerald-100" };
  return { label: "災難", cls: "border-red-400/45 bg-red-500/20 text-red-100" };
}

/** 範圍（全球／區域／指定國家）的中文標籤。 */
function scopeLabel(scope: string): string {
  if (scope === "global") return "全球";
  if (scope === "targeted") return "指定國家";
  return "區域";
}

export default function GameSuperEvents() {
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
    data: list,
    isLoading: loadingList,
    isError: listError,
    refetch,
  } = useListSuperEvents({
    query: {
      queryKey: getListSuperEventsQueryKey(),
      enabled: authenticated && !noNation,
      staleTime: 1000 * 20,
    },
  });

  const bg = nation?.backgroundUrl || DEFAULT_BG;
  const [openId, setOpenId] = useState<string | null>(null);

  if (loadingMe || (authenticated && !noNation && loadingList)) {
    return (
      <Shell bg={bg}>
        <div className="flex h-full items-center justify-center">
          <div className="flex items-center gap-3 rounded-xl bg-black/60 px-6 py-4 text-white backdrop-blur">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>載入超事件中…</span>
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
            <h1 className="mb-2 font-serif text-xl font-bold">超事件</h1>
            <p className="mb-6 text-sm text-white/70">
              請先以 Discord 登入，才能查看與應對世界超事件。
            </p>
            <button
              onClick={() => startDiscordLogin()}
              className="w-full rounded-lg bg-[#5865f2] px-4 py-2.5 text-sm font-semibold transition hover:bg-[#4752c4]"
              data-testid="button-super-events-login"
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
              你還沒有國家。請先到玩家首頁完成建國，再回來查看超事件。
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

  if (listError || !list) {
    return (
      <Shell bg={bg}>
        <div className="flex h-full items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-black/65 p-8 text-center text-white shadow-2xl backdrop-blur">
            <h1 className="mb-2 font-serif text-xl font-bold">無法載入超事件</h1>
            <p className="mb-6 text-sm text-white/70">
              讀取超事件時發生錯誤，請稍後再試。
            </p>
            <button
              onClick={() => refetch()}
              className="w-full rounded-lg bg-white/15 px-4 py-2.5 text-sm font-semibold transition hover:bg-white/25"
              data-testid="button-retry-super-events"
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

  const events = list.events;
  const active = events.filter((e) => e.status === "active");
  const ended = events.filter((e) => e.status !== "active");

  return (
    <Shell bg={bg}>
      <div className="flex h-full flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-black/60 px-3 py-3 backdrop-blur sm:px-4 md:px-6">
          <div className="flex items-center gap-3">
            <Link
              href="/game"
              className="inline-flex items-center gap-1 rounded-lg border border-white/20 bg-black/40 px-3 py-1.5 text-sm text-white/80 transition hover:bg-black/60"
              data-testid="button-back-home"
            >
              <ArrowLeft className="h-4 w-4" />
              首頁
            </Link>
            <div className="flex items-center gap-2">
              <Siren className="h-5 w-5 text-red-300" />
              <h1 className="font-serif text-lg font-bold text-white">超事件</h1>
            </div>
          </div>
          <GameNotifications />
        </header>

        <div className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6">
          <div className="mx-auto max-w-3xl space-y-6">
            <p className="rounded-xl border border-white/10 bg-black/45 px-4 py-3 text-xs leading-relaxed text-white/70 backdrop-blur">
              超事件是牽動全球或多國的重大局勢。若你的國家在影響範圍內，可提交自由文字應對，
              下個回合由 AI 判定其結果——妥善應對可減輕衝擊，甚至化危機為轉機。
            </p>

            <Section
              title="進行中"
              icon={Siren}
              iconClass="text-red-300"
              empty="目前沒有進行中的超事件。"
              events={active}
              onOpen={setOpenId}
            />

            {ended.length > 0 && (
              <Section
                title="已結束"
                icon={Clock}
                iconClass="text-white/50"
                empty=""
                events={ended}
                onOpen={setOpenId}
              />
            )}
          </div>
        </div>
      </div>

      {openId && (
        <SuperEventDetailDialog
          id={openId}
          onClose={() => setOpenId(null)}
        />
      )}
    </Shell>
  );
}

function Shell({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-hidden bg-cover bg-center text-white"
      style={{ backgroundImage: `url(${bg})` }}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div className="relative h-full">{children}</div>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  iconClass,
  empty,
  events,
  onOpen,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  iconClass: string;
  empty: string;
  events: SuperEventListItem[];
  onOpen: (id: string) => void;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <Icon className={`h-4 w-4 ${iconClass}`} />
        <h2 className="font-serif text-sm font-bold text-white/90">{title}</h2>
        <span className="text-xs text-white/40">（{events.length}）</span>
      </div>
      {events.length === 0 ? (
        empty ? (
          <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-6 text-center text-sm text-white/50 backdrop-blur">
            {empty}
          </div>
        ) : null
      ) : (
        <div className="space-y-2.5">
          {events.map((e) => (
            <EventCard key={e.id} event={e} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

function EventCard({
  event,
  onOpen,
}: {
  event: SuperEventListItem;
  onOpen: (id: string) => void;
}) {
  const tone = severityTone(event.severity);
  return (
    <button
      onClick={() => onOpen(event.id)}
      className="block w-full rounded-xl border border-white/12 bg-black/50 p-4 text-left backdrop-blur transition hover:border-white/30 hover:bg-black/65"
      data-testid={`super-event-card-${event.id}`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        {(() => {
          const k = kindInfo(event.kind);
          return (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${k.cls}`}
            >
              {event.kind === "opportunity" ? (
                <Sparkles className="h-3 w-3" />
              ) : (
                <Siren className="h-3 w-3" />
              )}
              {k.label}
            </span>
          );
        })()}
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${tone.cls}`}
        >
          {tone.label}
        </span>
        {(() => {
          const s = stageInfo(event.stage);
          return (
            <span
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${s.cls}`}
            >
              {s.label}
            </span>
          );
        })()}
        <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-white/70">
          {event.scope === "global" ? (
            <Globe2 className="h-3 w-3" />
          ) : (
            <MapPin className="h-3 w-3" />
          )}
          {scopeLabel(event.scope)}
        </span>
        <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-white/60">
          {event.category}
        </span>
        {event.affectsMe && (
          <span className="rounded-full border border-amber-400/40 bg-amber-500/20 px-2 py-0.5 text-[11px] font-bold text-amber-100">
            影響本國
          </span>
        )}
        <span className="ml-auto text-[11px] text-white/40">
          第 {event.turnsElapsed} 回合
        </span>
      </div>
      <h3 className="font-serif text-base font-bold text-white">{event.title}</h3>
      <p className="mt-1 line-clamp-2 text-sm text-white/70">{event.summary}</p>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-white/45">
        <span>{causeLabel(event.cause)}</span>
        <span>·</span>
        <span>{formatDateTime(event.createdAt)}</span>
        {event.affectsMe && event.status === "active" && (
          <span className="ml-auto">
            {event.myResponseStatus === "judged" ? (
              <span className="inline-flex items-center gap-1 text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" /> 已判定
              </span>
            ) : event.myResponseStatus === "pending" ? (
              <span className="inline-flex items-center gap-1 text-amber-200">
                <Hourglass className="h-3.5 w-3.5" /> 應對待判定
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-sky-200">
                <Send className="h-3.5 w-3.5" /> 尚未應對
              </span>
            )}
          </span>
        )}
      </div>
    </button>
  );
}

function SuperEventDetailDialog({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError, refetch } = useGetSuperEvent(id, {
    query: {
      queryKey: getGetSuperEventQueryKey(id),
      staleTime: 1000 * 15,
    },
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-[#141821] text-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex items-center gap-2">
            <Siren className="h-5 w-5 text-red-300" />
            <span className="font-serif text-sm font-bold">超事件詳情</span>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-white/60 transition hover:bg-white/10 hover:text-white"
            data-testid="button-close-detail"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-white/60">
              <Loader2 className="h-5 w-5 animate-spin" /> 載入中…
            </div>
          ) : isError || !data ? (
            <div className="py-10 text-center text-sm text-white/60">
              <p>無法載入此超事件。</p>
              <button
                onClick={() => refetch()}
                className="mt-3 rounded-lg bg-white/15 px-4 py-2 text-sm font-semibold transition hover:bg-white/25"
              >
                重新載入
              </button>
            </div>
          ) : (
            <DetailBody event={data} onSubmitted={() => refetch()} />
          )}
        </div>
      </div>
    </div>
  );
}

function DetailBody({
  event,
  onSubmitted,
}: {
  event: SuperEventDetailResponse;
  onSubmitted: () => void;
}) {
  const tone = severityTone(event.severity);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState(event.myResponse?.responseText ?? "");

  const submit = useSubmitSuperEventResponse({
    mutation: {
      onSuccess: async () => {
        toast({ title: "已提交應對", description: "下個回合將由 AI 判定結果。" });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetSuperEventQueryKey(event.id) }),
          queryClient.invalidateQueries({ queryKey: getListSuperEventsQueryKey() }),
        ]);
        onSubmitted();
      },
      onError: (err: unknown) => {
        toast({
          title: "提交失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        });
      },
    },
  });

  const trimmed = text.trim();
  const canSubmit =
    event.status === "active" &&
    event.affectsMe &&
    trimmed.length > 0 &&
    trimmed.length <= RESPONSE_MAX &&
    !submit.isPending;

  const logs = useMemo(
    () => [...event.turnLogs].sort((a, b) => b.turnNumber - a.turnNumber),
    [event.turnLogs],
  );

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {(() => {
            const k = kindInfo(event.kind);
            return (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${k.cls}`}
              >
                {event.kind === "opportunity" ? (
                  <Sparkles className="h-3 w-3" />
                ) : (
                  <Siren className="h-3 w-3" />
                )}
                {k.label}
              </span>
            );
          })()}
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${tone.cls}`}
          >
            {tone.label}
          </span>
          {(() => {
            const s = stageInfo(event.stage);
            return (
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-bold ${s.cls}`}
              >
                {s.label}
              </span>
            );
          })()}
          <span className="inline-flex items-center gap-1 rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-white/70">
            {event.scope === "global" ? (
              <>
                <Globe2 className="h-3 w-3" /> 全球
              </>
            ) : (
              <>
                <MapPin className="h-3 w-3" /> {scopeLabel(event.scope)}
                {event.scope === "regional" && event.regionIds.length > 0
                  ? `（${event.regionIds.length} 地區）`
                  : ""}
              </>
            )}
          </span>
          {event.canSpread && event.scope === "regional" && (
            <span className="rounded-full border border-orange-400/40 bg-orange-500/15 px-2 py-0.5 text-[11px] font-bold text-orange-100">
              可蔓延
            </span>
          )}
          <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-white/60">
            {event.category}
          </span>
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${
              event.status === "active"
                ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                : "border-white/20 bg-white/5 text-white/50"
            }`}
          >
            {event.status === "active" ? "進行中" : "已結束"}
          </span>
        </div>
        <h2 className="font-serif text-xl font-bold">{event.title}</h2>
        <p className="mt-1 text-xs text-white/45">
          {causeLabel(event.cause)} · 第 {event.turnsElapsed} 回合 ·{" "}
          {formatDateTime(event.createdAt)}
        </p>
      </div>

      <p className="whitespace-pre-wrap rounded-xl border border-white/10 bg-black/30 p-3 text-sm leading-relaxed text-white/85">
        {event.narrative || event.summary}
      </p>

      {event.grantedTechs.length > 0 && (
        <div className="rounded-xl border border-indigo-400/30 bg-indigo-500/10 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-indigo-200">
            <Sparkles className="h-3.5 w-3.5" /> 跨時代科技賦予
          </div>
          <div className="flex flex-wrap gap-1.5">
            {event.grantedTechs.map((t, i) => (
              <span
                key={i}
                className="rounded-full border border-indigo-300/30 bg-indigo-500/15 px-2 py-0.5 text-[11px] text-indigo-100"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 本國應對 */}
      {event.affectsMe ? (
        <div className="rounded-xl border border-amber-400/25 bg-amber-500/5 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-amber-100">
            <Send className="h-4 w-4" /> 本國應對
          </div>

          {event.myResponse && (
            <div className="mb-3 space-y-2">
              <div className="rounded-lg border border-white/10 bg-black/30 p-2.5">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] text-white/50">
                  你的應對
                  {event.myResponse.status === "judged" ? (
                    <span className="inline-flex items-center gap-1 text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" /> 已判定
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-amber-200">
                      <Hourglass className="h-3 w-3" /> 待下回合判定
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap text-sm text-white/85">
                  {event.myResponse.responseText}
                </p>
              </div>
              {event.myResponse.status === "judged" &&
                (event.myResponse.resultTitle || event.myResponse.resultDescription) && (
                  <div className="rounded-lg border border-emerald-400/25 bg-emerald-500/10 p-2.5">
                    {event.myResponse.resultTitle && (
                      <div className="mb-1 text-sm font-bold text-emerald-100">
                        {event.myResponse.resultTitle}
                      </div>
                    )}
                    {event.myResponse.resultDescription && (
                      <p className="whitespace-pre-wrap text-sm text-white/80">
                        {event.myResponse.resultDescription}
                      </p>
                    )}
                  </div>
                )}
            </div>
          )}

          {event.status === "active" ? (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value.slice(0, RESPONSE_MAX))}
                rows={3}
                placeholder={
                  event.myResponse
                    ? "重新提交會覆寫上次應對，並重置為待判定…"
                    : "描述你的國家如何應對此事件（1–500 字）…"
                }
                className="w-full resize-none rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:border-amber-400/50 focus:outline-none"
                data-testid="input-super-event-response"
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[11px] text-white/40">
                  {trimmed.length}/{RESPONSE_MAX}
                </span>
                <button
                  onClick={() =>
                    submit.mutate({ id: event.id, data: { responseText: trimmed } })
                  }
                  disabled={!canSubmit}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500/90 px-4 py-2 text-sm font-bold text-black transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
                  data-testid="button-submit-super-event-response"
                >
                  {submit.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  {event.myResponse ? "更新應對" : "提交應對"}
                </button>
              </div>
            </>
          ) : (
            <p className="text-xs text-white/50">此事件已結束，無法再提交應對。</p>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-white/55">
          本國不在此超事件的影響範圍內，僅供參考。
        </div>
      )}

      {/* 發展時間軸 */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 text-sm font-bold text-white/90">
          <Clock className="h-4 w-4 text-white/60" /> 事件發展
        </div>
        {logs.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-5 text-center text-xs text-white/45">
            尚無發展紀錄，事件於每回合推進。
          </div>
        ) : (
          <ol className="space-y-2">
            {logs.map((log) => (
              <li
                key={log.id}
                className="rounded-xl border border-white/10 bg-black/30 p-3"
              >
                <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-white/45">
                  <span className="flex items-center gap-2">
                    <span className="font-bold text-white/70">
                      第 {log.turnNumber} 回合
                    </span>
                    {(() => {
                      const s = stageInfo(log.stage);
                      return (
                        <span
                          className={`rounded-full border px-1.5 py-0.5 text-[10px] ${s.cls}`}
                        >
                          {s.label}
                        </span>
                      );
                    })()}
                  </span>
                  <span>{formatDateTime(log.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-white/85">
                  {log.narrative}
                </p>
                {log.effectSummary && (
                  <p className="mt-1.5 rounded-lg bg-white/5 px-2 py-1 text-[11px] text-white/60">
                    {log.effectSummary}
                  </p>
                )}
                {log.spreadRegionIds.length > 0 && (
                  <p className="mt-1.5 rounded-lg bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200/80">
                    傳染擴散：新增 {log.spreadRegionIds.length} 個受影響地區
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
