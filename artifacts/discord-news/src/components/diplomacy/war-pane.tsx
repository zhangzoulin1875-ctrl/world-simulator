import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Flame, Loader2, Swords } from "lucide-react";
import {
  useListDiplomacyWars,
  getListDiplomacyWarsQueryKey,
  useDeclareDiplomacyWar,
  getListDiplomacyNationsQueryKey,
} from "@workspace/api-client-react";
import type { DiplomacyNation } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";
import { PaneHeader } from "./shared";

export function WarPane({
  selected,
  onBackMobile,
}: {
  selected: DiplomacyNation | null;
  onBackMobile: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  const { data, isLoading } = useListDiplomacyWars({
    query: {
      queryKey: getListDiplomacyWarsQueryKey(),
      refetchInterval: 20_000,
    },
  });
  const wars = data?.wars ?? [];

  const declare = useDeclareDiplomacyWar({
    mutation: {
      onSuccess: (r) => {
        setConfirming(false);
        const joined = r.autoJoined ?? [];
        toast({
          title: `已對 ${r.targetName} 宣戰`,
          description:
            joined.length > 0
              ? `兩國進入交戰狀態。${joined.map((j) => j.name).join("、")} 因保障獨立條約自動參戰！`
              : "兩國進入交戰狀態。",
        });
        void queryClient.invalidateQueries({
          queryKey: getListDiplomacyWarsQueryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: getListDiplomacyNationsQueryKey(),
        });
      },
      onError: (err) => {
        setConfirming(false);
        toast({ title: "宣戰失敗", description: apiErrorMessage(err) });
      },
    },
  });

  // NPC 需關係值 < 0 才能宣戰；玩家↔玩家可直接宣戰（伺服器仍會擋互不侵犯／同盟／同盟友）。
  const npcBlocked =
    selected !== null &&
    selected.isNpc &&
    (selected.relationScore === null || selected.relationScore >= 0);
  const canDeclare =
    selected !== null && !selected.atWar && !npcBlocked;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selected ? (
        <PaneHeader nation={selected} onBackMobile={onBackMobile} />
      ) : (
        <div className="border-b border-white/10 bg-black/50 px-4 py-3 text-sm font-bold backdrop-blur">
          <Swords className="mr-1.5 inline h-4 w-4 text-red-300" />
          交戰情勢
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {selected && (
          <section className="rounded-xl border border-red-400/25 bg-black/50 p-4 backdrop-blur">
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-bold">
              <Flame className="h-4 w-4 text-red-300" />
              對 {selected.name} 宣戰
            </h3>
            {selected.atWar ? (
              <p className="text-sm text-red-200">已與該國處於交戰狀態。</p>
            ) : npcBlocked ? (
              <p className="text-sm text-white/60">
                對 NPC 宣戰需關係值低於 0（目前為{" "}
                {selected.relationScore ?? 0}）。可先在「通訊」分頁與其對話，AI 會依互動調整關係值。
              </p>
            ) : !confirming ? (
              <button
                onClick={() => setConfirming(true)}
                className="rounded-lg bg-red-600/90 px-4 py-2 text-sm font-bold transition hover:bg-red-500"
                data-testid="button-declare-war"
              >
                宣戰
              </button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-red-200">
                  確定要對 {selected.name} 宣戰嗎？
                </span>
                <button
                  onClick={() =>
                    declare.mutate({ data: { targetNationId: selected.id } })
                  }
                  disabled={declare.isPending}
                  className="flex items-center gap-1.5 rounded-lg bg-red-600/90 px-3 py-1.5 text-xs font-bold transition hover:bg-red-500 disabled:opacity-40"
                  data-testid="button-confirm-war"
                >
                  {declare.isPending && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  確定宣戰
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/75 hover:bg-white/20"
                  data-testid="button-cancel-war"
                >
                  取消
                </button>
              </div>
            )}
          </section>
        )}

        <section>
          <h3 className="mb-2 text-sm font-bold text-white/80">
            世界交戰列表
          </h3>
          {isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" />
              載入中…
            </div>
          ) : wars.length === 0 ? (
            <div className="rounded-lg bg-black/40 px-4 py-6 text-center text-sm text-white/45 backdrop-blur">
              目前世界和平，沒有任何交戰。
            </div>
          ) : (
            <div className="space-y-2">
              {wars.map((w) => (
                <div
                  key={w.id}
                  className={`rounded-xl border p-3 backdrop-blur ${
                    w.involvesMe
                      ? "border-red-400/40 bg-red-500/10"
                      : "border-white/10 bg-black/45"
                  }`}
                  data-testid={`war-${w.id}`}
                >
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <Swords className="h-4 w-4 text-red-300" />
                    {w.nationAName} vs {w.nationBName}
                    {w.involvesMe && (
                      <span className="rounded bg-red-500/30 px-1.5 text-[10px] font-bold text-red-200">
                        與我交戰
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[11px] text-white/50">
                    由 {w.declaredByName} 於{" "}
                    {new Date(w.createdAt).toLocaleDateString("zh-TW")} 宣戰
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
