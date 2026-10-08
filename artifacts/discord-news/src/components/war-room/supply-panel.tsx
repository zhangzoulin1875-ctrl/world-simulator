import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, PackageCheck, Truck } from "lucide-react";
import {
  getGetWarCampaignSupplyQueryKey,
  useGetWarCampaignSupply,
  useResupplyWarCampaign,
} from "@workspace/api-client-react";
import type { WarCampaignDetail } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * 後勤補給面板：本週期彈藥需求、國家庫存、可撐週期、缺口，
 * 以及「緊急運補」（花錢買彈藥進國家庫存）。
 * 需求/缺口由後端以結算同一套公式預估，這裡只負責顯示與下單。
 */
export function SupplyPanel({ detail }: { detail: WarCampaignDetail }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [custom, setCustom] = useState("");

  const { data, isLoading, isError } = useGetWarCampaignSupply(detail.id, {
    query: {
      queryKey: getGetWarCampaignSupplyQueryKey(detail.id),
      refetchInterval: 30_000,
    },
  });

  const mutation = useResupplyWarCampaign({
    mutation: {
      onSuccess: (r) => {
        setCustom("");
        toast({
          title: "運補完成",
          description: `購入彈藥 ${fmt(r.amount)}，花費 ${fmt(r.cost)} 金`,
        });
        queryClient.invalidateQueries({
          queryKey: getGetWarCampaignSupplyQueryKey(detail.id),
        });
      },
      onError: (err) =>
        toast({
          variant: "destructive",
          title: "運補失敗",
          description: apiErrorMessage(err),
        }),
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-white/15 bg-black/55 p-4 text-xs text-white/50 backdrop-blur">
        <Loader2 className="h-4 w-4 animate-spin" /> 讀取後勤補給中……
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-2xl border border-white/15 bg-black/55 p-4 text-xs text-white/50 backdrop-blur">
        暫時讀不到後勤補給資訊。
      </div>
    );
  }

  const buy = (amount: number) => {
    if (!Number.isInteger(amount) || amount < 1) {
      toast({ variant: "destructive", title: "請輸入大於 0 的整數數量" });
      return;
    }
    mutation.mutate({ id: detail.id, data: { amount } });
  };

  const cost = (n: number) => Math.ceil(n * data.unitPrice);
  const shortfall = data.ammoShortfall;
  const canBuy = data.campaignActive && data.ammoRelevant && data.maxResupply > 0;
  const fillShortfall = Math.min(shortfall, data.maxResupply);
  const customAmount = Number(custom);
  const customValid = Number.isInteger(customAmount) && customAmount >= 1;

  const status =
    !data.ammoRelevant
      ? { text: "本時代戰爭不消耗彈藥，無需運補", tone: "text-white/60" }
      : data.totalAmmoDemand === 0
        ? { text: "目前軍團沒有彈藥需求", tone: "text-white/60" }
        : shortfall > 0
          ? { text: `彈藥不足，缺口 ${fmt(shortfall)}`, tone: "text-red-300" }
          : { text: "彈藥充足", tone: "text-emerald-300" };

  return (
    <div className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur" data-testid="supply-panel">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Truck className="h-4 w-4 text-amber-300" />
        後勤補給
        <span className={`ml-auto text-xs font-normal ${status.tone}`}>{status.text}</span>
      </div>
      <p className="mb-3 text-xs text-white/50">
        每個結算週期，軍團會從國家彈藥庫存扣彈；庫存不足時補給下降，補給過低會崩潰。
        {data.activeCampaignCount > 1 &&
          `你同時參與 ${data.activeCampaignCount} 場戰役，下列需求與庫存為全國合計。`}
      </p>

      {data.ammoRelevant && (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-white/50">本週期需求</dt>
              <dd className="font-mono text-sm text-white/90">{fmt(data.totalAmmoDemand)}</dd>
            </div>
            <div>
              <dt className="text-white/50">彈藥庫存</dt>
              <dd className="font-mono text-sm text-white/90">{fmt(data.ammoStock)}</dd>
            </div>
            <div>
              <dt className="text-white/50">可撐週期</dt>
              <dd className={`font-mono text-sm ${data.cyclesOfAmmo !== null && data.cyclesOfAmmo < 1 ? "text-red-300" : "text-white/90"}`}>
                {data.cyclesOfAmmo === null ? "—" : `${data.cyclesOfAmmo} 週期`}
              </dd>
            </div>
            <div>
              <dt className="text-white/50">國庫金錢</dt>
              <dd className="font-mono text-sm text-amber-200">{fmt(data.money)}</dd>
            </div>
          </dl>

          {data.legions.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs">
              {data.legions.map((l) => (
                <li key={l.slot} className="flex flex-wrap items-center gap-x-3 rounded border border-white/10 bg-black/30 px-2 py-1.5">
                  <span className="font-semibold text-amber-100">軍團 {l.slot}</span>
                  {l.mercenary ? (
                    <span className="text-white/50">僱傭兵自帶補給</span>
                  ) : (
                    <>
                      <span className="text-white/60">需彈 <span className="font-mono text-white/85">{fmt(l.ammoDemand)}</span></span>
                      <span className="text-white/60">補給 <span className="font-mono text-white/85">{l.supply}</span></span>
                      {l.collapsed ? (
                        <span className="flex items-center gap-1 text-red-300"><AlertTriangle className="h-3 w-3" />補給崩潰</span>
                      ) : l.ammoFill < 1 ? (
                        <span className="text-amber-300">預估只補得到 {Math.round(l.ammoFill * 100)}%</span>
                      ) : (
                        <span className="flex items-center gap-1 text-emerald-300"><PackageCheck className="h-3 w-3" />足量</span>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {data.famineTurns > 0 && (
            <p className="mt-2 flex items-center gap-1 text-xs text-red-300">
              <AlertTriangle className="h-3 w-3" />
              國內缺糧 {data.famineTurns} 回合，軍團口糧也會跟著不足。
            </p>
          )}

          {data.campaignActive && (
            <div className="mt-4 space-y-2 border-t border-white/10 pt-3">
              <div className="text-xs font-semibold text-white/80">緊急運補</div>
              <p className="text-[11px] text-white/45">
                單價 {data.unitPrice} 金／彈藥。單次最多補到撐過 {data.horizonCycles} 個週期
                （目前最多可買 {fmt(data.maxResupply)}）。自建軍工廠的產出更便宜。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canBuy || fillShortfall < 1 || mutation.isPending}
                  onClick={() => buy(fillShortfall)}
                  className="rounded border border-amber-300/60 bg-amber-300/15 px-3 py-1.5 text-xs font-semibold text-amber-100 transition hover:bg-amber-300/25 disabled:cursor-not-allowed disabled:opacity-40"
                  data-testid="button-resupply-shortfall"
                >
                  {mutation.isPending ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null}
                  {fillShortfall >= 1
                    ? ` 補足缺口 ${fmt(fillShortfall)}（${fmt(cost(fillShortfall))} 金）`
                    : " 目前無缺口"}
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={data.maxResupply}
                  value={custom}
                  placeholder="自訂數量"
                  disabled={!canBuy || mutation.isPending}
                  onChange={(e) => setCustom(e.target.value)}
                  className="w-28 rounded border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white outline-none placeholder:text-white/30 focus:border-amber-300/60 disabled:opacity-40"
                  data-testid="input-resupply-amount"
                />
                <button
                  type="button"
                  disabled={!canBuy || !customValid || customAmount > data.maxResupply || mutation.isPending}
                  onClick={() => buy(customAmount)}
                  className="rounded border border-white/25 bg-white/10 px-3 py-1.5 text-xs text-white/90 transition hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40"
                  data-testid="button-resupply-custom"
                >
                  {customValid ? `購買（${fmt(cost(customAmount))} 金）` : "購買"}
                </button>
              </div>
              {!canBuy && data.maxResupply <= 0 && data.totalAmmoDemand > 0 && (
                <p className="text-[11px] text-emerald-300/80">庫存已足夠撐過 {data.horizonCycles} 個週期，暫不需運補。</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
