import { Link } from "wouter";
import { ChevronRight, Clock, Loader2, Shield, Swords, Trophy } from "lucide-react";
import {
  useListWarCampaigns,
  getListWarCampaignsQueryKey,
} from "@workspace/api-client-react";
import type { WarCampaignListItem } from "@workspace/api-client-react";

export const END_REASON_LABELS: Record<string, string> = {
  territory: "領土陷落",
  ceasefire: "停戰協議",
  nation_removed: "國家消失",
  stalemate: "長期僵持",
  annihilation: "軍隊全滅",
};

/** 距離下次結算的倒數字串。 */
export function formatCountdown(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "即將結算";
  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小時後結算`;
  if (hours > 0) return `${hours} 小時 ${minutes} 分後結算`;
  return `${minutes} 分鐘後結算`;
}

function outcomeLabel(c: WarCampaignListItem): {
  text: string;
  tone: "win" | "loss" | "neutral";
} {
  if (!c.winnerNationId) {
    return { text: END_REASON_LABELS[c.endReason ?? ""] ?? "已結束", tone: "neutral" };
  }
  if (c.winnerNationId === c.opponentNationId) return { text: "敗北", tone: "loss" };
  return { text: "勝利", tone: "win" };
}

/** 指揮部分頁：戰役列表。 */
export function WarHqTab() {
  const { data, isLoading } = useListWarCampaigns({
    query: { queryKey: getListWarCampaignsQueryKey(), refetchInterval: 60_000 },
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center rounded-2xl border border-white/15 bg-black/55 p-12 backdrop-blur">
        <Loader2 className="h-6 w-6 animate-spin text-white/60" />
      </div>
    );
  }

  const campaigns = data?.campaigns ?? [];
  if (campaigns.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center rounded-2xl border border-white/15 bg-black/55 p-12 backdrop-blur"
        data-testid="panel-no-campaigns"
      >
        <div className="text-center">
          <Shield className="mx-auto mb-4 h-12 w-12 text-white/30" />
          <h2 className="mb-2 font-serif text-xl font-bold text-white/80">
            目前沒有戰役
          </h2>
          <p className="text-sm text-white/50">
            在「軍事指令」分頁對交戰中的敵國發起進攻，或等待敵軍來犯。
          </p>
        </div>
      </div>
    );
  }

  const active = campaigns.filter((c) => c.status === "active");
  const ended = campaigns.filter((c) => c.status !== "active");

  return (
    <div className="space-y-4">
      {active.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {active.map((c) => (
            <CampaignCard key={c.id} campaign={c} />
          ))}
        </div>
      )}
      {ended.length > 0 && (
        <div>
          <div className="mb-2 text-sm font-semibold text-white/60">已結束的戰役</div>
          <div className="grid gap-3 md:grid-cols-2">
            {ended.map((c) => (
              <CampaignCard key={c.id} campaign={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CampaignCard({ campaign: c }: { campaign: WarCampaignListItem }) {
  const isActive = c.status === "active";
  const outcome = isActive ? null : outcomeLabel(c);
  return (
    <Link
      href={`/game/military/war/${c.id}`}
      className={`group block rounded-xl border p-4 backdrop-blur transition ${
        isActive
          ? "border-red-400/40 bg-black/55 hover:border-red-300/60 hover:bg-black/70"
          : "border-white/12 bg-black/45 opacity-80 hover:opacity-100"
      }`}
      data-testid={`card-campaign-${c.id}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={`rounded px-2 py-0.5 text-xs font-bold ${
              c.role === "attacker"
                ? "bg-red-500/25 text-red-200"
                : "bg-blue-500/25 text-blue-200"
            }`}
          >
            {c.role === "attacker" ? "進攻方" : "防守方"}
          </span>
          {isActive ? (
            <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs font-bold text-emerald-200">
              進行中・第 {c.cycleNumber} 週期
            </span>
          ) : (
            <span
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs font-bold ${
                outcome!.tone === "win"
                  ? "bg-amber-500/25 text-amber-200"
                  : outcome!.tone === "loss"
                    ? "bg-zinc-500/25 text-zinc-300"
                    : "bg-white/10 text-white/60"
              }`}
            >
              {outcome!.tone === "win" && <Trophy className="h-3 w-3" />}
              {outcome!.text}
            </span>
          )}
        </div>
        <ChevronRight className="h-4 w-4 text-white/40 transition group-hover:translate-x-0.5 group-hover:text-white/70" />
      </div>

      <div className="mb-1 flex items-center gap-2 font-serif text-base font-bold">
        <Swords className="h-4 w-4 shrink-0 text-red-300" />
        <span>對 {c.opponentName} 的戰役</span>
      </div>
      <div className="flex items-center gap-1.5 text-sm text-white/65">
        <span>
          {c.attackerRegionName}
          <span className="mx-1 text-white/40">→</span>
          {c.defenderRegionName}
        </span>
        {c.isSeaLanding ? (
          <span
            className="inline-block rounded bg-sky-500/25 px-1.5 py-0.5 text-xs font-bold text-sky-200"
            data-testid={`badge-sea-landing-${c.id}`}
          >
            海上登陸
          </span>
        ) : null}
      </div>

      <div className="mt-2 flex items-center gap-1.5 text-xs text-white/50">
        <Clock className="h-3.5 w-3.5" />
        {isActive
          ? `${formatCountdown(c.nextResolveAt)}（每 ${c.cycleHours} 小時）`
          : c.endedAt
            ? `結束於 ${new Date(c.endedAt).toLocaleString("zh-TW")}`
            : "已結束"}
      </div>
    </Link>
  );
}
