import React, { useState } from "react";
import { Loader2, Users, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useMobilizationStatus, useMobilizationActions } from "@/lib/mobilization";

const fmt = (n: number) => Math.round(n).toLocaleString("zh-TW");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "操作失敗");
const btn =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-40";

/** 軍事頁「全民皆兵」:戰時把 10% 人口變民兵,期間每回合固定掉穩定度;解散後人口補回。 */
export function MobilizationPanel() {
  const { data, isLoading } = useMobilizationStatus();
  const { start, stop } = useMobilizationActions();
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);

  if (isLoading || !data) return null;

  const busy = start.isPending || stop.isPending;
  // 不在戰爭、也沒開啟:不佔版面(避免平時干擾)。
  if (!data.active && !data.atWar) return null;

  const blocker = data.active
    ? null
    : data.hasMercenaryContract
      ? "簽有僱傭兵合約期間不能開啟,請先解約"
      : data.stability < data.minStabilityToStart
        ? `穩定度過低(需至少 ${data.minStabilityToStart},目前 ${data.stability})`
        : data.previewLevy <= 0
          ? "可徵召人口不足"
          : null;

  const onStart = () =>
    start.mutate(undefined, {
      onSuccess: (r) => {
        setConfirming(false);
        toast({ title: "全民皆兵已開啟", description: `徵召 ${fmt(r.levy ?? 0)} 名民兵` });
      },
      onError: (e) => toast({ title: "無法開啟", description: errMsg(e), variant: "destructive" }),
    });
  const onStop = () =>
    stop.mutate(undefined, {
      onSuccess: (r) =>
        toast({
          title: "全民皆兵已關閉",
          description: `解散 ${fmt(r.disbanded ?? 0)} 名民兵,人口補回 ${fmt(r.releasedPopulation ?? 0)}`,
        }),
      onError: (e) => toast({ title: "無法關閉", description: errMsg(e), variant: "destructive" }),
    });

  const m = data.militia;
  return (
    <div
      className={`rounded-2xl border p-4 backdrop-blur-sm md:p-5 ${
        data.active ? "border-red-400/50 bg-red-950/40" : "border-amber-300/30 bg-black/55"
      }`}
      data-testid="panel-mobilization"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-serif text-base font-bold">
            <Users className="h-5 w-5 text-amber-300" />
            全民皆兵
            {data.active && (
              <span className="rounded bg-red-500/30 px-2 py-0.5 text-xs text-red-100">實施中</span>
            )}
          </div>
          <p className="mt-1 text-sm text-white/70">
            戰時動員:把可徵召人口的 {data.popRatioPct}% 編成「{m.label}」(視為正規部隊,不占生產力、不收維護費)。
            實施期間每回合穩定度 −{data.stabilityPerTurn};解散民兵後人口如數補回。與僱傭兵合約互斥。
          </p>
          <p className="mt-1 text-xs text-white/55">
            民兵數值:血量 {m.hp} / 攻擊 {m.attack} / 防禦 {m.defense} / 命中 {m.accuracy}%(隨時代成長)
          </p>
          {data.active ? (
            <p className="mt-2 text-sm text-red-100" data-testid="text-mobilization-active">
              已徵召 {fmt(data.lastLevy)} 人 · 累計穩定度損失 {fmt(data.totalStabilityLost)}
              {!data.atWar && "(戰爭已結束,建議盡快解散)"}
            </p>
          ) : (
            <p className="mt-2 text-sm text-amber-100" data-testid="text-mobilization-preview">
              現在開啟將徵召約 {fmt(data.previewLevy)} 人
            </p>
          )}
          {blocker && (
            <p className="mt-1 flex items-center gap-1 text-xs text-red-200">
              <AlertTriangle className="h-3.5 w-3.5" />
              {blocker}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {data.active ? (
            <button
              className={`${btn} border-white/25 bg-black/40 text-white/85 hover:bg-black/60`}
              disabled={busy}
              onClick={onStop}
              data-testid="button-mobilization-stop"
            >
              {stop.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              關閉並解散民兵
            </button>
          ) : confirming ? (
            <>
              <button
                className={`${btn} border-red-400/50 bg-red-500/25 text-red-100 hover:bg-red-500/40`}
                disabled={busy || !!blocker}
                onClick={onStart}
                data-testid="button-mobilization-confirm"
              >
                {start.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                確認動員
              </button>
              <button
                className={`${btn} border-white/20 bg-black/40 text-white/80 hover:bg-black/60`}
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                取消
              </button>
            </>
          ) : (
            <button
              className={`${btn} border-amber-300/60 bg-amber-500/25 text-amber-100 hover:bg-amber-500/40`}
              disabled={busy || !!blocker}
              onClick={() => setConfirming(true)}
              data-testid="button-mobilization-start"
            >
              開啟全民皆兵
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
