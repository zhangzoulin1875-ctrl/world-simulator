import React from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  PersistQueryClientProvider,
} from "@tanstack/react-query-persist-client";
import { getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { useCurrentUser } from "@/lib/current-user";
import {
  queryClient,
  queryPersister,
  CACHE_BUSTER,
  PERSIST_MAX_AGE,
  clearPersistedQueryCache,
  getCacheUserMarker,
  setCacheUserMarker,
} from "@/lib/query-persist";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { IntroSplash } from "@/components/intro-splash";
import { DomesticEventGate } from "@/components/domestic-event-gate";
import { AppErrorBoundary } from "@/components/app-error-boundary";
import { GameMusicProvider } from "@/components/game-music-context";
import { EncyclopediaProvider } from "@/components/encyclopedia-context";
import { DiscordAuthListener } from "@/components/discord-auth";
import { GameMusicFloatingPlayer } from "@/components/game-music-player";
import { AutopilotGate } from "@/components/autopilot-gate";
import { useIsAdmin } from "@/lib/admin-token";
import { useToast } from "@/hooks/use-toast";
import GameAppearance from "@/pages/game-appearance";
import RegionControl from "@/pages/region-control";
import WorldMap from "@/pages/world-map";
import GameHome from "@/pages/game-home";
import GameNews from "@/pages/game-news";
import GameMilitary from "@/pages/game-military";
import GameMissile from "@/pages/game-missile";
import GameWarRoom from "@/pages/game-war-room";
import GameTech from "@/pages/game-tech";
import GameTechnology from "@/pages/game-technology";
import GameDiplomacy from "@/pages/game-diplomacy";
import GameMap from "@/pages/game-map";
import GameEconomy from "@/pages/game-economy";
import GameSuperEvents from "@/pages/game-super-events";
import SuperEvents from "@/pages/super-events";
import NpcNations from "@/pages/npc-nations";
import GamePolitics from "@/pages/game-politics";
import GameParliament from "@/pages/game-parliament";
import GameCabinet from "@/pages/game-cabinet";
import PoliticsSettings from "@/pages/politics-settings";
import TurnSettings from "@/pages/turn-settings";
import CampaignManagement from "@/pages/campaign-management";
import CampaignDetail from "@/pages/campaign-detail";
import WarManagement from "@/pages/war-management";
import AccountBans from "@/pages/account-bans";
import GiftResources from "@/pages/gift-resources";
import DomesticEventsAdmin from "@/pages/domestic-events-admin";
import WorldSim from "@/pages/world-sim";
import TerritoryHistory from "@/pages/territory-history";
import PoliticalNotes from "@/pages/political-notes";
import DataReset from "@/pages/data-reset";
import GameBalance from "@/pages/game-balance";
import TechTreeAdmin from "@/pages/tech-tree-admin";
import AiUsage from "@/pages/ai-usage";
import AiRoutes from "@/pages/ai-routes";
import MilitaryAdmin from "@/pages/military-admin";
import NotFound from "@/pages/not-found";

function Router() {
  return (
    <DomesticEventGate>
    <Switch>
      {/* Full-screen game home — deliberately outside the news Layout. */}
      <Route path="/game">{() => <AutopilotGate><GameHome /></AutopilotGate>}</Route>
      <Route path="/game/military/war/:id">{() => <AutopilotGate><GameWarRoom /></AutopilotGate>}</Route>
      <Route path="/game/military/tech">{() => <AutopilotGate><GameTech /></AutopilotGate>}</Route>
      <Route path="/game/military">{() => <AutopilotGate><GameMilitary /></AutopilotGate>}</Route>
      <Route path="/game/missile">{() => <AutopilotGate><GameMissile /></AutopilotGate>}</Route>
      <Route path="/game/technology">{() => <AutopilotGate><GameTechnology /></AutopilotGate>}</Route>
      <Route path="/game/diplomacy">{() => <AutopilotGate><GameDiplomacy /></AutopilotGate>}</Route>
      <Route path="/game/politics">{() => <AutopilotGate><GamePolitics /></AutopilotGate>}</Route>
      <Route path="/game/parliament">{() => <AutopilotGate><GameParliament /></AutopilotGate>}</Route>
      <Route path="/game/cabinet">{() => <AutopilotGate><GameCabinet /></AutopilotGate>}</Route>
      <Route path="/game/economy">{() => <AutopilotGate><GameEconomy /></AutopilotGate>}</Route>
      <Route path="/game/super-events">{() => <AutopilotGate><GameSuperEvents /></AutopilotGate>}</Route>
      <Route path="/game/map">{() => <AutopilotGate><GameMap /></AutopilotGate>}</Route>
      <Route path="/game/news">{() => <AutopilotGate><GameNews /></AutopilotGate>}</Route>
      <Route path="/">{() => <Redirect to="/game" />}</Route>
      <Route>{() => <SiteRoutes />}</Route>
    </Switch>
    </DomesticEventGate>
  );
}

function SiteRoutes() {
  return (
    <Layout>
      <Switch>
        <Route path="/world-map">
          {() => <WorldMapGate />}
        </Route>
        <Route path="/game-appearance">
          {() => <AdminOnly><GameAppearance /></AdminOnly>}
        </Route>
        <Route path="/region-control">
          {() => <AdminOnly><RegionControl /></AdminOnly>}
        </Route>
        <Route path="/npc-nations">
          {() => <AdminOnly><NpcNations /></AdminOnly>}
        </Route>
        <Route path="/territory-history">
          {() => <AdminOnly><TerritoryHistory /></AdminOnly>}
        </Route>
        <Route path="/super-events">
          {() => <AdminOnly><SuperEvents /></AdminOnly>}
        </Route>
        <Route path="/politics-settings">
          {() => <AdminOnly><PoliticsSettings /></AdminOnly>}
        </Route>
        <Route path="/turn-settings">
          {() => <AdminOnly><TurnSettings /></AdminOnly>}
        </Route>
        <Route path="/campaign-management/:id">
          {() => <AdminOnly><CampaignDetail /></AdminOnly>}
        </Route>
        <Route path="/campaign-management">
          {() => <AdminOnly><CampaignManagement /></AdminOnly>}
        </Route>
        <Route path="/war-management">
          {() => <AdminOnly><WarManagement /></AdminOnly>}
        </Route>
        <Route path="/account-bans">
          {() => <AdminOnly><AccountBans /></AdminOnly>}
        </Route>
        <Route path="/gift-resources">
          {() => <AdminOnly><GiftResources /></AdminOnly>}
        </Route>
        <Route path="/domestic-events">
          {() => <AdminOnly><DomesticEventsAdmin /></AdminOnly>}
        </Route>
        <Route path="/world-sim">
          {() => <AdminOnly><WorldSim /></AdminOnly>}
        </Route>
        <Route path="/political-notes">
          {() => <AdminOnly><PoliticalNotes /></AdminOnly>}
        </Route>
        <Route path="/data-reset">
          {() => <AdminOnly><DataReset /></AdminOnly>}
        </Route>
        <Route path="/game-balance">
          {() => <AdminOnly><GameBalance /></AdminOnly>}
        </Route>
        <Route path="/tech-tree-admin">
          {() => <AdminOnly><TechTreeAdmin /></AdminOnly>}
        </Route>
        <Route path="/ai-usage">
          {() => <AdminOnly><AiUsage /></AdminOnly>}
        </Route>
<Route path="/ai-routes">
          {() => <AdminOnly><AiRoutes /></AdminOnly>}
        </Route>
        <Route path="/military-admin">
          {() => <AdminOnly><MilitaryAdmin /></AdminOnly>}
        </Route>
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

/** 管理端世界地圖：非管理員導向遊戲內的世界地圖子頁。 */
function WorldMapGate() {
  const isAdmin = useIsAdmin();
  if (!isAdmin) return <Redirect to="/game/map" />;
  return <WorldMap />;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  React.useEffect(() => {
    if (!isAdmin) {
      toast({
        title: "此頁僅限管理員",
        description: "已自動帶你回首頁。如需編輯權限，請從側邊欄底部的鎖頭登入。",
      });
    }
  }, [isAdmin, toast]);
  if (!isAdmin) return <Redirect to="/game" />;
  return <>{children}</>;
}

/**
 * 依「當前登入的 Discord 使用者」隔離持久化快取。偵測到換人登入、登出或
 * 無 session 時，清掉前一位使用者殘留在本機與記憶體的遊戲資料，確保不同帳號
 * 之間不會看到彼此的資料。渲染 null。
 */
function CacheUserGuard() {
  const client = useQueryClient();
  const { data: me, isSuccess } = useCurrentUser();

  React.useEffect(() => {
    // 只在 current-user 查詢成功回應後才處理；網路錯誤時保留現有快取。
    if (!isSuccess) return;
    const currentId = me?.authenticated ? (me.user?.discordUserId ?? null) : null;
    const marker = getCacheUserMarker();
    if (marker === currentId) return;

    // 身分不一致：清掉除了 current-user 以外的所有查詢（前一位使用者的資料），
    // 並移除本機持久化快取，再更新標記。current-user 本身保留以避免重抓迴圈。
    const meKey = JSON.stringify(getGetCurrentUserQueryKey());
    client.removeQueries({
      predicate: (q) => JSON.stringify(q.queryKey) !== meKey,
    });
    clearPersistedQueryCache();
    setCacheUserMarker(currentId);
  }, [client, me, isSuccess]);

  return null;
}

function App() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister!,
        maxAge: PERSIST_MAX_AGE,
        buster: CACHE_BUSTER,
        dehydrateOptions: {
          // 只持久化成功的查詢；錯誤 / 進行中的查詢不寫入本機。
          // 國內事件是「待處理的強制彈窗」:若從 localStorage 還原舊快取,
          // 重新整理時會先閃出已經處理過的事件(再點就是 409)。一律不持久化,永遠讀伺服器最新狀態。
          shouldDehydrateQuery: (query) =>
            query.state.status === "success" && query.queryKey[0] !== "domestic-events",
        },
      }}
    >
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppErrorBoundary>
            <DiscordAuthListener />
            <CacheUserGuard />
            <GameMusicProvider>
              <EncyclopediaProvider>
                <Router />
                <GameMusicFloatingPlayer />
              </EncyclopediaProvider>
            </GameMusicProvider>
          </AppErrorBoundary>
        </WouterRouter>
        <Toaster />
        {/* 開場動畫：蓋在整個 App 之上，點按可跳過；遊戲在底下照常載入。 */}
        <IntroSplash />
      </TooltipProvider>
    </PersistQueryClientProvider>
  );
}

export default App;
