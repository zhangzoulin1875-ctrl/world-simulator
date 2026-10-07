import { Link } from "wouter";
import { ArrowLeft, Landmark } from "lucide-react";
import { GameNotifications } from "@/components/game-notifications";
import { HelpButton } from "@/components/help-button";
import { ParliamentPanel } from "./parliament-panel";
import { ConstitutionPanel } from "./constitution-panel";

/**
 * 議會:獨立大分類(2026-10-07 自政治頁拆出)。
 * 目前內容 = 議場(席次/滿意度/政策要求/國情報告)+ 憲法。
 * 之後分頁:黨派經營、立法表決、選舉、國際政黨聯盟。
 */
export function ParliamentScreen({ bg }: { bg: string }) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-white"
      style={{ backgroundImage: `url(${bg})` }}
      data-testid="page-game-parliament"
    >
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/65 via-black/45 to-black/70" />
      <div className="relative mx-auto flex min-h-full max-w-6xl flex-col px-3 pb-10 md:px-6">
        <header className="relative flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between md:py-4">
          <HelpButton helpKey="parliament" />
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
              <span className="font-serif text-base font-bold md:text-lg">議會</span>
            </div>
          </div>
          <GameNotifications />
        </header>

        <ParliamentPanel />
        <ConstitutionPanel />
      </div>
    </div>
  );
}
