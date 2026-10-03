import { useState } from "react";
import { Link } from "wouter";
import {
  Newspaper,
  Loader2,
  Swords,
  Handshake,
  Landmark,
  Globe,
  Hourglass,
  TrendingUp,
  ChevronRight,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { zhTW } from "date-fns/locale";
import {
  useListGameNews,
  getListGameNewsQueryKey,
} from "@workspace/api-client-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * Task #184 — 每回合新聞面板（掛在鈴鐺旁）。
 * - 公開唯讀端點 GET /game/news，60 秒輪詢，新到舊列出 AI 整理的重大事件。
 * - 依 category 顯示不同圖示與顏色；每則附遊戲日期與相對時間。
 * - `variant`：預設 `dark`（深色遊戲頁）；`light` 供亮色版面。
 */
export const NEWS_CATEGORY_META: Record<
  string,
  { label: string; Icon: typeof Newspaper; className: string }
> = {
  war: { label: "戰爭", Icon: Swords, className: "text-red-300" },
  treaty: { label: "外交", Icon: Handshake, className: "text-sky-300" },
  era: { label: "時代", Icon: Hourglass, className: "text-amber-300" },
  rise_fall: { label: "興亡", Icon: TrendingUp, className: "text-fuchsia-300" },
  politics: { label: "政治", Icon: Landmark, className: "text-violet-300" },
  world: { label: "國際", Icon: Globe, className: "text-emerald-300" },
};

export function newsCategoryMeta(category: string) {
  return (
    NEWS_CATEGORY_META[category] ?? {
      label: "新聞",
      Icon: Newspaper,
      className: "text-white/60",
    }
  );
}

export function GameNews({
  variant = "dark",
}: {
  variant?: "dark" | "light";
}) {
  const [open, setOpen] = useState(false);

  const listQuery = useListGameNews(undefined, {
    query: {
      queryKey: getListGameNewsQueryKey(),
      refetchInterval: 60_000,
    },
  });

  const news = listQuery.data?.news ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition ${
            variant === "light"
              ? "border-border bg-background text-foreground shadow-sm hover:bg-secondary/60"
              : "border-white/20 bg-black/45 backdrop-blur hover:bg-black/70"
          }`}
          title="世界新聞"
          data-testid="button-news"
        >
          <Newspaper className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 border-white/15 bg-zinc-900 p-0 text-white"
        data-testid="panel-news"
      >
        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
          <span className="flex items-center gap-1.5 text-sm font-bold">
            <Newspaper className="h-4 w-4 text-amber-300" />
            世界新聞
          </span>
        </div>

        <div className="max-h-72 overflow-y-auto" data-testid="list-news">
          {listQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-white/50">
              <Loader2 className="h-4 w-4 animate-spin" />
              載入中…
            </div>
          ) : news.length === 0 ? (
            <div
              className="px-3 py-6 text-center text-sm text-white/50"
              data-testid="text-no-news"
            >
              目前還沒有新聞，回合結束後將自動更新
            </div>
          ) : (
            news.map((item) => {
              const meta = newsCategoryMeta(item.category);
              return (
                <div
                  key={item.id}
                  className="border-b border-white/5 px-3 py-2.5 last:border-b-0"
                  data-testid={`news-${item.id}`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1.5 text-xs font-bold">
                      <meta.Icon
                        className={`h-3.5 w-3.5 shrink-0 ${meta.className}`}
                        aria-label={meta.label}
                        data-testid={`icon-news-category-${item.category}`}
                      />
                      <span className="truncate">{item.title}</span>
                    </span>
                    <span className="shrink-0 text-[10px] text-white/45">
                      {formatDistanceToNow(new Date(item.createdAt), {
                        addSuffix: true,
                        locale: zhTW,
                      })}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs leading-relaxed text-white/70">
                    {item.body}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[10px] text-white/40">
                    <span
                      className={`rounded px-1 py-0.5 font-semibold ${meta.className} bg-white/5`}
                    >
                      {meta.label}
                    </span>
                    <span>{item.gameDate}（西元 {item.year} 年）</span>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <Link
          href="/game/news"
          onClick={() => setOpen(false)}
          className="flex items-center justify-center gap-1 border-t border-white/10 px-3 py-2.5 text-xs font-semibold text-amber-300 transition hover:bg-white/5"
          data-testid="link-all-news"
        >
          查看全部世界新聞
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </PopoverContent>
    </Popover>
  );
}
