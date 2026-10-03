import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Eye, Loader2, MessageSquare, Siren, X } from "lucide-react";
import {
  API,
  authedFetch,
  deltaClass,
  fmtDelta,
  formatDateTime,
  IMPACT_FIELDS,
  kindLabel,
  readError,
  scopeLabel,
  stageLabel,
  targetStatsText,
  type AdminSuperEvent,
  type EventDetail,
  type ImpactResponse,
} from "./shared";

export function EventDetailModal({
  event,
  onClose,
}: {
  event: AdminSuperEvent;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [impacts, setImpacts] = useState<ImpactResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const [detailRes, impactRes] = await Promise.all([
          authedFetch(`${API}/super-events/admin/${event.id}/detail`),
          authedFetch(`${API}/super-events/admin/${event.id}/impacts`),
        ]);
        if (!detailRes.ok) {
          if (!cancelled) setError(await readError(detailRes));
          return;
        }
        const data = (await detailRes.json()) as EventDetail;
        if (!cancelled) setDetail(data);
        if (impactRes.ok) {
          const impactData = (await impactRes.json()) as ImpactResponse;
          if (!cancelled) setImpacts(impactData);
        }
      } catch {
        if (!cancelled) setError("無法連線至伺服器");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [event.id]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-bold">{event.title}</h2>
            <p className="text-xs text-muted-foreground">
              影響檢視 · 玩家應對與回合歷程
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" /> 載入中…
            </div>
          ) : error ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          ) : detail ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full border px-2 py-0.5 text-xs">
                  {kindLabel(detail.kind)}
                </span>
                <span className="rounded-full border px-2 py-0.5 text-xs">
                  {stageLabel(detail.stage)}
                </span>
                <span className="rounded-full border px-2 py-0.5 text-xs">
                  {scopeLabel(detail.scope)}
                  {detail.scope === "regional"
                    ? `（${detail.regionIds.length} 地區）`
                    : detail.scope === "targeted"
                      ? `（${detail.nations.length} 國）`
                      : ""}
                </span>
                {detail.scope === "regional" && detail.canSpread && (
                  <span className="rounded-full border border-orange-500/40 px-2 py-0.5 text-xs text-orange-600 dark:text-orange-300">
                    可蔓延
                  </span>
                )}
                {detail.targetStats && detail.targetStats.length > 0 && (
                  <span className="rounded-full border border-indigo-500/40 px-2 py-0.5 text-xs text-indigo-600 dark:text-indigo-300">
                    目標數據：{targetStatsText(detail.targetStats)}
                  </span>
                )}
              </div>

              <ImpactSection impacts={impacts} />

              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
                  <MessageSquare className="h-4 w-4 text-sky-500" />
                  各國應對（{detail.responses.length}）
                </h3>
                {detail.responses.length === 0 ? (
                  <p className="rounded-lg border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
                    尚無任何國家提交應對。
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {detail.responses.map((r) => (
                      <div
                        key={r.id}
                        className="rounded-lg border bg-card p-3"
                        data-testid={`response-${r.id}`}
                      >
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {r.nationName?.trim() || "（未命名國家）"}
                          </span>
                          {r.nationLeader?.trim() && (
                            <span className="text-xs text-muted-foreground">
                              領袖：{r.nationLeader}
                            </span>
                          )}
                          {r.isNpc && (
                            <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                              NPC
                            </span>
                          )}
                          <span
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-xs",
                              r.status === "judged"
                                ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-300"
                                : "border-amber-500/40 text-amber-600 dark:text-amber-300",
                            )}
                          >
                            {r.status === "judged" ? "已判定" : "待判定"}
                          </span>
                          <span className="ml-auto text-xs text-muted-foreground">
                            {formatDateTime(r.createdAt)}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap text-sm">
                          {r.responseText}
                        </p>
                        {(r.resultTitle || r.resultDescription) && (
                          <div className="mt-2 rounded-md border border-dashed bg-muted/40 p-2.5">
                            {r.resultTitle && (
                              <p className="text-sm font-medium">
                                {r.resultTitle}
                              </p>
                            )}
                            {r.resultDescription && (
                              <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                                {r.resultDescription}
                              </p>
                            )}
                            {r.judgedAt && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                判定於 {formatDateTime(r.judgedAt)}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section>
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
                  <Siren className="h-4 w-4 text-red-500" />
                  回合歷程（{detail.turnLogs.length}）
                </h3>
                {detail.turnLogs.length === 0 ? (
                  <p className="rounded-lg border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
                    尚無回合結算紀錄。
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {detail.turnLogs.map((l) => (
                      <div
                        key={l.id}
                        className="rounded-lg border bg-card p-3"
                        data-testid={`turn-log-${l.id}`}
                      >
                        <div className="mb-1 flex items-center gap-2">
                          <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
                            第 {l.turnNumber} 回合
                          </span>
                          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                            {stageLabel(l.stage)}
                          </span>
                          <span className="ml-auto text-xs text-muted-foreground">
                            {formatDateTime(l.createdAt)}
                          </span>
                        </div>
                        {l.narrative && (
                          <p className="whitespace-pre-wrap text-sm">
                            {l.narrative}
                          </p>
                        )}
                        {l.effectSummary && (
                          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                            效果：{l.effectSummary}
                          </p>
                        )}
                        {l.spreadRegionIds.length > 0 && (
                          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                            傳染擴散：新增 {l.spreadRegionIds.length} 個受影響地區
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          ) : null}
        </div>

        <div className="flex justify-end border-t px-4 py-3">
          <Button variant="outline" onClick={onClose}>
            關閉
          </Button>
        </div>
      </div>
    </div>
  );
}

function ImpactSection({ impacts }: { impacts: ImpactResponse | null }) {
  const nations = impacts?.nations ?? [];
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nations;
    return nations.filter((n) =>
      (n.nationName ?? "").toLowerCase().includes(q),
    );
  }, [nations, query]);
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
        <Eye className="h-4 w-4 text-indigo-500" />
        各國影響檢視（{nations.length}）
      </h3>
      {nations.length === 0 ? (
        <p className="rounded-lg border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
          尚無任何回合影響紀錄。事件結算後會逐回合累計各國實際受到的衝擊。
        </p>
      ) : (
        <>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜尋國家名稱…"
            className="mb-2.5 h-9"
          />
          {filtered.length === 0 ? (
            <p className="rounded-lg border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
              沒有符合「{query}」的國家。
            </p>
          ) : (
            <div className="space-y-2.5">
              {filtered.map((n) => (
            <div
              key={n.nationId}
              className="rounded-lg border bg-card p-3"
              data-testid={`impact-${n.nationId}`}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {n.nationName?.trim() || "（未命名國家）"}
                </span>
                {n.isNpc && (
                  <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                    NPC
                  </span>
                )}
                <span className="ml-auto text-xs text-muted-foreground">
                  {n.turns.length} 回合累計
                </span>
              </div>
              <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                {IMPACT_FIELDS.map((f) => (
                  <span key={f.key} className="inline-flex items-center gap-1">
                    <span className="text-muted-foreground">{f.label}</span>
                    <span className={cn("font-medium", deltaClass(n.cumulative[f.key]))}>
                      {fmtDelta(n.cumulative[f.key])}
                    </span>
                  </span>
                ))}
              </div>
              {n.turns.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    每回合明細
                  </summary>
                  <div className="mt-1.5 space-y-1">
                    {n.turns.map((t) => (
                      <div
                        key={t.turnNumber}
                        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded border bg-muted/30 px-2 py-1"
                      >
                        <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium">
                          第 {t.turnNumber} 回合
                        </span>
                        {IMPACT_FIELDS.filter((f) => t[f.key] !== 0).map((f) => (
                          <span key={f.key} className="inline-flex items-center gap-0.5">
                            <span className="text-muted-foreground">{f.label}</span>
                            <span className={deltaClass(t[f.key])}>
                              {fmtDelta(t[f.key])}
                            </span>
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
