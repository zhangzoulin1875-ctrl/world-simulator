import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Globe2, Landmark } from "lucide-react";
import type { PoliticsOverview } from "@workspace/api-client-react";
import { GameNotifications } from "@/components/game-notifications";
import { HelpButton } from "@/components/help-button";
import { TopStats } from "./top-stats";
import { GovernmentPanel } from "./government-panel";
import { AdvisorSlotsPanel } from "./advisor-slots-panel";
import { PolicyPanel } from "./policy-panel";
import { MilitaryPanel } from "./military-panel";
import { MilitaryDemandCard } from "./military-demand-card";
import { FocusPanel } from "@/components/focus/focus-panel";
import { IntlOrgsPanel } from "./intl-orgs-panel";
import { PoliticsHistoryTimeline } from "./politics-history-timeline";

type PoliticsTab = "domestic" | "orgs";

/** 分頁記在網址 ?tab=orgs:可直接連結、重新整理不會掉回第一頁。 */
function readTab(): PoliticsTab {
  if (typeof window === "undefined") return "domestic";
  return new URLSearchParams(window.location.search).get("tab") === "orgs" ? "orgs" : "domestic";
}
function writeTab(tab: PoliticsTab) {
  const url = new URL(window.location.href);
  if (tab === "orgs") url.searchParams.set("tab", "orgs"); else url.searchParams.delete("tab");
  window.history.replaceState(null, "", url.toString());
}

const TABS: { id: PoliticsTab; label: string; Icon: typeof Landmark }[] = [
  { id: "domestic", label: "內政", Icon: Landmark },
  { id: "orgs", label: "國際組織", Icon: Globe2 },
];

export function PoliticsScreen({
  bg,
  overview,
}: {
  bg: string;
  overview: PoliticsOverview;
}) {
  const [tab, setTab] = useState<PoliticsTab>(readTab);
  const pick = (t: PoliticsTab) => { setTab(t); writeTab(t); };
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white"
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

        {/* 子頁分頁列 */}
        <nav className="mb-3 flex gap-2" role="tablist" aria-label="政治子頁" data-testid="tabs-politics">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => pick(id)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-1.5 text-sm font-semibold backdrop-blur transition ${
                tab === id ? "border-amber-300/60 bg-amber-400/20 text-amber-100" : "border-white/15 bg-black/40 text-white/65 hover:bg-white/10"
              }`}
              data-testid={`tab-politics-${id}`}
            >
              <Icon className="h-4 w-4" />{label}
            </button>
          ))}
        </nav>

        {tab === "orgs" ? (
          <IntlOrgsPanel />
        ) : (
          <>
          {/* 政府治理：政體＋政治註記＋支持度／接受度＋政府決策 */}
          <GovernmentPanel overview={overview} />

          {/* 國策樹:政體轉型與各項國策 */}
          <FocusPanel />

          <AdvisorSlotsPanel unlocked={overview.social.advisorSlotEnabled} />

          {/* Task #402 — 軍方面板 */}
          <MilitaryDemandCard />
          <MilitaryPanel overview={overview} />

          <PolicyPanel overview={overview} />

          {/* 政治歷史時間軸 */}
          <PoliticsHistoryTimeline />
          </>
        )}
      </div>
    </div>
  );
}
