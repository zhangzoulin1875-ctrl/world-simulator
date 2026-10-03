import React from "react";
import { Link, useLocation } from "wouter";
import {
  Activity,
  AlertTriangle,
  RefreshCw,
  Globe2,
  Map,
  Crown,
  Sparkles,
  Bot,
  Siren,
  Landmark,
  Hourglass,
  Swords,
  Wand2,
  Scale,
  FlaskConical,
  History,
  ScrollText,
  Ban,
  Gift,
  Flag,
  Trash2,
  Shield,
} from "lucide-react";
import {
  getGetBotStatusQueryKey,
  useGetBotStatus,
  useRestartBot,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

import { 
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarTrigger
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { TokenSetup } from "./token-setup";
import { AdminTokenSetup } from "./admin-token-setup";
import { AdminGate } from "./admin-gate";
import { DiscordAuthPanel } from "./discord-auth";
import { useIsAdmin } from "@/lib/admin-token";
import { AiQueueBadge } from "./ai-queue-badge";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      <div className="flex min-h-[100dvh] w-full bg-background">
        <AppSidebar />
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <header className="md:hidden sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-3 py-2">
            <SidebarTrigger className="h-9 w-9" />
            <div className="flex items-center gap-2 min-w-0">
              <div className="bg-primary text-primary-foreground p-1.5 rounded-md">
                <Globe2 className="w-4 h-4" />
              </div>
              <span className="font-serif font-bold truncate">架空世界模擬器</span>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 md:py-8 lg:px-12">
            <div className="max-w-5xl mx-auto w-full">
              {children}
            </div>
          </div>
        </main>
      </div>
      <AiQueueBadge />
    </SidebarProvider>
  );
}

function AppSidebar() {
  const [location] = useLocation();
  const isAdmin = useIsAdmin();

  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: status, isLoading: loadingStatus, isFetching: fetchingStatus } = useGetBotStatus({
    query: {
      enabled: isAdmin,
      queryKey: getGetBotStatusQueryKey(),
      refetchInterval: isAdmin ? 15_000 : false,
      refetchOnWindowFocus: isAdmin,
    },
  });
  const restartMutation = useRestartBot({
    mutation: {
      onSuccess: () => {
        toast({ title: "Bot 已重新啟動" });
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      },
      onError: (err) => {
        const message =
          (err as { data?: { error?: string } })?.data?.error ??
          (err instanceof Error ? err.message : "重新啟動失敗");
        toast({ variant: "destructive", title: "重新啟動失敗", description: message });
      },
    },
  });
  const restarting = restartMutation.isPending;
  const refreshing = fetchingStatus || restarting;
  const handleRefresh = async () => {
    await queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
    if (status && status.connected === false && status.hasToken) {
      restartMutation.mutate();
    }
  };

  const isActive = (path: string) => {
    if (path === "/") return location === "/";
    return location.startsWith(path);
  };

  return (
    <Sidebar>
      <SidebarHeader className="pt-6 pb-4 px-4">
        <div className="flex items-center gap-3">
          <div className="bg-primary text-primary-foreground p-2 rounded-md">
            <Globe2 className="w-5 h-5" />
          </div>
          <div className="flex flex-col">
            <h1 className="font-serif font-bold text-lg leading-tight">架空世界模擬器</h1>
            <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">管理控制台</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>遊戲</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={isActive("/game")}>
                <Link href="/game">
                  <Crown className="w-4 h-4" />
                  <span>玩家首頁</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {isAdmin && (
          <SidebarGroup>
            <SidebarGroupLabel>管理</SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/world-map")}>
                  <Link href="/world-map">
                    <Map className="w-4 h-4" />
                    <span>世界地圖</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/game-appearance")}>
                  <Link href="/game-appearance">
                    <Sparkles className="w-4 h-4" />
                    <span>遊戲外觀</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/region-control")}>
                  <Link href="/region-control">
                    <Globe2 className="w-4 h-4" />
                    <span>地區歸屬管理</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/npc-nations")}>
                  <Link href="/npc-nations">
                    <Bot className="w-4 h-4" />
                    <span>國家管理</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/military-admin")}>
                  <Link href="/military-admin">
                    <Shield className="w-4 h-4" />
                    <span>軍事管理</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  isActive={isActive("/territory-history")}
                >
                  <Link href="/territory-history">
                    <History className="w-4 h-4" />
                    <span>領土變化歷史</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/super-events")}>
                  <Link href="/super-events">
                    <Siren className="w-4 h-4" />
                    <span>超事件管理</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/political-notes")}>
                  <Link href="/political-notes">
                    <ScrollText className="w-4 h-4" />
                    <span>政治註記總覽</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/turn-settings")}>
                  <Link href="/turn-settings">
                    <Hourglass className="w-4 h-4" />
                    <span>回合設定</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/war-management")}>
                  <Link href="/war-management">
                    <Flag className="w-4 h-4" />
                    <span>戰爭管理</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/campaign-management")}>
                  <Link href="/campaign-management">
                    <Swords className="w-4 h-4" />
                    <span>戰役管理</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/world-sim")}>
                  <Link href="/world-sim">
                    <Wand2 className="w-4 h-4" />
                    <span>AI 世界模擬</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/game-balance")}>
                  <Link href="/game-balance">
                    <Scale className="w-4 h-4" />
                    <span>遊戲平衡</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/tech-tree-admin")}>
                  <Link href="/tech-tree-admin">
                    <FlaskConical className="w-4 h-4" />
                    <span>科技樹編輯器</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/ai-usage")}>
                  <Link href="/ai-usage">
                    <Activity className="w-4 h-4" />
                    <span>AI 用量與限額</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/gift-resources")}>
                  <Link href="/gift-resources">
                    <Gift className="w-4 h-4" />
                    <span>發放資源</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/account-bans")}>
                  <Link href="/account-bans">
                    <Ban className="w-4 h-4" />
                    <span>封禁帳號</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/politics-settings")}>
                  <Link href="/politics-settings">
                    <Landmark className="w-4 h-4" />
                    <span>內政參數</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={isActive("/data-reset")}>
                  <Link href="/data-reset">
                    <Trash2 className="w-4 h-4" />
                    <span>資料重置</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
        )}

        <div className="px-4 mt-auto space-y-4 pb-6">
          {isAdmin && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Bot 狀態</h4>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleRefresh}
                disabled={refreshing}
                aria-label={
                  status && status.connected === false && status.hasToken
                    ? "重新啟動 Bot"
                    : "刷新 Bot 狀態"
                }
                title={
                  status && status.connected === false && status.hasToken
                    ? "重新啟動 Bot"
                    : "刷新 Bot 狀態"
                }
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
              </Button>
            </div>
            {loadingStatus ? (
              <Skeleton className="h-16 w-full" />
            ) : status ? (
              <div className={`p-3 rounded-md border ${status.connected ? 'bg-secondary/50 border-border' : 'bg-destructive/10 border-destructive/20 text-destructive-foreground'}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Activity className={`w-4 h-4 ${status.connected ? 'text-primary' : 'text-destructive'}`} />
                    <span className={`text-sm font-medium ${status.connected ? 'text-foreground' : 'text-destructive'}`}>
                      {status.connected ? '已連線' : '已斷線'}
                    </span>
                  </div>
                  {status.connected && (
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                    </span>
                  )}
                </div>
                {!status.connected && (
                  <p className="text-xs text-destructive opacity-80 mb-2">
                    Bot 目前離線，暫時無法發送通知。
                  </p>
                )}
                <div className="grid grid-cols-1 gap-2 text-xs text-muted-foreground">
                  <div className="flex flex-col">
                    <span className="font-semibold text-foreground">{status.guildCount}</span>
                    <span>伺服器</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <span className="text-xs text-destructive font-medium">無法載入狀態</span>
              </div>
            )}
            {status && <TokenSetup hasToken={status.hasToken ?? false} />}
            <AdminTokenSetup />
          </div>
          )}

          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">伺服器管理員</h4>
            <DiscordAuthPanel />
          </div>

          <div className="flex justify-end pt-1">
            <AdminGate />
          </div>
        </div>
      </SidebarContent>
    </Sidebar>
  );
}
