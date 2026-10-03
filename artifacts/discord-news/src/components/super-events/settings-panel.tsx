import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Save, Settings2, Sparkles, X } from "lucide-react";
import {
  NationMultiSelect,
  RegionMultiSelect,
  TargetStatsPicker,
} from "./pickers";
import {
  API,
  authedFetch,
  readError,
  scopeLabel,
  type NationOption,
  type RegionOption,
  type Settings,
} from "./shared";

export function SettingsPanel({
  regions,
  nations,
  onGenerated,
}: {
  regions: RegionOption[];
  nations: NationOption[];
  onGenerated: () => void;
}) {
  const { toast } = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [extraPrompt, setExtraPrompt] = useState("");
  const [genScope, setGenScope] = useState<string>("global");
  const [genKind, setGenKind] = useState<string>("disaster");
  const [genRegionIds, setGenRegionIds] = useState<number[]>([]);
  const [genNationIds, setGenNationIds] = useState<string[]>([]);
  const [genCanSpread, setGenCanSpread] = useState(false);
  const [genTargetStats, setGenTargetStats] = useState<string[]>([]);
  const toggleGenTargetStat = (key: string) =>
    setGenTargetStats((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );

  const regionNameById = useMemo(
    () => new Map(regions.map((r) => [r.id, r.name])),
    [regions],
  );
  const nationNameById = useMemo(
    () => new Map(nations.map((n) => [n.id, n.name])),
    [nations],
  );
  const toggleGenRegion = (id: number) =>
    setGenRegionIds((prev) =>
      prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id],
    );
  const toggleGenNation = (id: string) =>
    setGenNationIds((prev) =>
      prev.includes(id) ? prev.filter((n) => n !== id) : [...prev, id],
    );

  const load = useCallback(async () => {
    const res = await authedFetch(`${API}/super-events/admin/settings`);
    if (!res.ok) return;
    setSettings((await res.json()) as Settings);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!settings) return;
    if (settings.lossMinPct > settings.lossMaxPct) {
      toast({
        title: "損失下限不可大於損失上限",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const res = await authedFetch(`${API}/super-events/admin/settings`, {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        toast({ title: "儲存失敗", description: await readError(res), variant: "destructive" });
        return;
      }
      toast({ title: "已儲存設定" });
      void load();
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    if (genScope === "regional" && genRegionIds.length === 0) {
      toast({ title: "請至少選擇一個地區", variant: "destructive" });
      return;
    }
    if (genScope === "targeted" && genNationIds.length === 0) {
      toast({ title: "請至少選擇一個國家", variant: "destructive" });
      return;
    }
    setGenerating(true);
    try {
      const res = await authedFetch(`${API}/super-events/admin/generate`, {
        method: "POST",
        body: JSON.stringify({
          extraPrompt: extraPrompt.trim() || undefined,
          scope: genScope,
          kind: genKind,
          canSpread: genScope === "regional" ? genCanSpread : false,
          regionIds: genScope === "regional" ? genRegionIds : [],
          nationIds: genScope === "targeted" ? genNationIds : [],
          targetStats: genTargetStats,
        }),
      });
      if (!res.ok) {
        toast({ title: "生成失敗", description: await readError(res), variant: "destructive" });
        return;
      }
      toast({
        title: "已生成超事件",
        description: `AI 已建立一則${scopeLabel(genScope)}事件。`,
      });
      setExtraPrompt("");
      setGenRegionIds([]);
      setGenNationIds([]);
      setGenCanSpread(false);
      setGenTargetStats([]);
      onGenerated();
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Settings2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="font-bold">系統設定與 AI 生成</h2>
      </div>

      {!settings ? (
        <p className="text-sm text-muted-foreground">載入設定中…（需有效管理金鑰）</p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">
                每回合自動生成機率（%）
              </span>
              <Input
                type="number"
                min={0}
                max={100}
                value={settings.autoGenerateChancePct}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    autoGenerateChancePct: Number(e.target.value),
                  })
                }
                data-testid="input-auto-generate-chance"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">
                全球事件影響強度（%）
              </span>
              <Input
                type="number"
                min={0}
                max={500}
                value={settings.globalImpactPct}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    globalImpactPct: Number(e.target.value),
                  })
                }
                data-testid="input-global-impact"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">
                每回合損失下限（%／點）
              </span>
              <Input
                type="number"
                min={0}
                max={100}
                value={settings.lossMinPct}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    lossMinPct: Number(e.target.value),
                  })
                }
                data-testid="input-loss-min"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">
                每回合損失上限（%／點）
              </span>
              <Input
                type="number"
                min={0}
                max={100}
                value={settings.lossMaxPct}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    lossMaxPct: Number(e.target.value),
                  })
                }
                data-testid="input-loss-max"
              />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            損失上下限套用於所有負面影響（人口％、生產素質％、滿意度／安定度下降、暴動度上升）：
            只夾限事件本就造成的損失，不會無中生有；上限設 0 ＝ 取消所有負面影響；增益（機會事件）不受影響。
          </p>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">
              AI 生成提示（額外指引，可留空）
            </span>
            <textarea
              rows={2}
              value={settings.aiGenerationPrompt}
              onChange={(e) =>
                setSettings({ ...settings, aiGenerationPrompt: e.target.value })
              }
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              data-testid="input-ai-prompt"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={save} disabled={saving}>
              {saving ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-4 w-4" />
              )}
              儲存設定
            </Button>
          </div>

          <div className="rounded-md border border-dashed p-3">
            <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <Sparkles className="h-4 w-4 text-indigo-500" /> 立即 AI 生成一則超事件
            </div>
            <div className="mb-2 grid gap-2 sm:grid-cols-2">
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">影響範圍</span>
                <select
                  value={genScope}
                  onChange={(e) => setGenScope(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  data-testid="select-generate-scope"
                >
                  <option value="global">全球</option>
                  <option value="regional">區域</option>
                  <option value="targeted">指定國家</option>
                </select>
              </label>
              <label className="text-sm">
                <span className="mb-1 block text-muted-foreground">事件性質</span>
                <select
                  value={genKind}
                  onChange={(e) => setGenKind(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  data-testid="select-generate-kind"
                >
                  <option value="disaster">災難</option>
                  <option value="opportunity">機會</option>
                </select>
              </label>
            </div>
            <Input
              placeholder="額外指引（例如：與科技突破有關），可留空"
              value={extraPrompt}
              onChange={(e) => setExtraPrompt(e.target.value)}
              data-testid="input-generate-extra-prompt"
            />

            <div className="mt-2 text-sm">
              <span className="mb-1 block text-muted-foreground">
                目標數據（勾選＝事件只影響這些數據；全不勾＝由 AI 自行決定）
              </span>
              <TargetStatsPicker
                selected={genTargetStats}
                onToggle={toggleGenTargetStat}
                testIdPrefix="checkbox-generate-target-stat"
              />
            </div>

            {genScope === "regional" && (
              <div className="mt-2 text-sm">
                <span className="mb-1 block text-muted-foreground">影響地區 *</span>
                <RegionMultiSelect
                  regions={regions}
                  selected={genRegionIds}
                  onToggle={toggleGenRegion}
                />
                {genRegionIds.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {genRegionIds.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
                      >
                        {regionNameById.get(id) ?? `#${id}`}
                        <button
                          onClick={() => toggleGenRegion(id)}
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
                    checked={genCanSpread}
                    onChange={(e) => setGenCanSpread(e.target.checked)}
                    data-testid="checkbox-generate-can-spread"
                  />
                  <span>允許蔓延至相鄰地區（擴散階段自動波及鄰區）</span>
                </label>
              </div>
            )}

            {genScope === "targeted" && (
              <div className="mt-2 text-sm">
                <span className="mb-1 block text-muted-foreground">指定國家 *</span>
                <NationMultiSelect
                  nations={nations}
                  selected={genNationIds}
                  onToggle={toggleGenNation}
                />
                {genNationIds.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {genNationIds.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs"
                      >
                        {nationNameById.get(id) ?? "（未知國家）"}
                        <button
                          onClick={() => toggleGenNation(id)}
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

            <Button
              className="mt-2"
              variant="secondary"
              onClick={generate}
              disabled={generating}
              data-testid="button-generate-now"
            >
              {generating ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-4 w-4" />
              )}
              立即生成
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
