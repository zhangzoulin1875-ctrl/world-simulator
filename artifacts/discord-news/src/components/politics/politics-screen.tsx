import { Link } from "wouter";
import { ArrowLeft, Landmark } from "lucide-react";
import type { PoliticsOverview } from "@workspace/api-client-react";
import { GameNotifications } from "@/components/game-notifications";
import { HelpButton } from "@/components/help-button";
import { TopStats } from "./top-stats";
import { GovernmentPanel } from "./government-panel";
import { AdvisorSlotsPanel } from "./advisor-slots-panel";
import { PolicyPanel } from "./policy-panel";
import { MilitaryPanel } from "./military-panel";
import { MilitaryDemandCard } from "./military-demand-card";
import { ParliamentPanel } from "@/components/parliament/parliament-panel";
import { PoliticsHistoryTimeline } from "./politics-history-timeline";

export function PoliticsScreen({
  bg,
  overview,
}: {
  bg: string;
  overview: PoliticsOverview;
}) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center text-white"
      style={{ backgroundImage: `url(${bg})` }}
      data-testid="page-game-politics"
    >
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/65 via-black/45 to-black/70" />

      <div className="relative mx-auto flex min-h-full max-w-6xl flex-col px-3 pb-10 md:px-6">
        {/* header */}
        <header className="relative flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between md:py-4">
          <HelpButton helpKey="politics" />
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
              <Landmark className="h-5 w-5 text-amber-300" />
              <span className="font-serif text-base font-bold md:text-lg">
                政治介面
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <GameNotifications />
            <TopStats overview={overview} />
          </div>
        </header>

        {/* 政府治理：政體＋政治註記＋支持度／接受度＋政府決策 */}
        <GovernmentPanel overview={overview} />

        <AdvisorSlotsPanel unlocked={overview.social.advisorSlotEnabled} />

        {/* Task #402 — 軍方面板 */}
        <ParliamentPanel />
        <MilitaryDemandCard />
        <MilitaryPanel overview={overview} />

        <PolicyPanel overview={overview} />

        {/* 政治歷史時間軸 */}
        <PoliticsHistoryTimeline />
      </div>
    </div>
  );
}
