import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  ArrowLeft,
  Handshake,
  MessageCircle,
  ScrollText,
  Swords,
  Users,
} from "lucide-react";
import {
  useListDiplomacyNations,
  getListDiplomacyNationsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { GameNotifications } from "@/components/game-notifications";
import { HelpButton } from "@/components/help-button";
import type { NationResources } from "./shared";
import { Shell, ResourceBar, EmptyPane } from "./shared";
import { NationList } from "./nation-list";
import { ChatPane } from "./chat-pane";
import { LobbyPane } from "./lobby-pane";
import { TreatyPane } from "./treaty-pane";
import { WarPane } from "./war-pane";
import { AlliancePane } from "./alliance-pane";

type TabKey = "chat" | "treaty" | "war" | "alliance";

const TABS: { key: TabKey; label: string; icon: React.ElementType }[] = [
  { key: "chat", label: "通訊", icon: MessageCircle },
  { key: "treaty", label: "締約", icon: ScrollText },
  { key: "war", label: "宣戰", icon: Swords },
  { key: "alliance", label: "聯盟", icon: Users },
];

/** 玩家大廳的 sentinel 選取值；不與任何真實國家 uuid 衝突。 */
const LOBBY_ID = "__lobby__";

export function DiplomacyScreen({
  bg,
  resources,
}: {
  bg: string;
  resources: NationResources | null;
}) {
  const { toast } = useToast();
  const [tab, setTab] = useState<TabKey>("chat");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [listOpenMobile, setListOpenMobile] = useState(true);
  // Task #341 — 由行動晶片跳轉時要高亮的條約提案 id（締約分頁滾動＋高亮）。
  const [highlightTreatyId, setHighlightTreatyId] = useState<number | null>(
    null,
  );

  const {
    data: directory,
    isLoading,
    isError,
    refetch,
  } = useListDiplomacyNations(
    search.trim() ? { q: search.trim() } : undefined,
    {
      query: {
        queryKey: getListDiplomacyNationsQueryKey(
          search.trim() ? { q: search.trim() } : undefined,
        ),
        refetchInterval: 30_000,
      },
    },
  );

  const nations = directory?.nations ?? [];
  const selected = nations.find((n) => n.id === selectedId) ?? null;

  // 穩定化選取回呼：切換選取時列表列項（memo 化）不會整份重繪。
  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setListOpenMobile(false);
  }, []);
  const handleSelectLobby = useCallback(() => {
    setSelectedId(LOBBY_ID);
    setListOpenMobile(false);
  }, []);

  // Task #108 — 站內通知 linkPath 帶對方國家（?nation=<id>）：
  // 點擊通知直達交流分頁並選定該國。讀取後即清掉查詢字串，
  // 避免手動切換後回訪又被重設。
  const searchStr = useSearch();
  const [, navigate] = useLocation();
  useEffect(() => {
    const params = new URLSearchParams(searchStr);
    const nationParam = params.get("nation");
    const tabParam = params.get("tab");
    const treatyParam = params.get("treaty");
    if (!nationParam && !tabParam && !treatyParam) return;
    // Task #341 — 行動晶片跳轉：?tab=treaty&nation=<id>&treaty=<proposalId>
    // → 切到締約分頁、選定該 NPC、記下要高亮的提案 id。
    if (tabParam && TABS.some((t) => t.key === tabParam)) {
      setTab(tabParam as TabKey);
      setListOpenMobile(false);
      if (nationParam) setSelectedId(nationParam);
      if (treatyParam) {
        const n = Number(treatyParam);
        if (Number.isInteger(n)) setHighlightTreatyId(n);
      }
    } else if (nationParam) {
      setSelectedId(nationParam);
      setTab("chat");
      setListOpenMobile(false);
    }
    navigate("/game/diplomacy", { replace: true });
  }, [searchStr, navigate]);

  const totalUnread = useMemo(
    () => nations.reduce((sum, n) => sum + n.unreadCount, 0),
    [nations],
  );

  return (
    <Shell bg={bg}>
      {/* top bar */}
      <header className="relative flex items-center gap-3 border-b border-white/10 bg-black/60 px-4 py-2.5 backdrop-blur md:px-6">
        <HelpButton
          helpKey={`diplomacy:${tab}`}
          className="absolute left-1/2 top-1/2 z-30 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-black/50 text-white/85 backdrop-blur transition hover:bg-black/75 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        />
        <Link
          href="/game"
          className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-white/70 transition hover:bg-white/10 hover:text-white"
          data-testid="link-back-game"
        >
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">玩家首頁</span>
        </Link>
        <h1 className="flex items-center gap-2 font-serif text-lg font-bold">
          <Handshake className="h-5 w-5 text-amber-300" />
          外交
        </h1>
        {resources && <ResourceBar resources={resources} />}
        <nav className="ml-auto flex items-center gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                tab === t.key
                  ? "bg-amber-500/85 text-black"
                  : "text-white/75 hover:bg-white/10 hover:text-white"
              }`}
              data-testid={`tab-${t.key}`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
              {t.key === "chat" && totalUnread > 0 && (
                <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
                  {totalUnread}
                </span>
              )}
            </button>
          ))}
        </nav>
        <GameNotifications />
      </header>

      <div className="flex min-h-0 flex-1">
        {tab === "war" ? (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <NationList
              nations={nations}
              isLoading={isLoading}
              isError={isError}
              refetch={() => refetch()}
              search={search}
              setSearch={setSearch}
              selectedId={selectedId}
              onSelect={handleSelect}
              openMobile={listOpenMobile}
            />
            <WarPane
              selected={selected}
              onBackMobile={() => setListOpenMobile(true)}
            />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <NationList
              nations={nations}
              isLoading={isLoading}
              isError={isError}
              refetch={() => refetch()}
              search={search}
              setSearch={setSearch}
              selectedId={selectedId}
              onSelect={handleSelect}
              openMobile={listOpenMobile}
              lobby={
                tab === "chat"
                  ? {
                      active: selectedId === LOBBY_ID,
                      onSelect: handleSelectLobby,
                    }
                  : undefined
              }
            />
            <div
              className={`min-h-0 flex-1 flex-col ${listOpenMobile ? "hidden md:flex" : "flex"}`}
            >
              {tab === "alliance" ? (
                <AlliancePane />
              ) : tab === "chat" && selectedId === LOBBY_ID ? (
                <LobbyPane onBackMobile={() => setListOpenMobile(true)} />
              ) : selected === null ? (
                <EmptyPane />
              ) : tab === "chat" ? (
                <ChatPane
                  nation={selected}
                  aiChatRemaining={directory?.aiChatRemaining ?? 0}
                  aiChatCap={directory?.aiChatCap ?? 0}
                  onBackMobile={() => setListOpenMobile(true)}
                />
              ) : (
                <TreatyPane
                  nation={selected}
                  onBackMobile={() => setListOpenMobile(true)}
                  highlightTreatyId={highlightTreatyId}
                  onHighlightConsumed={() => setHighlightTreatyId(null)}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </Shell>
  );
}
