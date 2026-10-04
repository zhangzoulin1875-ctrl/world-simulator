import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Link,
  useSearch,
  useLocation,
} from "wouter";
import {
  ArrowLeft,
  FlaskConical,
  Landmark,
  Loader2,
  Factory,
} from "lucide-react";
import {
  useGetTechTreeOverview,
  getGetTechTreeOverviewQueryKey,
} from "@workspace/api-client-react";
import type {
  MilitaryOverview,
} from "@workspace/api-client-react";
import {
  MilitaryPageGuard,
  ResourceBar,
  formatBigNumber,
} from "@/components/military-shared";
import {
  GameNotifications,
} from "@/components/game-notifications";
import {
  HelpButton,
} from "@/components/help-button";
import {
  EraUnlockList,
} from "@/components/tech-tree/era-unlock-list";

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
              {/* Left Sidebar: 規則說明 */}
              <div className="flex flex-col gap-4">
                <div className="rounded-xl border border-sky-400/20 bg-sky-950/20 p-5 backdrop-blur">
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-sky-300/80">
                    科技規則
                  </div>
                  <p className="text-sm leading-relaxed text-white/80">
                    關鍵技術不再需要研發,世界進入對應年代時會自動解鎖。
                  </p>
                  <p className="mt-2 text-xs leading-relaxed text-white/50">
                    兵種、政體、建築與各項加成都依此解鎖。國家發展方向將由之後的國策系統決定。
                  </p>
                  {techOverview.stockTechPoints > 0 && (
                    <p className="mt-3 border-t border-white/10 pt-3 text-xs text-white/50">
                      庫存科技點 {formatBigNumber(techOverview.stockTechPoints)}(先保留,國策系統上線後使用)
                    </p>
                  )}
                </div>
              </div>

              {/* Right Content: Tabs & Tree */}
              <div className="flex flex-col min-w-0">
                <div className="mb-4 flex gap-2 overflow-x-auto pb-2" data-testid="tabs-technology">
                  {TABS.map(({ key, label, icon: Icon }) => {
                    const isSelected = tab === key;
                    
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
                      </button>
                    );
                  })}
                </div>

                {domainView && (
                  <div className="flex-1 rounded-xl border border-white/10 bg-black/40 shadow-2xl backdrop-blur-sm overflow-hidden flex flex-col min-h-[600px]">
                    <EraUnlockList domainView={domainView} />
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

