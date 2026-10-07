import { Loader2, ScrollText } from "lucide-react";
import {
  useListWarCampaignReports,
  getListWarCampaignReportsQueryKey,
} from "@workspace/api-client-react";
import type { WarReportView } from "@workspace/api-client-react";
import { formatBigNumber } from "@/components/military-shared";

// ── 戰報時間軸 ────────────────────────────────────────────────

export function ReportsTimeline({ campaignId }: { campaignId: number }) {
  const { data, isLoading } = useListWarCampaignReports(campaignId, {
    query: { queryKey: getListWarCampaignReportsQueryKey(campaignId), refetchInterval: 60_000 },
  });

  return (
    <div className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <ScrollText className="h-4 w-4 text-emerald-300" />
        歷次結算戰報
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-white/50" />
        </div>
      ) : (data?.reports.length ?? 0) === 0 ? (
        <p className="py-6 text-center text-sm text-white/45" data-testid="text-no-reports">
          尚未有結算戰報。第一次結算後，AI 戰報會顯示在這裡。
        </p>
      ) : (
        <div className="space-y-3">
          {data!.reports.map((r) => (
            <ReportCard key={r.id} report={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReportCard({ report: r }: { report: WarReportView }) {
  return (
    <div
      className="rounded-xl border border-white/12 bg-white/[0.04] p-3"
      data-testid={`card-report-${r.id}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-white/10 px-2 py-0.5 text-xs font-bold text-white/75">
          第 {r.cycleNumber} 週期
        </span>
        {r.stalemate && (
          <span className="rounded bg-zinc-500/25 px-2 py-0.5 text-xs text-zinc-300">戰局僵持</span>
        )}
        <span className="ml-auto text-xs text-white/40">
          {new Date(r.createdAt).toLocaleString("zh-TW")}
        </span>
      </div>
      <p className="mb-3 whitespace-pre-wrap text-sm leading-relaxed text-white/80">{r.report}</p>
      <div className="grid gap-2 md:grid-cols-2">
        <SideStats title="我方" side={r.mySide} exact />
        <SideStats title="敵方（估計）" side={r.enemySide} exact={false} />
      </div>
      <p className="mt-2 text-xs leading-relaxed text-white/55">
        {buildCasualtyExplanation(r.mySide, r.stalemate ?? false)}
      </p>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <ReportCityList
          title="進攻方城市"
          cities={r.attackerCities}
          fallbackPct={r.attackerCityHoldoutPct}
        />
        <ReportCityList
          title="防守方城市"
          cities={r.defenderCities}
          fallbackPct={r.defenderCityHoldoutPct}
        />
      </div>
      {r.localPopulationLoss > 0 && (
        <div className="mt-2 text-xs text-red-300/80">
          當地人口損失 {formatBigNumber(r.localPopulationLoss)}
        </div>
      )}
    </div>
  );
}

/** 戰報逐城城牆狀態；舊戰報無逐城資料時退回整體防線百分比。 */
function ReportCityList({
  title,
  cities,
  fallbackPct,
}: {
  title: string;
  cities: WarReportView["attackerCities"];
  fallbackPct: number | null;
}) {
  if (!cities || cities.length === 0) {
    if (fallbackPct == null) return null;
    return (
      <div className="rounded-lg border border-white/10 bg-black/30 p-2 text-xs text-white/60">
        <span className="font-semibold text-white/70">{title}</span>
        <span className="ml-2">城市防線 {fallbackPct}%</span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-2">
      <div className="mb-1 text-xs font-semibold text-white/70">{title}</div>
      <div className="space-y-1">
        {cities.map((c) => {
          const fallen = c.durability <= 0;
          return (
            <div
              key={c.cityId}
              className="flex items-center justify-between gap-2 text-[11px]"
            >
              <span className="flex items-center gap-1 text-white/75">
                {c.name}
                <span className="rounded bg-amber-500/20 px-1 text-[10px] text-amber-200">
                  {c.wallTierLabel}
                </span>
              </span>
              <span
                className={`tabular-nums ${fallen ? "font-bold text-red-300" : "text-white/55"}`}
              >
                {fallen
                  ? "已攻破"
                  : `${c.durability.toLocaleString("en-US")}/${c.maxDurability.toLocaleString("en-US")}（${c.durabilityPct}%）`}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 從戰報數值欄位生成傷亡摘要說明文字（zh-TW）。
 * 此函式取代原本的伺服器端文字生成，改由前端依數值自行組成語句。
 */
function buildCasualtyExplanation(
  mySide: WarReportView["mySide"],
  stalemate: boolean,
): string {
  const parts: string[] = [];

  const totalLoss = mySide.deadTotal + mySide.woundedTotal;
  if (totalLoss > 0) {
    parts.push(
      `我方本週期損傷 ${formatBigNumber(totalLoss)} 人（死亡 ${formatBigNumber(mySide.deadTotal)}、負傷 ${formatBigNumber(mySide.woundedTotal)}）。`,
    );
  } else if (!stalemate) {
    parts.push("我方本週期無傷亡。");
  }

  if (mySide.territoryPctDelta > 0) {
    parts.push(`領土推進 +${mySide.territoryPctDelta}%。`);
  } else if (mySide.territoryPctDelta < 0) {
    parts.push(`領土退讓 ${mySide.territoryPctDelta}%。`);
  }

  if (mySide.moraleDelta <= -10) {
    parts.push("士氣受到嚴重打擊，請儘快調整部署與指令。");
  } else if (mySide.moraleDelta < 0) {
    parts.push("士氣略有損耗。");
  }

  if (mySide.warWearinessDelta > 0) {
    parts.push(`厭戰度上升 ${mySide.warWearinessDelta} 點。`);
  }

  const sup = mySide.supply;
  if (sup) {
    if (sup.collapsedLegions > 0) {
      parts.push(
        `${sup.collapsedLegions} 個軍團補給斷絕、組織崩潰（補給 ${sup.minSupply}），戰力近乎歸零，隨時可能潰散。`,
      );
    } else if (sup.rationShort || sup.ammoShort) {
      const lacks = [sup.rationShort ? "口糧" : "", sup.ammoShort ? "彈藥" : ""]
        .filter(Boolean)
        .join("與");
      parts.push(`前線${lacks}不足，補給下降至 ${sup.minSupply}，請儘快補充。`);
    }
  }

  return parts.join("　") || (stalemate ? "雙方無實質進展。" : "本週期無重大變動。");
}

function signed(v: number): string {
  return v > 0 ? `+${v}` : String(v);
}

function SideStats({
  title,
  side,
  exact,
}: {
  title: string;
  side: WarReportView["mySide"];
  exact: boolean;
}) {
  const approx = exact ? "" : "約 ";
  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-2.5">
      <div className="mb-1.5 text-xs font-bold text-white/70">{title}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-white/65 md:grid-cols-3">
        <span>
          士氣{" "}
          <span className={side.moraleDelta < 0 ? "text-red-300" : "text-emerald-300"}>
            {signed(side.moraleDelta)}
          </span>
        </span>
        <span>
          受傷 <span className="text-amber-300">{approx}{formatBigNumber(side.woundedTotal)}</span>
        </span>
        <span>
          死亡 <span className="text-red-300">{approx}{formatBigNumber(side.deadTotal)}</span>
        </span>
        <span>
          領土{" "}
          <span className={side.territoryPctDelta < 0 ? "text-red-300" : "text-emerald-300"}>
            {signed(side.territoryPctDelta)}%
          </span>
        </span>
        <span>
          厭戰{" "}
          <span className={side.warWearinessDelta > 0 ? "text-red-300" : "text-emerald-300"}>
            {signed(side.warWearinessDelta)}
          </span>
        </span>
      </div>
    </div>
  );
}
