import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import { Hourglass, Loader2, Play, Save, ShieldAlert } from "lucide-react";

interface EraInfo {
  slug: string;
  startYear: number;
  label: string;
}

interface TurnTime {
  hour: number;
  minute: number;
}

interface TurnSettings {
  gameDate: string;
  year: number;
  currentEra: string;
  currentEraLabel: string;
  statsEra: string;
  statsEraLabel: string;
  turnTimes: TurnTime[];
  yearsPerTurn: number;
  moneyIncomePct: number;
  populationGrowthMultiplierPct: number;
  productionMultiplierPct: number;
  techMultiplierPct: number;
  aheadEraCostMultiplier: number;
  lastTurnDate: string | null;
  lastTurnAt: string | null;
  runsToday: number;
  totalRunsToday: number;
  nextTurnTime: string | null;
  ranToday: boolean;
  eras: EraInfo[];
}

const MAX_TURN_TIMES = 24;

// Task #584 — 政變後果參數（存於內政參數 /api/politics/settings，這裡提供獨立卡片編輯）。
const COUP_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "coupResetSatisfaction", label: "重置：四大滿意度", hint: "政變後四大階級滿意度重置為此值" },
  { key: "coupResetObedience", label: "重置：軍方滿意度／服從度" },
  { key: "coupResetStability", label: "重置：穩定度" },
  { key: "coupResetSupport", label: "重置：政治支持度" },
  { key: "coupResetUnrest", label: "重置：暴動度", hint: "政變後暴動度重置為此值（預設 0）" },
  {
    key: "coupPolicyLockTurns",
    label: "政策封鎖回合數",
    hint: "封鎖期間無法提交政策想法／政府決策／設計兵種；內閣自動行動靜默跳過",
  },
  { key: "coupMoralePenalty", label: "士氣懲罰點數", hint: "戰役結算時全軍士氣扣減（純計算，不落地）" },
  { key: "coupMoralePenaltyTurns", label: "士氣懲罰回合數" },
];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 依「更新次數」調整時刻列數：增加時補預設列、減少時從尾端裁切。 */
function resizeTurnTimes(times: TurnTime[], count: number): TurnTime[] {
  const target = Math.max(1, Math.min(MAX_TURN_TIMES, Math.floor(count)));
  if (target === times.length) return times;
  if (target < times.length) return times.slice(0, target);
  const next = [...times];
  while (next.length < target) {
    const last = next[next.length - 1];
    next.push(last ? { ...last } : { hour: 18, minute: 0 });
  }
  return next;
}

async function authedFetch(url: string, init?: RequestInit) {
  const token = getAdminToken();
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

function eraLabelForYear(eras: EraInfo[], year: number): string {
  let label = eras[0]?.label ?? "";
  for (const e of eras) {
    if (e.startYear <= year) label = e.label;
    else break;
  }
  return label;
}

export default function TurnSettings() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<TurnSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const [turnTimes, setTurnTimes] = useState<TurnTime[]>([
    { hour: 18, minute: 0 },
  ]);
  const [yearsPerTurn, setYearsPerTurn] = useState("1");
  const [moneyIncomePct, setMoneyIncomePct] = useState("10");
  const [populationGrowthMultiplierPct, setPopulationGrowthMultiplierPct] =
    useState("100");
  const [productionMultiplierPct, setProductionMultiplierPct] = useState("100");
  const [techMultiplierPct, setTechMultiplierPct] = useState("100");
  const [aheadEraCostMultiplier, setAheadEraCostMultiplier] = useState("5");
  const [year, setYear] = useState("1");
  const [syncEraStats, setSyncEraStats] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Task #584 — 政變後果參數（來自內政參數 API，獨立載入／儲存）。
  const [coupSettings, setCoupSettings] = useState<Record<string, number> | null>(
    null,
  );
  const [coupDirty, setCoupDirty] = useState(false);
  const [coupSaving, setCoupSaving] = useState(false);

  const isAdmin = Boolean(getAdminToken());

  const applySettings = (s: TurnSettings) => {
    setSettings(s);
    setTurnTimes(
      s.turnTimes.length > 0
        ? s.turnTimes.map((t) => ({ ...t }))
        : [{ hour: 18, minute: 0 }],
    );
    setYearsPerTurn(String(s.yearsPerTurn));
    setMoneyIncomePct(String(s.moneyIncomePct));
    setPopulationGrowthMultiplierPct(String(s.populationGrowthMultiplierPct));
    setProductionMultiplierPct(String(s.productionMultiplierPct));
    setTechMultiplierPct(String(s.techMultiplierPct));
    setAheadEraCostMultiplier(String(s.aheadEraCostMultiplier));
    setYear(String(s.year));
    setSyncEraStats(false);
    setDirty(false);
  };

  const setCount = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    setTurnTimes((prev) => resizeTurnTimes(prev, n));
    setDirty(true);
  };

  const updateTime = (idx: number, field: "hour" | "minute", raw: string) => {
    const n = Number(raw);
    setTurnTimes((prev) =>
      prev.map((t, i) =>
        i === idx
          ? { ...t, [field]: Number.isFinite(n) ? Math.floor(n) : 0 }
          : t,
      ),
    );
    setDirty(true);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch("/api/turn/settings");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
          );
        }
        if (!cancelled) applySettings(data.settings as TurnSettings);
      } catch (err) {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : "載入失敗");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    (async () => {
      try {
        const res = await authedFetch("/api/politics/settings");
        const data = await res.json().catch(() => ({}));
        if (res.ok && !cancelled) {
          setCoupSettings(data.settings as Record<string, number>);
        }
      } catch {
        // 政變後果卡片載入失敗時不阻擋回合設定頁；卡片自行顯示載入中。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveCoup = async () => {
    if (!coupSettings) return;
    setCoupSaving(true);
    try {
      const res = await authedFetch("/api/politics/settings", {
        method: "PUT",
        body: JSON.stringify(coupSettings),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      setCoupSettings(data.settings as Record<string, number>);
      setCoupDirty(false);
      toast({ title: "已儲存", description: "政變後果參數已更新。" });
    } catch (err) {
      toast({
        title: "儲存失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setCoupSaving(false);
    }
  };

  const save = async () => {
    if (!settings) return;
    const payload: Record<string, unknown> = {};
    const ypt = Number(yearsPerTurn);
    const pct = Number(moneyIncomePct);
    const popMult = Number(populationGrowthMultiplierPct);
    const y = Number(year);
    const timesChanged =
      JSON.stringify(turnTimes) !== JSON.stringify(settings.turnTimes);
    if (timesChanged) payload.turnTimes = turnTimes;
    if (ypt !== settings.yearsPerTurn) payload.yearsPerTurn = ypt;
    if (pct !== settings.moneyIncomePct) payload.moneyIncomePct = pct;
    if (popMult !== settings.populationGrowthMultiplierPct)
      payload.populationGrowthMultiplierPct = popMult;
    const prodMult = Number(productionMultiplierPct);
    if (prodMult !== settings.productionMultiplierPct)
      payload.productionMultiplierPct = prodMult;
    const techMult = Number(techMultiplierPct);
    if (techMult !== settings.techMultiplierPct)
      payload.techMultiplierPct = techMult;
    const aheadMult = Number(aheadEraCostMultiplier);
    if (aheadMult !== settings.aheadEraCostMultiplier)
      payload.aheadEraCostMultiplier = aheadMult;
    if (y !== settings.year) payload.year = y;
    if (syncEraStats) payload.syncEraStats = true;
    if (Object.keys(payload).length === 0) {
      setDirty(false);
      return;
    }
    setSaving(true);
    try {
      const res = await authedFetch("/api/turn/settings", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      applySettings(data.settings as TurnSettings);
      toast({ title: "已儲存", description: "回合設定已更新。" });
    } catch (err) {
      toast({
        title: "儲存失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (
      !window.confirm(
        "確定要立即執行回合嗎？將推進年份、依年份更新時代、發放所有國家的科技與金錢收入（扣除軍隊維護費），並執行內政 AI 結算。可在同一天內多次執行。",
      )
    ) {
      return;
    }
    setRunning(true);
    try {
      const res = await authedFetch("/api/turn/run", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      const s = data.summary ?? {};
      toast({
        title: "回合完成",
        description: `年份 ${s.year ?? "?"}（${s.eraLabel ?? ""}）、結算國家 ${s.nations?.accrued ?? 0}、科技 +${s.nations?.techAdded ?? 0}、收入 +${s.nations?.moneyAdded ?? 0}、維護費 -${s.nations?.upkeepCharged ?? 0}${s.politics?.ok ? "、內政結算完成" : "、內政結算失敗（見伺服器記錄）"}`,
      });
      // 重新載入最新狀態（年份/時代/今日已執行）。
      const fresh = await authedFetch("/api/turn/settings");
      const freshData = await fresh.json().catch(() => ({}));
      if (fresh.ok) applySettings(freshData.settings as TurnSettings);
    } catch (err) {
      toast({
        title: "回合執行失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              需要管理金鑰
            </CardTitle>
            <CardDescription>
              請先在側邊欄底部輸入管理金鑰，才能檢視與調整回合設定。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const previewYear = Number(year);
  const previewEraLabel =
    settings && Number.isInteger(previewYear)
      ? eraLabelForYear(settings.eras, previewYear)
      : "";

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6" data-testid="page-turn-settings">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-bold">
            <Hourglass className="h-6 w-6" />
            回合設定
          </h1>
          <p className="text-sm text-muted-foreground">
            每日自動回合：推進年份與時代、發放國家資源、執行內政 AI 結算。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={runNow}
            disabled={running || !settings}
            data-testid="button-run-turn"
          >
            {running ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-4 w-4" />
            )}
            立即執行回合
          </Button>
          <Button
            onClick={save}
            disabled={saving || !dirty || !settings}
            data-testid="button-save-turn-settings"
          >
            {saving ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-4 w-4" />
            )}
            儲存
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          載入回合設定中…
        </div>
      ) : loadError || !settings ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {loadError ?? "載入失敗"}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">目前世界狀態</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span>
                遊戲日期：<span className="font-medium">{settings.gameDate}</span>
              </span>
              <span>
                時代：
                <Badge variant="secondary" className="ml-1">
                  {settings.currentEraLabel}
                </Badge>
              </span>
              {settings.statsEra !== settings.currentEra && (
                <span>
                  數據時代：
                  <Badge variant="outline" className="ml-1">
                    {settings.statsEraLabel}
                  </Badge>
                  <span className="ml-1 text-[11px] text-muted-foreground">
                    （玩家數據仍以此時代計算）
                  </span>
                </span>
              )}
              <span>
                今日回合：
                <Badge
                  variant={
                    settings.runsToday >= settings.totalRunsToday
                      ? "default"
                      : "outline"
                  }
                  className="ml-1"
                  data-testid="badge-runs-today"
                >
                  已執行 {settings.runsToday}/{settings.totalRunsToday} 次
                </Badge>
              </span>
              {settings.nextTurnTime && (
                <span className="text-muted-foreground">
                  下次時刻：{settings.nextTurnTime}
                </span>
              )}
              {settings.lastTurnDate && (
                <span className="text-muted-foreground">
                  上次執行：{settings.lastTurnDate}
                </span>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">回合排程</CardTitle>
              <CardDescription>
                先設定「每天更新幾次」，再逐一填入每個更新時刻（台北時間）。每個時刻各執行一次完整回合；若把某時刻改到比現在早且該時段今日尚未執行，會在一分鐘內觸發。伺服器若曾離線錯過時刻，重啟後會補跑當天已過但尚未執行的時段。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="max-w-[16rem] space-y-1.5">
                <Label htmlFor="field-turnCount" className="text-xs">
                  每日更新次數（1–{MAX_TURN_TIMES}）
                </Label>
                <Input
                  id="field-turnCount"
                  type="number"
                  min={1}
                  max={MAX_TURN_TIMES}
                  value={turnTimes.length}
                  onChange={(e) => setCount(e.target.value)}
                  data-testid="input-turnCount"
                />
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  各更新時刻
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {turnTimes.map((t, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 rounded-lg border p-2"
                      data-testid={`row-turn-time-${i}`}
                    >
                      <span className="w-10 shrink-0 text-xs text-muted-foreground">
                        第 {i + 1} 次
                      </span>
                      <Input
                        type="number"
                        min={0}
                        max={23}
                        value={t.hour}
                        onChange={(e) => updateTime(i, "hour", e.target.value)}
                        aria-label={`第 ${i + 1} 次時`}
                        data-testid={`input-turn-hour-${i}`}
                        className="w-16"
                      />
                      <span className="text-muted-foreground">:</span>
                      <Input
                        type="number"
                        min={0}
                        max={59}
                        value={t.minute}
                        onChange={(e) => updateTime(i, "minute", e.target.value)}
                        aria-label={`第 ${i + 1} 次分`}
                        data-testid={`input-turn-minute-${i}`}
                        className="w-16"
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  時 0–23、分 0–59；儲存時會自動依時間排序並去除重複時刻。
                </p>
              </div>

              <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="field-yearsPerTurn" className="text-xs">
                    每回合年數（1–100）
                  </Label>
                  <Input
                    id="field-yearsPerTurn"
                    type="number"
                    min={1}
                    max={100}
                    value={yearsPerTurn}
                    onChange={(e) => {
                      setYearsPerTurn(e.target.value);
                      setDirty(true);
                    }}
                    data-testid="input-yearsPerTurn"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="field-moneyIncomePct" className="text-xs">
                    金錢收入比例 %（0–1000）
                  </Label>
                  <Input
                    id="field-moneyIncomePct"
                    type="number"
                    min={0}
                    max={1000}
                    value={moneyIncomePct}
                    onChange={(e) => {
                      setMoneyIncomePct(e.target.value);
                      setDirty(true);
                    }}
                    data-testid="input-moneyIncomePct"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    每回合收入 = 生產力 × 比例 ÷ 100，再扣除軍隊維護費
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="field-populationGrowthMultiplierPct"
                    className="text-xs"
                  >
                    人口增長倍率 %（0–100）
                  </Label>
                  <Input
                    id="field-populationGrowthMultiplierPct"
                    type="number"
                    min={0}
                    max={100}
                    value={populationGrowthMultiplierPct}
                    onChange={(e) => {
                      setPopulationGrowthMultiplierPct(e.target.value);
                      setDirty(true);
                    }}
                    data-testid="input-populationGrowthMultiplierPct"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    每回合人口增長量的縮放倍率：100 = 正常速度、數值越低越慢、0
                    = 停止增長。玩家看到的「有效人口增長率」也會一併反映。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="field-productionMultiplierPct"
                    className="text-xs"
                  >
                    生產力基礎倍率 %（0–1000）
                  </Label>
                  <Input
                    id="field-productionMultiplierPct"
                    type="number"
                    min={0}
                    max={1000}
                    value={productionMultiplierPct}
                    onChange={(e) => {
                      setProductionMultiplierPct(e.target.value);
                      setDirty(true);
                    }}
                    data-testid="input-productionMultiplierPct"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    全國生產力總量的縮放倍率：100 = 正常、200 =
                    兩倍。延長回合間隔時可等比提高；研發成本的全球平均會同步縮放，國力研發倍率不受影響。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="field-techMultiplierPct"
                    className="text-xs"
                  >
                    科技點數基礎倍率 %（0–1000）
                  </Label>
                  <Input
                    id="field-techMultiplierPct"
                    type="number"
                    min={0}
                    max={1000}
                    value={techMultiplierPct}
                    onChange={(e) => {
                      setTechMultiplierPct(e.target.value);
                      setDirty(true);
                    }}
                    data-testid="input-techMultiplierPct"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    每回合科技點數產出的縮放倍率：100 = 正常、200 =
                    兩倍。玩家顯示與回合實際發放一併反映。
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label
                    htmlFor="field-aheadEraCostMultiplier"
                    className="text-xs"
                  >
                    領先時代研發成本倍率（1–100）
                  </Label>
                  <Input
                    id="field-aheadEraCostMultiplier"
                    type="number"
                    min={1}
                    max={100}
                    value={aheadEraCostMultiplier}
                    onChange={(e) => {
                      setAheadEraCostMultiplier(e.target.value);
                      setDirty(true);
                    }}
                    data-testid="input-aheadEraCostMultiplier"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    玩家某科技領域的時代領先世界目前時代時，該領域的研發成本乘上此倍率（不隨領先幅度累乘）；1
                    = 不加價。
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">年份與時代</CardTitle>
              <CardDescription>
                修改年份會立即依「年份 → 時代」對照表更新全世界的時代。玩家國家數據（人口／生產力／科技產出）不會因此被重設成新時代預設值，除非勾選下方「同步預設」。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="field-year" className="text-xs">
                    目前年份（1–9999）
                  </Label>
                  <Input
                    id="field-year"
                    type="number"
                    min={1}
                    max={9999}
                    value={year}
                    onChange={(e) => {
                      setYear(e.target.value);
                      setDirty(true);
                    }}
                    data-testid="input-year"
                  />
                  {previewEraLabel && (
                    <p className="text-[11px] text-muted-foreground">
                      此年份對應時代：{previewEraLabel}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-lg border p-3">
                <Checkbox
                  id="field-syncEraStats"
                  checked={syncEraStats}
                  onCheckedChange={(checked) => {
                    setSyncEraStats(checked === true);
                    setDirty(true);
                  }}
                  data-testid="checkbox-syncEraStats"
                />
                <div className="space-y-0.5">
                  <Label
                    htmlFor="field-syncEraStats"
                    className="text-xs font-medium"
                  >
                    同步預設：玩家數據改用（新）當前時代的預設值
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    勾選後儲存，玩家國家的人口／生產力／科技產出會依當前時代的地區數據重新計算；未勾選則沿用原本的數據時代，玩家數據不變。回合自然推進造成的時代變遷仍會照常同步。
                  </p>
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  年份 → 時代對照表
                </p>
                <div className="grid gap-1.5 text-xs sm:grid-cols-2">
                  {settings.eras.map((e, i) => {
                    const next = settings.eras[i + 1];
                    const range = next
                      ? `${e.startYear}–${next.startYear - 1} 年`
                      : `${e.startYear} 年起`;
                    const active = e.slug === settings.currentEra;
                    return (
                      <div
                        key={e.slug}
                        className={`flex items-center justify-between rounded border px-2 py-1 ${
                          active ? "border-primary bg-primary/5 font-medium" : ""
                        }`}
                      >
                        <span>{e.label}</span>
                        <span className="text-muted-foreground">{range}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-coup-consequences">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">政變後果</CardTitle>
                  <CardDescription>
                    政變成功後：各項數值重置、政策封鎖與士氣懲罰倒數（每回合 −1）。
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  onClick={saveCoup}
                  disabled={coupSaving || !coupDirty || !coupSettings}
                  data-testid="button-save-coup-settings"
                >
                  {coupSaving ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-1.5 h-4 w-4" />
                  )}
                  儲存
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {!coupSettings ? (
                <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  載入政變後果參數中…
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  {COUP_FIELDS.map((f) => (
                    <div key={f.key} className="space-y-1.5">
                      <Label htmlFor={`field-${f.key}`} className="text-xs">
                        {f.label}
                      </Label>
                      <Input
                        id={`field-${f.key}`}
                        type="number"
                        step="any"
                        value={coupSettings[f.key] ?? 0}
                        onChange={(e) => {
                          const num = Number(e.target.value);
                          setCoupSettings((prev) =>
                            prev
                              ? {
                                  ...prev,
                                  [f.key]: Number.isFinite(num) ? num : 0,
                                }
                              : prev,
                          );
                          setCoupDirty(true);
                        }}
                        data-testid={`input-${f.key}`}
                      />
                      {f.hint && (
                        <p className="text-[11px] text-muted-foreground">
                          {f.hint}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <p className="rounded-lg border border-muted p-3 text-xs text-muted-foreground">
            回合內容：年份 +{settings.yearsPerTurn}、時代依年份更新、每個國家「科技點數
            += 每回合科技」、「金錢 += 生產力 × {settings.moneyIncomePct}% −
            軍隊維護費（下限 0）」、內政 AI 結算（政策判定、條目衰減、隨機事件、政變檢定）。
          </p>
        </>
      )}
    </div>
  );
}
