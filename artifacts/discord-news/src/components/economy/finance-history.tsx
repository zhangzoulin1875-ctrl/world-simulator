import { FileClock, Loader2, ReceiptText } from "lucide-react";
import {
  useGetEconomyLedger,
  getGetEconomyLedgerQueryKey,
} from "@workspace/api-client-react";
import type {
  FinanceEntry,
  FinanceLedgerEntry,
} from "@workspace/api-client-react";
import { formatBigNumber } from "@/components/military-shared";
import { signed, formatDateTime } from "./shared";

export function FinanceHistory({ entries }: { entries: FinanceEntry[] }) {
  return (
    <section className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
      <h2 className="mb-3 flex items-center gap-2 font-serif text-sm font-bold text-white/80">
        <FileClock className="h-4 w-4 text-sky-300" />
        財政政策歷史
      </h2>
      {entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-8 text-center text-sm text-white/45">
          還沒有任何財政政策紀錄。送出財政政策，在回合結算時建立你的第一筆紀錄吧。
        </div>
      ) : (
        <ul className="space-y-2.5">
          {entries.map((e) => (
            <FinanceEntryCard key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FinanceEntryCard({ entry }: { entry: FinanceEntry }) {
  const chips: { label: string; positive: boolean }[] = [];
  if (entry.taxRateBefore != null && entry.taxRateAfter != null) {
    const up = entry.taxRateAfter >= entry.taxRateBefore;
    chips.push({
      label: `稅率 ${entry.taxRateBefore}% → ${entry.taxRateAfter}%`,
      positive: up,
    });
  }
  if (entry.moneyDelta != null && entry.moneyDelta !== 0) {
    const pos = entry.moneyDelta > 0;
    chips.push({
      label: `金錢 ${pos ? "+" : "−"}${formatBigNumber(Math.abs(entry.moneyDelta))}`,
      positive: pos,
    });
  }
  if (entry.satisfactionDelta != null && entry.satisfactionDelta !== 0) {
    const pos = entry.satisfactionDelta > 0;
    chips.push({
      label: `滿意度 ${pos ? "+" : ""}${entry.satisfactionDelta}`,
      positive: pos,
    });
  }
  if (entry.stabilityDelta != null && entry.stabilityDelta !== 0) {
    const pos = entry.stabilityDelta > 0;
    chips.push({
      label: `穩定度 ${pos ? "+" : ""}${entry.stabilityDelta}`,
      positive: pos,
    });
  }

  return (
    <li
      className="rounded-xl border border-white/15 bg-white/5 p-3"
      data-testid={`finance-entry-${entry.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                entry.isGood
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "bg-rose-500/20 text-rose-300"
              }`}
            >
              {entry.isGood ? "好事件" : "壞事件"}
            </span>
            <span className="truncate text-sm font-bold">{entry.title}</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-white/65">
            {entry.description}
          </p>
        </div>
        <span className="shrink-0 text-[10px] text-white/40">
          {formatDateTime(entry.createdAt)}
        </span>
      </div>
      {chips.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {chips.map((c, i) => (
            <span
              key={i}
              className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${
                c.positive
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "bg-red-500/20 text-red-300"
              }`}
            >
              {c.label}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}

/** 一次性收支的用途分組：外交（條約款項／外交贈禮）與暫時性（財政政策／賠款／政變）。 */
const LEDGER_GROUPS: { key: string; label: string; categories: string[] }[] = [
  {
    key: "diplomacy",
    label: "外交支出／收入",
    categories: ["treaty", "gift"],
  },
  {
    key: "temporary",
    label: "暫時性收支",
    categories: ["fiscal_policy", "policy_penalty", "coup"],
  },
];

export function LedgerPanel() {
  const { data, isLoading } = useGetEconomyLedger({
    query: {
      queryKey: getGetEconomyLedgerQueryKey(),
      staleTime: 1000 * 15,
    },
  });
  const entries: FinanceLedgerEntry[] = data?.entries ?? [];

  const groups = LEDGER_GROUPS.map((g) => {
    const items = entries.filter((e) => g.categories.includes(e.category));
    const subtotal = items.reduce((s, e) => s + e.amount, 0);
    return { ...g, items, subtotal };
  });
  const others = entries.filter(
    (e) => !LEDGER_GROUPS.some((g) => g.categories.includes(e.category)),
  );
  if (others.length > 0) {
    const subtotal = others.reduce((s, e) => s + e.amount, 0);
    groups.push({
      key: "other",
      label: "其他",
      categories: [],
      items: others,
      subtotal,
    });
  }
  const nonEmpty = groups.filter((g) => g.items.length > 0);

  return (
    <section className="rounded-2xl border border-white/15 bg-black/55 p-4 backdrop-blur">
      <h2 className="mb-3 flex items-center gap-2 font-serif text-sm font-bold text-white/80">
        <ReceiptText className="h-4 w-4 text-amber-300" />
        一次性收支
        <span className="text-[11px] font-normal text-white/40">近 30 天</span>
      </h2>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-white/60">
          <Loader2 className="h-4 w-4 animate-spin" />
          載入流水中…
        </div>
      ) : nonEmpty.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/15 p-8 text-center text-sm text-white/45">
          近 30 天沒有外交／內政／財政政策造成的金錢收支。
        </div>
      ) : (
        <div className="space-y-4">
          {nonEmpty.map((g) => (
            <div key={g.key} data-testid={`ledger-group-${g.key}`}>
              <div className="mb-1 flex items-center justify-between border-b border-white/10 pb-1">
                <span className="text-xs font-bold text-white/70">
                  {g.label}
                </span>
                <span
                  className={`text-xs font-bold tabular-nums ${
                    g.subtotal >= 0 ? "text-emerald-300" : "text-red-300"
                  }`}
                  data-testid={`ledger-subtotal-${g.key}`}
                >
                  小計 {signed(g.subtotal)}
                </span>
              </div>
              <ul className="divide-y divide-white/10">
                {g.items.map((e) => {
                  const pos = e.amount >= 0;
                  return (
                    <li
                      key={e.id}
                      className="flex items-center justify-between gap-3 py-2"
                      data-testid={`ledger-entry-${e.id}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70">
                            {e.categoryLabel}
                          </span>
                          <span className="truncate text-xs text-white/75">
                            {e.description}
                          </span>
                        </div>
                        <div className="text-[10px] text-white/40">
                          {formatDateTime(e.createdAt)}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 text-sm font-bold tabular-nums ${
                          pos ? "text-emerald-300" : "text-red-300"
                        }`}
                      >
                        {pos ? "+" : "−"}
                        {formatBigNumber(Math.abs(e.amount))}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
