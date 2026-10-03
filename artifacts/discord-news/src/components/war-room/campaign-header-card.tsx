import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Clock, Loader2, Map as MapIcon, Play } from "lucide-react";
import {
  getGetWarCampaignDetailQueryKey,
  getListWarCampaignReportsQueryKey,
} from "@workspace/api-client-react";
import type { WarCampaignDetail } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { END_REASON_LABELS, formatCountdown } from "@/components/war-hq-tab";
import { getAdminToken, useIsAdmin } from "@/lib/admin-token";

// ── 戰役概要卡 ────────────────────────────────────────────────

function AdminSettleButton({ detail }: { detail: WarCampaignDetail }) {
  const isAdmin = useIsAdmin();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [settling, setSettling] = useState(false);

  if (!isAdmin || detail.status !== "active") return null;

  const settle = async () => {
    if (
      !window.confirm(
        `確定要立即結算「對 ${detail.opponentName} 的戰役」嗎？將執行一次 AI 結算週期。`,
      )
    ) {
      return;
    }
    setSettling(true);
    try {
      const token = getAdminToken();
      const res = await fetch(
        `/api/war/admin/campaigns/${detail.id}/settle`,
        {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );
      if (!res.ok) {
        let msg = `請求失敗（${res.status}）`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data && typeof data.error === "string" && data.error) {
            msg = data.error;
          }
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      toast({ title: "已立即結算", description: "戰役狀態已更新。" });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getGetWarCampaignDetailQueryKey(detail.id),
        }),
        queryClient.invalidateQueries({
          queryKey: getListWarCampaignReportsQueryKey(detail.id),
        }),
      ]);
    } catch (err) {
      toast({
        title: "結算失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSettling(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void settle()}
      disabled={settling}
      className="flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/20 px-3 py-1.5 text-sm font-bold text-amber-100 backdrop-blur transition hover:bg-amber-500/35 disabled:opacity-60"
      data-testid="button-admin-settle"
    >
      {settling ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Play className="h-4 w-4" />
      )}
      立即結算
    </button>
  );
}

export function CampaignHeaderCard({ detail }: { detail: WarCampaignDetail }) {
  const isActive = detail.status === "active";
  const won = detail.winnerNationId && detail.winnerNationId !== detail.opponentNationId;
  const sameRegion = detail.attackerRegionId === detail.defenderRegionId;
  return (
    <div className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-xs font-bold ${
                detail.role === "attacker"
                  ? "bg-red-500/25 text-red-200"
                  : "bg-blue-500/25 text-blue-200"
              }`}
            >
              {detail.role === "attacker" ? "進攻方" : "防守方"}
            </span>
            {isActive ? (
              <span className="rounded bg-emerald-500/20 px-2 py-0.5 text-xs font-bold text-emerald-200">
                進行中・第 {detail.cycleNumber} 週期
              </span>
            ) : (
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs font-bold text-white/65">
                已結束・
                {detail.winnerNationId
                  ? won
                    ? "勝利"
                    : "敗北"
                  : (END_REASON_LABELS[detail.endReason ?? ""] ?? "已結束")}
              </span>
            )}
          </div>
          <h1 className="font-serif text-lg font-bold md:text-xl" data-testid="text-campaign-title">
            對 {detail.opponentName} 的戰役
          </h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm text-white/65">
            <MapIcon className="h-3.5 w-3.5" />
            {sameRegion ? (
              <span data-testid="text-contested-region">
                {detail.attackerRegionName}
              </span>
            ) : (
              <>
                {detail.attackerRegionName}
                <span className="text-white/40">→</span>
                {detail.defenderRegionName}
              </>
            )}
            {detail.isSeaLanding ? (
              <span
                className="inline-block rounded bg-sky-500/25 px-1.5 py-0.5 text-xs font-bold text-sky-200"
                data-testid="badge-sea-landing"
              >
                海上登陸
              </span>
            ) : null}
          </div>
          {detail.isSeaLanding ? (
            <div
              className="mt-1 text-xs text-sky-100/70"
              data-testid="text-sea-landing-info"
            >
              海上登陸戰役：進攻方攻擊力減損
              <span className="font-bold text-sky-200">
                {detail.landingAttackReductionPct ?? 0}%
              </span>
              {detail.seaLandingTroopCap != null ? (
                <>
                  ，可投入兵力上限
                  <span className="font-bold text-sky-200">
                    {detail.seaLandingTroopCap.toLocaleString("zh-TW")}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col items-start gap-2 md:items-end">
          {isActive && (
            <div className="flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm text-white/75">
              <Clock className="h-4 w-4 text-amber-300" />
              {formatCountdown(detail.nextResolveAt)}
              <span className="text-xs text-white/45">（每 {detail.cycleHours} 小時）</span>
            </div>
          )}
          <AdminSettleButton detail={detail} />
        </div>
      </div>
    </div>
  );
}
