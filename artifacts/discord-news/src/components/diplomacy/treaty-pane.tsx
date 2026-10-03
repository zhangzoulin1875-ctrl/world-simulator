import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Info, Loader2, ScrollText, X } from "lucide-react";
import {
  useListDiplomacyTreaties,
  getListDiplomacyTreatiesQueryKey,
  useProposeDiplomacyTreaty,
  useAcceptDiplomacyTreaty,
  useAnnulDiplomacyTreaty,
  useWithdrawDiplomacyTreaty,
  useRejectDiplomacyTreaty,
  useGetNpcTreatyHistory,
  getGetNpcTreatyHistoryQueryKey,
  useGetNpcTreatyCaps,
  getGetNpcTreatyCapsQueryKey,
  useGetPlayerNation,
  getGetPlayerNationQueryKey,
} from "@workspace/api-client-react";
import type {
  DiplomacyNation,
  DiplomacyTreaty,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/components/military-shared";
import { PaneHeader } from "./shared";
import { CeasefireCard } from "./ceasefire-card";
import { VassalConsentCard } from "./vassal-consent-card";
import { NpcHistoryCard } from "./npc-history-card";

function treatyStatusBadge(t: DiplomacyTreaty) {
  switch (t.status) {
    case "proposed":
      return (
        <span className="rounded bg-amber-500/25 px-1.5 py-0.5 text-[10px] font-bold text-amber-200">
          待回覆
        </span>
      );
    case "active":
      return (
        <span className="rounded bg-emerald-500/25 px-1.5 py-0.5 text-[10px] font-bold text-emerald-200">
          生效中
        </span>
      );
    case "rejected":
      return (
        <span className="rounded bg-red-500/25 px-1.5 py-0.5 text-[10px] font-bold text-red-200">
          已拒絕
        </span>
      );
    case "expired":
      return (
        <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-bold text-white/60">
          已到期
        </span>
      );
    case "annulled":
      return (
        <span className="rounded bg-orange-500/25 px-1.5 py-0.5 text-[10px] font-bold text-orange-200">
          已廢除
        </span>
      );
    case "withdrawn":
      return (
        <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-bold text-white/60">
          已撤回
        </span>
      );
    default:
      return (
        <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-bold text-white/60">
          已被對案取代
        </span>
      );
  }
}

export function TreatyPane({
  nation,
  onBackMobile,
  highlightTreatyId,
  onHighlightConsumed,
}: {
  nation: DiplomacyNation;
  onBackMobile: () => void;
  highlightTreatyId?: number | null;
  onHighlightConsumed?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useListDiplomacyTreaties({
    query: {
      queryKey: getListDiplomacyTreatiesQueryKey(),
      refetchInterval: 15_000,
    },
  });
  // Task #90 — NPC 提案記憶：只對 NPC 對象查詢（玩家對玩家後端不套用記憶，也不顯示）。
  const npcHistory = useGetNpcTreatyHistory(nation.id, {
    query: {
      queryKey: getGetNpcTreatyHistoryQueryKey(nation.id),
      enabled: nation.isNpc,
    },
  });
  const npcHistoryEntries = npcHistory.data?.entries ?? [];
  // Task #570 — NPC 締約資源上限：只對 NPC 對象查詢；後端提案守門用同一計算。
  const npcCapsQuery = useGetNpcTreatyCaps(nation.id, {
    query: {
      queryKey: getGetNpcTreatyCapsQueryKey(nation.id),
      enabled: nation.isNpc,
      staleTime: 1000 * 30,
    },
  });
  const npcCaps = nation.isNpc ? (npcCapsQuery.data?.caps ?? null) : null;
  const treatyTypes = data?.treatyTypes ?? [];
  const myRegions = data?.myRegions ?? [];
  const treaties = (data?.treaties ?? []).filter(
    (t) => t.proposerNationId === nation.id || t.targetNationId === nation.id,
  );

  // Task #341 — 由行動晶片跳轉時捲動到並短暫高亮指定提案。
  const highlightRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlightTreatyId == null) return;
    const el = highlightRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(() => onHighlightConsumed?.(), 2600);
    return () => window.clearTimeout(timer);
  }, [highlightTreatyId, treaties.length, onHighlightConsumed]);

  const [type, setType] = useState("nonaggression");
  const [permanent, setPermanent] = useState(true);
  const [days, setDays] = useState("365");
  const [money, setMoney] = useState("0");
  const [tech, setTech] = useState("0");
  const [wood, setWood] = useState("0");
  const [ore, setOre] = useState("0");
  const [reqMoney, setReqMoney] = useState("0");
  const [reqTech, setReqTech] = useState("0");
  const [reqWood, setReqWood] = useState("0");
  const [reqOre, setReqOre] = useState("0");
  // Task #214 — 自訂條約表單狀態：條款文字、每回合經常性轉移量、付款方向。
  const [customClause, setCustomClause] = useState("");
  const [perTurnMoney, setPerTurnMoney] = useState("0");
  const [perTurnTech, setPerTurnTech] = useState("0");
  const [perTurnProduction, setPerTurnProduction] = useState("0");
  const [perTurnFood, setPerTurnFood] = useState("0");
  // Task #476 — 每回合木材／礦石（庫存制：付款方不足該項則本回合略過）。
  const [perTurnWood, setPerTurnWood] = useState("0");
  const [perTurnOre, setPerTurnOre] = useState("0");
  // Task #527 — 反向每回合定期支付（對方每回合付給我方）。新提案固定
  // proposerIsPayer=true：perTurn*=我方付、requestPerTurn*=對方付。
  const [reqPerTurnMoney, setReqPerTurnMoney] = useState("0");
  const [reqPerTurnTech, setReqPerTurnTech] = useState("0");
  const [reqPerTurnProduction, setReqPerTurnProduction] = useState("0");
  const [reqPerTurnFood, setReqPerTurnFood] = useState("0");
  const [reqPerTurnWood, setReqPerTurnWood] = useState("0");
  const [reqPerTurnOre, setReqPerTurnOre] = useState("0");
  // 附庸條約表單狀態：貢金比例（%稅收）與方向（我方是否為附庸）。
  const [tributePct, setTributePct] = useState("10");
  const [proposerIsVassal, setProposerIsVassal] = useState(true);
  const [npcReply, setNpcReply] = useState<{
    decision: string;
    note: string;
  } | null>(null);

  const isCustom = type === "custom";
  const isVassal = type === "vassal";

  const regionNames = data?.regionNames ?? {};

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: getListDiplomacyTreatiesQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getGetPlayerNationQueryKey(),
    });
    if (nation.isNpc) {
      // NPC 拒絕／對案、玩家撤回都會新增一筆記憶，立即刷新顯示。
      void queryClient.invalidateQueries({
        queryKey: getGetNpcTreatyHistoryQueryKey(nation.id),
      });
    }
  };

  const propose = useProposeDiplomacyTreaty({
    mutation: {
      onSuccess: (result) => {
        invalidate();
        if (result.npcDecision) {
          setNpcReply({
            decision: result.npcDecision,
            note: result.npcNote ?? "",
          });
        } else {
          toast({ title: "提案已送出", description: "等待對方回覆。" });
        }
        setMoney("0");
        setTech("0");
        setReqMoney("0");
        setReqTech("0");
      },
      onError: (err) =>
        toast({ title: "提案失敗", description: apiErrorMessage(err) }),
    },
  });

  const accept = useAcceptDiplomacyTreaty({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "條約已成立" });
      },
      onError: (err) =>
        toast({ title: "無法接受", description: apiErrorMessage(err) }),
    },
  });
  const reject = useRejectDiplomacyTreaty({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "已拒絕條約" });
      },
      onError: (err) =>
        toast({ title: "無法拒絕", description: apiErrorMessage(err) }),
    },
  });
  const [withdrawConfirmId, setWithdrawConfirmId] = useState<number | null>(
    null,
  );
  // Task #377 — 接受條約前的確認摘要：列出我方將付出／獲得的一次性轉移，
  // 以我方餘額／掌控做前端預警（後端 400 仍為最終防線）。
  const [acceptConfirmId, setAcceptConfirmId] = useState<number | null>(null);
  const { data: myNationEnvelope } = useGetPlayerNation({
    query: {
      queryKey: getGetPlayerNationQueryKey(),
      staleTime: 1000 * 30,
    },
  });
  const myNation = myNationEnvelope?.nation ?? null;
  const withdraw = useWithdrawDiplomacyTreaty({
    mutation: {
      onSuccess: () => {
        setWithdrawConfirmId(null);
        invalidate();
        toast({
          title: "提案已撤回",
          description: "你可以重新向對方送出新的條約提案。",
        });
      },
      onError: (err) => {
        setWithdrawConfirmId(null);
        toast({ title: "無法撤回", description: apiErrorMessage(err) });
      },
    },
  });
  const [annulConfirmId, setAnnulConfirmId] = useState<number | null>(null);
  const annul = useAnnulDiplomacyTreaty({
    mutation: {
      onSuccess: () => {
        setAnnulConfirmId(null);
        invalidate();
        toast({
          title: "條約已廢除",
          description: "兩國關係值大幅下降，對方已收到通知。",
        });
      },
      onError: (err) => {
        setAnnulConfirmId(null);
        toast({ title: "無法廢除", description: apiErrorMessage(err) });
      },
    },
  });

  // 切換締約對象時重置整份提案表單與各種確認狀態，
  // 避免把上一國的草稿（金額/地區/自訂條款等）帶到新對象。
  useEffect(() => {
    setType("nonaggression");
    setPermanent(true);
    setDays("365");
    setMoney("0");
    setTech("0");
    setWood("0");
    setOre("0");
    setReqMoney("0");
    setReqTech("0");
    setReqWood("0");
    setReqOre("0");
    setCustomClause("");
    setPerTurnMoney("0");
    setPerTurnTech("0");
    setPerTurnProduction("0");
    setPerTurnFood("0");
    setPerTurnWood("0");
    setPerTurnOre("0");
    setReqPerTurnMoney("0");
    setReqPerTurnTech("0");
    setReqPerTurnProduction("0");
    setReqPerTurnFood("0");
    setReqPerTurnWood("0");
    setReqPerTurnOre("0");
    setNpcReply(null);
    setWithdrawConfirmId(null);
    setAnnulConfirmId(null);
    setAcceptConfirmId(null);
  }, [nation.id]);

  const doPropose = () => {
    if (propose.isPending) return;
    const durationDays = permanent ? null : Number(days);
    if (!permanent && (!Number.isInteger(durationDays) || durationDays! < 1)) {
      toast({ title: "時效必須是至少 1 天的整數" });
      return;
    }
    // Task #374 — 一次性雙向交換欄位（所有條約類型共用，含自訂）。
    const offerMoney = Number(money) || 0;
    const offerTechPoints = Number(tech) || 0;
    const offerWood = Number(wood) || 0;
    const offerOre = Number(ore) || 0;
    const requestMoney = Number(reqMoney) || 0;
    const requestTechPoints = Number(reqTech) || 0;
    const requestWood = Number(reqWood) || 0;
    const requestOre = Number(reqOre) || 0;
    const oneTime = {
      offerMoney,
      offerTechPoints,
      offerWood,
      offerOre,
      offerRegionIds: [] as number[],
      offerRegionPercents: {} as Record<string, number>,
      requestMoney,
      requestTechPoints,
      requestWood,
      requestOre,
      requestRegionIds: [] as number[],
      requestRegionPercents: {} as Record<string, number>,
    };
    if (isCustom) {
      const clause = customClause.trim();
      const ptMoney = Number(perTurnMoney) || 0;
      const ptTech = Number(perTurnTech) || 0;
      const ptProduction = Number(perTurnProduction) || 0;
      const ptFood = Number(perTurnFood) || 0;
      const ptWood = Number(perTurnWood) || 0;
      const ptOre = Number(perTurnOre) || 0;
      // Task #527 — 反向每回合（對方每回合付給我方）。
      const rptMoney = Number(reqPerTurnMoney) || 0;
      const rptTech = Number(reqPerTurnTech) || 0;
      const rptProduction = Number(reqPerTurnProduction) || 0;
      const rptFood = Number(reqPerTurnFood) || 0;
      const rptWood = Number(reqPerTurnWood) || 0;
      const rptOre = Number(reqPerTurnOre) || 0;
      if (clause.length > 500) {
        toast({ title: "自訂條款不可超過 500 字" });
        return;
      }
      if (
        [
          ptMoney,
          ptTech,
          ptProduction,
          ptFood,
          ptWood,
          ptOre,
          rptMoney,
          rptTech,
          rptProduction,
          rptFood,
          rptWood,
          rptOre,
        ].some((n) => !Number.isInteger(n) || n < 0)
      ) {
        toast({ title: "每回合經常性轉移必須是不小於 0 的整數" });
        return;
      }
      if (
        !clause &&
        ptMoney === 0 &&
        ptTech === 0 &&
        ptProduction === 0 &&
        ptFood === 0 &&
        ptWood === 0 &&
        ptOre === 0 &&
        rptMoney === 0 &&
        rptTech === 0 &&
        rptProduction === 0 &&
        rptFood === 0 &&
        rptWood === 0 &&
        rptOre === 0
      ) {
        toast({ title: "自訂條約至少要有條款文字或一項每回合經常性轉移" });
        return;
      }
      propose.mutate({
        data: {
          targetNationId: nation.id,
          type: "custom",
          durationDays,
          customClause: clause.length > 0 ? clause : null,
          perTurnMoney: ptMoney,
          perTurnTech: ptTech,
          perTurnProduction: ptProduction,
          perTurnFood: ptFood,
          perTurnWood: ptWood,
          perTurnOre: ptOre,
          // Task #527 — 新提案固定「perTurn*=我方付、requestPerTurn*=對方付」。
          requestPerTurnMoney: rptMoney,
          requestPerTurnTech: rptTech,
          requestPerTurnProduction: rptProduction,
          requestPerTurnFood: rptFood,
          requestPerTurnWood: rptWood,
          requestPerTurnOre: rptOre,
          proposerIsPayer: true,
          ...oneTime,
        },
      });
      return;
    }
    if (isVassal) {
      const pct = Number(tributePct);
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
        toast({ title: "貢金比例必須是 1–100 的整數" });
        return;
      }
      propose.mutate({
        data: {
          targetNationId: nation.id,
          type: "vassal",
          durationDays,
          tributePct: pct,
          proposerIsVassal,
          ...oneTime,
        },
      });
      return;
    }
    propose.mutate({
      data: {
        targetNationId: nation.id,
        type: type as "nonaggression" | "military_access" | "guarantee",
        durationDays,
        ...oneTime,
      },
    });
  };

  const npcDecisionLabel =
    npcReply?.decision === "accept"
      ? "對方同意了你的條約！"
      : npcReply?.decision === "reject"
        ? "對方拒絕了你的條約。"
        : "對方提出了對案，請至下方條約列表回覆。";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PaneHeader nation={nation} onBackMobile={onBackMobile} />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {/* Task #235 — 停戰提案卡片：與選定國家有進行中戰爭時顯示於提案區最上方 */}
        <CeasefireCard nation={nation} />
        {/* 附庸外交同意：宗主待審請求／附庸請求近況（與選定國家相關時才顯示） */}
        <VassalConsentCard nation={nation} />
        {npcReply && (
          <div className="relative rounded-xl border border-purple-400/40 bg-purple-500/15 p-4 backdrop-blur">
            <button
              onClick={() => setNpcReply(null)}
              className="absolute right-2 top-2 rounded p-1 text-white/50 hover:bg-white/10"
              data-testid="button-dismiss-npc-reply"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="mb-1 flex items-center gap-1.5 text-sm font-bold text-purple-200">
              <Bot className="h-4 w-4" />
              {npcDecisionLabel}
            </div>
            {npcReply.note && (
              <p className="text-sm text-white/80">「{npcReply.note}」</p>
            )}
          </div>
        )}

        {/* NPC 提案記憶（Task #90）：只對 NPC 對象顯示，玩家對玩家不顯示 */}
        {nation.isNpc && npcHistoryEntries.length > 0 && (
          <section
            className="rounded-xl border border-purple-400/30 bg-purple-500/10 p-4 backdrop-blur"
            data-testid="npc-history-section"
          >
            <h3 className="mb-1 flex items-center gap-1.5 text-sm font-bold text-purple-200">
              <Bot className="h-4 w-4" />
              對方記得的近期提案
            </h3>
            <p className="mb-2 text-[11px] text-white/55">
              {nation.name} 會參考近 7 天內雙方已結束的提案來回覆。條件相近的重提可能被更嚴格對待。
            </p>
            <div className="space-y-1.5">
              {npcHistoryEntries.map((entry, i) => (
                <NpcHistoryCard key={i} entry={entry} />
              ))}
            </div>
          </section>
        )}

        {/* 提案表單 */}
        <section className="rounded-xl border border-white/15 bg-black/50 p-4 backdrop-blur">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-bold">
            <ScrollText className="h-4 w-4 text-amber-300" />
            向 {nation.name} 提出條約
            {nation.isNpc && (
              <span className="text-[11px] font-normal text-purple-200">
                （NPC 將由 AI 立即回覆）
              </span>
            )}
          </h3>
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {treatyTypes.map((t) => (
                <button
                  key={t.slug}
                  onClick={() => setType(t.slug)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    type === t.slug
                      ? "bg-amber-500/90 text-black"
                      : "bg-white/10 text-white/75 hover:bg-white/20"
                  }`}
                  data-testid={`treaty-type-${t.slug}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            {(() => {
              const sel = treatyTypes.find((t) => t.slug === type);
              return sel ? (
                <p
                  className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90"
                  data-testid="text-treaty-type-description"
                >
                  <Info className="mr-1 inline h-3.5 w-3.5 text-amber-300" />
                  效果：{sel.description}
                </p>
              ) : null;
            })()}
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={permanent}
                  onChange={(e) => setPermanent(e.target.checked)}
                  className="accent-amber-500"
                  data-testid="checkbox-permanent"
                />
                無期限
              </label>
              {!permanent && (
                <label className="flex items-center gap-1.5">
                  時效
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    className="w-20 rounded border border-white/15 bg-white/10 px-2 py-1 text-sm focus:border-amber-400 focus:outline-none"
                    data-testid="input-duration-days"
                  />
                  天
                </label>
              )}
            </div>
            {/* Task #374 — 一次性雙向交換（所有條約類型，含自訂） */}
            <div className="space-y-3 rounded-lg border border-emerald-400/25 bg-emerald-500/5 p-3">
              <div className="text-xs font-bold text-emerald-200">
                我方提供（條約成立時一次轉移給 {nation.name}）
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-white/60">金錢</span>
                  <input
                    type="number"
                    min={0}
                    value={money}
                    onChange={(e) => setMoney(e.target.value)}
                    className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                    data-testid="input-offer-money"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-white/60">科技點數</span>
                  <input
                    type="number"
                    min={0}
                    value={tech}
                    onChange={(e) => setTech(e.target.value)}
                    className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                    data-testid="input-offer-tech"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-white/60">木材</span>
                  <input
                    type="number"
                    min={0}
                    value={wood}
                    onChange={(e) => setWood(e.target.value)}
                    className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                    data-testid="input-offer-wood"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-white/60">礦石</span>
                  <input
                    type="number"
                    min={0}
                    value={ore}
                    onChange={(e) => setOre(e.target.value)}
                    className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                    data-testid="input-offer-ore"
                  />
                </label>
              </div>
            </div>
            <div className="space-y-3 rounded-lg border border-sky-400/25 bg-sky-500/5 p-3">
              <div className="text-xs font-bold text-sky-200">
                要求 {nation.name} 提供（條約成立時一次轉移給我方）
              </div>
              {npcCaps && (
                <p
                  className="text-[11px] leading-relaxed text-sky-200/70"
                  data-testid="text-npc-treaty-caps-onetime"
                >
                  NPC 可提供上限：金錢{" "}
                  {npcCaps.money.toLocaleString("zh-TW")}、科技點數{" "}
                  {npcCaps.techPoints.toLocaleString("zh-TW")}、木材{" "}
                  {npcCaps.wood.toLocaleString("zh-TW")}、礦石{" "}
                  {npcCaps.ore.toLocaleString("zh-TW")}。超過上限的提案會被退回。
                </p>
              )}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-white/60">金錢</span>
                  <input
                    type="number"
                    min={0}
                    value={reqMoney}
                    onChange={(e) => setReqMoney(e.target.value)}
                    className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                    data-testid="input-request-money"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-white/60">科技點數</span>
                  <input
                    type="number"
                    min={0}
                    value={reqTech}
                    onChange={(e) => setReqTech(e.target.value)}
                    className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                    data-testid="input-request-tech"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-white/60">木材</span>
                  <input
                    type="number"
                    min={0}
                    value={reqWood}
                    onChange={(e) => setReqWood(e.target.value)}
                    className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                    data-testid="input-request-wood"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-white/60">礦石</span>
                  <input
                    type="number"
                    min={0}
                    value={reqOre}
                    onChange={(e) => setReqOre(e.target.value)}
                    className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                    data-testid="input-request-ore"
                  />
                </label>
              </div>
            </div>
            {isCustom && (
              <div className="space-y-3 rounded-lg border border-amber-400/25 bg-amber-500/5 p-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-white/60">
                    自訂條款（自由文字，最多 500 字）
                  </span>
                  <textarea
                    value={customClause}
                    maxLength={500}
                    rows={3}
                    onChange={(e) => setCustomClause(e.target.value)}
                    placeholder="例如：雙方互相開放邊境貿易，並共享情報。"
                    className="resize-y rounded border border-white/15 bg-white/10 px-2 py-1.5 text-sm focus:border-amber-400 focus:outline-none"
                    data-testid="input-custom-clause"
                  />
                  <span className="self-end text-[11px] text-white/40">
                    {customClause.length}/500
                  </span>
                </label>
                <div>
                  <div className="mb-1 text-xs text-white/60">
                    我方每回合支付給 {nation.name}（每個回合自動執行）
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">金錢</span>
                      <input
                        type="number"
                        min={0}
                        value={perTurnMoney}
                        onChange={(e) => setPerTurnMoney(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-per-turn-money"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">科技點數</span>
                      <input
                        type="number"
                        min={0}
                        value={perTurnTech}
                        onChange={(e) => setPerTurnTech(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-per-turn-tech"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">生產力</span>
                      <input
                        type="number"
                        min={0}
                        value={perTurnProduction}
                        onChange={(e) => setPerTurnProduction(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-per-turn-production"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">糧食</span>
                      <input
                        type="number"
                        min={0}
                        value={perTurnFood}
                        onChange={(e) => setPerTurnFood(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-per-turn-food"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">木材</span>
                      <input
                        type="number"
                        min={0}
                        value={perTurnWood}
                        onChange={(e) => setPerTurnWood(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-per-turn-wood"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">礦石</span>
                      <input
                        type="number"
                        min={0}
                        value={perTurnOre}
                        onChange={(e) => setPerTurnOre(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-per-turn-ore"
                      />
                    </label>
                  </div>
                </div>
                {/* Task #527 — 反向每回合定期支付：對方每回合付給我方，
                    兩個方向可同時填寫（雙向互相轉移）。 */}
                <div>
                  <div className="mb-1 text-xs text-white/60">
                    {nation.name} 每回合支付給我方（每個回合自動執行）
                  </div>
                  {npcCaps && (
                    <p
                      className="mb-1 text-[11px] leading-relaxed text-sky-200/70"
                      data-testid="text-npc-treaty-caps-per-turn"
                    >
                      NPC 每回合可支付上限：金錢{" "}
                      {npcCaps.perTurnMoney.toLocaleString("zh-TW")}、科技點數{" "}
                      {npcCaps.perTurnTech.toLocaleString("zh-TW")}、生產力{" "}
                      {npcCaps.perTurnProduction.toLocaleString("zh-TW")}、糧食{" "}
                      {npcCaps.perTurnFood.toLocaleString("zh-TW")}、木材{" "}
                      {npcCaps.perTurnWood.toLocaleString("zh-TW")}、礦石{" "}
                      {npcCaps.perTurnOre.toLocaleString("zh-TW")}。
                    </p>
                  )}
                  <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">金錢</span>
                      <input
                        type="number"
                        min={0}
                        value={reqPerTurnMoney}
                        onChange={(e) => setReqPerTurnMoney(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-request-per-turn-money"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">科技點數</span>
                      <input
                        type="number"
                        min={0}
                        value={reqPerTurnTech}
                        onChange={(e) => setReqPerTurnTech(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-request-per-turn-tech"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">生產力</span>
                      <input
                        type="number"
                        min={0}
                        value={reqPerTurnProduction}
                        onChange={(e) =>
                          setReqPerTurnProduction(e.target.value)
                        }
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-request-per-turn-production"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">糧食</span>
                      <input
                        type="number"
                        min={0}
                        value={reqPerTurnFood}
                        onChange={(e) => setReqPerTurnFood(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-request-per-turn-food"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">木材</span>
                      <input
                        type="number"
                        min={0}
                        value={reqPerTurnWood}
                        onChange={(e) => setReqPerTurnWood(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-request-per-turn-wood"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[11px] text-white/50">礦石</span>
                      <input
                        type="number"
                        min={0}
                        value={reqPerTurnOre}
                        onChange={(e) => setReqPerTurnOre(e.target.value)}
                        className="rounded border border-white/15 bg-white/10 px-2 py-1.5 focus:border-amber-400 focus:outline-none"
                        data-testid="input-request-per-turn-ore"
                      />
                    </label>
                  </div>
                  <p className="mt-1 text-[11px] text-white/40">
                    兩個方向可同時填寫（雙向互相轉移）。糧食是流量：輸出方即使自己不夠吃也會照樣送出（可能因此陷入飢荒）。木材／礦石是庫存：付款方當回合庫存不足該項則略過；金錢／科技／生產力餘額不足該項則本回合略過。
                  </p>
                </div>
              </div>
            )}
            {isVassal && (
              <div className="space-y-3 rounded-lg border border-purple-400/25 bg-purple-500/5 p-3">
                <div>
                  <div className="mb-1 text-xs text-white/60">附庸方向</div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setProposerIsVassal(true)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                        proposerIsVassal
                          ? "bg-purple-500/90 text-white"
                          : "bg-white/10 text-white/75 hover:bg-white/20"
                      }`}
                      data-testid="button-vassal-me"
                    >
                      我方成為 {nation.name} 的附庸
                    </button>
                    <button
                      onClick={() => setProposerIsVassal(false)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                        !proposerIsVassal
                          ? "bg-purple-500/90 text-white"
                          : "bg-white/10 text-white/75 hover:bg-white/20"
                      }`}
                      data-testid="button-vassal-them"
                    >
                      邀請 {nation.name} 成為我方附庸
                    </button>
                  </div>
                </div>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-white/60">
                    貢金比例（附庸每回合上繳稅收的 %，1–100）
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={tributePct}
                    onChange={(e) => setTributePct(e.target.value)}
                    className="w-28 rounded border border-white/15 bg-white/10 px-2 py-1.5 text-sm focus:border-purple-400 focus:outline-none"
                    data-testid="input-tribute-pct"
                  />
                </label>
                <p className="text-[11px] text-white/45">
                  附庸每回合自動上繳稅收的指定比例給宗主；附庸被宣戰時宗主自動參戰；雙方強制和平（不可互相宣戰）；附庸的宣戰與聯盟行動需經宗主同意。一國同時只能有一位宗主。
                </p>
              </div>
            )}
            <button
              onClick={doPropose}
              disabled={propose.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-amber-500/90 px-4 py-2 text-sm font-bold text-black transition hover:bg-amber-400 disabled:opacity-40"
              data-testid="button-propose-treaty"
            >
              {propose.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {propose.isPending && nation.isNpc
                ? "對方考慮中…"
                : "送出提案"}
            </button>
          </div>
        </section>

        {/* 條約列表 */}
        <section>
          <h3 className="mb-2 text-sm font-bold text-white/80">
            與 {nation.name} 的條約
          </h3>
          {isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-white/60">
              <Loader2 className="h-4 w-4 animate-spin" />
              載入中…
            </div>
          ) : treaties.length === 0 ? (
            <div className="rounded-lg bg-black/40 px-4 py-6 text-center text-sm text-white/45 backdrop-blur">
              尚無條約紀錄
            </div>
          ) : (
            <div className="space-y-2">
              {treaties.map((t) => {
                const isHighlighted = t.id === highlightTreatyId;
                // Task #374 — 一次性方向與後端 activateTreaty 一致：
                // offer＝提案方→對象、request＝對象→提案方；
                // 僅舊制（#341）非 custom 且 proposerIsPayer=false 的列翻轉。
                // custom 的 proposerIsPayer 只影響每回合經常性轉移，不影響一次性。
                const oneTimeFlipped =
                  !t.proposerIsPayer && t.type !== "custom";
                const payerName = oneTimeFlipped
                  ? t.targetName
                  : t.proposerName;
                const receiverName = oneTimeFlipped
                  ? t.proposerName
                  : t.targetName;
                const hasOneTimeOffer =
                  t.offerMoney > 0 ||
                  t.offerTechPoints > 0 ||
                  (t.offerWood ?? 0) > 0 ||
                  (t.offerOre ?? 0) > 0 ||
                  t.offerRegionIds.length > 0;
                const percents = t.offerRegionPercents ?? {};
                // Task #374 — 要求對方提供側（成立時對方→提案方一次轉移）。
                const reqIds = t.requestRegionIds ?? [];
                const reqPercents = t.requestRegionPercents ?? {};
                const hasOneTimeRequest =
                  (t.requestMoney ?? 0) > 0 ||
                  (t.requestTechPoints ?? 0) > 0 ||
                  (t.requestWood ?? 0) > 0 ||
                  (t.requestOre ?? 0) > 0 ||
                  reqIds.length > 0;
                const regionLabel = (
                  rid: number,
                  pcts: Record<string, number>,
                ) => {
                  const pct = pcts[String(rid)];
                  const name =
                    regionNames[String(rid)] ??
                    myRegions.find((r) => r.regionId === rid)?.regionName ??
                    `#${rid}`;
                  return pct && pct > 0 && pct < 100
                    ? `${name}（${pct}%）`
                    : `${name}（全部）`;
                };
                return (
                <div
                  key={t.id}
                  ref={isHighlighted ? highlightRef : undefined}
                  className={`rounded-xl border p-3 backdrop-blur transition ${
                    isHighlighted
                      ? "border-amber-300/80 bg-amber-500/15 ring-2 ring-amber-300/60"
                      : "border-white/10 bg-black/45"
                  }`}
                  data-testid={`treaty-${t.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-bold">{t.typeLabel}</span>
                    {treatyStatusBadge(t)}
                    {t.boundWarId != null && (
                      <span
                        className="rounded bg-red-500/25 px-1.5 py-0.5 text-[10px] font-bold text-red-200"
                        data-testid={`treaty-ceasefire-${t.id}`}
                      >
                        附條件停戰
                      </span>
                    )}
                    {t.isCounter && (
                      <span className="rounded bg-purple-500/25 px-1.5 py-0.5 text-[10px] font-bold text-purple-200">
                        對案
                      </span>
                    )}
                    <span className="ml-auto text-[11px] text-white/45">
                      {new Date(t.createdAt).toLocaleDateString("zh-TW")}
                    </span>
                  </div>
                  {(() => {
                    const desc = treatyTypes.find(
                      (tt) => tt.slug === t.type,
                    )?.description;
                    return desc ? (
                      <div
                        className="mt-1 text-[11px] text-amber-200/80"
                        data-testid={`treaty-effect-${t.id}`}
                      >
                        效果：{desc}
                      </div>
                    ) : null;
                  })()}
                  {t.boundWarId != null && (
                    <div className="mt-1 text-[11px] text-red-200/80">
                      接受後將立即結束與 {nation.name} 的戰爭。
                    </div>
                  )}
                  <div className="mt-1 text-xs text-white/65">
                    {t.proposerName} → {t.targetName}
                    ・{t.durationDays == null ? "無期限" : `${t.durationDays} 天`}
                  </div>
                  {hasOneTimeOffer && (
                    <div
                      className="mt-1 text-xs text-amber-100/85"
                      data-testid={`treaty-offer-${t.id}`}
                    >
                      一次性給付：{payerName} → {receiverName}
                      {t.offerMoney > 0 &&
                        `・金錢 ${t.offerMoney.toLocaleString("zh-TW")}`}
                      {t.offerTechPoints > 0 &&
                        `・科技點數 ${t.offerTechPoints.toLocaleString("zh-TW")}`}
                      {(t.offerWood ?? 0) > 0 &&
                        `・木材 ${(t.offerWood ?? 0).toLocaleString("zh-TW")}`}
                      {(t.offerOre ?? 0) > 0 &&
                        `・礦石 ${(t.offerOre ?? 0).toLocaleString("zh-TW")}`}
                      {t.offerRegionIds.length > 0 &&
                        `・領土 ${t.offerRegionIds
                          .map((rid) => regionLabel(rid, percents))
                          .join("、")}`}
                    </div>
                  )}
                  {hasOneTimeRequest && (
                    <div
                      className="mt-1 text-xs text-sky-100/85"
                      data-testid={`treaty-request-${t.id}`}
                    >
                      一次性收取：{receiverName} → {payerName}
                      {(t.requestMoney ?? 0) > 0 &&
                        `・金錢 ${(t.requestMoney ?? 0).toLocaleString("zh-TW")}`}
                      {(t.requestTechPoints ?? 0) > 0 &&
                        `・科技點數 ${(t.requestTechPoints ?? 0).toLocaleString("zh-TW")}`}
                      {(t.requestWood ?? 0) > 0 &&
                        `・木材 ${(t.requestWood ?? 0).toLocaleString("zh-TW")}`}
                      {(t.requestOre ?? 0) > 0 &&
                        `・礦石 ${(t.requestOre ?? 0).toLocaleString("zh-TW")}`}
                      {reqIds.length > 0 &&
                        `・領土 ${reqIds
                          .map((rid) => regionLabel(rid, reqPercents))
                          .join("、")}`}
                    </div>
                  )}
                  {t.type === "custom" &&
                    (() => {
                      const payerName = t.proposerIsPayer
                        ? t.proposerName
                        : t.targetName;
                      const beneficiaryName = t.proposerIsPayer
                        ? t.targetName
                        : t.proposerName;
                      const flows: string[] = [];
                      if (t.perTurnMoney > 0)
                        flows.push(
                          `金錢 ${t.perTurnMoney.toLocaleString("zh-TW")}`,
                        );
                      if (t.perTurnTech > 0)
                        flows.push(
                          `科技點數 ${t.perTurnTech.toLocaleString("zh-TW")}`,
                        );
                      if (t.perTurnProduction > 0)
                        flows.push(
                          `生產力 ${t.perTurnProduction.toLocaleString("zh-TW")}`,
                        );
                      if (t.perTurnFood > 0)
                        flows.push(
                          `糧食 ${t.perTurnFood.toLocaleString("zh-TW")}`,
                        );
                      if ((t.perTurnWood ?? 0) > 0)
                        flows.push(
                          `木材 ${(t.perTurnWood ?? 0).toLocaleString("zh-TW")}`,
                        );
                      if ((t.perTurnOre ?? 0) > 0)
                        flows.push(
                          `礦石 ${(t.perTurnOre ?? 0).toLocaleString("zh-TW")}`,
                        );
                      // Task #527 — 反向每回合定期支付（方向相反）。
                      const reverseFlows: string[] = [];
                      if ((t.requestPerTurnMoney ?? 0) > 0)
                        reverseFlows.push(
                          `金錢 ${(t.requestPerTurnMoney ?? 0).toLocaleString("zh-TW")}`,
                        );
                      if ((t.requestPerTurnTech ?? 0) > 0)
                        reverseFlows.push(
                          `科技點數 ${(t.requestPerTurnTech ?? 0).toLocaleString("zh-TW")}`,
                        );
                      if ((t.requestPerTurnProduction ?? 0) > 0)
                        reverseFlows.push(
                          `生產力 ${(t.requestPerTurnProduction ?? 0).toLocaleString("zh-TW")}`,
                        );
                      if ((t.requestPerTurnFood ?? 0) > 0)
                        reverseFlows.push(
                          `糧食 ${(t.requestPerTurnFood ?? 0).toLocaleString("zh-TW")}`,
                        );
                      if ((t.requestPerTurnWood ?? 0) > 0)
                        reverseFlows.push(
                          `木材 ${(t.requestPerTurnWood ?? 0).toLocaleString("zh-TW")}`,
                        );
                      if ((t.requestPerTurnOre ?? 0) > 0)
                        reverseFlows.push(
                          `礦石 ${(t.requestPerTurnOre ?? 0).toLocaleString("zh-TW")}`,
                        );
                      return (
                        <div
                          className="mt-1.5 space-y-1"
                          data-testid={`treaty-custom-${t.id}`}
                        >
                          {t.customClause && (
                            <div className="rounded bg-amber-500/10 px-2 py-1.5 text-xs text-amber-100/90">
                              條款：{t.customClause}
                            </div>
                          )}
                          {flows.length > 0 && (
                            <div className="text-[11px] text-white/60">
                              每回合：{payerName} → {beneficiaryName}（
                              {flows.join("、")}）
                            </div>
                          )}
                          {reverseFlows.length > 0 && (
                            <div
                              className="text-[11px] text-white/60"
                              data-testid={`treaty-custom-reverse-${t.id}`}
                            >
                              每回合：{beneficiaryName} → {payerName}（
                              {reverseFlows.join("、")}）
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  {t.type === "vassal" &&
                    (() => {
                      const vassalName = t.proposerIsVassal
                        ? t.proposerName
                        : t.targetName;
                      const suzerainName = t.proposerIsVassal
                        ? t.targetName
                        : t.proposerName;
                      return (
                        <div
                          className="mt-1 text-xs text-purple-200/85"
                          data-testid={`treaty-vassal-${t.id}`}
                        >
                          附庸關係：{vassalName} 為 {suzerainName} 的附庸・每回合上繳稅收 {t.tributePct}%
                        </div>
                      );
                    })()}
                  {t.status === "active" && t.expiresAt && (
                    <div className="mt-1 text-[11px] text-white/45">
                      到期：{new Date(t.expiresAt).toLocaleString("zh-TW")}
                    </div>
                  )}
                  {t.responseNote && (
                    <div className="mt-1.5 rounded bg-white/5 px-2 py-1.5 text-xs text-white/70">
                      「{t.responseNote}」
                    </div>
                  )}
                  {t.awaitingMe && acceptConfirmId === t.id && (() => {
                    // Task #377 — 我方（接受方＝本列的對象國）將付出／獲得的
                    // 一次性轉移，方向與後端 activateTreaty 一致：
                    // 一般情形我方付 request 側、收 offer 側；
                    // 舊制翻轉列（!proposerIsPayer 且非 custom）則相反。
                    const iPayOffer = oneTimeFlipped;
                    const payMoney = iPayOffer
                      ? t.offerMoney
                      : (t.requestMoney ?? 0);
                    const payTech = iPayOffer
                      ? t.offerTechPoints
                      : (t.requestTechPoints ?? 0);
                    const payWood = iPayOffer
                      ? (t.offerWood ?? 0)
                      : (t.requestWood ?? 0);
                    const payOre = iPayOffer
                      ? (t.offerOre ?? 0)
                      : (t.requestOre ?? 0);
                    const payRegionIds = iPayOffer
                      ? t.offerRegionIds
                      : reqIds;
                    const payPercents = iPayOffer ? percents : reqPercents;
                    const gainMoney = iPayOffer
                      ? (t.requestMoney ?? 0)
                      : t.offerMoney;
                    const gainTech = iPayOffer
                      ? (t.requestTechPoints ?? 0)
                      : t.offerTechPoints;
                    const gainWood = iPayOffer
                      ? (t.requestWood ?? 0)
                      : (t.offerWood ?? 0);
                    const gainOre = iPayOffer
                      ? (t.requestOre ?? 0)
                      : (t.offerOre ?? 0);
                    const gainRegionIds = iPayOffer
                      ? reqIds
                      : t.offerRegionIds;
                    const gainPercents = iPayOffer ? reqPercents : percents;
                    const warnings: string[] = [];
                    if (myNation) {
                      if (payMoney > 0 && myNation.money < payMoney) {
                        warnings.push(
                          `金錢不足：需 ${payMoney.toLocaleString("zh-TW")}，目前僅有 ${myNation.money.toLocaleString("zh-TW")}`,
                        );
                      }
                      if (payTech > 0 && myNation.techPoints < payTech) {
                        warnings.push(
                          `科技點數不足：需 ${payTech.toLocaleString("zh-TW")}，目前僅有 ${myNation.techPoints.toLocaleString("zh-TW")}`,
                        );
                      }
                    }
                    const payItems: string[] = [];
                    if (payMoney > 0)
                      payItems.push(`金錢 ${payMoney.toLocaleString("zh-TW")}`);
                    if (payTech > 0)
                      payItems.push(
                        `科技點數 ${payTech.toLocaleString("zh-TW")}`,
                      );
                    if (payWood > 0)
                      payItems.push(`木材 ${payWood.toLocaleString("zh-TW")}`);
                    if (payOre > 0)
                      payItems.push(`礦石 ${payOre.toLocaleString("zh-TW")}`);
                    for (const rid of payRegionIds) {
                      const held =
                        myRegions.find((r) => r.regionId === rid)?.percent ??
                        0;
                      const need = payPercents[String(rid)];
                      const name =
                        regionNames[String(rid)] ??
                        myRegions.find((r) => r.regionId === rid)
                          ?.regionName ??
                        `#${rid}`;
                      if (held <= 0) {
                        warnings.push(`我方目前並未掌控 ${name}`);
                      } else if (need != null && need > held) {
                        warnings.push(
                          `${name} 掌控不足：將轉移 ${need}%，目前僅掌控 ${held}%`,
                        );
                      }
                      payItems.push(
                        need != null
                          ? `領土 ${name}（目前掌控 ${held}%、將轉移 ${need}%）`
                          : `領土 ${name}（目前掌控 ${held}%、將轉移我方全部掌控份額）`,
                      );
                    }
                    const gainItems: string[] = [];
                    if (gainMoney > 0)
                      gainItems.push(
                        `金錢 ${gainMoney.toLocaleString("zh-TW")}`,
                      );
                    if (gainTech > 0)
                      gainItems.push(
                        `科技點數 ${gainTech.toLocaleString("zh-TW")}`,
                      );
                    if (gainWood > 0)
                      gainItems.push(
                        `木材 ${gainWood.toLocaleString("zh-TW")}`,
                      );
                    if (gainOre > 0)
                      gainItems.push(
                        `礦石 ${gainOre.toLocaleString("zh-TW")}`,
                      );
                    for (const rid of gainRegionIds) {
                      gainItems.push(`領土 ${regionLabel(rid, gainPercents)}`);
                    }
                    return (
                      <div
                        className="mt-2 rounded-lg border border-emerald-300/30 bg-emerald-500/10 p-2.5"
                        data-testid={`accept-confirm-${t.id}`}
                      >
                        <div className="text-xs font-bold text-white/85">
                          確定接受這份「{t.typeLabel}」嗎？
                        </div>
                        <div className="mt-1.5 space-y-1 text-[11px] leading-relaxed">
                          <div className="text-red-200/90">
                            我方將付出：
                            {payItems.length > 0 ? payItems.join("、") : "無"}
                          </div>
                          <div className="text-emerald-200/90">
                            我方將獲得：
                            {gainItems.length > 0
                              ? gainItems.join("、")
                              : "無"}
                          </div>
                          {t.boundWarId != null && (
                            <div className="text-red-200/80">
                              接受後將立即結束與 {nation.name} 的戰爭。
                            </div>
                          )}
                        </div>
                        {warnings.length > 0 && (
                          <div
                            className="mt-1.5 rounded bg-red-500/15 px-2 py-1.5 text-[11px] text-red-200"
                            data-testid={`accept-warnings-${t.id}`}
                          >
                            {warnings.map((w, i) => (
                              <div key={i}>⚠ {w}</div>
                            ))}
                            <div className="mt-0.5 text-red-200/70">
                              照目前狀況接受，很可能會因不足而失敗。
                            </div>
                          </div>
                        )}
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => {
                              setAcceptConfirmId(null);
                              accept.mutate({ id: t.id });
                            }}
                            disabled={accept.isPending || reject.isPending}
                            className="flex items-center gap-1 rounded-lg bg-emerald-500/85 px-3 py-1.5 text-xs font-bold text-black transition hover:bg-emerald-400 disabled:opacity-40"
                            data-testid={`button-accept-confirm-${t.id}`}
                          >
                            {accept.isPending && (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            確認接受
                          </button>
                          <button
                            onClick={() => setAcceptConfirmId(null)}
                            disabled={accept.isPending}
                            className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-white/80 transition hover:bg-white/20 disabled:opacity-40"
                            data-testid={`button-accept-cancel-${t.id}`}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                  {t.awaitingMe && acceptConfirmId !== t.id && (
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => setAcceptConfirmId(t.id)}
                        disabled={accept.isPending || reject.isPending}
                        className="rounded-lg bg-emerald-500/85 px-3 py-1.5 text-xs font-bold text-black transition hover:bg-emerald-400 disabled:opacity-40"
                        data-testid={`button-accept-treaty-${t.id}`}
                      >
                        接受
                      </button>
                      <button
                        onClick={() => reject.mutate({ id: t.id })}
                        disabled={accept.isPending || reject.isPending}
                        className="rounded-lg bg-red-500/80 px-3 py-1.5 text-xs font-bold transition hover:bg-red-400 disabled:opacity-40"
                        data-testid={`button-reject-treaty-${t.id}`}
                      >
                        拒絕
                      </button>
                    </div>
                  )}
                  {t.status === "proposed" &&
                    !t.awaitingMe &&
                    (withdrawConfirmId === t.id ? (
                      <div
                        className="mt-2 rounded-lg border border-white/25 bg-white/5 p-2.5"
                        data-testid={`withdraw-confirm-${t.id}`}
                      >
                        <div className="text-xs font-bold text-white/85">
                          確定要撤回這份「{t.typeLabel}」提案嗎？
                        </div>
                        <div className="mt-1 text-[11px] leading-relaxed text-white/70">
                          撤回後這份提案立即失效，對方將無法再回覆；
                          不影響兩國關係值，之後可以重新送出新的提案。
                          對方也會收到通知。
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => withdraw.mutate({ id: t.id })}
                            disabled={withdraw.isPending}
                            className="flex items-center gap-1 rounded-lg bg-white/85 px-3 py-1.5 text-xs font-bold text-black transition hover:bg-white disabled:opacity-40"
                            data-testid={`button-withdraw-confirm-${t.id}`}
                          >
                            {withdraw.isPending && (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            確認撤回
                          </button>
                          <button
                            onClick={() => setWithdrawConfirmId(null)}
                            disabled={withdraw.isPending}
                            className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-white/80 transition hover:bg-white/20 disabled:opacity-40"
                            data-testid={`button-withdraw-cancel-${t.id}`}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2">
                        <button
                          onClick={() => setWithdrawConfirmId(t.id)}
                          disabled={withdraw.isPending}
                          className="rounded-lg border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-bold text-white/85 transition hover:bg-white/20 disabled:opacity-40"
                          data-testid={`button-withdraw-treaty-${t.id}`}
                        >
                          撤回提案
                        </button>
                      </div>
                    ))}
                  {t.status === "active" &&
                    (annulConfirmId === t.id ? (
                      <div
                        className="mt-2 rounded-lg border border-orange-400/40 bg-orange-500/10 p-2.5"
                        data-testid={`annul-confirm-${t.id}`}
                      >
                        <div className="text-xs font-bold text-orange-200">
                          確定要廢除這份「{t.typeLabel}」條約嗎？
                        </div>
                        <div className="mt-1 text-[11px] leading-relaxed text-white/70">
                          廢約後條約效力立即消失（宣戰限制、自動參戰等隨之解除），
                          兩國關係值將大幅下降（−30），對方也會收到通知。
                          已轉移的資源不會退還。
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => annul.mutate({ id: t.id })}
                            disabled={annul.isPending}
                            className="flex items-center gap-1 rounded-lg bg-orange-500/90 px-3 py-1.5 text-xs font-bold text-black transition hover:bg-orange-400 disabled:opacity-40"
                            data-testid={`button-annul-confirm-${t.id}`}
                          >
                            {annul.isPending && (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            確認廢除
                          </button>
                          <button
                            onClick={() => setAnnulConfirmId(null)}
                            disabled={annul.isPending}
                            className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold text-white/80 transition hover:bg-white/20 disabled:opacity-40"
                            data-testid={`button-annul-cancel-${t.id}`}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2">
                        <button
                          onClick={() => setAnnulConfirmId(t.id)}
                          disabled={annul.isPending}
                          className="rounded-lg border border-orange-400/40 bg-orange-500/15 px-3 py-1.5 text-xs font-bold text-orange-200 transition hover:bg-orange-500/30 disabled:opacity-40"
                          data-testid={`button-annul-treaty-${t.id}`}
                        >
                          廢除條約
                        </button>
                      </div>
                    ))}
                </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
