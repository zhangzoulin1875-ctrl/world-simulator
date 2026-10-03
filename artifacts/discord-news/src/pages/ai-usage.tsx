import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { authedFetch, readError } from "@/components/world-sim/shared";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Loader2,
  RefreshCw,
  Save,
  TrendingUp,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Task #593 — AI 用量統計＋各功能 token 上限（admin raw-fetch，不在 OpenAPI spec）。
 * Task #596 — 加上最近 30 天每日 token 用量趨勢折線圖（可切換單一功能）。
 */

interface UsageWindow {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  failures: number;
}

interface FeatureRow {
  feature: string;
  label: string;
  defaultMaxTokens: number;
  maxTokensOverride: number | null;
  dailyTokenQuota: number | null;
  today: UsageWindow;
  last7d: UsageWindow;
  last30d: UsageWindow;
}

interface DailyRow {
  date: string;
  feature: string;
  calls: number;
  totalTokens: number;
  failures: number;
}

interface SummaryResponse {
  features: FeatureRow[];
  maxTokensFloor: number;
  daily: DailyRow[];
  days: string[];
}

type SortKey =
  | "label"
  | "todayTokens"
  | "todayCalls"
  | "d7Tokens"
  | "d30Tokens"
  | "failures";

const SORT_LABELS: Record<SortKey, string> = {
  label: "功能",
  todayTokens: "今日 token",
  todayCalls: "今日呼叫",
  d7Tokens: "7 日 token",
  d30Tokens: "30 日 token",
  failures: "30 日失敗",
};

function sortValue(row: FeatureRow, key: SortKey): number | string {
  switch (key) {
    case "label":
      return row.label;
    case "todayTokens":
      return row.today.totalTokens;
    case "todayCalls":
      return row.today.calls;
    case "d7Tokens":
      return row.last7d.totalTokens;
    case "d30Tokens":
      return row.last30d.totalTokens;
    case "failures":
      return row.last30d.failures;
  }
}

function fmt(n: number): string {
  return n.toLocaleString("zh-TW");
}

interface EditState {
  maxTokensOverride: string;
  dailyTokenQuota: string;
}

export default function AiUsagePage() {
  const { toast } = useToast();
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortKey, setSortKey] = useState<SortKey>("todayTokens");
  const [sortDesc, setSortDesc] = useState(true);
  const [edits, setEdits] = useState<Record<string, EditState>>({});
  const [savingFeature, setSavingFeature] = useState<string | null>(null);
  const [trendFeature, setTrendFeature] = useState<string>("__all__");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/ai-usage/summary");
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as SummaryResponse;
      setData(body);
      setEdits({});
    } catch (err) {
      toast({
        title: "載入 AI 用量失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const topTodayFeature = useMemo(() => {
    if (!data) return null;
    let best: FeatureRow | null = null;
    for (const row of data.features) {
      if (row.today.totalTokens > 0 && (!best || row.today.totalTokens > best.today.totalTokens)) {
        best = row;
      }
    }
    return best?.feature ?? null;
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const sorted = [...data.features].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      const cmp =
        typeof va === "string" && typeof vb === "string"
          ? va.localeCompare(vb, "zh-TW")
          : Number(va) - Number(vb);
      return sortDesc ? -cmp : cmp;
    });
    return sorted;
  }, [data, sortKey, sortDesc]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      setSortDesc(key !== "label");
    }
  };

  const getEdit = (row: FeatureRow): EditState =>
    edits[row.feature] ?? {
      maxTokensOverride:
        row.maxTokensOverride === null ? "" : String(row.maxTokensOverride),
      dailyTokenQuota:
        row.dailyTokenQuota === null ? "" : String(row.dailyTokenQuota),
    };

  const setEdit = (feature: string, patch: Partial<EditState>, base: EditState) => {
    setEdits((prev) => ({ ...prev, [feature]: { ...base, ...patch } }));
  };

  const save = async (row: FeatureRow) => {
    const edit = getEdit(row);
    const parseField = (raw: string): number | null | undefined => {
      const trimmed = raw.trim();
      if (trimmed === "") return null;
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 0) return undefined;
      return n;
    };
    const maxTokensOverride = parseField(edit.maxTokensOverride);
    const dailyTokenQuota = parseField(edit.dailyTokenQuota);
    if (maxTokensOverride === undefined || dailyTokenQuota === undefined) {
      toast({
        title: "數值格式不正確",
        description: "請輸入非負整數，或留空表示不限制／使用預設值",
        variant: "destructive",
      });
      return;
    }
    setSavingFeature(row.feature);
    try {
      const res = await authedFetch(
        `/api/ai-usage/settings/${encodeURIComponent(row.feature)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ maxTokensOverride, dailyTokenQuota }),
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: `「${row.label}」設定已儲存` });
      await load();
    } catch (err) {
      toast({
        title: "儲存設定失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setSavingFeature(null);
    }
  };

  // 每日趨勢資料：以伺服器提供的完整 30 天日期軸補零，
  // 「全部功能」為各功能加總，選定功能則只取該功能列。
  const trendData = useMemo(() => {
    if (!data) return [];
    const byDate = new Map<string, { tokens: number; calls: number; failures: number }>();
    for (const day of data.days) {
      byDate.set(day, { tokens: 0, calls: 0, failures: 0 });
    }
    for (const row of data.daily) {
      if (trendFeature !== "__all__" && row.feature !== trendFeature) continue;
      const slot = byDate.get(row.date);
      if (!slot) continue;
      slot.tokens += row.totalTokens;
      slot.calls += row.calls;
      slot.failures += row.failures;
    }
    return data.days.map((day) => ({
      date: day,
      shortDate: day.slice(5),
      ...byDate.get(day)!,
    }));
  }, [data, trendFeature]);

  const trendFeatureLabel = useMemo(() => {
    if (trendFeature === "__all__") return "全部功能";
    return (
      data?.features.find((f) => f.feature === trendFeature)?.label ??
      trendFeature
    );
  }, [data, trendFeature]);

  // 只列出 30 天內實際有用量的功能當切換選項，避免 21 顆按鈕全排開。
  const trendFeatureOptions = useMemo(() => {
    if (!data) return [];
    const used = new Set(data.daily.map((r) => r.feature));
    return data.features
      .filter((f) => used.has(f.feature))
      .sort((a, b) => b.last30d.totalTokens - a.last30d.totalTokens);
  }, [data]);

  const totals = useMemo(() => {
    const sum = (pick: (r: FeatureRow) => number) =>
      rows.reduce((acc, r) => acc + pick(r), 0);
    return {
      todayTokens: sum((r) => r.today.totalTokens),
      todayCalls: sum((r) => r.today.calls),
      d7Tokens: sum((r) => r.last7d.totalTokens),
      d30Tokens: sum((r) => r.last30d.totalTokens),
      failures: sum((r) => r.last30d.failures),
    };
  }, [rows]);

  const sortIcon = (key: SortKey) =>
    sortKey !== key ? (
      <ArrowUpDown className="w-3 h-3 inline-block ml-1 opacity-40" />
    ) : sortDesc ? (
      <ArrowDown className="w-3 h-3 inline-block ml-1" />
    ) : (
      <ArrowUp className="w-3 h-3 inline-block ml-1" />
    );

  return (
    <div className="space-y-6" data-testid="page-ai-usage">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="w-6 h-6" />
            AI 用量與限額
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            各 AI 功能的 token 用量統計（今日／7 日／30 日；原始紀錄保留 30
            天），以及 max_tokens 覆寫與每日 token 配額設定。
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => void load()}
          disabled={loading}
          data-testid="button-refresh"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4 mr-2" />
          )}
          重新整理
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>全站合計</CardTitle>
          <CardDescription>
            今日 token {fmt(totals.todayTokens)} ・ 今日呼叫{" "}
            {fmt(totals.todayCalls)} 次 ・ 7 日 token {fmt(totals.d7Tokens)} ・
            30 日 token {fmt(totals.d30Tokens)} ・ 30 日失敗{" "}
            {fmt(totals.failures)} 次
          </CardDescription>
        </CardHeader>
      </Card>

      <Card data-testid="card-daily-trend">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="w-5 h-5" />
            每日 token 用量趨勢（30 天）
          </CardTitle>
          <CardDescription>
            按 token 花費逐日折線圖，可切換單一功能，及早發現用量異常暴增。目前顯示：
            {trendFeatureLabel}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            <Button
              size="sm"
              variant={trendFeature === "__all__" ? "default" : "outline"}
              onClick={() => setTrendFeature("__all__")}
              data-testid="trend-feature-all"
            >
              全部功能
            </Button>
            {trendFeatureOptions.map((f) => (
              <Button
                key={f.feature}
                size="sm"
                variant={trendFeature === f.feature ? "default" : "outline"}
                onClick={() => setTrendFeature(f.feature)}
                data-testid={`trend-feature-${f.feature}`}
              >
                {f.label}
              </Button>
            ))}
          </div>
          {loading && !data ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              載入中…
            </div>
          ) : trendData.every((d) => d.tokens === 0) ? (
            <div
              className="flex items-center justify-center py-12 text-muted-foreground text-sm"
              data-testid="trend-empty"
            >
              最近 30 天沒有{trendFeature === "__all__" ? "" : "此功能的"}用量紀錄
            </div>
          ) : (
            <div className="h-64 w-full" data-testid="trend-chart">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={trendData}
                  margin={{ top: 8, right: 16, bottom: 0, left: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis
                    dataKey="shortDate"
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    width={64}
                    allowDecimals={false}
                    tickFormatter={(v: number) => fmt(v)}
                  />
                  <Tooltip
                    formatter={(value, name) => [
                      fmt(Number(value ?? 0)),
                      name === "tokens"
                        ? "token"
                        : name === "calls"
                          ? "呼叫次數"
                          : "失敗次數",
                    ]}
                    labelFormatter={(_, payload) =>
                      payload?.[0]?.payload?.date ?? ""
                    }
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="tokens"
                    stroke="hsl(var(--primary))"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>各功能用量與設定</CardTitle>
          <CardDescription>
            max_tokens 覆寫留空＝使用程式碼預設（低於下限{" "}
            {data ? fmt(data.maxTokensFloor) : "—"} 會被拒絕）；每日配額留空＝不限
            制。配額用罄時該功能當日暫停，玩家操作會收到明確錯誤訊息。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading && !data ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              載入中…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    {(
                      [
                        "label",
                        "todayTokens",
                        "todayCalls",
                        "d7Tokens",
                        "d30Tokens",
                        "failures",
                      ] as SortKey[]
                    ).map((key) => (
                      <th key={key} className="py-2 pr-3 whitespace-nowrap">
                        <button
                          type="button"
                          className="hover:text-foreground"
                          onClick={() => toggleSort(key)}
                          data-testid={`sort-${key}`}
                        >
                          {SORT_LABELS[key]}
                          {sortIcon(key)}
                        </button>
                      </th>
                    ))}
                    <th className="py-2 pr-3 whitespace-nowrap">
                      max_tokens 覆寫
                    </th>
                    <th className="py-2 pr-3 whitespace-nowrap">每日配額</th>
                    <th className="py-2 whitespace-nowrap" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const edit = getEdit(row);
                    const quotaExceeded =
                      row.dailyTokenQuota !== null &&
                      row.today.totalTokens >= row.dailyTokenQuota;
                    const isTopToday = row.feature === topTodayFeature;
                    const floor = data?.maxTokensFloor ?? 0;
                    const overrideTrimmed = edit.maxTokensOverride.trim();
                    const overrideNum = Number(overrideTrimmed);
                    const overrideTooLow =
                      overrideTrimmed !== "" &&
                      Number.isInteger(overrideNum) &&
                      overrideNum >= 0 &&
                      overrideNum < floor;
                    return (
                      <tr
                        key={row.feature}
                        className={`border-b last:border-0 align-middle ${
                          isTopToday ? "bg-amber-500/10" : ""
                        }`}
                        data-testid={`row-${row.feature}`}
                      >
                        <td className="py-2 pr-3">
                          <div className="font-medium">{row.label}</div>
                          <div className="text-xs text-muted-foreground font-mono">
                            {row.feature}
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {isTopToday && (
                              <Badge
                                variant="secondary"
                                className="border-amber-500/50 text-amber-600 dark:text-amber-400"
                                data-testid={`badge-top-today-${row.feature}`}
                              >
                                今日用量最高
                              </Badge>
                            )}
                            {quotaExceeded && (
                              <Badge variant="destructive">
                                今日配額已用罄
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {fmt(row.today.totalTokens)}
                          <div className="text-xs text-muted-foreground">
                            入 {fmt(row.today.inputTokens)}／出{" "}
                            {fmt(row.today.outputTokens)}
                          </div>
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {fmt(row.today.calls)}
                          {row.today.failures > 0 && (
                            <div className="text-xs text-destructive">
                              失敗 {fmt(row.today.failures)}
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {fmt(row.last7d.totalTokens)}
                          <div className="text-xs text-muted-foreground">
                            {fmt(row.last7d.calls)} 次
                          </div>
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {fmt(row.last30d.totalTokens)}
                          <div className="text-xs text-muted-foreground">
                            {fmt(row.last30d.calls)} 次
                          </div>
                        </td>
                        <td className="py-2 pr-3 tabular-nums">
                          {fmt(row.last30d.failures)}
                        </td>
                        <td className="py-2 pr-3">
                          <Input
                            className="w-28"
                            inputMode="numeric"
                            placeholder={`預設 ${fmt(row.defaultMaxTokens)}`}
                            value={edit.maxTokensOverride}
                            onChange={(e) =>
                              setEdit(
                                row.feature,
                                { maxTokensOverride: e.target.value },
                                edit,
                              )
                            }
                            data-testid={`input-maxtokens-${row.feature}`}
                          />
                          {overrideTooLow && (
                            <div
                              className="text-xs text-destructive mt-1"
                              data-testid={`warning-maxtokens-${row.feature}`}
                            >
                              低於下限 {fmt(floor)}，儲存會被拒絕
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-3">
                          <Input
                            className="w-32"
                            inputMode="numeric"
                            placeholder="不限制"
                            value={edit.dailyTokenQuota}
                            onChange={(e) =>
                              setEdit(
                                row.feature,
                                { dailyTokenQuota: e.target.value },
                                edit,
                              )
                            }
                            data-testid={`input-quota-${row.feature}`}
                          />
                        </td>
                        <td className="py-2">
                          <Button
                            size="sm"
                            onClick={() => void save(row)}
                            disabled={savingFeature === row.feature}
                            data-testid={`button-save-${row.feature}`}
                          >
                            {savingFeature === row.feature ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Save className="w-4 h-4" />
                            )}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
