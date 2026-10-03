import React, { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useGetNationStatBreakdown,
  getGetNationStatBreakdownQueryKey,
  useGetPlayerNation,
} from "@workspace/api-client-react";
import type { NationStatBreakdown } from "@workspace/api-client-react";
import { formatBigNumber } from "@/components/military-shared";

/** 首頁可點擊、且會開啟來源明細彈窗的數值欄位。 */
export type BreakdownStatKey =
  | "tech"
  | "production"
  | "population"
  | "stability"
  | "unrest"
  | "warweariness";

const DIRECTION_LABELS: Record<string, string> = {
  law: "農民",
  culture: "工人",
  religion: "教士",
  rights: "貴族(資本家)",
};

const ENTRY_TYPE_LABELS: Record<string, string> = {
  policy: "政策",
  tradition: "傳統",
  reform: "變革",
  event: "事件",
};

const STAT_TITLES: Record<BreakdownStatKey, string> = {
  tech: "科技點數來源明細",
  production: "生產力來源明細",
  population: "總人口來源明細",
  stability: "穩定度來源明細",
  unrest: "暴動度來源明細",
  warweariness: "厭戰度來源明細",
};

/** 顯示用：帶正負號的百分比（0 顯示為 0%）。 */
function signedPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v}%`;
}

function Row({
  label,
  value,
  hint,
  strong,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className={`text-white/70 ${strong ? "font-bold text-white" : ""}`}>
        {label}
        {hint && <span className="ml-1 text-[11px] text-white/40">{hint}</span>}
      </span>
      <span
        className={`tabular-nums ${strong ? "text-base font-bold text-white" : "text-white/90"}`}
      >
        {value}
      </span>
    </div>
  );
}

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="mb-1 text-xs font-bold text-white/50">{title}</div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * 可展開的來源清單（科技節點 / 建築）。
 * pct / items 允許 undefined：持久化快取還原出的舊形狀資料可能缺欄位，
 * 此時以 0% / 空清單安全顯示，而不是渲染 undefined% 或崩潰。
 */
function ExpandableSourceList({
  label,
  pct,
  items,
}: {
  label: string;
  pct: number | undefined;
  items: { name: string; pct: number; count?: number }[] | undefined;
}) {
  const [open, setOpen] = useState(false);
  const safePct = pct ?? 0;
  const safeItems = items ?? [];
  const hasItems = safeItems.length > 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 py-1">
        <button
          type="button"
          onClick={() => hasItems && setOpen((v) => !v)}
          className={`flex items-center gap-1 text-white/70 ${hasItems ? "cursor-pointer hover:text-white/90" : "cursor-default"}`}
        >
          {hasItems ? (
            open ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-white/40" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-white/40" />
            )
          ) : (
            <span className="inline-block w-3" />
          )}
          {label}
        </button>
        <span className="tabular-nums text-white/90">{signedPct(safePct)}</span>
      </div>
      {open && (
        <div className="ml-4 mt-0.5 space-y-0.5 rounded border border-white/10 bg-black/30 px-2 py-1">
          {safeItems.map((it, i) => (
            <div
              key={i}
              className="flex items-baseline justify-between gap-2 text-[11px]"
            >
              <span className="text-white/55">
                {it.name}
                {it.count && it.count > 1 ? (
                  <span className="ml-1 text-white/30">×{it.count}</span>
                ) : null}
              </span>
              <span className="tabular-nums text-white/70">
                {it.pct > 0 ? "+" : ""}
                {it.pct}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 生產力地區貢獻表（含基礎素質 / 投資加成 / 掌控 % / 加權貢獻）。 */
function ProductionRegionTable({
  regions,
}: {
  regions: NationStatBreakdown["regions"];
}) {
  if (regions.length === 0) {
    return <p className="text-xs text-white/50">尚未掌控任何地區，數值為 0。</p>;
  }
  return (
    <div className="max-h-64 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-black/60 text-white/50">
          <tr>
            <th className="py-1 text-left font-medium">地區</th>
            <th className="py-1 text-right font-medium">基礎素質</th>
            <th className="py-1 text-right font-medium">投資加成</th>
            <th className="py-1 text-right font-medium">掌控</th>
            <th className="py-1 text-right font-medium">加權貢獻</th>
          </tr>
        </thead>
        <tbody>
          {regions.map((r) => (
            <tr key={r.regionId} className="border-t border-white/5">
              <td className="py-1 pr-2">
                <div className="text-white/85">{r.name}</div>
                <div className="text-[10px] text-white/40">{r.macroRegion}</div>
              </td>
              <td className="py-1 text-right tabular-nums text-white/70">
                {r.baseProductivity}
              </td>
              <td className="py-1 text-right tabular-nums">
                {r.productivityInvestBonus > 0 ? (
                  <span className="text-amber-400">+{r.productivityInvestBonus}</span>
                ) : (
                  <span className="text-white/30">—</span>
                )}
              </td>
              <td className="py-1 text-right tabular-nums text-white/70">
                {r.percent}%
              </td>
              <td className="py-1 text-right tabular-nums text-white/90">
                {formatBigNumber(r.productivity)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 地區加權貢獻表：依所選數值欄位（人口/科技）呈現。 */
function RegionTable({
  regions,
  field,
}: {
  regions: NationStatBreakdown["regions"];
  field: "population" | "techPoints";
}) {
  if (regions.length === 0) {
    return <p className="text-xs text-white/50">尚未掌控任何地區，數值為 0。</p>;
  }
  return (
    <div className="max-h-52 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-black/60 text-white/50">
          <tr>
            <th className="py-1 text-left font-medium">地區</th>
            <th className="py-1 text-right font-medium">掌控</th>
            <th className="py-1 text-right font-medium">加權貢獻</th>
          </tr>
        </thead>
        <tbody>
          {regions.map((r) => (
            <tr key={r.regionId} className="border-t border-white/5">
              <td className="py-1 pr-2">
                <span className="text-white/85">{r.name}</span>
                <span className="ml-1 text-white/40">{r.macroRegion}</span>
              </td>
              <td className="py-1 text-right tabular-nums text-white/70">
                {r.percent}%
              </td>
              <td className="py-1 text-right tabular-nums text-white/90">
                {formatBigNumber(r[field])}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 可展開的扣減列（Task #541 軍事佔用／建築佔用共用）。 */
function ExpandableSpentRow({
  label,
  amount,
  testId,
  lines,
}: {
  label: string;
  amount: number;
  testId: string;
  lines: {
    key: string | number;
    /** 主要名稱（兵種名／建築名＋等級）。 */
    primary: string;
    /** 次要說明（×數量／地區名）。 */
    secondary?: string;
    reserved: number;
  }[];
}) {
  const [open, setOpen] = useState(false);
  const hasItems = lines.length > 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 py-1">
        <button
          type="button"
          onClick={() => hasItems && setOpen((v) => !v)}
          className={`flex items-center gap-1 text-white/70 ${hasItems ? "cursor-pointer hover:text-white/90" : "cursor-default"}`}
          data-testid={`button-expand-${testId}`}
        >
          {hasItems ? (
            open ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-white/40" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-white/40" />
            )
          ) : (
            <span className="inline-block w-3" />
          )}
          {label}
        </button>
        <span className="tabular-nums text-white/90">
          − {formatBigNumber(amount)}
        </span>
      </div>
      {open && (
        <div className="ml-4 mt-0.5 space-y-0.5 rounded border border-white/10 bg-black/30 px-2 py-1">
          {lines.map((l) => (
            <div
              key={l.key}
              className="flex items-baseline justify-between gap-2 text-[11px]"
              data-testid={`${testId}-line-${l.key}`}
            >
              <span className="text-white/55">
                {l.primary}
                {l.secondary && (
                  <span className="ml-1 text-white/30">{l.secondary}</span>
                )}
              </span>
              <span className="tabular-nums text-white/70">
                − {formatBigNumber(l.reserved)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Task #568 — 本回合招募花費區塊：逐筆明細＋合計（跨回合自動歸零）。 */
function RecruitSpendSection({
  b,
}: {
  b: NationStatBreakdown["production"];
}) {
  if (b.recruitSpendLines.length === 0) {
    return (
      <p
        className="rounded-lg border border-dashed border-white/15 px-3 py-2 text-xs text-white/45"
        data-testid="breakdown-recruit-spend-empty"
      >
        本回合尚未招募，沒有招募花費。
      </p>
    );
  }
  return (
    <>
      <table className="mb-2 w-full text-xs">
        <thead>
          <tr className="text-[10px] text-white/40">
            <th className="pb-1 text-left font-normal">兵種</th>
            <th className="pb-1 text-right font-normal">招募數量</th>
            <th className="pb-1 text-right font-normal">花費</th>
          </tr>
        </thead>
        <tbody>
          {b.recruitSpendLines.map((l, i) => (
            <tr
              key={`${l.templateId}-${l.createdAt}-${i}`}
              className="border-t border-white/5"
              data-testid={`breakdown-recruit-spend-${l.templateId}-${i}`}
            >
              <td className="py-1.5 pr-2 text-white/80">{l.name}</td>
              <td className="py-1.5 text-right tabular-nums text-white/70">
                {formatBigNumber(l.quantity)}
              </td>
              <td className="py-1.5 text-right font-bold tabular-nums text-sky-300">
                −{formatBigNumber(l.amount)}
              </td>
            </tr>
          ))}
          <tr className="border-t border-white/15">
            <td className="py-1.5 pr-2 text-xs font-bold text-white/70" colSpan={2}>
              本回合招募花費合計
            </td>
            <td
              className="py-1.5 text-right text-sm font-bold tabular-nums text-sky-300"
              data-testid="breakdown-recruit-spend-total"
            >
              −{formatBigNumber(b.recruitSpendThisTurn)}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="text-[11px] leading-relaxed text-white/45">
        招募花費是一次性的生產力消耗（⌈數量 × 每 100 單位花費 ÷ 100⌉）：
        只在招募當回合佔住額度，回合結算後自動歸零；解散軍隊不會退還。
        與長期「軍事已佔用」（解散時按比例釋放）分開計算。
      </p>
    </>
  );
}

function ProductionBody({ data }: { data: NationStatBreakdown }) {
  const b = data.production;
  return (
    <div className="space-y-3">
      <SectionCard title="計算流程">
        <Row label="地區加權基礎" value={formatBigNumber(b.regionBase)} />
        {b.treatyBonus !== 0 && (
          <Row
            label="條約輸送生產力"
            hint="生效自訂條約每回合淨流量；廢約即停止"
            value={`${b.treatyBonus >= 0 ? "+" : ""}${formatBigNumber(b.treatyBonus)}`}
          />
        )}
        {b.otherBonus !== 0 && (
          <Row
            label="其他生產力偏移"
            hint="超事件／管理員調整的持久偏移"
            value={`${b.otherBonus >= 0 ? "+" : ""}${formatBigNumber(b.otherBonus)}`}
          />
        )}
        {(b.treatyBonus + b.otherBonus < 0 ||
          b.regionBase + b.treatyBonus + b.otherBonus < 0) && (
          <Row label="基礎合計（下限 0）" value={formatBigNumber(b.base)} />
        )}
        {(b.treatyBonus !== 0 || b.otherBonus !== 0) &&
          b.treatyBonus + b.otherBonus >= 0 &&
          b.regionBase + b.treatyBonus + b.otherBonus >= 0 && (
            <Row label="基礎合計" value={formatBigNumber(b.base)} />
          )}
        <Row label="穩定度乘數" value={`× ${b.stabilityMult}`} />
        <Row label="政策／事件加成" value={signedPct(b.policyPct)} />
        <ExpandableSourceList
          label="生產科技加成"
          pct={b.techPct}
          items={b.techSources}
        />
        <ExpandableSourceList
          label="建築加成"
          pct={b.buildingPct}
          items={b.buildingSources}
        />
        {(b.globalMultiplierPct ?? 100) !== 100 && (
          <Row
            label="全域基礎倍率"
            hint="管理員回合設定的全域生產力倍率"
            value={`× ${(b.globalMultiplierPct ?? 100) / 100}`}
          />
        )}
        <div className="my-1 border-t border-white/10" />
        <Row label="本回合總量" value={formatBigNumber(b.total)} strong />
        <ExpandableSpentRow
          label="軍事已佔用"
          amount={b.armySpent ?? 0}
          testId="spent-army"
          lines={b.spentLines.map((l) => ({
            key: l.templateId,
            primary: l.name,
            secondary: `×${formatBigNumber(l.quantity)}`,
            reserved: l.reserved,
          }))}
        />
        {(b.buildingSpent ?? 0) > 0 && (
          <ExpandableSpentRow
            label="建築已佔用"
            amount={b.buildingSpent}
            testId="spent-building"
            lines={(b.buildingSpentLines ?? []).map((l) => ({
              key: l.buildingId,
              primary: `${l.name} Lv.${l.level}`,
              secondary: l.regionName,
              reserved: l.reserved,
            }))}
          />
        )}
        {b.spent - (b.armySpent ?? 0) - (b.buildingSpent ?? 0) > 0 && (
          <Row
            label="其他佔用（系統校正中）"
            hint="每小時健檢會自動校正此差額"
            value={`− ${formatBigNumber(b.spent - (b.armySpent ?? 0) - (b.buildingSpent ?? 0))}`}
          />
        )}
        <Row
          label="本回合招募花費"
          hint="跨回合自動歸零"
          value={`− ${formatBigNumber(b.recruitSpendThisTurn)}`}
        />
        <Row label="剩餘可用" value={formatBigNumber(b.remaining)} strong />
      </SectionCard>
      <SectionCard title="本回合招募花費（一次性）">
        <RecruitSpendSection b={b} />
      </SectionCard>
      <SectionCard title="各地區貢獻（基礎素質 × 投資加成 × 掌控 %）">
        <ProductionRegionTable regions={data.regions} />
      </SectionCard>
    </div>
  );
}

function TechBody({ data }: { data: NationStatBreakdown }) {
  const b = data.tech;
  return (
    <div className="space-y-3">
      <SectionCard title="計算流程">
        <Row label="地區加權基礎" value={formatBigNumber(b.base)} />
        <Row label="穩定度乘數" value={`× ${b.stabilityMult}`} />
        <Row label="政策／事件加成" value={signedPct(b.policyPct)} />
        <Row label="科技研發加成" value={signedPct(b.techBonusPct)} />
        {(b.globalMultiplierPct ?? 100) !== 100 && (
          <Row
            label="全域基礎倍率"
            hint="管理員回合設定的全域科技點數倍率"
            value={`× ${(b.globalMultiplierPct ?? 100) / 100}`}
          />
        )}
        <div className="my-1 border-t border-white/10" />
        <Row label="每回合科技產出" value={formatBigNumber(b.total)} strong />
      </SectionCard>
      <SectionCard title="各地區貢獻">
        <RegionTable regions={data.regions} field="techPoints" />
      </SectionCard>
    </div>
  );
}

function PopulationBody({ data }: { data: NationStatBreakdown }) {
  const p = data.population;
  const g = p.growth;
  return (
    <div className="space-y-3">
      <SectionCard title="人口組成">
        <Row label="地區加權基礎" value={formatBigNumber(p.base)} />
        <Row
          label="累積人口增長"
          value={`${p.accruedGrowth >= 0 ? "+" : ""}${formatBigNumber(p.accruedGrowth)}`}
        />
        <div className="my-1 border-t border-white/10" />
        <Row label="總人口" value={formatBigNumber(p.total)} strong />
        <Row label="軍事已佔用" value={`− ${formatBigNumber(p.spent)}`} />
        <Row label="剩餘可用" value={formatBigNumber(p.remaining)} strong />
      </SectionCard>
      <SectionCard title="人口增長率（每回合）">
        <Row label="內政基礎" value={signedPct(g.basePct)} />
        <Row label="政策／事件加減成" value={signedPct(g.policyPct)} />
        <ExpandableSourceList
          label="科技樹加成"
          pct={g.techPct}
          items={g.techSources}
        />
        <ExpandableSourceList
          label="建築加成"
          pct={g.buildingPct}
          items={g.buildingSources}
        />
        {(g.buffPct ?? 0) !== 0 && (
          <Row
            label="暫時人口 buff（回合限制）"
            value={signedPct(g.buffPct ?? 0)}
          />
        )}
        <Row label="增長率上限" value={`±${g.capAbsPct}%`} />
        <div className="my-1 border-t border-white/10" />
        <Row label="有效增長率" value={signedPct(g.effectivePct)} strong />
      </SectionCard>
      <SectionCard title="各地區貢獻">
        <RegionTable regions={data.regions} field="population" />
      </SectionCard>
    </div>
  );
}

function PoliticsBody({
  data,
  focus,
}: {
  data: NationStatBreakdown;
  focus: BreakdownStatKey;
}) {
  const p = data.politics;
  const nationQuery = useGetPlayerNation();
  const farmerPct = nationQuery.data?.nation?.farmerPopulationPct;
  return (
    <div className="space-y-3">
      {focus === "stability" && (
        <SectionCard title="穩定度計算">
          <Row label="基底值" value={String(p.stabilityBase)} />
          {p.stabilityEntries.length === 0 ? (
            <p className="py-1 text-xs text-white/50">
              目前沒有影響穩定度的生效中內政條目。
            </p>
          ) : (
            p.stabilityEntries.map((e, i) => (
              <Row
                key={i}
                label={e.title}
                hint={`${ENTRY_TYPE_LABELS[e.entryType] ?? e.entryType}・${DIRECTION_LABELS[e.direction] ?? e.direction}`}
                value={signedPct(e.value)}
              />
            ))
          )}
          <div className="my-1 border-t border-white/10" />
          <Row label="有效穩定度" value={String(p.stabilityEffective)} strong />
        </SectionCard>
      )}
      {focus === "unrest" && (
        <SectionCard title="暴動度">
          <Row label="目前暴動度" value={String(p.unrest)} strong />
          <p className="mt-2 text-xs leading-relaxed text-white/55">
            暴動度由回合結算依四大滿意度計算：滿意度高於{" "}
            {p.satisfactionHighThreshold} 會降低暴動度，低於{" "}
            {p.satisfactionLowThreshold} 會大幅提高暴動度。
          </p>
        </SectionCard>
      )}
      {focus === "warweariness" && (
        <SectionCard title="厭戰度">
          <Row label="目前厭戰度" value={String(p.warWeariness)} strong />
          <p className="mt-2 text-xs leading-relaxed text-white/55">
            厭戰度隨戰爭結算累積、和平時逐步回復；過高會拖累穩定度與人心。
          </p>
        </SectionCard>
      )}
      <SectionCard title="四大階級滿意度">
        <Row label="農民" value={String(p.satisfactions.law)} />
        <Row label="工人" value={String(p.satisfactions.culture)} />
        <Row label="教士" value={String(p.satisfactions.religion)} />
        <Row label="貴族(資本家)" value={String(p.satisfactions.rights)} />
      </SectionCard>
      {typeof farmerPct === "number" && (
        <SectionCard title="人口結構">
          <Row
            label="農民比例"
            value={`${farmerPct}%（約 ${formatBigNumber(
              Math.round((data.population.total * farmerPct) / 100),
            )} 人）`}
          />
          <Row
            label="工人比例"
            value={`${100 - farmerPct}%（約 ${formatBigNumber(
              Math.round((data.population.total * (100 - farmerPct)) / 100),
            )} 人）`}
          />
        </SectionCard>
      )}
    </div>
  );
}

export function StatBreakdownDialog({
  statKey,
  onOpenChange,
}: {
  statKey: BreakdownStatKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = statKey !== null;
  const { data, isLoading, isError } = useGetNationStatBreakdown({
    query: {
      queryKey: getGetNationStatBreakdownQueryKey(),
      enabled: open,
      staleTime: 1000 * 30,
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto border-white/15 bg-neutral-900/95 text-white backdrop-blur"
        data-testid="dialog-stat-breakdown"
      >
        <DialogHeader>
          <DialogTitle className="font-serif">
            {statKey ? STAT_TITLES[statKey] : ""}
          </DialogTitle>
          <DialogDescription className="text-white/50">
            {data ? `數據時代：${data.eraLabel}` : "數值的計算來源與各地區貢獻。"}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center justify-center gap-2 py-8 text-white/60">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span>載入中…</span>
          </div>
        )}
        {isError && (
          <p className="py-6 text-center text-sm text-rose-300">
            載入來源明細失敗，請稍後再試。
          </p>
        )}
        {data && statKey && (
          <>
            {statKey === "tech" && <TechBody data={data} />}
            {statKey === "production" && <ProductionBody data={data} />}
            {statKey === "population" && <PopulationBody data={data} />}
            {(statKey === "stability" ||
              statKey === "unrest" ||
              statKey === "warweariness") && (
              <PoliticsBody data={data} focus={statKey} />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
