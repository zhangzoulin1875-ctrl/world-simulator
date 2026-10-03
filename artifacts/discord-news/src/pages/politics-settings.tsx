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
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import {
  Landmark,
  Loader2,
  Play,
  RotateCcw,
  Save,
  ShieldAlert,
} from "lucide-react";

type Settings = Record<string, number>;

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

interface FieldDef {
  key: string;
  label: string;
  hint?: string;
}

interface SectionDef {
  title: string;
  description: string;
  fields: FieldDef[];
}

const SECTIONS: SectionDef[] = [
  {
    title: "穩定度效果",
    description: "穩定度對科技與生產力的加減成（穩定度 50 為中性）。",
    fields: [
      {
        key: "stabilityMaxBonusPct",
        label: "最大加減成 %",
        hint: "穩定度 100 時 +N%、0 時 -N%",
      },
    ],
  },
  {
    title: "滿意度 → 暴動度／穩定度（每回合）",
    description: "回合結算時依四大階級滿意度平均值調整暴動度與穩定度。",
    fields: [
      { key: "satisfactionHighThreshold", label: "高滿意門檻" },
      { key: "highSatisfactionUnrestDelta", label: "高滿意：暴動度變化" },
      { key: "highSatisfactionStabilityDelta", label: "高滿意：穩定度變化" },
      { key: "midSatisfactionUnrestDelta", label: "中間帶：暴動度變化" },
      { key: "satisfactionLowThreshold", label: "低滿意門檻" },
      { key: "lowSatisfactionUnrestDelta", label: "低滿意：暴動度變化" },
      { key: "lowSatisfactionStabilityDelta", label: "低滿意：穩定度變化" },
    ],
  },
  {
    title: "政策判定",
    description: "玩家政策想法由 AI 評分後的成功率公式與失敗懲罰。",
    fields: [
      { key: "policySuccessBasePct", label: "基礎成功率 %" },
      {
        key: "policySuccessStabilityWeight",
        label: "穩定度權重",
        hint: "(穩定度 − 50) × 權重",
      },
      {
        key: "policySuccessFitWeight",
        label: "契合度權重",
        hint: "(AI 契合分 − 50) × 權重",
      },
      { key: "policySuccessMinPct", label: "成功率下限 %" },
      { key: "policySuccessMaxPct", label: "成功率上限 %" },
    ],
  },
  {
    title: "隨機事件",
    description: "回合結算時每個國家觸發政體風格隨機事件的機率與長度。",
    fields: [
      { key: "eventChancePct", label: "事件機率 %" },
      {
        key: "goodEventMinPct",
        label: "好事件機率下限 %",
        hint: "滿意度低時趨近下限",
      },
      {
        key: "goodEventMaxPct",
        label: "好事件機率上限 %",
        hint: "滿意度高時趨近上限",
      },
      { key: "eventDurationTurns", label: "事件持續回合" },
      { key: "reformDurationTurns", label: "變革預設持續回合" },
      { key: "maxDurationTurns", label: "持續回合上限" },
      { key: "modifierAbsCap", label: "單項加減成絕對值上限" },
    ],
  },
  {
    title: "政變",
    description: "暴動度超過門檻時可能發生政變；機率與懲罰皆可調整。",
    fields: [
      { key: "coupUnrestThreshold", label: "暴動度門檻" },
      { key: "coupBaseChancePct", label: "基礎機率 %" },
      { key: "coupUnrestFactor", label: "暴動度係數", hint: "(暴動 − 門檻) × 係數" },
      { key: "coupStabilityFactor", label: "穩定度抵抗係數" },
      { key: "coupMaxChancePct", label: "機率上限 %" },
      {
        key: "counterEventStabilityPenalty",
        label: "抗衡事件：穩定度損失",
        hint: "軍方抗衡事件觸發時的穩定度扣減",
      },
    ],
  },
  {
    title: "人口增長",
    description:
      "每日回合依「基礎增長率 + 政策/事件人口增長加減成」對總人口累加（總人口不會低於 0）。",
    fields: [
      {
        key: "populationBaseGrowthPct",
        label: "基礎增長率 %／回合",
        hint: "可為負值（-20 ～ 20）",
      },
      {
        key: "populationGrowthMaxAbsPct",
        label: "增長率絕對值上限 %",
        hint: "基礎 + 加減成後夾在 ±N%",
      },
    ],
  },
  {
    title: "政策效果目標分項上限",
    description:
      "各目標的單項絕對值上限（伺服器端強制夾限；超出直接截斷）。預設：滿意度/穩定/服從 ±10、生產/科技 ±5、人口增長/糧食增長 ±3、厭戰度 ±5。",
    fields: [
      {
        key: "modifierCapSatisfaction",
        label: "滿意度系列上限",
        hint: "satisfaction / satisfactionLaw/Culture/Religion/Rights/Military 共用此上限",
      },
      { key: "modifierCapStability", label: "穩定度（stability）上限" },
      { key: "modifierCapProduction", label: "生產力（production）上限" },
      { key: "modifierCapTech", label: "科技（tech）上限" },
      {
        key: "modifierCapPopulationGrowth",
        label: "人口增長（populationGrowth）上限",
      },
      {
        key: "modifierCapMilitaryObedience",
        label: "軍方服從度（militaryObedience）上限",
      },
      {
        key: "warWearinessModifierCapPct",
        label: "厭戰度修飾上限（warWeariness）",
        hint: "啟用後政策的厭戰度加減成夾在 ±N%；正值降低厭戰",
      },
      {
        key: "foodGrowthModifierCapPct",
        label: "糧食增長率修飾上限（foodGrowth）",
        hint: "啟用後政策的糧食增長率加減成夾在 ±N%",
      },
    ],
  },
  {
    title: "政策效果目標白名單",
    description:
      "0 = 禁用（伺服器剔除，AI prompt 同步排除）；1 = 允許。例如設為 0 可阻止政策直接加減生產力或科技。",
    fields: [
      {
        key: "allowTargetSatisfaction",
        label: "允許影響滿意度系列 (0/1)",
        hint: "包含 satisfactionLaw/Culture/Religion/Rights/Military 及舊式 satisfaction",
      },
      { key: "allowTargetStability", label: "允許影響穩定度 (0/1)" },
      { key: "allowTargetProduction", label: "允許影響生產力 (0/1)" },
      { key: "allowTargetTech", label: "允許影響科技加成 (0/1)" },
      { key: "allowTargetPopulationGrowth", label: "允許影響人口增長 (0/1)" },
      {
        key: "allowTargetMilitaryObedience",
        label: "允許影響軍方服從度 (0/1)",
      },
      {
        key: "warWearinessModifierEnabled",
        label: "啟用厭戰度政策修飾 (0/1)",
        hint: "0 = 政策無法影響厭戰度，亦不顯示於 AI prompt",
      },
      {
        key: "allowPermanentTradition",
        label: "允許傳統（tradition）永久效果 (0/1)",
        hint: "0 = 傳統也有期限，durationTurns=null 一律轉為 maxDurationTurns",
      },
    ],
  },
  {
    title: "厭戰度政策修飾",
    description:
      "啟用後，政策可以透過 warWeariness 目標每回合降低或提升厭戰度（正值 = 降低厭戰；已於上方「白名單」區塊的「啟用厭戰度政策修飾 (0/1)」控制開關）。",
    fields: [
      {
        key: "warWearinessModifierCapPct",
        label: "單項上限 %",
        hint: "政策 warWeariness 效果的絕對值上限（預設 5）",
      },
    ],
  },
  {
    title: "糧食增長率修飾",
    description:
      "啟用後，政策可透過 foodGrowth 目標每回合提升糧食產出。有效增長率 = 基礎率 + 各國政策加減成，夾在 0.01–10%；停用或合計 ≤ 0 時無加成。",
    fields: [
      {
        key: "foodGrowthEnabled",
        label: "啟用糧食增長率修飾 (0/1)",
        hint: "0 = 糧食增長率無效（政策 foodGrowth 目標被剔除）",
      },
      {
        key: "foodGrowthModifierCapPct",
        label: "政策單項上限 %",
        hint: "政策 foodGrowth 效果的絕對值上限（預設 3）",
      },
      {
        key: "foodGrowthBaseRatePct",
        label: "全域基礎糧食增長率 %",
        hint: "各國政策加減成疊加於此基礎上；預設 0（僅由政策驅動）",
      },
    ],
  },
  {
    title: "人口增長率下限",
    description: "防止政策效果或事件將人口增長率壓成永久衰退。",
    fields: [
      {
        key: "populationGrowthMinAbsPct",
        label: "人口增長最小值 %",
        hint: "增長率夾至不低於此值（預設 0.01%；設 0 允許衰退至 0）",
      },
    ],
  },
  {
    title: "其他",
    description: "介面與輸入相關限制。",
    fields: [{ key: "ideaMaxLength", label: "政策想法字數上限" }],
  },
];

export default function PoliticsSettings() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [defaults, setDefaults] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [settling, setSettling] = useState(false);
  const [dirty, setDirty] = useState(false);

  const isAdmin = Boolean(getAdminToken());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authedFetch("/api/politics/settings");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(
            typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
          );
        }
        if (!cancelled) {
          setSettings(data.settings as Settings);
          if (data.defaults) setDefaults(data.defaults as Settings);
        }
      } catch (err) {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : "載入失敗");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setField = (key: string, raw: string) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const num = Number(raw);
      return { ...prev, [key]: Number.isFinite(num) ? num : 0 };
    });
    setDirty(true);
  };

  const restoreField = (key: string) => {
    if (!defaults) return;
    setSettings((prev) => {
      if (!prev) return prev;
      return { ...prev, [key]: defaults[key] };
    });
    setDirty(true);
  };

  const restoreAll = () => {
    if (!defaults) return;
    setSettings((prev) => (prev ? { ...prev, ...defaults } : prev));
    setDirty(true);
  };

  const diffCount =
    settings && defaults
      ? Object.keys(defaults).filter((k) => settings[k] !== defaults[k]).length
      : 0;

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await authedFetch("/api/politics/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      setSettings(data.settings as Settings);
      setDirty(false);
      toast({ title: "已儲存", description: "內政參數已更新。" });
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

  const settle = async () => {
    if (
      !window.confirm(
        "確定要手動觸發內政回合結算嗎？將判定所有待審政策、衰減條目、產生隨機事件與政變檢定。",
      )
    ) {
      return;
    }
    setSettling(true);
    try {
      const res = await authedFetch("/api/politics/settle", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      const s = data.summary ?? {};
      toast({
        title: "結算完成",
        description: `國家 ${s.nations ?? 0}、判定想法 ${s.ideasJudged ?? 0}、事件 ${s.eventsCreated ?? 0}、政變 ${s.coups ?? 0}`,
      });
    } catch (err) {
      toast({
        title: "結算失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSettling(false);
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
              請先在側邊欄底部輸入管理金鑰，才能檢視與調整內政參數。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6" data-testid="page-politics-settings">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-bold">
            <Landmark className="h-6 w-6" />
            內政參數
          </h1>
          <p className="text-sm text-muted-foreground">
            調整穩定度、滿意度、政策判定、隨機事件與政變的所有數值。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={restoreAll}
            disabled={saving || !settings || !defaults || diffCount === 0}
            data-testid="button-restore-all"
          >
            <RotateCcw className="mr-1.5 h-4 w-4" />
            全部還原為預設
            {diffCount > 0 ? `（${diffCount}）` : ""}
          </Button>
          <Button
            variant="secondary"
            onClick={settle}
            disabled={settling}
            data-testid="button-settle"
          >
            {settling ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-4 w-4" />
            )}
            手動回合結算
          </Button>
          <Button
            onClick={save}
            disabled={saving || !dirty || !settings}
            data-testid="button-save-settings"
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

      <p className="rounded-lg border border-muted p-3 text-xs text-muted-foreground">
        內政結算已由每日回合自動執行（見「回合設定」頁）；「手動回合結算」可額外立即執行一次完整的內政結算（AI
        判定政策、條目衰減、隨機事件、政變檢定）。
      </p>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          載入內政參數中…
        </div>
      ) : loadError || !settings ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {loadError ?? "載入失敗"}
          </CardContent>
        </Card>
      ) : (
        SECTIONS.map((section) => (
          <Card key={section.title}>
            <CardHeader>
              <CardTitle className="text-base">{section.title}</CardTitle>
              <CardDescription>{section.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2">
                {section.fields.map((f) => {
                  const hasDefault =
                    defaults != null && f.key in defaults;
                  const differs =
                    hasDefault && settings[f.key] !== defaults![f.key];
                  return (
                    <div key={f.key} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={`field-${f.key}`} className="text-xs">
                          {f.label}
                        </Label>
                        {differs && (
                          <button
                            type="button"
                            onClick={() => restoreField(f.key)}
                            className="flex items-center gap-1 text-[11px] text-amber-600 hover:underline"
                            data-testid={`restore-${f.key}`}
                          >
                            <RotateCcw className="h-3 w-3" />
                            還原 {defaults![f.key]}
                          </button>
                        )}
                      </div>
                      <Input
                        id={`field-${f.key}`}
                        type="number"
                        step="any"
                        value={settings[f.key] ?? 0}
                        onChange={(e) => setField(f.key, e.target.value)}
                        data-testid={`input-${f.key}`}
                        className={
                          differs ? "border-amber-500 focus-visible:ring-amber-500" : undefined
                        }
                      />
                      {f.hint && (
                        <p className="text-[11px] text-muted-foreground">{f.hint}</p>
                      )}
                      {hasDefault && (
                        <p
                          className={`text-[11px] ${
                            differs ? "text-amber-600" : "text-muted-foreground"
                          }`}
                        >
                          預設值：{defaults![f.key]}
                          {differs ? "（目前為非預設值）" : ""}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
