import React from "react";
import {
  ArrowLeft,
  Bot,
  Coins,
  Factory,
  FlaskConical,
  UserRound,
  Users,
} from "lucide-react";
import type { DiplomacyNation } from "@workspace/api-client-react";
import { discordAvatarUrl } from "@/lib/current-user";
import { formatBigNumber } from "@/components/military-shared";

export interface NationResources {
  techPoints: number;
  production: number;
  population: number;
  money: number;
}

export function ResourceBar({ resources }: { resources: NationResources }) {
  const stats = [
    {
      key: "tech",
      label: "科技點數",
      icon: FlaskConical,
      iconClass: "text-sky-300",
      value: formatBigNumber(resources.techPoints),
    },
    {
      key: "production",
      label: "生產力",
      icon: Factory,
      iconClass: "text-orange-300",
      value: formatBigNumber(resources.production),
    },
    {
      key: "population",
      label: "人口",
      icon: Users,
      iconClass: "text-emerald-300",
      value: formatBigNumber(resources.population),
    },
    {
      key: "money",
      label: "金錢",
      icon: Coins,
      iconClass: "text-yellow-300",
      value: formatBigNumber(resources.money),
    },
  ];
  return (
    <div
      className="hidden items-center gap-2 lg:flex"
      data-testid="diplomacy-stats-bar"
    >
      {stats.map((s) => (
        <div
          key={s.key}
          className="flex items-center gap-2 rounded-lg border border-white/15 bg-black/50 px-2.5 py-1 backdrop-blur"
          data-testid={`diplomacy-stat-${s.key}`}
        >
          <s.icon className={`h-3.5 w-3.5 shrink-0 ${s.iconClass}`} />
          <div className="min-w-0 leading-tight">
            <div className="text-[9px] text-white/60">{s.label}</div>
            <div className="text-xs font-bold tabular-nums">{s.value}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function relationTone(score: number): string {
  if (score >= 30) return "text-emerald-300";
  if (score <= -30) return "text-red-300";
  if (score < 0) return "text-orange-300";
  return "text-white/70";
}

export function Shell({ bg, children }: { bg: string; children: React.ReactNode }) {
  return (
    <div
      className="relative flex h-dvh flex-col overflow-hidden bg-slate-900 bg-cover bg-center text-white"
      style={{ backgroundImage: `url(${bg})` }}
    >
      <div className="absolute inset-0 bg-black/45" />
      <div className="relative z-10 flex h-full flex-col">{children}</div>
    </div>
  );
}

export function EmptyPane() {
  return (
    <div className="hidden h-full items-center justify-center md:flex">
      <div className="rounded-xl bg-black/50 px-6 py-4 text-sm text-white/60 backdrop-blur">
        從左側選擇一個國家開始外交
      </div>
    </div>
  );
}

export function NationAvatar({ nation }: { nation: DiplomacyNation }) {
  const avatar =
    nation.ownerDiscordUserId && nation.ownerAvatar
      ? discordAvatarUrl(nation.ownerDiscordUserId, nation.ownerAvatar)
      : null;
  if (nation.flagUrl) {
    return (
      <img
        src={nation.flagUrl}
        alt=""
        className="h-9 w-9 shrink-0 rounded-md border border-white/20 object-cover"
      />
    );
  }
  if (avatar) {
    return (
      <img
        src={avatar}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full border border-white/20 object-cover"
      />
    );
  }
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/15 bg-white/10">
      {nation.isNpc ? (
        <Bot className="h-4 w-4 text-white/50" />
      ) : (
        <UserRound className="h-4 w-4 text-white/50" />
      )}
    </div>
  );
}

export function PaneHeader({
  nation,
  onBackMobile,
  subtitle,
}: {
  nation: DiplomacyNation;
  onBackMobile: () => void;
  subtitle?: string;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-white/10 bg-black/50 px-4 py-2.5 backdrop-blur">
      <button
        onClick={onBackMobile}
        className="rounded-lg p-1.5 text-white/70 hover:bg-white/10 md:hidden"
        data-testid="button-back-list"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <NationAvatar nation={nation} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-bold">{nation.name}</span>
          {nation.isNpc && (
            <span className="rounded bg-purple-500/30 px-1 text-[10px] font-bold text-purple-200">
              NPC
            </span>
          )}
          {nation.atWar && (
            <span className="rounded bg-red-500/30 px-1 text-[10px] font-bold text-red-200">
              交戰中
            </span>
          )}
        </div>
        <div className="text-[11px] text-white/55">
          {nation.isNpc && nation.relationScore !== null && (
            <span className={relationTone(nation.relationScore)}>
              關係值 {nation.relationScore > 0 ? "+" : ""}
              {nation.relationScore}
            </span>
          )}
          {subtitle && (
            <span className={nation.isNpc ? "ml-2" : ""}>{subtitle}</span>
          )}
        </div>
      </div>
    </div>
  );
}
