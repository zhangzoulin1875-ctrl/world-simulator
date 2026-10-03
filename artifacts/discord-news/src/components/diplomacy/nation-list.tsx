import React, { useMemo, useState } from "react";
import { Loader2, Search, Users } from "lucide-react";
import type { DiplomacyNation } from "@workspace/api-client-react";
import { NationAvatar, relationTone } from "./shared";

type NationFilter = "all" | "npc" | "conversed" | "atWar";

const NATION_FILTERS: { key: NationFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "npc", label: "NPC" },
  { key: "conversed", label: "已對話" },
  { key: "atWar", label: "交戰中" },
];

// memo 化的列項：僅在該國資料、選取狀態或 onSelect 變更時重繪，
// 使切換選取時只更新舊/新兩項，其餘列項（含頭像）保持穩定不重繪。
const NationListItem = React.memo(function NationListItem({
  nation: n,
  selected,
  onSelect,
}: {
  nation: DiplomacyNation;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(n.id)}
      className={`flex w-full items-center gap-3 border-b border-white/5 px-3 py-2.5 text-left transition hover:bg-white/10 ${
        selected ? "bg-amber-500/15" : ""
      }`}
      data-testid={`nation-item-${n.id}`}
    >
      <NationAvatar nation={n} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold">{n.name}</span>
          {n.isNpc && (
            <span className="rounded bg-purple-500/30 px-1 text-[10px] font-bold text-purple-200">
              NPC
            </span>
          )}
          {n.atWar && (
            <span className="rounded bg-red-500/30 px-1 text-[10px] font-bold text-red-200">
              交戰中
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-white/50">
          {n.isNpc && n.relationScore !== null && (
            <span className={relationTone(n.relationScore)}>
              關係 {n.relationScore > 0 ? "+" : ""}
              {n.relationScore}
            </span>
          )}
          {n.distance !== null && n.distance !== undefined && (
            <span>距離 {n.distance}</span>
          )}
        </div>
      </div>
      {n.unreadCount > 0 && (
        <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-bold">
          {n.unreadCount}
        </span>
      )}
    </button>
  );
});

export function NationList(props: {
  nations: DiplomacyNation[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
  search: string;
  setSearch: (v: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  openMobile: boolean;
  lobby?: { active: boolean; onSelect: () => void };
}) {
  const {
    nations,
    isLoading,
    isError,
    refetch,
    search,
    setSearch,
    selectedId,
    onSelect,
    openMobile,
    lobby,
  } = props;

  const [filter, setFilter] = useState<NationFilter>("all");
  // 穩定化過濾結果：僅在國家清單或篩選變更時重算，避免每次選取都重跑。
  const filtered = useMemo(
    () =>
      nations.filter((n) => {
        if (filter === "npc") return n.isNpc;
        if (filter === "conversed") return n.hasConversed;
        if (filter === "atWar") return n.atWar;
        return true;
      }),
    [nations, filter],
  );

  const emptyMessage = search.trim()
    ? "沒有符合的國家"
    : filter === "npc"
      ? "目前沒有 NPC 國家"
      : filter === "conversed"
        ? "尚無已對話的國家"
        : filter === "atWar"
          ? "目前沒有交戰中的國家"
          : "沒有符合的國家";

  return (
    <aside
      className={`min-h-0 w-full flex-1 flex-col border-r border-white/10 bg-black/55 backdrop-blur md:flex md:w-80 md:flex-none ${
        openMobile ? "flex" : "hidden"
      }`}
    >
      <div className="border-b border-white/10 p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-white/40" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋國家名稱…"
            className="w-full rounded-lg border border-white/15 bg-white/10 py-2 pl-8 pr-3 text-sm text-white placeholder:text-white/40 focus:border-amber-400 focus:outline-none"
            data-testid="input-nation-search"
          />
        </div>
        <div className="mt-2 flex items-center gap-1">
          {NATION_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                filter === f.key
                  ? "bg-amber-500/85 text-black"
                  : "bg-white/10 text-white/70 hover:bg-white/20"
              }`}
              data-testid={`filter-${f.key}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-white/45">依陸地距離由近至遠排序</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {lobby && (
          <button
            onClick={lobby.onSelect}
            className={`flex w-full items-center gap-3 border-b border-white/10 px-3 py-2.5 text-left transition hover:bg-white/10 ${
              lobby.active ? "bg-amber-500/15" : ""
            }`}
            data-testid="lobby-entry"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-amber-300/30 bg-amber-500/20">
              <Users className="h-4 w-4 text-amber-200" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">玩家大廳</div>
              <div className="text-[11px] text-white/50">所有玩家共用的群聊</div>
            </div>
          </button>
        )}
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 p-6 text-sm text-white/60">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入國家中…
          </div>
        ) : isError ? (
          <div className="p-6 text-center text-sm text-white/60">
            載入失敗。
            <button onClick={refetch} className="ml-1 text-amber-300 underline">
              重試
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-center text-sm text-white/50">
            {emptyMessage}
          </div>
        ) : (
          filtered.map((n) => (
            <NationListItem
              key={n.id}
              nation={n}
              selected={selectedId === n.id}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </aside>
  );
}
