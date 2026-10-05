import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ChevronRight,
  Loader2,
  Lock,
  Pencil,
  Rocket,
  Sparkles,
  Swords,
  Trash2,
  UserMinus,
  X,
} from "lucide-react";
import {
  getGetPlayerNationQueryKey,
  getGetMilitaryOverviewQueryKey,
  getGetMilitaryQueueQueryKey,
  useRecruitMilitaryUnits,
  usePurchaseMilitaryUnits,
  useRenameMilitaryUnit,
  useDisbandMilitaryUnits,
  useDeleteMilitaryUnitTemplate,
  useEquipMilitaryWeapon,
} from "@workspace/api-client-react";
import type {
  MilitaryOverview,
  MilitaryUnitTemplate,
  MilitaryWeapon,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  MilitaryPageGuard,
  NavalLandingBar,
  ResourceBar,
  apiErrorMessage,
  formatBigNumber,
} from "@/components/military-shared";
import { GameNotifications } from "@/components/game-notifications";
import { TrainingQueuePanel } from "@/components/training-queue-panel";
import { HelpButton } from "@/components/help-button";
import { WarHqTab } from "@/components/war-hq-tab";
import { WarOrdersTab } from "@/components/war-orders-tab";
import { GeneralsTab } from "@/components/generals-tab";
import { MercenaryTab, ContractNotice } from "@/components/mercenary-tab";

type TabKey = "build" | "hq" | "orders" | "generals" | "contracts";

export default function GameMilitary() {
  return (
    <MilitaryPageGuard
      pageTitle="軍事介面"
      loginDescription="請先以 Discord 登入，才能管理你的軍隊。"
      render={(overview, bg) => <MilitaryScreen bg={bg} overview={overview} />}
    />
  );
}

function MilitaryScreen({
  bg,
  overview,
}: {
  bg: string;
  overview: MilitaryOverview;
}) {
  const [tab, setTab] = useState<TabKey>("build");

  const tabs: { key: TabKey; label: string }[] = [
    { key: "build", label: "建造軍隊" },
    { key: "hq", label: "指揮部" },
    { key: "orders", label: "軍事指令" },
    { key: "generals", label: "武將" },
    { key: "contracts", label: "軍事合約" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-cover bg-center text-white"
      style={{ backgroundImage: `url(${bg})` }}
      data-testid="page-game-military"
    >
      <div className="pointer-events-none fixed inset-0 bg-gradient-to-b from-black/65 via-black/45 to-black/70" />

      <div className="relative mx-auto flex min-h-full max-w-6xl flex-col px-3 pb-10 md:px-6">
        {/* header */}
        <header className="relative flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between md:py-4">
          <HelpButton helpKey={`military:${tab}`} />
          <div className="flex items-center gap-3">
            <Link
              href="/game"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-black/45 backdrop-blur transition hover:bg-black/70"
              title="回玩家首頁"
              data-testid="button-back-game"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex items-center gap-2.5 rounded-lg border border-white/15 bg-black/45 px-3 py-1.5 backdrop-blur">
              <Swords className="h-5 w-5 text-red-300" />
              <span className="font-serif text-base font-bold md:text-lg">軍事介面</span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs text-white/70">
                {overview.currentEraLabel}
              </span>
            </div>
            <Link
              href="/game/missile"
              className="flex items-center gap-1.5 rounded-lg border border-red-300/30 bg-red-500/15 px-3 py-1.5 text-sm font-semibold backdrop-blur transition hover:bg-red-500/30"
              title="導彈系統（1960 年後解鎖）"
              data-testid="link-missile"
            >
              <Rocket className="h-4 w-4 text-red-300" />
              導彈
            </Link>
          </div>
          <div className="flex items-start gap-2">
            <GameNotifications />
            <ResourceBar
              resources={overview.resources}
              wounded={{
                total: overview.woundedTotal,
                speedPct: overview.woundedRecoverySpeedPct,
                ratePct: overview.woundedRecoveryRatePct,
              }}
            />
          </div>
        </header>

        {/* tabs */}
        <div className="mb-4 flex gap-1.5">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-t-lg border border-b-0 px-4 py-2 font-serif text-sm font-bold transition md:px-6 md:text-base ${
                tab === t.key
                  ? "border-amber-300/60 bg-gradient-to-b from-amber-500/25 to-black/60 text-amber-100"
                  : "border-white/15 bg-black/45 text-white/70 hover:bg-black/60"
              }`}
              data-testid={`tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "build" && <BuildTab overview={overview} onOpenContracts={() => setTab("contracts")} />}
        {tab === "hq" && <WarHqTab />}
        {tab === "orders" && <WarOrdersTab />}
        {tab === "generals" && <GeneralsTab />}
        {tab === "contracts" && <MercenaryTab />}
      </div>
    </div>
  );
}

// ── 建造軍隊 ──────────────────────────────────────────────────

function BuildTab({
  overview,
  onOpenContracts,
}: {
  overview: MilitaryOverview;
  onOpenContracts: () => void;
}) {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  const armyByTemplate = useMemo(() => {
    const m = new Map<number, number>();
    for (const a of overview.armies) m.set(a.templateId, a.quantity);
    return m;
  }, [overview.armies]);

  // Task #511 — 只顯示玩家自創兵種（伺服器已只回傳自創；此處防禦性再過濾預設）。
  const customTemplates = useMemo(
    () => overview.templates.filter((t) => !t.isDefault),
    [overview.templates],
  );

  const templates = useMemo(() => {
    return customTemplates.filter(
      (t) => selectedCategory === "all" || t.category === selectedCategory,
    );
  }, [customTemplates, selectedCategory]);

  const unlockedSet = useMemo(
    () => new Set(overview.categories.filter((c) => c.unlocked).map((c) => c.slug)),
    [overview.categories],
  );

  return (
    <div className="space-y-6">
      <ContractNotice onOpen={onOpenContracts} />
      <TrainingQueuePanel templates={overview.templates} />
      {/* category chips */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setSelectedCategory("all")}
          className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
            selectedCategory === "all"
              ? "border-amber-300/70 bg-amber-500/20 text-amber-100"
              : "border-white/20 bg-black/45 text-white/75 hover:bg-black/65"
          }`}
          data-testid="chip-category-all"
        >
          全部
        </button>
        {overview.categories.map((c) => (
          <button
            key={c.slug}
            onClick={() => c.unlocked && setSelectedCategory(c.slug)}
            disabled={!c.unlocked}
            title={
              c.unlocked
                ? undefined
                : (c.lockReason ??
                  (c.requiredKeyName
                    ? `${c.label}將隨世界時代自動解鎖(${c.requiredKeyName})`
                    : `${c.label}尚未解鎖`))
            }
            className={`flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
              !c.unlocked
                ? "cursor-not-allowed border-white/10 bg-black/30 text-white/30"
                : selectedCategory === c.slug
                  ? "border-amber-300/70 bg-amber-500/20 text-amber-100"
                  : "border-white/20 bg-black/45 text-white/75 hover:bg-black/65"
            }`}
            data-testid={`chip-category-${c.slug}`}
          >
            {!c.unlocked && <Lock className="h-3 w-3" />}
            {c.label}
            {!c.unlocked && c.requiredKeyName && (
              <span className="text-[10px] text-white/40">
                需「{c.requiredKeyName}」
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Task #550 — 生產力額度摘要：招募與購買共用，下單前即可看到剩餘上限 */}
      <div
        className="rounded-lg border border-orange-300/25 bg-black/45 px-4 py-3 backdrop-blur"
        data-testid="section-production-quota"
      >
        <div className="mb-2 text-xs font-semibold text-orange-200">
          生產力額度（招募與金錢購買共用）
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <div className="rounded bg-white/8 px-2.5 py-1.5">
            <div className="text-[10px] text-white/50">總生產力</div>
            <div
              className="font-bold tabular-nums text-white/90"
              data-testid="text-production-total"
            >
              {formatBigNumber(overview.resources.productionTotal)}
            </div>
          </div>
          <div className="rounded bg-white/8 px-2.5 py-1.5">
            <div className="text-[10px] text-white/50">本回合招募花費</div>
            <div
              className="font-bold tabular-nums text-red-300"
              data-testid="text-recruit-spend-current-turn"
            >
              −{formatBigNumber(overview.resources.currentTurnSpend)}
            </div>
          </div>
          <div className="rounded bg-white/8 px-2.5 py-1.5">
            <div className="text-[10px] text-white/50">已佔用</div>
            <div
              className="font-bold tabular-nums text-yellow-300"
              data-testid="text-production-spent"
            >
              −{formatBigNumber(overview.resources.productionSpent)}
            </div>
          </div>
          <div className="rounded border border-emerald-300/30 bg-emerald-500/10 px-2.5 py-1.5">
            <div className="text-[10px] text-emerald-200/80">剩餘可用額度</div>
            <div
              className="font-bold tabular-nums text-emerald-300"
              data-testid="text-production-available"
            >
              {formatBigNumber(overview.resources.production)}
            </div>
          </div>
        </div>
      </div>

      {/* purchase quota note */}
      <div
        className="rounded-lg border border-white/15 bg-black/45 px-4 py-2.5 text-xs text-white/70 backdrop-blur"
        data-testid="text-purchase-quota"
      >
        今日金錢購買額度：已用 {formatBigNumber(overview.purchase.usedUnits)} /上限{" "}
        {formatBigNumber(overview.purchase.capUnits)} 單位（每日約為總人口的
        1%，跨日重置）
      </div>

      {/* 海上登陸能力（研發海戰後顯示） */}
      <NavalLandingBar info={overview.navalLanding} />

      {/* 兵種設計子頁入口 */}
      <div className="grid gap-3">
        <Link
          href="/game/military/tech"
          className="flex items-center justify-between gap-3 rounded-xl border border-purple-300/30 bg-gradient-to-r from-purple-900/50 to-black/55 px-4 py-3.5 backdrop-blur transition hover:border-purple-300/60 hover:from-purple-900/70"
          data-testid="link-design-page"
        >
          <div className="flex items-center gap-3">
            <Sparkles className="h-6 w-6 text-purple-300" />
            <div>
              <div className="font-serif text-base font-bold">兵種設計</div>
              <div className="text-xs text-white/60">
                AI 依你的描述設計專屬自訂兵種
              </div>
            </div>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-white/50" />
        </Link>
      </div>

      {/* template cards */}
      <div className="grid gap-4 md:grid-cols-2">
        {templates.length === 0 && (
          <div
            className="col-span-full rounded-xl border border-white/15 bg-black/50 p-8 text-center text-sm text-white/50"
            data-testid="text-no-templates"
          >
            {customTemplates.length === 0 ? (
              <>
                你還沒有任何自創兵種。請先到
                <Link
                  href="/game/military/tech"
                  className="mx-1 font-semibold text-purple-300 underline underline-offset-2 hover:text-purple-200"
                  data-testid="link-design-empty"
                >
                  兵種設計
                </Link>
                設計專屬兵種後，才能在此建造軍隊。
              </>
            ) : (
              "這個類別目前沒有可用的兵種模板。"
            )}
          </div>
        )}
        {templates.map((t) => (
          <UnitCard
            key={t.id}
            template={t}
            owned={armyByTemplate.get(t.id) ?? 0}
            unlocked={unlockedSet.has(t.category)}
            maxOrderQuantity={overview.maxOrderQuantity}
            availableProduction={overview.resources.production}
            weapons={overview.weapons}
          />
        ))}
      </div>
    </div>
  );
}

/** 顯示用四捨五入至最多 1 位小數（維護費為 doublePrecision，可能有小數）。 */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded bg-white/8 px-2 py-1 text-center">
      <div className="text-[10px] text-white/50">{label}</div>
      <div className="text-xs font-bold tabular-nums">{value}</div>
    </div>
  );
}

// Task #590 — 兵種介紹過長時可點「顯示更多」展開全文、「收起」折回兩行；
// 以 scrollHeight vs clientHeight 量測是否真的溢出兩行，未溢出不顯示按鈕。
function UnitDescription({
  templateId,
  description,
}: {
  templateId: number;
  description: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => {
      // 展開時以 clamp 樣式暫時量測會造成閃爍，改為僅在收起狀態量測；
      // 展開狀態沿用先前的 overflowing 判定（內容不變時結果相同）。
      if (!expanded) {
        setOverflowing(el.scrollHeight > el.clientHeight + 1);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [expanded, description]);

  return (
    <div className="mt-1">
      <p
        ref={textRef}
        className={`text-xs text-white/60 ${expanded ? "" : "line-clamp-2"}`}
        data-testid={`text-unit-description-${templateId}`}
      >
        {description}
      </p>
      {(overflowing || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[11px] font-semibold text-amber-300/80 transition hover:text-amber-200"
          data-testid={`button-toggle-description-${templateId}`}
        >
          {expanded ? "收起" : "顯示更多"}
        </button>
      )}
    </div>
  );
}

function UnitCard({
  template: t,
  owned,
  unlocked,
  maxOrderQuantity,
  availableProduction,
  weapons,
}: {
  template: MilitaryUnitTemplate;
  owned: number;
  unlocked: boolean;
  maxOrderQuantity: number;
  /** Task #568 — 剩餘可用生產力額度（總量 − 已佔用 − 本回合招募花費）。 */
  availableProduction: number;
  /** 武器系統 — 玩家武器庫（裝備下拉選單用）。 */
  weapons: MilitaryWeapon[];
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [qtyText, setQtyText] = useState("100");
  const [editing, setEditing] = useState(false);
  const [nameText, setNameText] = useState("");
  const [disbandText, setDisbandText] = useState("");

  const displayName = t.customName ?? t.name;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getGetMilitaryOverviewQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetMilitaryQueueQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPlayerNationQueryKey() });
  };

  const equipMutation = useEquipMilitaryWeapon({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        if (res.equippedWeaponId === null) {
          toast({ title: "已卸除武器", description: `${displayName} 不再裝備武器` });
        } else if (res.compatible === false) {
          toast({
            title: "已裝備（不合用）",
            description: `武器與兵種不相容：${res.modsLabel}`,
          });
        } else {
          toast({ title: "裝備完成", description: res.modsLabel });
        }
      },
      onError: (err) =>
        toast({ title: "裝備失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });

  const recruitMutation = useRecruitMilitaryUnits({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: res.queued ? "已加入訓練佇列" : "徵召完成",
          description:
            res.quantity === null
              ? `${displayName} 開始訓練，完成後自動編入軍隊`
              : `${displayName} 現有 ${formatBigNumber(res.quantity)} 單位`,
        });
      },
      onError: (err) =>
        toast({ title: "徵召失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });
  const purchaseMutation = usePurchaseMilitaryUnits({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        toast({
          title: res.queued ? "已加入訓練佇列" : "購買完成",
          description:
            res.quantity === null
              ? `${displayName} 開始訓練，完成後自動編入軍隊`
              : `${displayName} 現有 ${formatBigNumber(res.quantity)} 單位`,
        });
      },
      onError: (err) =>
        toast({ title: "購買失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });

  const renameMutation = useRenameMilitaryUnit({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        setEditing(false);
        toast({
          title: res.customName ? "改名完成" : "已還原原名",
          description: res.customName
            ? `兵種名稱已改為「${res.customName}」`
            : `已還原為「${t.name}」`,
        });
      },
      onError: (err) =>
        toast({ title: "改名失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });
  const disbandMutation = useDisbandMilitaryUnits({
    mutation: {
      onSuccess: (res) => {
        invalidate();
        setDisbandText("");
        toast({
          title: "解散完成",
          description: `${displayName} 剩餘 ${formatBigNumber(res.quantity)} 單位`,
        });
      },
      onError: (err) =>
        toast({ title: "解散失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });
  const deleteMutation = useDeleteMilitaryUnitTemplate({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "刪除完成", description: `自創兵種「${displayName}」已刪除` });
      },
      onError: (err) =>
        toast({ title: "刪除失敗", description: apiErrorMessage(err), variant: "destructive" }),
    },
  });

  const qty = Number(qtyText);
  const qtyValid = Number.isInteger(qty) && qty > 0 && qty <= maxOrderQuantity;
  // Task #557 — 招募與購買共用同一條生產力「佔用」公式：⌈數量 × 每單位佔用 ÷ 100⌉。
  const prodCost = qtyValid ? Math.ceil((qty * t.prodUpkeepPerUnit) / 100) : 0;
  // Task #568 — 招募另有「立即性花費」（一次性消耗、跨回合歸零、解散不退還）。
  const recruitSpend = qtyValid
    ? Math.ceil((qty * t.prodCostPer100) / 100)
    : 0;
  const popCost = qtyValid ? qty * t.popCostPerUnit : 0;
  const moneyCost = qtyValid ? qty * t.moneyCostPerUnit : 0;
  const addedMoneyUpkeep = qtyValid ? round1(qty * t.upkeepPerUnit) : 0;
  // Task #546 — 金錢購買也佔用生產力：⌈數量 × 每單位佔用 ÷ 100⌉。
  const purchaseProdReserve = qtyValid
    ? Math.ceil((qty * t.prodUpkeepPerUnit) / 100)
    : 0;
  // Task #568 — 下單前即時提示：招募＝佔用＋立即花費一起吃額度（後端守衛仍在）。
  const recruitOverProduction =
    qtyValid && prodCost + recruitSpend > availableProduction;
  const purchaseOverProduction =
    qtyValid && purchaseProdReserve > availableProduction;
  const disbandQty = Number(disbandText);
  const disbandValid =
    Number.isInteger(disbandQty) &&
    disbandQty > 0 &&
    disbandQty <= Math.min(owned, maxOrderQuantity);
  const busy =
    recruitMutation.isPending ||
    purchaseMutation.isPending ||
    renameMutation.isPending ||
    disbandMutation.isPending ||
    deleteMutation.isPending;

  return (
    <div
      className="rounded-xl border border-white/15 bg-black/55 p-4 backdrop-blur"
      data-testid={`card-unit-${t.id}`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          {editing ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                value={nameText}
                onChange={(e) => setNameText(e.target.value)}
                maxLength={40}
                placeholder={t.name}
                className="w-40 rounded-lg border border-white/20 bg-black/50 px-2.5 py-1 text-sm outline-none focus:border-amber-300/60"
                data-testid={`input-rename-${t.id}`}
              />
              <button
                onClick={() =>
                  renameMutation.mutate({ id: t.id, data: { name: nameText.trim() || null } })
                }
                disabled={busy}
                className="rounded bg-amber-500/85 px-2.5 py-1 text-xs font-bold text-black transition hover:bg-amber-400 disabled:opacity-40"
                data-testid={`button-save-rename-${t.id}`}
              >
                {renameMutation.isPending ? "儲存中…" : "儲存"}
              </button>
              {t.customName && (
                <button
                  onClick={() => renameMutation.mutate({ id: t.id, data: { name: null } })}
                  disabled={busy}
                  className="rounded bg-white/15 px-2.5 py-1 text-xs font-semibold transition hover:bg-white/25 disabled:opacity-40"
                  data-testid={`button-clear-rename-${t.id}`}
                >
                  還原原名
                </button>
              )}
              <button
                onClick={() => setEditing(false)}
                className="rounded p-1 text-white/50 transition hover:text-white"
                title="取消"
                data-testid={`button-cancel-rename-${t.id}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-serif text-base font-bold">{displayName}</span>
              {t.customName && (
                <span className="text-[11px] text-white/35">原名：{t.name}</span>
              )}
              <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/60">
                {t.categoryLabel}
              </span>
              {t.isCustom && (
                <span className="rounded bg-purple-500/25 px-1.5 py-0.5 text-[10px] text-purple-200">
                  自訂
                </span>
              )}
              <button
                onClick={() => {
                  setNameText(t.customName ?? "");
                  setEditing(true);
                }}
                className="rounded p-1 text-white/45 transition hover:text-amber-300"
                title="改名"
                data-testid={`button-rename-${t.id}`}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {t.description && !editing && (
            <UnitDescription templateId={t.id} description={t.description} />
          )}
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] text-white/50">持有</div>
          <div className="text-sm font-bold tabular-nums text-amber-200">
            {formatBigNumber(owned)}
          </div>
        </div>
      </div>

      <div className="mb-2 grid grid-cols-5 gap-1.5">
        <StatChip label="HP" value={formatBigNumber(t.hp)} />
        <StatChip label="攻擊" value={formatBigNumber(t.attack)} />
        <StatChip label="防禦" value={formatBigNumber(t.defense)} />
        <StatChip label="速度" value={String(t.speed)} />
        <StatChip label="命中" value={`${t.accuracy}%`} />
      </div>

      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/60">
        <span>
          {t.range === "ranged" ? "遠程" : "近戰"}
        </span>
        <span>生產力占用 {round1(t.prodUpkeepPerUnit)}/100 單位</span>
        <span data-testid={`text-prod-cost-${t.id}`}>
          招募花費 {round1(t.prodCostPer100)}/100 單位
        </span>
        <span>人口 {t.popCostPerUnit}/單位</span>
        <span>價格 {formatBigNumber(t.moneyCostPerUnit)}/單位</span>
        <span>木材 {t.woodCostPerUnit}/單位</span>
        <span>礦石 {t.oreCostPerUnit}/單位</span>
        <span data-testid={`text-upkeep-${t.id}`}>
          金錢維護 {round1(t.upkeepPerUnit)}/單位
        </span>
        <span className="text-sky-300/80">抗騎兵 {t.antiCavalryPct}%</span>
        <span className="text-sky-300/80">抗射手 {t.antiRangedPct}%</span>
        <span className="text-sky-300/80">抗火炮 {t.antiArtilleryPct}%</span>
        <span className="text-orange-300/80">攻城 {t.siegePct}%</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={1}
          max={maxOrderQuantity}
          value={qtyText}
          onChange={(e) => setQtyText(e.target.value)}
          className="w-28 rounded-lg border border-white/20 bg-black/50 px-3 py-1.5 text-sm tabular-nums outline-none focus:border-amber-300/60"
          data-testid={`input-qty-${t.id}`}
        />
        <button
          onClick={() =>
            qtyValid &&
            recruitMutation.mutate({ data: { templateId: t.id, quantity: qty } })
          }
          disabled={!qtyValid || !unlocked || busy}
          className="flex items-center gap-1.5 rounded-lg bg-red-600/80 px-3 py-1.5 text-sm font-semibold transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
          title={
            qtyValid
              ? `佔用生產力 ${formatBigNumber(prodCost)}、立即花費生產力 ${formatBigNumber(recruitSpend)}、人口 ${formatBigNumber(popCost)}`
              : undefined
          }
          data-testid={`button-recruit-${t.id}`}
        >
          {recruitMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          徵召
        </button>
        <button
          onClick={() =>
            qtyValid &&
            purchaseMutation.mutate({ data: { templateId: t.id, quantity: qty } })
          }
          disabled={!qtyValid || !unlocked || busy}
          className="flex items-center gap-1.5 rounded-lg bg-yellow-600/80 px-3 py-1.5 text-sm font-semibold transition hover:bg-yellow-600 disabled:cursor-not-allowed disabled:opacity-40"
          title={
            qtyValid
              ? `花費金錢 ${formatBigNumber(moneyCost)}、佔用生產力 ${formatBigNumber(purchaseProdReserve)}（受每日額度限制）`
              : undefined
          }
          data-testid={`button-purchase-${t.id}`}
        >
          {purchaseMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          金錢購買
        </button>
        {qtyValid && (
          <span className="text-[11px] text-white/50" data-testid={`text-cost-estimate-${t.id}`}>
            徵召：佔用生產力 {formatBigNumber(prodCost)}＋立即花費{" "}
            {formatBigNumber(recruitSpend)}／人口 {formatBigNumber(popCost)}；購買：
            {formatBigNumber(moneyCost)} 金錢＋佔用生產力{" "}
            {formatBigNumber(purchaseProdReserve)}（受每日額度限制）；每回合維護新增：金錢{" "}
            {formatBigNumber(addedMoneyUpkeep)}
          </span>
        )}
      </div>

      {/* Task #550 — 超過剩餘生產力額度的即時提示（後端守衛仍在） */}
      {(recruitOverProduction || purchaseOverProduction) && (
        <div
          className="mt-2 rounded-lg border border-red-400/40 bg-red-950/45 px-3 py-1.5 text-[11px] text-red-200"
          data-testid={`text-production-warning-${t.id}`}
        >
          {recruitOverProduction && (
            <div>
              徵召將佔用生產力 {formatBigNumber(prodCost)}＋立即花費{" "}
              {formatBigNumber(recruitSpend)}，超過剩餘可用額度{" "}
              {formatBigNumber(availableProduction)}，送出會被拒絕。
            </div>
          )}
          {purchaseOverProduction && (
            <div>
              金錢購買將佔用生產力 {formatBigNumber(purchaseProdReserve)}
              ，超過剩餘可用額度 {formatBigNumber(availableProduction)}，送出會被拒絕。
            </div>
          )}
        </div>
      )}

      {/* 武器系統 — 裝備列：相容武器加成戰力；不合用則懲罰。 */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2.5">
        <Swords className="h-4 w-4 shrink-0 text-amber-300" />
        <select
          value={t.equippedWeaponId ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            equipMutation.mutate({
              data: { templateId: t.id, weaponId: v === "" ? null : Number(v) },
            });
          }}
          disabled={equipMutation.isPending}
          className="max-w-52 rounded-lg border border-white/20 bg-black/50 px-2.5 py-1.5 text-xs outline-none focus:border-amber-300/60 disabled:opacity-40"
          data-testid={`select-equip-weapon-${t.id}`}
        >
          <option value="" className="bg-zinc-900">
            未裝備武器
          </option>
          {weapons.map((w) => (
            <option key={w.id} value={w.id} className="bg-zinc-900">
              {w.name}（{w.compatibleLabels.join("、")}）
            </option>
          ))}
        </select>
        {t.equippedWeapon && (
          <span
            className={`rounded px-2 py-0.5 text-[10px] ${
              t.equippedWeapon.compatible
                ? "bg-amber-500/15 text-amber-200"
                : "bg-red-500/15 text-red-200"
            }`}
            data-testid={`text-equipped-mods-${t.id}`}
          >
            {t.equippedWeapon.modsLabel}
            {t.equippedWeapon.skillName
              ? `・技能「${t.equippedWeapon.skillName}」`
              : ""}
          </span>
        )}
      </div>

      {/* 管理列：解散軍隊／刪除自創兵種（不退還資源） */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
        <input
          type="number"
          min={1}
          max={Math.min(owned, maxOrderQuantity)}
          value={disbandText}
          onChange={(e) => setDisbandText(e.target.value)}
          placeholder="解散數量"
          disabled={owned <= 0}
          className="w-28 rounded-lg border border-white/20 bg-black/50 px-3 py-1.5 text-sm tabular-nums outline-none focus:border-red-300/60 disabled:opacity-40"
          data-testid={`input-disband-${t.id}`}
        />
        <button
          onClick={() => {
            if (!disbandValid) return;
            if (
              window.confirm(
                `確定要解散 ${formatBigNumber(disbandQty)} 單位的「${displayName}」嗎？解散不會退還任何資源。`,
              )
            ) {
              disbandMutation.mutate({ data: { templateId: t.id, quantity: disbandQty } });
            }
          }}
          disabled={!disbandValid || busy}
          className="flex items-center gap-1.5 rounded-lg bg-red-700/75 px-3 py-1.5 text-sm font-semibold transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid={`button-disband-${t.id}`}
        >
          {disbandMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          <UserMinus className="h-3.5 w-3.5" />
          解散
        </button>
        {t.isCustom && (
          <button
            onClick={() => {
              if (
                window.confirm(
                  `確定要刪除自創兵種「${displayName}」嗎？其軍隊（${formatBigNumber(owned)} 單位）將一併移除，且不退還任何資源。`,
                )
              ) {
                deleteMutation.mutate({ id: t.id });
              }
            }}
            disabled={busy}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-red-400/40 bg-black/40 px-3 py-1.5 text-sm font-semibold text-red-300 transition hover:bg-red-950/60 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid={`button-delete-${t.id}`}
          >
            {deleteMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            <Trash2 className="h-3.5 w-3.5" />
            刪除
          </button>
        )}
      </div>
    </div>
  );
}
