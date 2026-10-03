import { Link } from "wouter";
import { ArrowLeft, Map as MapIcon } from "lucide-react";
import type { MilitaryOverview } from "@workspace/api-client-react";
import { MilitaryPageGuard, ResourceBar } from "@/components/military-shared";
import { GameNotifications } from "@/components/game-notifications";
import { WorldMapExplorer } from "@/pages/world-map";

export default function GameMap() {
  return (
    <MilitaryPageGuard
      pageTitle="世界地圖"
      loginDescription="請先以 Discord 登入，才能查看世界地圖。"
      render={(overview, bg) => <MapScreen bg={bg} overview={overview} />}
    />
  );
}

function MapScreen({ bg, overview }: { bg: string; overview: MilitaryOverview }) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center text-white"
      style={{ backgroundImage: `url(${bg})` }}
      data-testid="page-game-map"
    >
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/65 via-black/45 to-black/70" />

      <div className="relative mx-auto flex min-h-full max-w-6xl flex-col px-3 pb-10 md:px-6">
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
              <MapIcon className="h-5 w-5 text-emerald-300" />
              <span className="font-serif text-base font-bold md:text-lg">世界地圖</span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-white/70">
                {overview.currentEraLabel}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden lg:block">
              <ResourceBar resources={overview.resources} />
            </div>
            <GameNotifications />
          </div>
        </header>

        {/* 地圖內容：淺色面板，沿用儀表板版世界地圖 */}
        <div className="rounded-2xl border border-white/15 bg-background p-4 text-foreground shadow-2xl md:p-6">
          <WorldMapExplorer linkNationsToDiplomacy enableCityRename />
        </div>
      </div>
    </div>
  );
}
