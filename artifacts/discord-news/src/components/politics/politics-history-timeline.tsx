import {
  Crown,
  Flame,
  Gavel,
  History,
  Landmark,
  Loader2,
  Replace,
  Sparkles,
} from "lucide-react";
import {
  useGetPoliticsHistory,
  getGetPoliticsHistoryQueryKey,
} from "@workspace/api-client-react";
import type { PoliticsHistoryEntry } from "@workspace/api-client-react";

const GOV_HISTORY_ICONS: Record<
  string,
  { icon: typeof Crown; className: string }
> = {
  government_change: { icon: Replace, className: "text-amber-300" },
  coup: { icon: Flame, className: "text-rose-400" },
  decision: { icon: Gavel, className: "text-sky-300" },
  decision_success: { icon: Gavel, className: "text-emerald-300" },
  decision_failure: { icon: Gavel, className: "text-rose-300" },
  note_update: { icon: Sparkles, className: "text-sky-200" },
};

export function PoliticsHistoryTimeline() {
  const { data, isLoading } = useGetPoliticsHistory({
    query: {
      queryKey: getGetPoliticsHistoryQueryKey(),
      staleTime: 1000 * 20,
    },
  });
  const history: PoliticsHistoryEntry[] = data?.history ?? [];

  return (
    <section
      className="mt-4 rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur"
      data-testid="section-politics-history"
    >
      <h2 className="mb-3 flex items-center gap-2 font-serif text-sm font-bold text-white/80">
        <History className="h-4 w-4 text-sky-300" />
        政治歷史
      </h2>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-white/50">
          <Loader2 className="h-4 w-4 animate-spin" />
          載入政治歷史中…
        </div>
      ) : history.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-6 text-center text-sm text-white/45">
          目前還沒有政治大事紀。下達政府決策、推動政體變更，或發生政變後，會在這裡留下紀錄。
        </div>
      ) : (
        <ul className="space-y-2.5">
          {history.map((h) => {
            const meta =
              GOV_HISTORY_ICONS[h.eventType] ?? {
                icon: Landmark,
                className: "text-white/60",
              };
            const Icon = meta.icon;
            return (
              <li
                key={h.id}
                className="flex gap-3 rounded-xl border border-white/10 bg-white/5 p-3"
                data-testid={`history-${h.id}`}
              >
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-black/40">
                  <Icon className={`h-4 w-4 ${meta.className}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-bold">
                      {h.title}
                    </span>
                    <time className="shrink-0 text-[10px] text-white/40">
                      {new Date(h.createdAt).toLocaleString("zh-TW", {
                        hour12: false,
                      })}
                    </time>
                  </div>
                  {h.description && (
                    <p className="mt-0.5 whitespace-pre-wrap text-xs leading-relaxed text-white/65">
                      {h.description}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
