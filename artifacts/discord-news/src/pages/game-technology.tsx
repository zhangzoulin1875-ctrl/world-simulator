import React, { useState, useEffect, useMemo, useRef } from "react";
import { Link, useSearch, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  FlaskConical,
  Landmark,
  Loader2,
  Factory,
  Star,
  Settings2,
  AlertCircle,
  XCircle,
} from "lucide-react";
import {
  useGetTechTreeOverview,
  getGetTechTreeOverviewQueryKey,
  useStartTechTreeResearch,
  useCancelTechTreeResearch,
  useSetTechTreeAllocation,
} from "@workspace/api-client-react";
import type {
  MilitaryOverview,
  TechTreeOverview,
  TechTreeDomainView,
  TechTreeNodeView,
  TechTreeActiveResearch,
  TechTreeAllocation,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  MilitaryPageGuard,
  ResourceBar,
  apiErrorMessage,
  formatBigNumber,
} from "@/components/military-shared";
import { GameNotifications } from "@/components/game-notifications";
import { HelpButton } from "@/components/help-button";
import { AllocationEditor } from "@/components/tech-tree/allocation-editor";
import { TechTreeView } from "@/components/tech-tree/tech-tree-view";

type TechTab = "military" | "social" | "production";

const TABS: { key: TechTab; label: string; icon: React.ElementType }[] = [
  { key: "social", label: "社會科技", icon: Landmark },
  { key: "production", label: "生產科技", icon: Factory },
  { key: "military", label: "軍事科技", icon: FlaskConical },
];

export default function GameTechnology() {
  return (
    <MilitaryPageGuard
      pageTitle="科技與研究"
      loginDescription="請先以 Discord 登入，才能規劃國家科技發展。"
      render={(overview, bg) => <TechnologyScreen bg={bg} militaryOverview={overview} />}
    />
  );
}

function TechnologyScreen({
  bg,
  militaryOverview,
}: {
  bg: string;
  militaryOverview: MilitaryOverview;
}) {
  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const urlTab = params.get("tab") as TechTab;
  const tab: TechTab = ["social", "production", "military"].includes(urlTab) ? urlTab : "social";

  const { data: techOverview, isLoading } = useGetTechTreeOverview({
    query: {
      queryKey: getGetTechTreeOverviewQueryKey(),
      staleTime: 1000 * 15,
    },
  });

  const handleTabChange = (newTab: TechTab) => {
    setLocation(`/game/technology?tab=${newTab}`);
  };

  const domainView = techOverview?.domains.find((d) => d.domain === tab);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center text-white"
      style={{ backgroundImage: `url(${bg})` }}
      data-testid="page-game-technology"
    >
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/80 via-black/70 to-black/90" />

      <div className="relative mx-auto flex min-h-full max-w-[1600px] flex-col px-4 pb-10 pt-4">
        <header className="relative flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between md:py-4">
          <HelpButton helpKey={`technology:${tab}`} />
          <div className="flex items-center gap-3">
            <Link
              href="/game"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-black/45 backdrop-blur transition hover:bg-black/70"
              title="回玩家首頁"
              data-testid="button-back-home"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-2.5 rounded-lg border border-white/15 bg-black/45 px-3 py-1.5 backdrop-blur shadow-lg">
              <FlaskConical className="h-5 w-5 text-sky-400" />
              <span className="font-serif text-base font-bold md:text-lg">
                國家科技樹
              </span>
              {domainView && (
                <span className="rounded bg-sky-900/40 px-2 py-0.5 text-xs text-sky-200 border border-sky-400/20">
                  {domainView.eraLabel}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-start gap-2">
            <GameNotifications />
            <ResourceBar resources={militaryOverview.resources} />
          </div>
        </header>

        {isLoading || !techOverview ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-4 text-white/50">
              <Loader2 className="h-8 w-8 animate-spin" />
              <p>載入科技庫中...</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-6">
            <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
              {/* Left Sidebar: Allocation & Active Research */}
              <div className="flex flex-col gap-4">
                <AllocationEditor
                  allocation={techOverview.allocation}
                  techGainPerTurn={techOverview.techGainPerTurn}
                  stockTechPoints={techOverview.stockTechPoints}
                />
                
                {domainView && (
                  <ActiveResearchPanel domainView={domainView} />
                )}
              </div>

              {/* Right Content: Tabs & Tree */}
              <div className="flex flex-col min-w-0">
                <div className="mb-4 flex gap-2 overflow-x-auto pb-2" data-testid="tabs-technology">
                  {TABS.map(({ key, label, icon: Icon }) => {
                    const isSelected = tab === key;
                    const domainData = techOverview.domains.find(d => d.domain === key);
                    const isResearching = !!domainData?.active;
                    
                    return (
                      <button
                        key={key}
                        onClick={() => handleTabChange(key)}
                        className={`flex min-w-max items-center gap-2 rounded-lg border px-5 py-2.5 text-sm font-semibold backdrop-blur transition-all ${
                          isSelected
                            ? "border-sky-400/50 bg-sky-900/40 text-sky-100 shadow-[0_0_15px_rgba(56,189,248,0.15)]"
                            : "border-white/10 bg-black/40 text-white/60 hover:bg-black/60 hover:text-white/80"
                        }`}
                        data-testid={`tab-${key}`}
                      >
                        <Icon className={`h-4 w-4 ${isSelected ? 'text-sky-400' : ''}`} />
                        {label}
                        {isResearching && (
                          <span className="ml-1 flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
                        )}
                      </button>
                    );
                  })}
                </div>

                {domainView && (
                  <div className="flex-1 rounded-xl border border-white/10 bg-black/40 shadow-2xl backdrop-blur-sm overflow-hidden flex flex-col min-h-[600px]">
                    <TechTreeView domainView={domainView} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ActiveResearchPanel({ domainView }: { domainView: TechTreeDomainView }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const cancelMutation = useCancelTechTreeResearch({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetTechTreeOverviewQueryKey() });
        toast({ title: "已取消研發", description: `已停止「${domainView.domainLabel}」的當前研究。` });
      },
      onError: (err) => {
        toast({ title: "取消失敗", description: apiErrorMessage(err), variant: "destructive" });
      }
    }
  });

  const active = domainView.active;

  if (!active) {
    return (
      <div className="rounded-xl border border-white/10 bg-black/40 p-5 backdrop-blur text-center">
        <FlaskConical className="mx-auto mb-3 h-8 w-8 text-white/20" />
        <h3 className="font-serif text-base font-bold text-white/60">無進行中的研究</h3>
        <p className="mt-1 text-xs text-white/40">
          在右側科技樹中選擇一項可用的科技來開始研發。
        </p>
      </div>
    );
  }

  const progressPct = Math.min(100, Math.max(0, (active.progressPoints / active.costSnapshot) * 100));

  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-5 backdrop-blur shadow-[0_0_20px_rgba(16,185,129,0.05)] relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/5 to-transparent pointer-events-none" />
      
      <div className="relative">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400/80 mb-1">
              當前研發項目
            </div>
            <h3 className="font-serif text-lg font-bold text-emerald-100 leading-tight">
              {active.name}
            </h3>
          </div>
          <button
            onClick={() => {
              if (window.confirm("確定要取消研發嗎？累積的進度將作廢。")) {
                cancelMutation.mutate({ data: { domain: domainView.domain } });
              }
            }}
            disabled={cancelMutation.isPending}
            className="rounded-full p-1.5 text-white/40 hover:bg-red-500/20 hover:text-red-400 transition"
            title="取消研發"
          >
            <XCircle className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-xs font-medium">
            <span className="text-emerald-200/80">
              {formatBigNumber(active.progressPoints)} / {formatBigNumber(active.costSnapshot)}
            </span>
            <span className="text-emerald-300">
              {progressPct.toFixed(1)}%
            </span>
          </div>
          
          <div className="h-2 overflow-hidden rounded-full bg-black/60 shadow-inner">
            <div 
              className="h-full bg-emerald-500 transition-all duration-1000 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>

          <div className="flex justify-between text-[11px] text-white/50 pt-1">
            <span>剩餘 {formatBigNumber(active.remainingPoints)} 點</span>
            <span>
              {active.estimatedTurns === null 
                ? "每回合產出不足" 
                : `約需 ${active.estimatedTurns} 回合`}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
