import React, { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Loader2, Sparkles } from "lucide-react";
import {
  getGetPlayerNationQueryKey,
  getGetMilitaryOverviewQueryKey,
  useDesignMilitaryUnit,
} from "@workspace/api-client-react";
import type { MilitaryOverview } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  MilitaryPageGuard,
  ResourceBar,
  apiErrorMessage,
} from "@/components/military-shared";
import { GameNotifications } from "@/components/game-notifications";

export default function GameTech() {
  return (
    <MilitaryPageGuard
      pageTitle="兵種設計"
      loginDescription="請先以 Discord 登入，才能進行 AI 自訂兵種設計。"
      render={(overview, bg) => <DesignScreen bg={bg} overview={overview} />}
    />
  );
}

function DesignScreen({
  bg,
  overview,
}: {
  bg: string;
  overview: MilitaryOverview;
}) {
  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center text-white"
      style={{ backgroundImage: `url(${bg})` }}
      data-testid="page-game-tech"
    >
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/65 via-black/45 to-black/70" />

      <div className="relative mx-auto flex min-h-full max-w-6xl flex-col px-3 pb-10 md:px-6">
        <header className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between md:py-4">
          <div className="flex items-center gap-3">
            <Link
              href="/game/military"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-black/45 backdrop-blur transition hover:bg-black/70"
              title="回軍事介面"
              data-testid="button-back-military"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-2.5 rounded-lg border border-white/15 bg-black/45 px-3 py-1.5 backdrop-blur">
              <Sparkles className="h-5 w-5 text-purple-300" />
              <span className="font-serif text-base font-bold md:text-lg">
                兵種設計
              </span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-white/70">
                {overview.currentEraLabel}
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <GameNotifications />
            <ResourceBar resources={overview.resources} />
          </div>
        </header>

        <div className="space-y-6">
          <DesignSection overview={overview} />
        </div>
      </div>
    </div>
  );
}

// ── AI 自訂兵種 ───────────────────────────────────────────────

function DesignSection({ overview }: { overview: MilitaryOverview }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const unlockedCategories = overview.categories.filter((c) => c.unlocked);
  const [category, setCategory] = useState(unlockedCategories[0]?.slug ?? "infantry");
  const [requirement, setRequirement] = useState("");

  const designMutation = useDesignMilitaryUnit({
    mutation: {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getGetMilitaryOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
        setRequirement("");
        toast({
          title: "兵種設計完成",
          description: `新兵種「${res.template.name}」已加入你的兵種清單`,
        });
      },
      onError: (err) =>
        toast({ title: "設計失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });

  const selectedInfo = overview.categories.find((c) => c.slug === category);
  const atCap = (selectedInfo?.customCount ?? 0) >= overview.customUnitLimit;

  // Task #584 — 政變後政策封鎖：> 0 時鎖定兵種設計。
  const coupLockTurns = overview.coupPolicyLockTurns;

  const canSubmit =
    requirement.trim().length > 0 &&
    requirement.trim().length <= 500 &&
    !designMutation.isPending &&
    !atCap &&
    coupLockTurns === 0 &&
    overview.unitDesignCharges >= 1;

  return (
    <section
      className="rounded-xl border border-purple-300/25 bg-black/55 p-4 backdrop-blur"
      data-testid="section-design"
    >
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-purple-300" />
        <h2 className="font-serif text-lg font-bold">AI 自訂兵種設計</h2>
        <span
          className="rounded bg-sky-500/20 px-2 py-0.5 text-xs text-sky-200"
          data-testid="text-design-charges"
        >
          剩餘設計次數 {overview.unitDesignCharges}/{overview.unitDesignChargeCap}
        </span>
      </div>
      <p className="mb-3 text-xs text-white/60">
        描述你想要的兵種，AI 會依當前時代（{overview.currentEraLabel}
        ）設計出數值與成本平衡的專屬兵種。越強的兵種成本越高。每個類別最多{" "}
        {overview.customUnitLimit} 個自創兵種。設計完成後，可在「建造軍隊」分頁的兵種卡片上改名、解散或刪除。
      </p>
      <div className="flex flex-col gap-2 md:flex-row md:items-start">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-white/20 bg-black/50 px-3 py-2 text-sm outline-none focus:border-purple-300/60 md:w-48"
          data-testid="select-design-category"
        >
          {unlockedCategories.map((c) => (
            <option key={c.slug} value={c.slug} className="bg-zinc-900">
              {c.label}（{c.customCount}/{overview.customUnitLimit}）
            </option>
          ))}
        </select>
        <textarea
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="例：一支擅長山地作戰的精銳重步兵，犧牲速度換取超高防禦……"
          className="flex-1 rounded-lg border border-white/20 bg-black/50 px-3 py-2 text-sm outline-none focus:border-purple-300/60"
          data-testid="input-design-requirement"
        />
        <button
          onClick={() =>
            designMutation.mutate({
              data: { category, requirement: requirement.trim() },
            })
          }
          disabled={!canSubmit}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-purple-600/80 px-4 py-2 text-sm font-semibold transition hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="button-design-unit"
        >
          {designMutation.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              AI 設計中…
            </>
          ) : (
            "開始設計"
          )}
        </button>
      </div>
      {atCap && (
        <p className="mt-2 text-xs text-red-300/80" data-testid="text-design-cap">
          {selectedInfo?.label}的自創兵種已達上限（{overview.customUnitLimit}{" "}
          個），請先刪除既有自創兵種再設計新的。
        </p>
      )}
      {overview.unitDesignCharges < 1 && (
        <p className="mt-2 text-xs text-red-300/80" data-testid="text-design-no-charges">
          設計次數已用完（每回合恢復 1 次，上限 {overview.unitDesignChargeCap} 次）。
        </p>
      )}
      {coupLockTurns > 0 && (
        <p className="mt-2 text-xs text-red-300/80" data-testid="text-design-coup-lock">
          政變後政局動盪，暫時無法設計兵種（剩餘 {coupLockTurns} 回合）。
        </p>
      )}
    </section>
  );
}
