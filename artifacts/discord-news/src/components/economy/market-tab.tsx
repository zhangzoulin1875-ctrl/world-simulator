import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Store, TrendingDown, TrendingUp } from "lucide-react";
import {
  getGetEconomyOverviewQueryKey,
  getGetMarketQueryKey,
  getGetPlayerNationQueryKey,
  getGetWarehouseQueryKey,
  useExecuteMarketTrade,
  useGetMarket,
  usePreviewMarketTrade,
} from "@workspace/api-client-react";
import type { MarketGood, MarketOverview } from "@workspace/api-client-react";
import { apiErrorMessage, formatBigNumber } from "@/components/military-shared";
import { useToast } from "@/hooks/use-toast";
import { blockReason, maxQty, parseQty, pctVsBase, type Side } from "./market-logic";

const TIER_ZH: Record<string, string> = { basic: "基礎", industrial: "工業", luxury: "奢侈" };
const fmtPrice = (n: number) => (n >= 100 ? Math.round(n).toLocaleString("zh-TW") : n.toFixed(2).replace(/\.?0+$/, ""));

export function MarketTab() {
  const { data, isLoading, isError, refetch } = useGetMarket({
    query: { queryKey: getGetMarketQueryKey(), staleTime: 1000 * 10 },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-white/15 bg-black/50 py-16 backdrop-blur">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        <span>載入黑市報價中…</span>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-xl border border-white/15 bg-black/50 p-8 text-center backdrop-blur">
        <p className="mb-4 text-sm text-white/70">無法載入黑市資料。</p>
        <button
          onClick={() => refetch()}
          className="rounded-lg bg-white/15 px-4 py-2 text-sm font-semibold transition hover:bg-white/25"
          data-testid="button-retry-market"
        >
          重新載入
        </button>
      </div>
    );
  }
  return <MarketContent data={data} />;
}

function MarketContent({ data }: { data: MarketOverview }) {
  const [selected, setSelected] = useState<string>(data.goods[0]?.good ?? "");
  // 目前時代可能讓選中的貨物消失(例如時代倒退),退回第一個。
  const good = data.goods.find((g) => g.good === selected) ?? data.goods[0];

  return (
    <div className="space-y-4" data-testid="market-tab">
      <div className="rounded-xl border border-white/15 bg-black/50 p-4 backdrop-blur">
        <div className="flex items-center gap-2">
          <Store className="h-5 w-5 text-amber-200" />
          <h3 className="font-serif text-base font-bold">黑市</h3>
          <span className="ml-auto text-xs text-white/60" data-testid="market-money">
            金錢 {formatBigNumber(data.money)}
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-white/60">
          價格會隨買賣浮動，並每回合向基準價回歸。每筆交易收 {Math.round(data.fee * 100)}% 手續費，
          單筆最多 {data.perTradeCap}，每種貨物每回合買、賣各最多 {data.turnCap}。糧食不在黑市交易。
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/15 bg-black/50 backdrop-blur">
        <table className="w-full text-sm" data-testid="market-table">
          <thead className="bg-white/5 text-xs text-white/60">
            <tr>
              <th className="px-3 py-2 text-left font-medium">貨物</th>
              <th className="px-3 py-2 text-right font-medium">買進價</th>
              <th className="px-3 py-2 text-right font-medium">賣出價</th>
              <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">行情</th>
              <th className="px-3 py-2 text-right font-medium">持有</th>
            </tr>
          </thead>
          <tbody>
            {data.goods.map((g) => {
              const pct = pctVsBase(g.mid, g.basePrice);
              const active = g.good === good?.good;
              return (
                <tr
                  key={g.good}
                  onClick={() => setSelected(g.good)}
                  className={`cursor-pointer border-t border-white/10 transition hover:bg-white/10 ${active ? "bg-white/10" : ""}`}
                  data-testid={`market-row-${g.good}`}
                >
                  <td className="px-3 py-2">
                    <span className="font-semibold">{g.label}</span>
                    <span className="ml-2 text-[10px] text-white/50">{TIER_ZH[g.tier] ?? g.tier}</span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPrice(g.buyPrice)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPrice(g.sellPrice)}</td>
                  <td className="hidden px-3 py-2 text-right text-xs tabular-nums sm:table-cell">
                    <span className={pct > 1 ? "text-rose-300" : pct < -1 ? "text-emerald-300" : "text-white/60"}>
                      {pct > 0 ? "+" : ""}
                      {pct.toFixed(0)}%
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatBigNumber(g.owned)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {good && <TradePanel key={good.good} data={data} good={good} />}
    </div>
  );
}

function TradePanel({ data, good }: { data: MarketOverview; good: MarketGood }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [side, setSide] = useState<Side>("buy");
  const [qtyText, setQtyText] = useState("10");

  const left = side === "buy" ? good.buyLeft : good.sellLeft;
  const qty = parseQty(qtyText);
  const qtyValid = qty >= 1 && qty <= data.perTradeCap;

  // 試算:數量或方向改變後稍等一下再問後端(避免每按一鍵就打一次)。
  const preview = usePreviewMarketTrade();
  const { mutate: runPreview, reset: resetPreview } = preview;
  useEffect(() => {
    if (!qtyValid) {
      resetPreview();
      return;
    }
    const t = setTimeout(() => runPreview({ data: { good: good.good, side, qty } }), 250);
    return () => clearTimeout(t);
  }, [good.good, side, qty, qtyValid, runPreview, resetPreview]);

  const tradeMutation = useExecuteMarketTrade({
    mutation: {
      onSuccess: (r) => {
        queryClient.invalidateQueries({ queryKey: getGetMarketQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetWarehouseQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetEconomyOverviewQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
        toast({
          title: side === "buy" ? `買進 ${r.qty} ${good.label}` : `賣出 ${r.qty} ${good.label}`,
          description: `${side === "buy" ? "支出" : "收入"} ${formatBigNumber(r.money)}（含手續費 ${formatBigNumber(r.fee)}）`,
        });
      },
      onError: (err) => {
        // 失敗多半是別人搶先改了價格或額度:重抓最新報價,讓畫面和後端一致。
        queryClient.invalidateQueries({ queryKey: getGetMarketQueryKey() });
        toast({ title: "交易失敗", description: apiErrorMessage(err), variant: "destructive" });
      },
    },
  });

  const p = preview.data;
  const blocked = blockReason({
    side,
    qty,
    perTradeCap: data.perTradeCap,
    left,
    owned: good.owned,
    affordable: p ? p.affordable : null,
  });

  const busy = tradeMutation.isPending;
  const disabled = busy || blocked !== null || !p || preview.isPending;

  return (
    <div className="rounded-xl border border-white/15 bg-black/50 p-4 backdrop-blur" data-testid="market-trade-panel">
      <div className="flex items-center justify-between">
        <h4 className="font-serif text-sm font-bold">{good.label}</h4>
        <span className="text-xs text-white/60">
          基準價 {fmtPrice(good.basePrice)}・中間價 {fmtPrice(good.mid)}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={`flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-sm font-semibold transition ${
              side === s ? "bg-amber-200/90 text-black" : "bg-white/10 text-white hover:bg-white/20"
            }`}
            data-testid={`market-side-${s}`}
          >
            {s === "buy" ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
            {s === "buy" ? "買進" : "賣出"}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          inputMode="numeric"
          value={qtyText}
          onChange={(e) => setQtyText(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
          className="w-28 rounded-lg border border-white/20 bg-black/40 px-3 py-2 text-right text-sm tabular-nums outline-none focus:border-amber-200/70"
          aria-label="數量"
          data-testid="market-qty"
        />
        <div className="flex gap-1">
          {[10, 50, 100].map((n) => (
            <button
              key={n}
              onClick={() => setQtyText(String(n))}
              className="rounded-md bg-white/10 px-2 py-1 text-xs transition hover:bg-white/20"
            >
              {n}
            </button>
          ))}
          <button
            onClick={() => setQtyText(String(maxQty(side, data.perTradeCap, left, good.owned)))}
            className="rounded-md bg-white/10 px-2 py-1 text-xs transition hover:bg-white/20"
            data-testid="market-qty-max"
          >
            最大
          </button>
        </div>
        <span className="ml-auto text-xs text-white/50">
          本回合剩餘 {left}
          {side === "sell" ? `・持有 ${good.owned}` : ""}
        </span>
      </div>

      <div className="mt-3 min-h-[3.25rem] rounded-lg bg-white/5 p-3 text-xs" data-testid="market-preview">
        {p && qtyValid ? (
          <div className="space-y-1">
            <div className="flex justify-between">
              <span className="text-white/60">{side === "buy" ? "需支付" : "可收到"}</span>
              <span className="font-semibold tabular-nums">{formatBigNumber(p.money)}</span>
            </div>
            <div className="flex justify-between text-white/60">
              <span>平均單價・手續費</span>
              <span className="tabular-nums">
                {fmtPrice(p.avgPrice)}・{formatBigNumber(p.fee)}
              </span>
            </div>
            <div className="flex justify-between text-white/60">
              <span>成交後中間價</span>
              <span className="tabular-nums">{fmtPrice(p.midAfter)}</span>
            </div>
          </div>
        ) : (
          <span className="text-white/50">輸入數量後顯示試算</span>
        )}
      </div>

      {blocked && (
        <p className="mt-2 text-xs text-amber-200/90" data-testid="market-blocked">
          {blocked}
        </p>
      )}

      <button
        onClick={() => tradeMutation.mutate({ data: { good: good.good, side, qty } })}
        disabled={disabled}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-amber-200/90 px-4 py-2.5 text-sm font-bold text-black transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-40"
        data-testid="market-submit"
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {side === "buy" ? "確認買進" : "確認賣出"}
      </button>
    </div>
  );
}
