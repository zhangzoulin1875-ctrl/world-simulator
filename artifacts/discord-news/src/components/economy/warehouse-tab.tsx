import { useState } from "react";
import { ChevronDown, Loader2, Lock, Package } from "lucide-react";
import { useGetWarehouse, getGetWarehouseQueryKey } from "@workspace/api-client-react";
import type { Warehouse, WarehouseGood } from "@workspace/api-client-react";
import { formatBigNumber } from "@/components/military-shared";

const ERA_ZH: Record<string, string> = {
  classical: "古典", roman: "羅馬", early_medieval: "中世紀初", high_medieval: "中世紀盛",
  renaissance: "文藝復興", discovery: "大航海", scientific: "科學革命", enlightenment: "啟蒙",
  industrial: "工業", ww1: "一戰", ww2: "二戰", cold_war: "冷戰", modern: "現代", future: "未來",
};

const TIERS: { key: WarehouseGood["tier"]; title: string; hint: string }[] = [
  { key: "basic", title: "基礎物資", hint: "建設與軍需的底層資源" },
  { key: "industrial", title: "工業物資", hint: "靠地區特產取得，決定工業與軍事潛力" },
  { key: "luxury", title: "奢侈品", hint: "可作為交易籌碼（黑市功能即將推出）" },
];

export function WarehouseTab() {
  const { data, isLoading, isError, refetch } = useGetWarehouse({
    query: { queryKey: getGetWarehouseQueryKey(), staleTime: 1000 * 15 },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-white/15 bg-black/50 py-16 backdrop-blur">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        <span>載入倉庫資料中…</span>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-xl border border-white/15 bg-black/50 p-8 text-center backdrop-blur">
        <p className="mb-4 text-sm text-white/70">無法載入倉庫資料。</p>
        <button
          onClick={() => refetch()}
          className="rounded-lg bg-white/15 px-4 py-2 text-sm font-semibold transition hover:bg-white/25"
          data-testid="button-retry-warehouse"
        >
          重新載入
        </button>
      </div>
    );
  }
  return <WarehouseContent data={data} />;
}

function WarehouseContent({ data }: { data: Warehouse }) {
  const hasAnyProduction = data.goods.some((g) => g.perTurn > 0);
  return (
    <div className="space-y-4" data-testid="warehouse-tab">
      <div className="rounded-xl border border-white/15 bg-black/50 p-4 backdrop-blur">
        <div className="flex items-center gap-2">
          <Package className="h-5 w-5 text-amber-200" />
          <h3 className="font-serif text-base font-bold">倉庫</h3>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-white/60">
          各種物資的庫存。控制帶有特產的地區，每回合會自動產出對應物資（主產區{" "}
          {3 * data.baseOutput}、次產區 {data.baseOutput}，依控制比例折算）。糧食有獨立的「糧食」分頁。
        </p>
        {!hasAnyProduction && (
          <p className="mt-2 text-xs text-amber-200/80" data-testid="warehouse-no-production">
            你目前沒有控制任何特產地區，物資不會自動增加。
          </p>
        )}
      </div>

      {TIERS.map((tier) => {
        const goods = data.goods.filter((g) => g.tier === tier.key);
        if (goods.length === 0) return null;
        return (
          <section key={tier.key} data-testid={`warehouse-tier-${tier.key}`}>
            <div className="mb-2 flex items-baseline gap-2 px-1">
              <h4 className="font-serif text-sm font-bold text-white/90">{tier.title}</h4>
              <span className="text-xs text-white/45">{tier.hint}</span>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              {goods.map((g) => (
                <GoodCard key={g.slug} good={g} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function GoodCard({ good }: { good: WarehouseGood }) {
  const [open, setOpen] = useState(false);
  const locked = !good.unlocked;
  const canExpand = good.sources.length > 0;

  return (
    <div
      className={`rounded-xl border bg-black/50 p-4 backdrop-blur ${
        locked ? "border-white/10 opacity-70" : "border-white/15"
      }`}
      data-testid={`warehouse-good-${good.slug}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5">
            <h5 className="font-serif text-base font-bold">{good.label}</h5>
            {locked && <Lock className="h-3.5 w-3.5 text-white/50" />}
          </div>
          {locked && good.unlockEra && (
            <p className="mt-0.5 text-xs text-white/50" data-testid={`warehouse-locked-${good.slug}`}>
              {ERA_ZH[good.unlockEra] ?? good.unlockEra}時代解鎖
            </p>
          )}
        </div>
        <div className="text-right">
          <div className="font-mono text-xl font-bold tabular-nums" data-testid={`warehouse-stock-${good.slug}`}>
            {formatBigNumber(good.stock)}
          </div>
          <div
            className={`text-xs tabular-nums ${good.perTurn > 0 ? "text-emerald-300" : "text-white/45"}`}
            data-testid={`warehouse-perturn-${good.slug}`}
          >
            {good.perTurn > 0 ? `+${formatBigNumber(good.perTurn)} / 回合` : "無產出"}
          </div>
        </div>
      </div>

      {canExpand && (
        <>
          <button
            onClick={() => setOpen((v) => !v)}
            className="mt-3 flex w-full items-center justify-between rounded-lg bg-white/5 px-3 py-1.5 text-xs text-white/70 transition hover:bg-white/10"
            aria-expanded={open}
            data-testid={`warehouse-toggle-${good.slug}`}
          >
            <span>產出來源（{good.sources.length} 個地區）</span>
            <ChevronDown className={`h-3.5 w-3.5 transition ${open ? "rotate-180" : ""}`} />
          </button>
          {open && (
            <ul className="mt-2 space-y-1" data-testid={`warehouse-sources-${good.slug}`}>
              {good.sources.map((s) => (
                <li key={s.regionName} className="flex items-center justify-between text-xs">
                  <span className="text-white/80">
                    {s.regionName}
                    {s.major && (
                      <span className="ml-1.5 rounded bg-amber-400/20 px-1 py-0.5 text-[10px] text-amber-200">
                        主產
                      </span>
                    )}
                    <span className="ml-1.5 text-white/40">控制 {s.percent}%</span>
                  </span>
                  <span className="tabular-nums text-emerald-300/90">+{formatBigNumber(s.perTurn)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
