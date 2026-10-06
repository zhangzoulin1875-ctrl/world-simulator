import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { authedFetch, readError } from "@/components/world-sim/shared";
import { Loader2, Network, Plus, RefreshCw, Save, Trash2, Zap } from "lucide-react";

/**
 * AI 線路池管理（admin raw-fetch，不在 OpenAPI spec）。
 * 後端：GET/PUT /api/bot/ai-routes、POST /api/bot/ai-routes/:id/test、
 *       PUT /api/bot/ai-routes/concurrency。
 * 池健康時所有排隊任務由池處理（無 NIM 速率限制）；全部線路失敗則任務退回佇列改走主線。
 */

type RouteState = "ok" | "open" | "half-open" | "disabled";

interface RouteRow {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string; // 後端回傳遮罩值；留空或維持遮罩值＝沿用舊 key
  qualityModel: string;
  bulkModel: string;
  weight: number;
  enabled: boolean;
  state?: RouteState;
  successes?: number;
  failures?: number;
  consecutiveFailures?: number;
  avgMs?: number | null;
  lastError?: string | null;
  cooldownSeconds?: number;
}

interface LaneStats {
  active: number;
  concurrency: number;
  handled: number;
  requeued: number;
}

interface TestResult {
  ok: boolean;
  ms: number;
  reply?: string;
  error?: string | null;
}

const STATE_LABEL: Record<RouteState, string> = {
  ok: "正常",
  open: "斷路中",
  "half-open": "探測中",
  disabled: "已停用",
};

function stateBadge(state: RouteState | undefined, cooldown: number | undefined) {
  const s = state ?? "ok";
  if (s === "ok") return <Badge>{STATE_LABEL.ok}</Badge>;
  if (s === "open")
    return <Badge variant="destructive">{STATE_LABEL.open}{cooldown ? ` ${cooldown}s` : ""}</Badge>;
  return <Badge variant="outline">{STATE_LABEL[s]}</Badge>;
}

let newCounter = 0;
function blankRoute(): RouteRow {
  newCounter += 1;
  return {
    id: `new-${Date.now().toString(36)}-${newCounter}`,
    name: "",
    baseUrl: "",
    apiKey: "",
    qualityModel: "",
    bulkModel: "",
    weight: 1,
    enabled: true,
  };
}

const isNewId = (id: string) => id.startsWith("new-");

export default function AiRoutesPage() {
  const { toast } = useToast();
  const [rows, setRows] = useState<RouteRow[]>([]);
  const [lane, setLane] = useState<LaneStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [concurrency, setConcurrency] = useState("4");
  const [testing, setTesting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestResult>>({});
  // 有未儲存的編輯時，自動刷新不可覆蓋使用者正在改的內容
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // 併發輸入框同理：使用者改了還沒按「套用」時，自動刷新不可把它重設回伺服器值
  const concurrencyEditedRef = useRef(false);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoading(true);
      try {
        const res = await authedFetch("/api/bot/ai-routes");
        if (!res.ok) throw new Error(await readError(res));
        const body = (await res.json()) as { routes: RouteRow[]; lane: LaneStats };
        setLane(body.lane);
        if (!concurrencyEditedRef.current) setConcurrency(String(body.lane.concurrency));
        if (!dirtyRef.current) {
          setRows(body.routes);
        } else {
          // 未儲存編輯中：只更新即時狀態欄位，不動使用者輸入
          const live = new Map(body.routes.map((r) => [r.id, r]));
          setRows((prev) =>
            prev.map((r) => {
              const l = live.get(r.id);
              return l
                ? { ...r, state: l.state, successes: l.successes, failures: l.failures, consecutiveFailures: l.consecutiveFailures, avgMs: l.avgMs, lastError: l.lastError, cooldownSeconds: l.cooldownSeconds }
                : r;
            }),
          );
        }
      } catch (err) {
        if (!opts.silent)
          toast({ title: "載入 AI 線路失敗", description: err instanceof Error ? err.message : "未知錯誤", variant: "destructive" });
      } finally {
        if (!opts.silent) setLoading(false);
      }
    },
    [toast],
  );

  useEffect(() => {
    void load();
    const t = setInterval(() => void load({ silent: true }), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const patchRow = (id: string, patch: Partial<RouteRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    setDirty(true);
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((r) => r.id !== id));
    setDirty(true);
  };

  const save = async () => {
    // 前端先擋明顯錯誤；細節驗證由後端負責
    for (const r of rows) {
      const label = r.name.trim() || r.baseUrl.trim() || "未命名線路";
      if (!/^https?:\/\//i.test(r.baseUrl.trim())) {
        toast({ title: `「${label}」網址需以 http:// 或 https:// 開頭`, variant: "destructive" });
        return;
      }
      if (!r.qualityModel.trim()) {
        toast({ title: `「${label}」缺少模型名稱`, variant: "destructive" });
        return;
      }
      if (isNewId(r.id) && !r.apiKey.trim()) {
        toast({ title: `「${label}」是新線路，需要填 API key`, variant: "destructive" });
        return;
      }
    }
    setSaving(true);
    try {
      const payload = rows.map((r) => ({
        // 新線路不送暫時 id，讓後端產生正式 id
        ...(isNewId(r.id) ? {} : { id: r.id }),
        name: r.name.trim(),
        baseUrl: r.baseUrl.trim(),
        apiKey: r.apiKey.trim(),
        qualityModel: r.qualityModel.trim(),
        bulkModel: r.bulkModel.trim(),
        weight: Number(r.weight) || 1,
        enabled: r.enabled,
      }));
      const res = await authedFetch("/api/bot/ai-routes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: payload }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { routes: RouteRow[] };
      setRows(body.routes);
      setDirty(false);
      dirtyRef.current = false;
      setResults({});
      toast({ title: "AI 線路已儲存並立即生效" });
      void load({ silent: true });
    } catch (err) {
      toast({ title: "儲存失敗", description: err instanceof Error ? err.message : "未知錯誤", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const testRoute = async (r: RouteRow) => {
    setTesting(r.id);
    try {
      const res = await authedFetch(`/api/bot/ai-routes/${encodeURIComponent(r.id)}/test`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as TestResult;
      setResults((prev) => ({ ...prev, [r.id]: body }));
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [r.id]: { ok: false, ms: 0, error: err instanceof Error ? err.message : "未知錯誤" },
      }));
    } finally {
      setTesting(null);
    }
  };

  const saveConcurrency = async () => {
    const n = Number(concurrency);
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      toast({ title: "併發數需為 1 到 16 的整數", variant: "destructive" });
      return;
    }
    try {
      const res = await authedFetch("/api/bot/ai-routes/concurrency", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concurrency: n }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { lane: LaneStats };
      setLane(body.lane);
      concurrencyEditedRef.current = false;
      setConcurrency(String(body.lane.concurrency));
      toast({ title: `池併發已設為 ${n}` });
    } catch (err) {
      toast({ title: "設定併發失敗", description: err instanceof Error ? err.message : "未知錯誤", variant: "destructive" });
    }
  };

  const healthy = rows.some((r) => r.enabled && (r.state ?? "ok") === "ok" && !isNewId(r.id));

  return (
    <div className="space-y-6 p-4 md:p-6" data-testid="page-ai-routes">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Network className="h-6 w-6" /> AI 線路池
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          接入任何 OpenAI v1 相容端點（公益站等）。池裡有健康線路時，所有排隊的 AI 任務都由池處理，
          不受 NVIDIA NIM 的 35 RPM 限制；全部線路都失敗時，任務會退回佇列改走 NIM 主線。
        </p>
      </div>

      <Card data-testid="card-ai-routes-lane">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            池線道狀態
            {healthy ? <Badge>接管中</Badge> : <Badge variant="outline">未接管（走 NIM 主線）</Badge>}
          </CardTitle>
          <CardDescription>
            已處理＝由池完成的任務數；已退回＝池全滅而退回主線的任務數（自上次服務啟動起算）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[
              ["進行中", lane?.active ?? 0],
              ["已處理", lane?.handled ?? 0],
              ["已退回主線", lane?.requeued ?? 0],
              ["目前併發上限", lane?.concurrency ?? 0],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">{k}</div>
                <div className="mt-1 text-xl font-semibold" data-testid={`lane-stat-${k}`}>{v}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-sm">池併發上限（1 到 16）</span>
            <Input
              className="w-24"
              inputMode="numeric"
              value={concurrency}
              onChange={(e) => {
                concurrencyEditedRef.current = true;
                setConcurrency(e.target.value);
              }}
              data-testid="input-pool-concurrency"
            />
            <Button variant="outline" size="sm" onClick={saveConcurrency} data-testid="button-save-concurrency">
              套用
            </Button>
            <span className="text-xs text-muted-foreground">即時生效，不需按下方的儲存。</span>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-ai-routes">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2">
            <span>線路清單（{rows.length}/12）</span>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} data-testid="button-refresh-routes">
              <RefreshCw className={`mr-1 h-4 w-4 ${loading ? "animate-spin" : ""}`} /> 重新整理
            </Button>
          </CardTitle>
          <CardDescription>
            權重越大分到的流量越多（權重相同＝輪流）。連續失敗 3 次的線路會自動斷路並冷卻，
            冷卻後只放一個探測請求，成功才恢復。API key 已儲存者只顯示遮罩，留空表示沿用舊 key。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> 載入中...
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="routes-empty">
              還沒有任何線路。按下方「新增線路」開始；沒有線路時，遊戲完全走原本的 NIM 與備援。
            </p>
          ) : (
            rows.map((r) => {
              const res = results[r.id];
              return (
                <div key={r.id} className="space-y-3 rounded-lg border bg-card p-4" data-testid={`route-${r.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.name.trim() || "（未命名）"}</span>
                      {isNewId(r.id) ? <Badge variant="outline">尚未儲存</Badge> : stateBadge(r.enabled ? r.state : "disabled", r.cooldownSeconds)}
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex cursor-pointer items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={r.enabled}
                          onChange={(e) => patchRow(r.id, { enabled: e.target.checked })}
                          data-testid={`route-enabled-${r.id}`}
                        />
                        啟用
                      </label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void testRoute(r)}
                        disabled={testing === r.id || isNewId(r.id) || dirty}
                        title={isNewId(r.id) || dirty ? "請先儲存再測試（測試使用已儲存的設定）" : undefined}
                        data-testid={`route-test-${r.id}`}
                      >
                        {testing === r.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Zap className="mr-1 h-4 w-4" />}
                        測試
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => removeRow(r.id)} data-testid={`route-delete-${r.id}`}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span>名稱</span>
                      <Input value={r.name} placeholder="例如 公益站A" onChange={(e) => patchRow(r.id, { name: e.target.value })} data-testid={`route-name-${r.id}`} />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span>權重（1 到 20）</span>
                      <Input inputMode="numeric" value={String(r.weight)} onChange={(e) => patchRow(r.id, { weight: Number(e.target.value.replace(/\D/g, "")) || 0 })} data-testid={`route-weight-${r.id}`} />
                    </label>
                    <label className="space-y-1 text-sm md:col-span-2">
                      <span>端點網址（OpenAI 相容 base URL，貼到 /v1 或 /chat/completions 皆可）</span>
                      <Input value={r.baseUrl} placeholder="https://example.com/v1" onChange={(e) => patchRow(r.id, { baseUrl: e.target.value })} data-testid={`route-url-${r.id}`} />
                    </label>
                    <label className="space-y-1 text-sm md:col-span-2">
                      <span>API key{isNewId(r.id) ? "" : "（留空＝沿用已儲存的 key）"}</span>
                      <Input
                        type="password"
                        autoComplete="off"
                        value={r.apiKey}
                        placeholder={isNewId(r.id) ? "必填" : "已儲存"}
                        onChange={(e) => patchRow(r.id, { apiKey: e.target.value })}
                        data-testid={`route-key-${r.id}`}
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span>品質模型名稱</span>
                      <Input value={r.qualityModel} placeholder="例如 gpt-4o" onChange={(e) => patchRow(r.id, { qualityModel: e.target.value })} data-testid={`route-quality-${r.id}`} />
                    </label>
                    <label className="space-y-1 text-sm">
                      <span>量產模型名稱（留空＝同品質模型）</span>
                      <Input value={r.bulkModel} placeholder="例如 gpt-4o-mini" onChange={(e) => patchRow(r.id, { bulkModel: e.target.value })} data-testid={`route-bulk-${r.id}`} />
                    </label>
                  </div>

                  {!isNewId(r.id) && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid={`route-health-${r.id}`}>
                      <span>成功 {r.successes ?? 0}</span>
                      <span>失敗 {r.failures ?? 0}</span>
                      <span>連續失敗 {r.consecutiveFailures ?? 0}</span>
                      <span>平均延遲 {r.avgMs != null ? `${r.avgMs} ms` : "—"}</span>
                      {r.lastError ? <span className="text-destructive">最後錯誤：{r.lastError}</span> : null}
                    </div>
                  )}

                  {res && (
                    <div
                      className={`rounded-md border p-2 text-sm ${res.ok ? "" : "border-destructive text-destructive"}`}
                      data-testid={`route-test-result-${r.id}`}
                    >
                      {res.ok ? `連線正常（${res.ms} ms）：${res.reply ?? ""}` : `測試失敗（${res.ms} ms）：${res.error ?? "未知錯誤"}`}
                    </div>
                  )}
                </div>
              );
            })
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setRows((prev) => [...prev, blankRoute()]);
                setDirty(true);
              }}
              disabled={rows.length >= 12}
              data-testid="button-add-route"
            >
              <Plus className="mr-1 h-4 w-4" /> 新增線路
            </Button>
            <Button onClick={() => void save()} disabled={!dirty || saving} data-testid="button-save-routes">
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
              儲存並生效
            </Button>
            {dirty && <span className="self-center text-xs text-muted-foreground">有尚未儲存的變更</span>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
