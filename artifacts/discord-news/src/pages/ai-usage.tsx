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
  CheckCircle2,
  Cpu,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
  TrendingUp,
  XCircle,
  Zap,
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

interface AiModelTierInfo {
  override: string | null;
  envDefault: string;
  effective: string;
}

interface AiTestResult {
  ok: boolean;
  tier: "quality" | "bulk";
  model: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

interface AiFallbackStats {
  attempts: number;
  successes: number;
  failures: number;
  lastUsedAt: number | null;
  lastError: string | null;
}

interface AiFallbackInfo {
  enabled: boolean;
  baseUrl: string;
  apiKeySet: boolean;
  apiKeyMasked: string | null;
  qualityModel: string;
  bulkModel: string;
  stats: AiFallbackStats;
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

  // --- AI 模型（quality／bulk）後台覆寫：換模型不必改環境變數＋重新部署 ---
  const [modelInfo, setModelInfo] = useState<Record<"quality" | "bulk", AiModelTierInfo> | null>(
    null,
  );
  const [modelEdits, setModelEdits] = useState<{ quality: string; bulk: string }>({
    quality: "",
    bulk: "",
  });
  const [loadingModels, setLoadingModels] = useState(true);
  const [savingModelTier, setSavingModelTier] = useState<"quality" | "bulk" | null>(null);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    try {
      const res = await authedFetch("/api/bot/ai-models");
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as Record<"quality" | "bulk", AiModelTierInfo>;
      setModelInfo(body);
      setModelEdits({
        quality: body.quality.override ?? "",
        bulk: body.bulk.override ?? "",
      });
    } catch (err) {
      toast({
        title: "載入 AI 模型設定失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setLoadingModels(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const saveModel = async (tier: "quality" | "bulk") => {
    const raw = modelEdits[tier].trim();
    setSavingModelTier(tier);
    try {
      const res = await authedFetch("/api/bot/ai-models", {
        method: "PATCH",
        body: JSON.stringify({ tier, model: raw === "" ? null : raw }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as Record<"quality" | "bulk", AiModelTierInfo>;
      setModelInfo(body);
      setModelEdits({
        quality: body.quality.override ?? "",
        bulk: body.bulk.override ?? "",
      });
      toast({
        title: `${tier === "quality" ? "品質" : "量產"}模型已更新`,
        description: `目前生效：${body[tier].effective}（約 30 秒內全站生效，不需重啟服務）`,
      });
    } catch (err) {
      toast({
        title: "儲存模型設定失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setSavingModelTier(null);
    }
  };

  // --- AI 備援（fallback）：主供應商失敗時自動改用的備援 API（預設 Gemini） ---
  const [fallbackInfo, setFallbackInfo] = useState<AiFallbackInfo | null>(null);
  const [fallbackEdits, setFallbackEdits] = useState({
    baseUrl: "",
    apiKey: "",
    qualityModel: "",
    bulkModel: "",
  });
  const [loadingFallback, setLoadingFallback] = useState(true);
  const [savingFallback, setSavingFallback] = useState(false);
  const [fallbackTestResults, setFallbackTestResults] = useState<
    Partial<Record<"quality" | "bulk", AiTestResult>>
  >({});
  const [testingFallbackTier, setTestingFallbackTier] = useState<"quality" | "bulk" | null>(null);

  const loadFallback = useCallback(async () => {
    setLoadingFallback(true);
    try {
      const res = await authedFetch("/api/bot/ai-fallback");
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as AiFallbackInfo;
      setFallbackInfo(body);
      setFallbackEdits({
        baseUrl: body.baseUrl,
        apiKey: "",
        qualityModel: body.qualityModel,
        bulkModel: body.bulkModel,
      });
    } catch (err) {
      toast({
        title: "載入 AI 備援設定失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setLoadingFallback(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadFallback();
  }, [loadFallback]);

  const saveFallback = async (patch: Record<string, string | null>) => {
    setSavingFallback(true);
    try {
      const res = await authedFetch("/api/bot/ai-fallback", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as AiFallbackInfo;
      setFallbackInfo(body);
      setFallbackEdits((prev) => ({
        baseUrl: body.baseUrl,
        apiKey: "",
        qualityModel: body.qualityModel,
        bulkModel: body.bulkModel,
      }));
      toast({
        title: "AI 備援設定已更新",
        description: body.enabled
          ? `備援已啟用（約 30 秒內生效，不需重啟服務）`
          : "尚未設定備援 API key，備援未啟用",
      });
    } catch (err) {
      toast({
        title: "儲存 AI 備援設定失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setSavingFallback(false);
    }
  };

  const runFallbackTest = async (tier: "quality" | "bulk") => {
    setTestingFallbackTier(tier);
    try {
      const res = await authedFetch("/api/ai-usage/test", {
        method: "POST",
        body: JSON.stringify({ tier, provider: "fallback" }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as AiTestResult;
      setFallbackTestResults((prev) => ({ ...prev, [tier]: body }));
      if (!body.ok) {
        toast({
          title: `備援${tier === "quality" ? "品質" : "量產"}模型連線測試失敗`,
          description: body.error,
          variant: "destructive",
        });
      } else {
        toast({ title: `備援${tier === "quality" ? "品質" : "量產"}模型連線正常` });
      }
    } catch (err) {
      toast({
        title: "備援連線測試失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setTestingFallbackTier(null);
    }
  };

  const [testResults, setTestResults] = useState<
    Partial<Record<"quality" | "bulk", AiTestResult>>
  >({});
  const [testingTier, setTestingTier] = useState<"quality" | "bulk" | null>(null);

  const runAiTest = async (tier: "quality" | "bulk") => {
    setTestingTier(tier);
    try {
      const res = await authedFetch("/api/ai-usage/test", {
        method: "POST",
        body: JSON.stringify({ tier }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as AiTestResult;
      setTestResults((prev) => ({ ...prev, [tier]: body }));
      if (!body.ok) {
        toast({
          title: `${tier === "quality" ? "品質" : "量產"}模型連線測試失敗`,
          description: body.error,
          variant: "destructive",
        });
      } else {
        toast({ title: `${tier === "quality" ? "品質" : "量產"}模型連線正常` });
      }
    } catch (err) {
      toast({
        title: "測試請求失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setTestingTier(null);
    }
  };

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

      <Card data-testid="card-ai-models">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="w-5 h-5" />
            AI 模型設定
          </CardTitle>
          <CardDescription>
            NVIDIA NIM（或其他 OpenAI 相容供應商）上游模型 ID，留空＝沿用環境變數
            AI_MODEL_QUALITY／AI_MODEL_BULK 的預設值。儲存後約 30 秒內全站生效，
            不需重新部署或重啟服務。「量產」用於高頻率、低風險的功能；「品質」用於
            需要較穩定輸出的功能（戰爭結算、回合新聞等）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingModels || !modelInfo ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> 載入中...
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {(["quality", "bulk"] as const).map((tier) => (
                <div key={tier} className="space-y-2" data-testid={`ai-model-${tier}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {tier === "quality" ? "品質模型（quality）" : "量產模型（bulk）"}
                    </span>
                    {modelInfo[tier].override === null ? (
                      <Badge variant="outline">使用預設</Badge>
                    ) : (
                      <Badge>已覆寫</Badge>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={modelEdits[tier]}
                      placeholder={modelInfo[tier].envDefault}
                      onChange={(e) =>
                        setModelEdits((prev) => ({ ...prev, [tier]: e.target.value }))
                      }
                      data-testid={`input-ai-model-${tier}`}
                    />
                    <Button
                      size="icon"
                      onClick={() => void saveModel(tier)}
                      disabled={savingModelTier === tier}
                      data-testid={`button-save-ai-model-${tier}`}
                    >
                      {savingModelTier === tier ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => void runAiTest(tier)}
                      disabled={testingTier === tier}
                      data-testid={`button-test-ai-model-${tier}`}
                    >
                      {testingTier === tier ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Zap className="w-4 h-4 mr-2" />
                      )}
                      {testingTier === tier ? "測試中…" : "測試"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    目前生效：<span className="font-mono">{modelInfo[tier].effective}</span>
                  </p>
                  {testResults[tier] && (
                    <div
                      className={`rounded-md border p-2 text-xs ${
                        testResults[tier]!.ok
                          ? "text-foreground"
                          : "text-destructive"
                      }`}
                      data-testid={`ai-test-result-${tier}`}
                    >
                      <div className="flex items-center gap-1 font-medium">
                        {testResults[tier]!.ok ? (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        ) : (
                          <XCircle className="w-3.5 h-3.5" />
                        )}
                        {testResults[tier]!.ok ? "連線正常" : "連線失敗"}
                        <span className="text-muted-foreground font-normal ml-1">
                          ({testResults[tier]!.latencyMs}ms ・{" "}
                          <span className="font-mono">{testResults[tier]!.model}</span>)
                        </span>
                      </div>
                      {testResults[tier]!.ok ? (
                        <p className="mt-1 text-muted-foreground">
                          回覆：{testResults[tier]!.reply || "(空白)"}
                        </p>
                      ) : (
                        <p className="mt-1 break-all text-destructive">
                          {testResults[tier]!.error}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-ai-fallback">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="w-5 h-5" />
            AI 備援設定
            {fallbackInfo?.enabled ? (
              <Badge>備援已啟用</Badge>
            ) : (
              <Badge variant="outline">未啟用（無 API key）</Badge>
            )}
          </CardTitle>
          <CardDescription>
            主供應商（NVIDIA NIM）單次呼叫失敗時，自動改用備援 API 重試一次
            （預設＝Google Gemini 的 OpenAI 相容端點，也可填其他 OpenAI 相容
            供應商）。未設定 API key 時備援關閉，遊戲行為不變。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loadingFallback || !fallbackInfo ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" /> 載入中...
            </div>
          ) : (
            <div className="space-y-4" data-testid="ai-fallback-body">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">備援 API 端點（OpenAI 相容 base URL）</span>
                </div>
                <Input
                  value={fallbackEdits.baseUrl}
                  onChange={(e) =>
                    setFallbackEdits((prev) => ({ ...prev, baseUrl: e.target.value }))
                  }
                  data-testid="input-ai-fallback-base-url"
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">備援 API key</span>
                  {fallbackInfo.apiKeySet && (
                    <Badge variant="outline">已設定：{fallbackInfo.apiKeyMasked}</Badge>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={fallbackEdits.apiKey}
                    placeholder={
                      fallbackInfo.apiKeySet
                        ? "留空＝沿用已設定的 key；輸入新值＝覆蓋"
                        : "輸入 Gemini（或其他供應商）的 API key"
                    }
                    onChange={(e) =>
                      setFallbackEdits((prev) => ({ ...prev, apiKey: e.target.value }))
                    }
                    data-testid="input-ai-fallback-api-key"
                  />
                  <Button
                    size="icon"
                    disabled={!fallbackInfo.apiKeySet || savingFallback}
                    onClick={() => void saveFallback({ apiKey: null })}
                    data-testid="button-clear-ai-fallback-key"
                    title="清除後台設定的 key（回退到環境變數 AI_FALLBACK_API_KEY，若也沒設即關閉備援）"
                  >
                    <XCircle className="w-4 h-4" />
                  </Button>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {(["quality", "bulk"] as const).map((tier) => (
                  <div key={tier} className="space-y-2" data-testid={`ai-fallback-${tier}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        備援{tier === "quality" ? "品質" : "量產"}模型
                      </span>
                    </div>
                    <div className="flex gap-2">
                      <Input
                        value={fallbackEdits[tier === "quality" ? "qualityModel" : "bulkModel"]}
                        onChange={(e) =>
                          setFallbackEdits((prev) =>
                            tier === "quality"
                              ? { ...prev, qualityModel: e.target.value }
                              : { ...prev, bulkModel: e.target.value },
                          )
                        }
                        data-testid={`input-ai-fallback-model-${tier}`}
                      />
                      <Button
                        variant="outline"
                        onClick={() => void runFallbackTest(tier)}
                        disabled={testingFallbackTier === tier || !fallbackInfo.enabled}
                        data-testid={`button-test-ai-fallback-${tier}`}
                      >
                        {testingFallbackTier === tier ? (
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        ) : (
                          <Zap className="w-4 h-4 mr-2" />
                        )}
                        {testingFallbackTier === tier ? "測試中…" : "測試"}
                      </Button>
                    </div>
                    {fallbackTestResults[tier] && (
                      <div
                        className={`rounded-md border p-2 text-xs ${
                          fallbackTestResults[tier]!.ok
                            ? "text-foreground"
                            : "text-destructive"
                        }`}
                        data-testid={`ai-fallback-test-result-${tier}`}
                      >
                        {fallbackTestResults[tier]!.ok
                          ? `備援連線正常（${fallbackTestResults[tier]!.latencyMs}ms）`
                          : fallbackTestResults[tier]!.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <Button
                  onClick={() =>
                    void saveFallback({
                      baseUrl: fallbackEdits.baseUrl.trim() || null,
                      qualityModel: fallbackEdits.qualityModel.trim() || null,
                      bulkModel: fallbackEdits.bulkModel.trim() || null,
                      ...(fallbackEdits.apiKey.trim()
                        ? { apiKey: fallbackEdits.apiKey.trim() }
                        : {}),
                    })
                  }
                  disabled={savingFallback}
                  data-testid="button-save-ai-fallback"
                >
                  {savingFallback ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4 mr-2" />
                  )}
                  儲存備援設定
                </Button>
                <p className="text-xs text-muted-foreground">
                  備援統計：成功 {fallbackInfo.stats.successes} 次／失敗{" "}
                  {fallbackInfo.stats.failures} 次
                  {fallbackInfo.stats.lastError
                    ? `（最近錯誤：${fallbackInfo.stats.lastError}）`
                    : ""}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

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
