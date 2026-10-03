import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Newspaper, Loader2, ChevronDown } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { zhTW } from "date-fns/locale";
import {
  useListGameNews,
  getListGameNewsQueryKey,
} from "@workspace/api-client-react";
import type { GameNewsItem } from "@workspace/api-client-react";
import { NEWS_CATEGORY_META, newsCategoryMeta } from "@/components/game-news";
import { DEFAULT_MILITARY_BG } from "@/components/military-shared";
import { GameNotifications } from "@/components/game-notifications";

/**
 * Task #187 — 世界新聞總覽頁（/game/news）。
 * - 公開唯讀端點 GET /game/news（limit 100），可依分類篩選、展開看完整報導。
 * - 每則新聞可展開看完整 body、遊戲日期與時代。
 */
type CategoryFilter = "all" | keyof typeof NEWS_CATEGORY_META;

const CATEGORY_ORDER = Object.keys(NEWS_CATEGORY_META) as (keyof typeof NEWS_CATEGORY_META)[];

export default function GameNews() {
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const listQuery = useListGameNews(
    { limit: 100 },
    {
      query: {
        queryKey: getListGameNewsQueryKey({ limit: 100 }),
        refetchInterval: 60_000,
      },
    },
  );

  const news = listQuery.data?.news ?? [];
  const filtered =
    filter === "all" ? news : news.filter((n) => n.category === filter);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center text-white"
      style={{ backgroundImage: `url(${DEFAULT_MILITARY_BG})` }}
      data-testid="page-game-news"
    >
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/70 via-black/55 to-black/75" />

      <div className="relative mx-auto flex min-h-full max-w-4xl flex-col px-3 pb-12 md:px-6">
        {/* header */}
        <header className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between md:py-4">
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
              <Newspaper className="h-5 w-5 text-amber-300" />
              <span className="font-serif text-base font-bold md:text-lg">
                世界新聞
              </span>
            </div>
          </div>
          <GameNotifications />
        </header>

        {/* category filter */}
        <div
          className="mb-4 flex flex-wrap gap-2"
          data-testid="news-category-filters"
        >
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
            testId="filter-all"
          >
            全部
          </FilterChip>
          {CATEGORY_ORDER.map((key) => {
            const meta = NEWS_CATEGORY_META[key];
            return (
              <FilterChip
                key={key}
                active={filter === key}
                onClick={() => setFilter(key)}
                testId={`filter-${key}`}
              >
                <meta.Icon className={`h-3.5 w-3.5 ${meta.className}`} />
                {meta.label}
              </FilterChip>
            );
          })}
        </div>

        {/* list */}
        <div className="flex flex-col gap-3" data-testid="list-all-news">
          {listQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-black/40 px-4 py-10 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" />
              載入中…
            </div>
          ) : filtered.length === 0 ? (
            <div
              className="rounded-xl border border-white/10 bg-black/40 px-4 py-10 text-center text-sm text-white/60"
              data-testid="text-no-news"
            >
              {news.length === 0
                ? "目前還沒有新聞，回合結束後將自動更新"
                : "此分類目前沒有新聞"}
            </div>
          ) : (
            filtered.map((item) => (
              <NewsCard
                key={item.id}
                item={item}
                expanded={expanded[item.id] ?? false}
                onToggle={() =>
                  setExpanded((prev) => ({
                    ...prev,
                    [item.id]: !prev[item.id],
                  }))
                }
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
        active
          ? "border-amber-300/60 bg-amber-300/15 text-amber-200"
          : "border-white/15 bg-black/40 text-white/70 hover:bg-black/60"
      }`}
      data-testid={`button-${testId}`}
    >
      {children}
    </button>
  );
}

function NewsCard({
  item,
  expanded,
  onToggle,
}: {
  item: GameNewsItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = newsCategoryMeta(item.category);
  return (
    <div
      className="rounded-xl border border-white/10 bg-black/45 backdrop-blur"
      data-testid={`news-${item.id}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-white/5"
        data-testid={`button-toggle-news-${item.id}`}
        aria-expanded={expanded}
      >
        <meta.Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${meta.className}`}
          aria-label={meta.label}
          data-testid={`icon-news-category-${item.category}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-bold leading-snug">{item.title}</span>
            <span className="shrink-0 text-[10px] text-white/45">
              {formatDistanceToNow(new Date(item.createdAt), {
                addSuffix: true,
                locale: zhTW,
              })}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-white/45">
            <span
              className={`rounded px-1 py-0.5 font-semibold ${meta.className} bg-white/5`}
            >
              {meta.label}
            </span>
            <span>{item.eraLabel}</span>
            <span>
              {item.gameDate}（西元 {item.year} 年）
            </span>
          </div>
          {!expanded ? (
            <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-white/65">
              {item.body}
            </p>
          ) : null}
        </div>
        <ChevronDown
          className={`mt-0.5 h-4 w-4 shrink-0 text-white/40 transition ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </button>
      {expanded ? (
        <div
          className="border-t border-white/10 px-4 py-3 pl-11"
          data-testid={`news-body-${item.id}`}
        >
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/85">
            {item.body}
          </p>
          <div className="mt-3 text-[11px] text-white/40">
            發布於{" "}
            {format(new Date(item.createdAt), "yyyy/MM/dd HH:mm", {
              locale: zhTW,
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
