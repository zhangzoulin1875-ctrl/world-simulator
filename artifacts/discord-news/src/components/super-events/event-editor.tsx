import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Save, X } from "lucide-react";
import {
  NationMultiSelect,
  RegionMultiSelect,
  TargetStatsPicker,
} from "./pickers";
import {
  API,
  authedFetch,
  readError,
  type AdminSuperEvent,
  type NationOption,
  type RegionOption,
} from "./shared";

interface EditorState {
  title: string;
  summary: string;
  narrative: string;
  category: string;
  scope: string;
  kind: string;
  stage: string;
  canSpread: boolean;
  status: string;
  severity: string;
  impactPct: string;
  maxTurns: string;
  aiContext: string;
  regionIds: number[];
  nationIds: string[];
  targetStats: string[];
}

export function EventEditor({
  event,
  regions,
  regionNameById,
  nations,
  nationNameById,
  onClose,
  onSaved,
}: {
  event: AdminSuperEvent | null;
  regions: RegionOption[];
  regionNameById: Map<number, string>;
  nations: NationOption[];
  nationNameById: Map<string, string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const isEdit = event != null;
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<EditorState>({
    title: event?.title ?? "",
    summary: event?.summary ?? "",
    narrative: event?.narrative ?? "",
    category: event?.category ?? "",
    scope: event?.scope ?? "global",
    kind: event?.kind ?? "disaster",
    stage: event?.stage ?? "outbreak",
    canSpread: event?.canSpread ?? false,
    status: event?.status ?? "active",
    severity: String(event?.severity ?? 50),
    impactPct: String(event?.impactPct ?? 100),
    maxTurns: event?.maxTurns != null ? String(event.maxTurns) : "",
    aiContext: event?.aiContext ?? "",
    regionIds: event?.regionIds ?? [],
    nationIds: event?.nationIds ?? [],
    targetStats: event?.targetStats ?? [],
  });

  const set = <K extends keyof EditorState>(k: K, v: EditorState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const toggleRegion = (id: number) =>
    setForm((f) => ({
      ...f,
      regionIds: f.regionIds.includes(id)
        ? f.regionIds.filter((r) => r !== id)
        : [...f.regionIds, id],
    }));

  const toggleNation = (id: string) =>
    setForm((f) => ({
      ...f,
      nationIds: f.nationIds.includes(id)
        ? f.nationIds.filter((n) => n !== id)
        : [...f.nationIds, id],
    }));

  const toggleTargetStat = (key: string) =>
    setForm((f) => ({
      ...f,
      targetStats: f.targetStats.includes(key)
        ? f.targetStats.filter((k) => k !== key)
        : [...f.targetStats, key],
    }));

  const submit = async () => {
    if (!form.title.trim()) {
      toast({ title: "請輸入事件標題", variant: "destructive" });
      return;
    }
    if (form.scope === "regional" && form.regionIds.length === 0) {
      toast({ title: "區域事件需至少選擇一個地區", variant: "destructive" });
      return;
    }
    if (form.scope === "targeted" && form.nationIds.length === 0) {
      toast({ title: "指定國家事件需至少選擇一個國家", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        title: form.title.trim(),
        summary: form.summary.trim(),
        narrative: form.narrative.trim(),
        category: form.category.trim() || "其他",
        scope: form.scope,
        kind: form.kind,
        canSpread: form.scope === "regional" ? form.canSpread : false,
        severity: Number(form.severity),
        impactPct: Number(form.impactPct),
        maxTurns: form.maxTurns.trim() === "" ? null : Number(form.maxTurns),
        aiContext: form.aiContext.trim() || null,
        regionIds: form.scope === "regional" ? form.regionIds : [],
        nationIds: form.scope === "targeted" ? form.nationIds : [],
        targetStats: form.targetStats,
      };
      if (isEdit) {
        payload["status"] = form.status;
        payload["stage"] = form.stage;
      }

      const url = isEdit
        ? `${API}/super-events/admin/${event.id}`
        : `${API}/super-events/admin`;
      const res = await authedFetch(url, {
        method: isEdit ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        toast({ title: "儲存失敗", description: await readError(res), variant: "destructive" });
        return;
      }
      toast({ title: isEdit ? "已更新超事件" : "已建立超事件" });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="font-bold">{isEdit ? "編輯超事件" : "手動建立超事件"}</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">標題 *</span>
            <Input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              data-testid="input-event-title"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">摘要</span>
            <Input
              value={form.summary}
              onChange={(e) => set("summary", e.target.value)}
              data-testid="input-event-summary"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">詳述</span>
            <textarea
              rows={3}
              value={form.narrative}
              onChange={(e) => set("narrative", e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="input-event-narrative"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">類別</span>
              <Input
                value={form.category}
                onChange={(e) => set("category", e.target.value)}
                placeholder="例如：天災、戰爭、科技…"
                data-testid="input-event-category"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">範圍</span>
              <select
                value={form.scope}
                onChange={(e) => set("scope", e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                data-testid="select-event-scope"
              >
                <option value="global">全球</option>
                <option value="regional">區域</option>
                <option value="targeted">指定國家</option>
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">性質</span>
              <select
                value={form.kind}
                onChange={(e) => set("kind", e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                data-testid="select-event-kind"
              >
                <option value="disaster">災難（負向）</option>
                <option value="opportunity">機會（正向）</option>
              </select>
            </label>
            {isEdit && (
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">階段</span>
                <select
                  value={form.stage}
                  onChange={(e) => set("stage", e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  data-testid="select-event-stage"
                >
                  <option value="outbreak">爆發</option>
                  <option value="spreading">擴散</option>
                  <option value="peak">高峰</option>
                  <option value="receding">消退</option>
                  <option value="ended">落幕</option>
                </select>
              </label>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">嚴重度（1–100）</span>
              <Input
                type="number"
                min={1}
                max={100}
                value={form.severity}
                onChange={(e) => set("severity", e.target.value)}
                data-testid="input-event-severity"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">影響強度（%）</span>
              <Input
                type="number"
                min={0}
                max={500}
                value={form.impactPct}
                onChange={(e) => set("impactPct", e.target.value)}
                data-testid="input-event-impact"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">最大回合（可留空）</span>
              <Input
                type="number"
                min={1}
                value={form.maxTurns}
                onChange={(e) => set("maxTurns", e.target.value)}
                data-testid="input-event-max-turns"
              />
            </label>
          </div>

          {isEdit && (
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">狀態</span>
              <select
                value={form.status}
                onChange={(e) => set("status", e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                data-testid="select-event-status"
              >
                <option value="active">進行中</option>
                <option value="ended">已結束</option>
              </select>
            </label>
          )}

          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">
              AI 情境備註（供每回合判定參考，可留空）
            </span>
            <textarea
              rows={2}
              value={form.aiContext}
              onChange={(e) => set("aiContext", e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="input-event-ai-context"
            />
          </label>

          <div className="text-sm">
            <span className="mb-1 block text-muted-foreground">
              目標數據（勾選＝事件只影響這些數據；全不勾＝由 AI 自行決定）
            </span>
            <TargetStatsPicker
              selected={form.targetStats}
              onToggle={toggleTargetStat}
              testIdPrefix="checkbox-event-target-stat"
            />
          </div>

          {form.scope === "regional" && (
            <div className="text-sm">
              <span className="mb-1 block text-muted-foreground">影響地區 *</span>
              <RegionMultiSelect
                regions={regions}
                selected={form.regionIds}
                onToggle={toggleRegion}
              />
              {form.regionIds.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {form.regionIds.map((id) => (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
                    >
                      {regionNameById.get(id) ?? `#${id}`}
                      <button
                        onClick={() => toggleRegion(id)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.canSpread}
                  onChange={(e) => set("canSpread", e.target.checked)}
                  data-testid="checkbox-event-can-spread"
                />
                <span>允許蔓延至相鄰地區（擴散階段自動波及鄰區）</span>
              </label>
            </div>
          )}

          {form.scope === "targeted" && (
            <div className="text-sm">
              <span className="mb-1 block text-muted-foreground">指定國家 *</span>
              <NationMultiSelect
                nations={nations}
                selected={form.nationIds}
                onToggle={toggleNation}
              />
              {form.nationIds.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {form.nationIds.map((id) => (
                    <span
                      key={id}
                      className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
                    >
                      {nationNameById.get(id) ?? "（未知國家）"}
                      <button
                        onClick={() => toggleNation(id)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving} data-testid="button-save-event">
            {saving ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-4 w-4" />
            )}
            {isEdit ? "儲存變更" : "建立"}
          </Button>
        </div>
      </div>
    </div>
  );
}
