import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  Shield,
  Swords,
} from "lucide-react";
import {
  useGetWarCampaignDetail,
  getGetWarCampaignDetailQueryKey,
  useGetWarCampaignJoinEligibility,
  getGetWarCampaignJoinEligibilityQueryKey,
  useJoinWarCampaign,
  getListWarCampaignsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import type {
  MilitaryOverview,
  WarCampaignDetail,
} from "@workspace/api-client-react";
import {
  MilitaryPageGuard,
  ResourceBar,
} from "@/components/military-shared";
import { GameNotifications } from "@/components/game-notifications";
import { CampaignHeaderCard } from "@/components/war-room/campaign-header-card";
import { TerrainCard } from "@/components/war-room/terrain-card";
import { EnemyIntelCard } from "@/components/war-room/enemy-intel-card";
import { CityStateCards } from "@/components/war-room/city-state-cards";
import { LegionEditor } from "@/components/war-room/legion-editor";
import { OrdersPanel } from "@/components/war-room/orders-panel";
import { SupplyPanel } from "@/components/war-room/supply-panel";
import { ReportsTimeline } from "@/components/war-room/reports-timeline";
import { ParticipantsCard } from "@/components/war-room/participants-card";

export default function GameWarRoom() {
  const params = useParams();
  const campaignId = Number(params.id);
  return (
    <MilitaryPageGuard
      pageTitle="戰情室"
      loginDescription="請先以 Discord 登入，才能進入戰情室。"
      render={(overview, bg) => (
        <WarRoomScreen bg={bg} overview={overview} campaignId={campaignId} />
      )}
    />
  );
}

function WarRoomScreen({
  bg,
  overview,
  campaignId,
}: {
  bg: string;
  overview: MilitaryOverview;
  campaignId: number;
}) {
  const validId = Number.isInteger(campaignId) && campaignId > 0;
  const { data: detail, isLoading } = useGetWarCampaignDetail(campaignId, {
    query: {
      queryKey: getGetWarCampaignDetailQueryKey(campaignId),
      enabled: validId,
      refetchInterval: 30_000,
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center text-white"
      style={{ backgroundImage: `url(${bg})` }}
      data-testid="page-game-war-room"
    >
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/70 via-black/50 to-black/75" />

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
              <Swords className="h-5 w-5 text-red-300" />
              <span className="font-serif text-base font-bold md:text-lg">戰情室</span>
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

        {overview.coupMoralePenaltyTurns > 0 && (
          <div
            className="mb-3 flex items-center gap-2 rounded-lg border border-red-400/40 bg-red-950/60 px-3 py-2 text-sm text-red-200 backdrop-blur"
            data-testid="banner-coup-morale-penalty"
          >
            <Shield className="h-4 w-4 shrink-0 text-red-300" />
            <span>
              政變士氣懲罰 −{overview.coupMoralePenalty}（剩餘{" "}
              {overview.coupMoralePenaltyTurns} 回合）：戰役結算時所有軍團士氣暫時下降。
            </span>
          </div>
        )}

        {!validId || (!isLoading && !detail) ? (
          <JoinCampaignPanel campaignId={campaignId} validId={validId} />
        ) : isLoading || !detail ? (
          <div className="flex flex-1 items-center justify-center p-12">
            <Loader2 className="h-7 w-7 animate-spin text-white/60" />
          </div>
        ) : (
          <WarRoomBody detail={detail} overview={overview} />
        )}
      </div>
    </div>
  );
}

// ── Task #453 — 晚加入選邊面板（非參戰方且符合資格時顯示） ──────

function JoinCampaignPanel({
  campaignId,
  validId,
}: {
  campaignId: number;
  validId: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: eligibility, isLoading } = useGetWarCampaignJoinEligibility(
    campaignId,
    {
      query: {
        queryKey: getGetWarCampaignJoinEligibilityQueryKey(campaignId),
        enabled: validId,
      },
    },
  );
  const joinMutation = useJoinWarCampaign({
    mutation: {
      onSuccess: async () => {
        toast({ title: "已加入戰局", description: "現在可以部署你的軍團了。" });
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetWarCampaignDetailQueryKey(campaignId),
          }),
          queryClient.invalidateQueries({
            queryKey: getGetWarCampaignJoinEligibilityQueryKey(campaignId),
          }),
          queryClient.invalidateQueries({
            queryKey: getListWarCampaignsQueryKey(),
          }),
        ]);
      },
      onError: (err) => {
        const message =
          err instanceof Error && err.message ? err.message : "請稍後再試";
        toast({ title: "加入失敗", description: message, variant: "destructive" });
      },
    },
  });

  const joinable = eligibility?.joinableSides ?? [];
  return (
    <div className="flex flex-1 items-center justify-center rounded-2xl border border-white/15 bg-black/55 p-12 backdrop-blur">
      <div className="text-center">
        <Shield className="mx-auto mb-4 h-12 w-12 text-white/30" />
        <p className="text-sm text-white/60">你不是這場戰役的參戰方。</p>
        {validId && isLoading ? (
          <Loader2 className="mx-auto mt-4 h-5 w-5 animate-spin text-white/50" />
        ) : joinable.length > 0 ? (
          <div className="mt-5">
            <p className="mb-3 text-sm text-amber-200/90">
              你與其中一方的敵國處於交戰狀態，可以加入戰局：
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {joinable.map((s) => (
                <button
                  key={s.side}
                  type="button"
                  disabled={joinMutation.isPending}
                  onClick={() =>
                    joinMutation.mutate({
                      id: campaignId,
                      data: { side: s.side },
                    })
                  }
                  className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-bold backdrop-blur transition disabled:opacity-60 ${
                    s.side === "attacker"
                      ? "border-red-400/40 bg-red-500/20 text-red-100 hover:bg-red-500/35"
                      : "border-blue-400/40 bg-blue-500/20 text-blue-100 hover:bg-blue-500/35"
                  }`}
                  data-testid={`button-join-${s.side}`}
                >
                  {joinMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Swords className="h-4 w-4" />
                  )}
                  加入{s.sideLabel}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ── 主體 ──────────────────────────────────────────────────────

function WarRoomBody({
  detail,
  overview,
}: {
  detail: WarCampaignDetail;
  overview: MilitaryOverview;
}) {
  const isActive = detail.status === "active";
  // Task #587 — 政變士氣懲罰生效中（剩餘回合 > 0）才傳懲罰值，
  // 結束後傳 0 讓軍團面板恢復顯示名目士氣。
  const coupMoralePenalty =
    overview.coupMoralePenaltyTurns > 0 ? overview.coupMoralePenalty : 0;
  return (
    <div className="space-y-4">
      <CampaignHeaderCard detail={detail} />
      <ParticipantsCard detail={detail} />
      <div className="grid gap-4 lg:grid-cols-2">
        <TerrainCard detail={detail} />
        <EnemyIntelCard detail={detail} />
      </div>
      <CityStateCards detail={detail} />
      <LegionEditor
        detail={detail}
        disabled={!isActive}
        coupMoralePenalty={coupMoralePenalty}
      />
      {isActive && <SupplyPanel detail={detail} />}
      {isActive && <OrdersPanel detail={detail} />}
      <ReportsTimeline campaignId={detail.id} />
    </div>
  );
}
