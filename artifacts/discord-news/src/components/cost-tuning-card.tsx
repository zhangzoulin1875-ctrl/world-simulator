import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { authedFetch } from "@/components/world-sim/shared";
import { Loader2, RotateCcw, SlidersHorizontal } from "lucide-react";

/** 與後端 nationCostScale.ts 的 COST_LINEAR_RANGE / COST_CURVE_RANGE 一致(後端仍會驗證)。 */
const LINEAR = { min: 10, max: 500, step: 5 };
const CURVE = { min: 0, max: 200, step: 5 };
const SAVE_DEBOUNCE_MS = 700;
const PREVIEW_DEBOUNCE_MS = 150;

interface PreviewRow {
  era: string; standardTax: number; event: number; eventTurns: number | null; focus: number;
  constitution: number; report: number; eventSmall: number; eventLarge: number;
}

const ERA_ZH: Record<string, string> = {
  classical: "古典", roman: "羅馬", early_medieval: "中世紀初", high_medieval: "中世紀盛", renaissance: "文藝復興",
  discovery: "大航海", scientific: "科學革命", enlightenment: "啟蒙", industrial: "工業", ww1: "一戰", ww2: "二戰",
  cold_war: "冷戰", modern: "現代", future: "未來",
};
const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * 全局開銷兩個滑竿:線性(整體倍率)與函數(國力曲線陡度)。
 * 拖曳 → 預覽表即時更新;停手 0.7 秒自動存檔、即時生效(不必重新部署、不必按儲存)。
 */
export function CostTuningCard() {
  const { toast } = useToast();
  const [linear, setLinear] = useState(100);
  const [curve, setCurve] = useState(100);
  const [saved, setSaved] = useState<{ linear: number; curve: number } | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewSeq = useRef(0);
  const loaded = useRef(false);

  const loadPreview = useCallback(async (l: number, c: number) => {
    const seq = ++previewSeq.current;
    try {
      const res = await authedFetch(`/api/turn/cost-preview?linear=${l}&curve=${c}`);
      if (!res.ok) return;
      const data = await res.json();
      if (seq === previewSeq.current) setRows(data.rows ?? []); // 只收最新一次的結果,避免舊回應蓋掉新的
    } catch { /* 預覽失敗不影響調整 */ }
  }, []);

  // 首次載入目前生效值
  useEffect(() => {
    (async () => {
      try {
        const res = await authedFetch("/api/turn/settings");
        const data = await res.json();
        const s = data?.settings;
        if (s && typeof s.costLinearPct === "number") {
          setLinear(s.costLinearPct); setCurve(s.costCurvePct);
          setSaved({ linear: s.costLinearPct, curve: s.costCurvePct });
          loadPreview(s.costLinearPct, s.costCurvePct);
        }
      } finally { loaded.current = true; }
    })();
  }, [loadPreview]);

  const persist = useCallback(async (l: number, c: number) => {
    setStatus("saving");
    try {
      const res = await authedFetch("/api/turn/settings", { method: "PUT", body: JSON.stringify({ costLinearPct: l, costCurvePct: c }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "儲存失敗");
      setSaved({ linear: l, curve: c });
      setStatus("saved");
    } catch (e) {
      setStatus("error");
      toast({ title: "儲存開銷旋鈕失敗", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    }
  }, [toast]);

  const change = (l: number, c: number) => {
    setLinear(l); setCurve(c);
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => loadPreview(l, c), PREVIEW_DEBOUNCE_MS);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => persist(l, c), SAVE_DEBOUNCE_MS);
  };

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (previewTimer.current) clearTimeout(previewTimer.current);
  }, []);

  const pending = saved !== null && (saved.linear !== linear || saved.curve !== curve);
  const statusText = status === "saving" || pending ? "儲存中…" : status === "saved" ? "已生效" : status === "error" ? "儲存失敗" : "";

  return (
    <Card data-testid="card-cost-tuning">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontal className="h-4 w-4" /> 全局開銷調節
          <span className="ml-auto flex items-center gap-1 text-xs font-normal text-muted-foreground" data-testid="text-cost-status">
            {(status === "saving" || pending) && <Loader2 className="h-3 w-3 animate-spin" />}{statusText}
          </span>
        </CardTitle>
        <CardDescription>
          拖曳後自動儲存並即時生效,不必按儲存、不必重新部署(多台伺服器約 5 秒內同步)。影響所有造價、維護費,以及事件、國策、憲法、國情報告的金錢代價。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="slider-cost-linear" className="text-sm">線性:整體開銷倍率</Label>
            <span className="text-sm font-semibold tabular-nums" data-testid="text-cost-linear">{linear}%</span>
          </div>
          <input id="slider-cost-linear" type="range" className="w-full accent-primary" min={LINEAR.min} max={LINEAR.max} step={LINEAR.step}
            value={linear} onChange={(e) => change(Number(e.target.value), curve)} data-testid="slider-cost-linear" />
          <p className="text-[11px] text-muted-foreground">所有金額等比例放大縮小,各時代比例不變。100% = 現狀;50% = 全部便宜一半;200% = 貴一倍。</p>
        </div>

        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="slider-cost-curve" className="text-sm">函數:國力曲線陡度</Label>
            <span className="text-sm font-semibold tabular-nums" data-testid="text-cost-curve">{curve}%</span>
          </div>
          <input id="slider-cost-curve" type="range" className="w-full accent-primary" min={CURVE.min} max={CURVE.max} step={CURVE.step}
            value={curve} onChange={(e) => change(linear, Number(e.target.value))} data-testid="slider-cost-curve" />
          <p className="text-[11px] text-muted-foreground">大小國的價差。0% = 不分大小國一律標準價;100% = 現狀(小國有補貼、大國貴得比國力慢);200% = 價差加倍。標準國的價格不受影響。</p>
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => change(100, 100)} disabled={linear === 100 && curve === 100} data-testid="button-cost-reset">
            <RotateCcw className="mr-1 h-3 w-3" /> 還原為 100% / 100%
          </Button>
        </div>

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs tabular-nums" data-testid="table-cost-preview">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">時代(標準國)</th>
                  <th className="px-2 py-1.5 text-right font-medium">每回合稅收</th>
                  <th className="px-2 py-1.5 text-right font-medium">事件</th>
                  <th className="px-2 py-1.5 text-right font-medium">占稅收</th>
                  <th className="px-2 py-1.5 text-right font-medium">國策</th>
                  <th className="px-2 py-1.5 text-right font-medium">憲法</th>
                  <th className="px-2 py-1.5 text-right font-medium">小國 / 大國事件</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.era} className="border-t">
                    <td className="px-2 py-1">{ERA_ZH[r.era] ?? r.era}</td>
                    <td className="px-2 py-1 text-right">{fmt(r.standardTax)}</td>
                    <td className="px-2 py-1 text-right">{fmt(r.event)}</td>
                    <td className="px-2 py-1 text-right">{r.eventTurns === null ? "-" : `${r.eventTurns} 回合`}</td>
                    <td className="px-2 py-1 text-right">{fmt(r.focus)}</td>
                    <td className="px-2 py-1 text-right">{fmt(r.constitution)}</td>
                    <td className="px-2 py-1 text-right text-muted-foreground">{fmt(r.eventSmall)} / {fmt(r.eventLarge)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">表中「事件」以基準價 1,800 計(目錄平均),「占稅收」= 一筆平均事件相當幾回合的標準稅收。</p>
      </CardContent>
    </Card>
  );
}
