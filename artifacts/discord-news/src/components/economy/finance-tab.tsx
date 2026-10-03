import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Factory,
  Hourglass,
  Landmark,
  Loader2,
  Percent,
  ReceiptText,
  Scale,
  ScrollText,
  Shield,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
  X,
} from "lucide-react";
import {
  getGetPlayerNationQueryKey,
  getGetEconomyOverviewQueryKey,
  useSubmitFinanceIdea,
  useWithdrawFinanceIdea,
} from "@workspace/api-client-react";
import type {
  EconomyOverview,
  MilitaryUpkeepLine,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage, formatBigNumber } from "@/components/military-shared";
import { signed } from "./shared";
import { FinanceHistory, LedgerPanel } from "./finance-history";

export function FinanceTab({ overview }: { overview: EconomyOverview }) {
  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      {/* left column */}
      <div className="space-y-4">
        <TaxOverviewCard overview={overview} />
        <FiscalPolicyBox overview={overview} />
      </div>

      {/* right column */}
      <div className="space-y-4">
        <CashFlowBreakdown overview={overview} />
        <FinanceHistory entries={overview.entries} />
        <LedgerPanel />
      </div>
    </div>
  );
}

/**
 * 每回合金錢流向明細：收入（稅收）、固定支出（軍隊維護費逐兵種＋建築維護費）、
 * 含維護費的每回合淨結餘。皆以表格逐筆列出。
 */
function CashFlowBreakdown({ overview }: { overview: EconomyOverview }) {
  const mil = overview.militaryUpkeepLines;
  return (
    <section className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
      <div className="mb-3 flex items-center gap-2">
        <ReceiptText className="h-4 w-4 text-emerald-300" />
        <h2 className="font-serif text-sm font-bold text-white/80">
          每回合金錢流向明細
        </h2>
      </div>

      {/* 每回合收入 */}
      <FlowGroupHeader
        icon={TrendingUp}
        label="每回合收入"
        color="text-emerald-300"
      />
      <table className="mb-4 w-full text-sm">
        <tbody>
          <FlowRow
            label="稅收"
            hint="人口 × 稅率% × 稅收效率% ÷ 10000"
            amount={overview.taxIncomePerTurn}
            positive
            testId="flow-income-tax"
          />
          <FlowSubtotal
            label="收入小計"
            amount={overview.taxIncomePerTurn}
            positive
          />
        </tbody>
      </table>
      <p className="-mt-3 mb-4 text-[11px] leading-relaxed text-white/45">
        代入值：{formatBigNumber(overview.totalPopulation)} 人 ×{" "}
        {overview.taxRatePct}% × {overview.taxEfficiencyPct}% ÷ 10000 ={" "}
        {formatBigNumber(overview.taxIncomePerTurn)}
      </p>

      {/* 每回合固定支出 */}
      <FlowGroupHeader
        icon={TrendingDown}
        label="每回合固定支出"
        color="text-rose-300"
      />

      {/* 軍隊維護費 */}
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-white/55">
        <Shield className="h-3.5 w-3.5" />
        軍隊維護費（逐兵種）
      </div>
      {mil.length === 0 ? (
        <p className="mb-3 rounded-lg border border-dashed border-white/15 px-3 py-2 text-xs text-white/45">
          目前沒有需要維護的軍隊。
        </p>
      ) : (
        <table className="mb-3 w-full text-sm">
          <thead>
            <tr className="text-[10px] text-white/40">
              <th className="pb-1 text-left font-normal">兵種</th>
              <th className="pb-1 text-right font-normal">數量</th>
              <th className="pb-1 text-right font-normal">每單位</th>
              <th className="pb-1 text-right font-normal">小計</th>
            </tr>
          </thead>
          <tbody>
            {mil.map((l: MilitaryUpkeepLine) => (
              <tr
                key={l.templateId}
                className="border-t border-white/5"
                data-testid={`flow-upkeep-${l.templateId}`}
              >
                <td className="py-1.5 pr-2 text-white/80">{l.name}</td>
                <td className="py-1.5 text-right tabular-nums text-white/70">
                  {formatBigNumber(l.quantity)}
                </td>
                <td className="py-1.5 text-right tabular-nums text-white/70">
                  {l.upkeepPerUnit}
                </td>
                <td className="py-1.5 text-right font-bold tabular-nums text-rose-300">
                  −{formatBigNumber(l.subtotal)}
                </td>
              </tr>
            ))}
            <tr className="border-t border-white/15">
              <td
                className="py-1.5 pr-2 text-xs font-bold text-white/70"
                colSpan={3}
              >
                軍隊維護費總計
              </td>
              <td
                className="py-1.5 text-right text-sm font-bold tabular-nums text-rose-300"
                data-testid="flow-upkeep-military-total"
              >
                −{formatBigNumber(overview.militaryUpkeepPerTurn)}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      {/* 建築維護費 */}
      <table className="mb-3 w-full text-sm">
        <tbody>
          <FlowRow
            label="建築維護費"
            hint="已含風車技術等減免"
            amount={-overview.buildingUpkeepPerTurn}
            icon={Building2}
            testId="flow-upkeep-building"
          />
          <FlowRow
            label="地區資源建築維護費"
            hint="木材廠／礦場，100 × Σ 等級"
            amount={-overview.regionBuildingUpkeepPerTurn}
            icon={Building2}
            testId="flow-upkeep-region-building"
          />
        </tbody>
      </table>

      {/* 每回合淨結餘（含維護費） */}
      <div className="mt-2 flex items-center justify-between rounded-lg border border-white/15 bg-black/40 px-3 py-2.5">
        <span className="text-xs font-bold text-white/75">
          每回合淨結餘（含維護費）
        </span>
        <span
          className={`text-base font-bold tabular-nums ${
            overview.netSurplusPerTurn >= 0
              ? "text-emerald-300"
              : "text-red-300"
          }`}
          data-testid="flow-net-surplus"
        >
          {signed(overview.netSurplusPerTurn)}
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-white/45">
        淨結餘 = 稅收 −（軍隊 ＋ 建築 ＋ 地區資源建築維護費），與回合引擎實際扣款一致
        （合併維護費會無條件進位，故實扣 {formatBigNumber(overview.upkeepPerTurn)}）。
      </p>

      {/* Task #568 — 生產力沒有每回合維護費：只剩軍事佔用（stock）＋
          招募當回合的一次性花費（flow，跨回合歸零）。 */}
      <div className="mt-4 border-t border-white/10 pt-4">
        <FlowGroupHeader
          icon={Factory}
          label="可用生產力（非金錢）"
          color="text-sky-300"
        />
        <div className="flex items-center justify-between rounded-lg border border-white/15 bg-black/40 px-3 py-2.5">
          <span className="text-xs font-bold text-white/75">目前可用生產力</span>
          <span
            className="text-base font-bold tabular-nums text-sky-300"
            data-testid="available-production"
          >
            {formatBigNumber(overview.availableProduction)}
          </span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-white/45">
          可用生產力 = 總生產力 − 軍事已佔用 − 本回合招募花費。
          軍事佔用在解散時按比例釋放；招募花費是一次性消耗，回合結算後自動歸零、
          解散不退還。生產力不再有每回合維護費。
        </p>
      </div>
    </section>
  );
}

function FlowGroupHeader({
  icon: Icon,
  label,
  color,
}: {
  icon: React.ElementType;
  label: string;
  color: string;
}) {
  return (
    <div className={`mb-1.5 flex items-center gap-1.5 text-xs font-bold ${color}`}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </div>
  );
}

function FlowRow({
  label,
  hint,
  amount,
  positive,
  icon: Icon,
  testId,
}: {
  label: string;
  hint?: string;
  amount: number;
  positive?: boolean;
  icon?: React.ElementType;
  testId?: string;
}) {
  const isPositive = positive ?? amount >= 0;
  return (
    <tr className="border-t border-white/5" data-testid={testId}>
      <td className="py-1.5 pr-2">
        <span className="flex items-center gap-1.5 text-white/80">
          {Icon && <Icon className="h-3.5 w-3.5 text-white/50" />}
          {label}
        </span>
        {hint && <span className="text-[10px] text-white/40">{hint}</span>}
      </td>
      <td
        className={`py-1.5 text-right font-bold tabular-nums ${
          isPositive ? "text-emerald-300" : "text-rose-300"
        }`}
      >
        {signed(amount)}
      </td>
    </tr>
  );
}

function FlowSubtotal({
  label,
  amount,
  positive,
}: {
  label: string;
  amount: number;
  positive?: boolean;
}) {
  const isPositive = positive ?? amount >= 0;
  return (
    <tr className="border-t border-white/15">
      <td className="py-1.5 pr-2 text-xs font-bold text-white/70">{label}</td>
      <td
        className={`py-1.5 text-right text-sm font-bold tabular-nums ${
          isPositive ? "text-emerald-300" : "text-rose-300"
        }`}
      >
        {signed(amount)}
      </td>
    </tr>
  );
}

function TaxOverviewCard({ overview }: { overview: EconomyOverview }) {
  const rows = [
    {
      key: "population",
      label: "總人口",
      icon: Users,
      value: formatBigNumber(overview.totalPopulation),
    },
    {
      key: "taxrate",
      label: "稅率",
      icon: Percent,
      value: `${overview.taxRatePct}% / 上限 ${overview.taxRateMax}%`,
    },
    {
      key: "efficiency",
      label: "稅收效率",
      icon: Scale,
      value: `${overview.taxEfficiencyPct}%`,
    },
    {
      key: "income",
      label: "每回合稅收",
      icon: Wallet,
      value: formatBigNumber(overview.taxIncomePerTurn),
    },
  ];
  return (
    <section className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
      <div className="mb-3 flex items-center gap-2">
        <Wallet className="h-4 w-4 text-emerald-300" />
        <h2 className="font-serif text-sm font-bold text-white/80">稅收概況</h2>
      </div>
      <dl className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.key}
            className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2"
            data-testid={`tax-row-${r.key}`}
          >
            <dt className="flex items-center gap-2 text-xs text-white/60">
              <r.icon className="h-3.5 w-3.5" />
              {r.label}
            </dt>
            <dd className="text-sm font-bold tabular-nums">{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-3 flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2">
        <span className="text-xs text-white/60">淨結餘/回合（含維護費）</span>
        <span
          className={`text-sm font-bold tabular-nums ${
            overview.netSurplusPerTurn >= 0
              ? "text-emerald-300"
              : "text-red-300"
          }`}
        >
          {signed(overview.netSurplusPerTurn)}
        </span>
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-white/45">
        收入完全來自稅收（生產力不再產生金錢）。稅收 = ⌊人口 × 稅率% × 稅收效率% ÷
        10000⌋。稅率只能透過下方「財政政策」由內閣（AI）判定後調整，沒有直接滑桿。
        完整收支拆解見右側「每回合金錢流向明細」。
      </p>
    </section>
  );
}

function FiscalPolicyBox({ overview }: { overview: EconomyOverview }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [idea, setIdea] = useState("");
  const maxLen = overview.ideaMaxLength;
  const pending = overview.pendingIdea;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetEconomyOverviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
  };

  const submit = useSubmitFinanceIdea({
    mutation: {
      onSuccess: () => {
        setIdea("");
        toast({
          title: "已送出財政政策",
          description: "回合結算時將由內閣（AI）判定成效。",
        });
        invalidate();
      },
      onError: (err) =>
        toast({
          title: "送出失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });
  const withdraw = useWithdrawFinanceIdea({
    mutation: {
      onSuccess: () => {
        toast({ title: "已撤回財政政策" });
        invalidate();
      },
      onError: (err) =>
        toast({
          title: "撤回失敗",
          description: apiErrorMessage(err),
          variant: "destructive",
        }),
    },
  });

  return (
    <section className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
      <h2 className="mb-2 flex items-center gap-2 font-serif text-sm font-bold text-white/80">
        <ScrollText className="h-4 w-4 text-amber-300" />
        財政政策
      </h2>
      {pending ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-amber-300/30 bg-amber-500/10 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-amber-200">
              <Hourglass className="h-3.5 w-3.5" />
              等待回合結算判定
            </div>
            <p className="whitespace-pre-wrap text-sm text-white/85">
              {pending.idea}
            </p>
          </div>
          <button
            onClick={() => withdraw.mutate()}
            disabled={withdraw.isPending}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-sm font-semibold transition hover:bg-white/20 disabled:opacity-50"
            data-testid="button-withdraw-finance-idea"
          >
            {withdraw.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4" />
            )}
            撤回政策
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <textarea
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            maxLength={maxLen}
            rows={4}
            placeholder="寫下你的財政政策（例如：加稅、減稅、開徵新稅源、稅制改革…），回合結算時由內閣（AI）判定成敗、稅率與金錢影響…"
            className="w-full resize-none rounded-lg border border-white/20 bg-black/40 p-3 text-sm text-white placeholder:text-white/35 focus:border-amber-300/60 focus:outline-none"
            data-testid="input-finance-idea"
          />
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-white/45">
              {idea.length}/{maxLen} 字
            </span>
            <button
              onClick={() => submit.mutate({ data: { idea } })}
              disabled={submit.isPending || idea.trim().length === 0}
              className="flex items-center gap-1.5 rounded-lg bg-amber-500/85 px-4 py-2 text-sm font-bold text-black transition hover:bg-amber-400 disabled:opacity-50"
              data-testid="button-submit-finance-idea"
            >
              {submit.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              送出政策
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-white/45">
            同時只能有一筆待判定的財政政策；判定為好事件可能調整稅率或帶來收入，壞事件可能損失金錢或降低滿意度。
          </p>
        </div>
      )}
    </section>
  );
}
