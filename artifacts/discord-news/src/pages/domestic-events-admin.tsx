import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import { Loader2, Newspaper, RefreshCw, Send, Undo2 } from "lucide-react";

interface ChoiceEffects {
  stability?: number;
  money?: number;
  politicalSupport?: number;
  militarySatisfaction?: number;
  parliamentSatisfaction?: number;
  civilWarRisk?: boolean;
  parliamentShift?: "socialists_in" | "socialists_out";
}
interface CatalogChoice { id: string; style: string; label: string; hint: string; effects: ChoiceEffects }
interface CatalogEvent { kind: string; category: string; title: string; body: string; weight: number; defaultChoiceId: string; choices: CatalogChoice[] }
interface RecentRow {
  id: string; nationId: string; nationName: string | null; kind: string; title: string;
  status: "pending" | "resolved" | "expired"; chosenId: string | null; outcome: string | null; createdAt: string;
}
interface CategoryRow { id: string; label: string; weight: number; count: number }
interface Overview {
  settings: { everyTurns: number; chance: number; deadlineTurns: number };
  categories: CategoryRow[];
  catalog: CatalogEvent[];
  recent: RecentRow[];
}
interface NationRow { id: string; name: string | null; leaderName: string | null }
interface SendResult {
  sent: { nationId: string; nationName: string }[];
  skipped: { nationId: string; nationName: string; reason: "has_pending" | "npc" | "not_found" }[];
}

const STATUS_LABEL: Record<RecentRow["status"], string> = { pending: "待處理", resolved: "已處理", expired: "逾期/撤回" };
const SKIP_REASON: Record<SendResult["skipped"][number]["reason"], string> = {
  has_pending: "已有待處理事件",
  npc: "NPC 不接受事件",
  not_found: "找不到國家",
};
const EFFECT_LABEL: Record<string, string> = {
  stability: "穩定", money: "國庫", politicalSupport: "政治支持", militarySatisfaction: "軍方滿意", parliamentSatisfaction: "議會滿意",
};

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

async function readError(res: Response): Promise<string> {
  try {
    const d = (await res.json()) as { error?: string };
    if (d && typeof d.error === "string" && d.error) return d.error;
  } catch { /* ignore */ }
  return `請求失敗(${res.status})`;
}

function effectsText(e: ChoiceEffects): string {
  const parts = Object.entries(EFFECT_LABEL)
    .filter(([k]) => typeof (e as Record<string, unknown>)[k] === "number")
    .map(([k, label]) => {
      const v = (e as Record<string, number>)[k]!;
      return `${label} ${v > 0 ? "+" : ""}${v}`;
    });
  if (e.parliamentShift === "socialists_in") parts.push("社會黨取得議會多數");
  if (e.parliamentShift === "socialists_out") parts.push("社會黨被逐出議會");
  if (e.civilWarRisk) parts.push("有內戰風險");
  return parts.join("、") || "無直接效果";
}

export default function DomesticEventsAdmin() {
  const { toast } = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [players, setPlayers] = useState<NationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [kind, setKind] = useState("");
  const [category, setCategory] = useState("");
  const [target, setTarget] = useState<string>("all"); // "all" 或某個國家 id
  const [rewrite, setRewrite] = useState(true);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const [a, b] = await Promise.all([authedFetch("/api/admin/domestic-events"), authedFetch("/api/npc-nations")]);
      if (!a.ok) throw new Error(await readError(a));
      if (!b.ok) throw new Error(await readError(b));
      const ov = (await a.json()) as Overview;
      setData(ov);
      setPlayers(((await b.json()) as { players: NationRow[] }).players ?? []);
      setKind((k) => k || ov.catalog[0]?.kind || "");
      setCategory((c) => c || ov.catalog[0]?.category || "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selected = data?.catalog.find((c) => c.kind === kind);
  const inCategory = (data?.catalog ?? []).filter((c) => c.category === category);
  // 換分類時事件跟著換成該類第一個,避免「分類是 A、事件還停在 B」
  const pickCategory = (id: string) => {
    setCategory(id);
    const first = (data?.catalog ?? []).find((c) => c.category === id);
    if (first) setKind(first.kind);
    setConfirming(false);
  };
  const targetLabel = target === "all" ? `所有玩家(${players.length} 個國家)` : (players.find((p) => p.id === target)?.name ?? "這個國家");

  const send = async () => {
    if (!selected || sending) return;
    setConfirming(false);
    setResult(null);
    setSending(true);
    try {
      const res = await authedFetch("/api/admin/domestic-events/send", {
        method: "POST",
        body: JSON.stringify({ kind, target: target === "all" ? { type: "allPlayers" } : { type: "nation", nationId: target }, rewrite }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const r = (await res.json()) as SendResult;
      setResult(r);
      toast({ title: "投放完成", description: `送達 ${r.sent.length} 國,略過 ${r.skipped.length} 國` });
      void load();
    } catch (err) {
      toast({ title: "投放失敗", description: err instanceof Error ? err.message : "請稍後再試", variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const cancel = async (id: string) => {
    if (cancelling) return;
    setCancelling(id);
    try {
      const res = await authedFetch(`/api/admin/domestic-events/${id}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "已撤回" });
      void load();
    } catch (err) {
      toast({ title: "撤回失敗", description: err instanceof Error ? err.message : "請稍後再試", variant: "destructive" });
      void load();
    } finally {
      setCancelling(null);
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />載入中…</div>;
  if (loadError || !data) {
    return (
      <div className="space-y-3">
        <p className="text-destructive">{loadError ?? "載入失敗"}</p>
        <Button variant="outline" onClick={() => { setLoading(true); void load(); }}>重試</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="page-domestic-events-admin">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-bold"><Newspaper className="h-6 w-6" />國內事件</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            自然觸發:每 {data.settings.everyTurns} 回合、每個玩家國 {Math.round(data.settings.chance * 100)}% 機率;未處理 {data.settings.deadlineTurns} 回合後自動採取「拖延」。
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { void load(); }} data-testid="button-refresh"><RefreshCw className="mr-1.5 h-3.5 w-3.5" />重新整理</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">投放事件</CardTitle>
          <CardDescription>事件會立刻出現在玩家的畫面上(強制彈窗)。對方已有待處理事件時會略過,不會覆蓋。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>分類</Label>
              <Select value={category} onValueChange={pickCategory}>
                <SelectTrigger data-testid="select-event-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {data.categories.map((m) => <SelectItem key={m.id} value={m.id}>{m.label}({m.count})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>事件</Label>
              <Select value={kind} onValueChange={(v) => { setKind(v); setConfirming(false); }}>
                <SelectTrigger data-testid="select-event-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {inCategory.map((c) => <SelectItem key={c.kind} value={c.kind}>{c.title}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>投放對象</Label>
              <Select value={target} onValueChange={(v) => { setTarget(v); setConfirming(false); }}>
                <SelectTrigger data-testid="select-event-target"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">所有玩家({players.length})</SelectItem>
                  {players.map((p) => <SelectItem key={p.id} value={p.id}>{p.name || p.leaderName || "(未命名)"}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {selected && (
            <div className="space-y-3 rounded-lg border bg-muted/30 p-3 text-sm">
              <p className="text-muted-foreground">{selected.body}</p>
              <div className="space-y-2">
                {selected.choices.map((c) => (
                  <div key={c.id} className="rounded-md border bg-background px-3 py-2">
                    <div className="font-medium">
                      {c.label}
                      {c.id === selected.defaultChoiceId && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">逾期預設</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{effectsText(c.effects)}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">以上是模板文字;勾選「AI 改寫文字」時玩家會看到 AI 潤飾後的版本,效果數字不變。國庫金額是古典時代的基準價,玩家實際扣的會依當前時代與國力縮放。</p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Checkbox id="rewrite" checked={rewrite} onCheckedChange={(v) => setRewrite(v === true)} data-testid="checkbox-rewrite" />
            <Label htmlFor="rewrite" className="text-sm font-normal">AI 改寫文字(會用到 AI 額度;關閉則直接用模板)</Label>
          </div>

          {confirming && selected ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" data-testid="confirm-send">
              <span>確定把「{selected.title}」投放給{targetLabel}?</span>
              <Button size="sm" onClick={send} disabled={sending} data-testid="button-confirm-send">確定投放</Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)} data-testid="button-cancel-send">取消</Button>
            </div>
          ) : (
            <Button onClick={() => setConfirming(true)} disabled={sending || !selected || (target !== "all" && players.length === 0)} data-testid="button-send-event">
              {sending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Send className="mr-1.5 h-4 w-4" />}投放
            </Button>
          )}

          {result && (
            <div className="space-y-1 rounded-lg border p-3 text-sm" data-testid="send-result">
              <p className={`font-medium ${result.sent.length === 0 ? "text-amber-600 dark:text-amber-400" : ""}`}>
                {result.sent.length === 0 && result.skipped.length === 0
                  ? "沒有送達任何國家:目前沒有可投放的玩家國(NPC 不接受事件)。"
                  : `送達 ${result.sent.length} 國${result.skipped.length > 0 ? `,略過 ${result.skipped.length} 國` : ""}`}
              </p>
              {result.sent.length > 0 && <p className="text-xs text-muted-foreground">送達:{result.sent.map((s) => s.nationName || "(未命名)").join("、")}</p>}
              {result.skipped.map((s) => (
                <p key={s.nationId} className="text-xs text-muted-foreground">略過 {s.nationName || s.nationId.slice(0, 8)}:{SKIP_REASON[s.reason]}</p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-lg">最近的事件</CardTitle><CardDescription>包含自然觸發與管理員投放的,最近 40 筆。</CardDescription></CardHeader>
        <CardContent>
          {data.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">還沒有任何事件。</p>
          ) : (
            <div className="divide-y">
              {data.recent.map((r) => {
                const def = data.catalog.find((c) => c.kind === r.kind);
                const chosen = def?.choices.find((c) => c.id === r.chosenId);
                return (
                  <div key={r.id} className="flex items-start justify-between gap-3 py-2.5 text-sm" data-testid={`row-event-${r.id}`}>
                    <div className="min-w-0">
                      <div className="font-medium">{r.nationName || "(未命名)"} · {def?.title ?? r.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {STATUS_LABEL[r.status]}{chosen ? `:${chosen.label}` : ""} · {new Date(r.createdAt).toLocaleString()}
                      </div>
                      {r.status !== "pending" && r.outcome && <div className="mt-0.5 text-xs text-muted-foreground">{r.outcome}</div>}
                    </div>
                    {r.status === "pending" && (
                      <Button size="sm" variant="outline" disabled={cancelling !== null} onClick={() => cancel(r.id)} data-testid={`button-cancel-${r.id}`}>
                        {cancelling === r.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Undo2 className="mr-1 h-3.5 w-3.5" />}撤回
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
