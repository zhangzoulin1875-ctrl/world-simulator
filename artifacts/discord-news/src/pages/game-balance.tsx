import { useCallback, useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import {
  authedFetch,
  formatDateTime,
  readError,
} from "@/components/world-sim/shared";
import { Gavel, Loader2, Save, Scale, ShieldAlert, Undo2 } from "lucide-react";

/** Task #451 — 遊戲平衡管理（admin raw-fetch，不在 OpenAPI spec）。 */

const UNIT_CATEGORIES = [
  "infantry",
  "ranged",
  "armor",
  "artillery",
  "ship",
  "air",
  "siege",
] as const;
type UnitCategory = (typeof UNIT_CATEGORIES)[number];

const CATEGORY_LABELS: Record<UnitCategory, string> = {
  infantry: "步兵",
  ranged: "遠程",
  armor: "裝甲",
  artillery: "砲兵",
  ship: "船艦",
  air: "空軍",
  siege: "攻城",
};

const MODIFIER_SOURCES = [
  "treasuryCrisis",
  "politicsEntries",
  "supportDrift",
  "fiscalPolicy",
] as const;
type ModifierSource = (typeof MODIFIER_SOURCES)[number];

const SOURCE_LABELS: Record<ModifierSource, string> = {
  treasuryCrisis: "國庫危機懲罰",
  politicsEntries: "政治條目每回合效果",
  supportDrift: "政治支持度漂移",
  fiscalPolicy: "財政政策 AI 判定偏移",
};

const ABUSE_DOMAINS = [
  "unit_design",
  "war_order",
  "interior_policy",
  "fiscal_policy",
] as const;
type AbuseDomain = (typeof ABUSE_DOMAINS)[number];

const DOMAIN_LABELS: Record<AbuseDomain, string> = {
  unit_design: "兵種設計",
  war_order: "戰爭指令",
  interior_policy: "內政政策",
  fiscal_policy: "財政政策",
};

const VERDICT_LABELS: Record<string, string> = {
  rejected: "退件",
  penalized: "懲罰",
  neutralized: "效果歸零",
  forced_failure: "強制失敗",
};

/**
 * 糧食時代指數（與伺服器 lib/mapRegionEras.ts ERAS、lib/food.ts
 * FOOD_ERA_INDEX 同步；def = 伺服器預設值，僅供顯示與缺值回填）。
 */
const FOOD_ERAS = [
  { slug: "classical", label: "古典時代(秦朝)", def: 0.1 },
  { slug: "roman", label: "羅馬帝國時期(漢朝)", def: 0.2 },
  { slug: "early_medieval", label: "中世紀早期(唐朝)", def: 0.3 },
  { slug: "high_medieval", label: "中世紀中期(宋朝)", def: 0.4 },
  { slug: "renaissance", label: "文藝復興時期(明朝)", def: 0.6 },
  { slug: "discovery", label: "大航海時代(清朝)", def: 0.8 },
  { slug: "scientific", label: "科學革命", def: 1 },
  { slug: "enlightenment", label: "啟蒙運動", def: 1.5 },
  { slug: "industrial", label: "工業革命", def: 2 },
  { slug: "ww1", label: "一戰時期", def: 3 },
  { slug: "ww2", label: "二戰時期", def: 4 },
  { slug: "cold_war", label: "冷戰時期", def: 6 },
  { slug: "modern", label: "現代時期", def: 10 },
  { slug: "future", label: "未來科技", def: 20 },
] as const;
type FoodEraSlug = (typeof FOOD_ERAS)[number]["slug"];

interface SourceSetting {
  enabled: boolean;
  minDelta: number;
  maxDelta: number;
}

interface BalanceSettings {
  unitDesign: {
    aiRejectionEnabled: boolean;
    multiplierCaps: Record<UnitCategory, number>;
    hpMax: number;
    attackMax: number;
    defenseMax: number;
    speedMax: number;
    moneyCostMin: number;
    prodCostPer100Min: number;
    popCostMin: number;
    prodUpkeepPerUnitMin: number;
    upkeepMin: number;
    woodCostMax: number;
    oreCostMax: number;
  };
  war: {
    reviewEnabled: boolean;
    penaltyAggressionPct: number;
    backlashExtraCasualtyPct: number;
    backlashTerritoryPct: number;
    backlashStabilityDrop: number;
    backlashUnrestRise: number;
    backlashWarWearinessRise: number;
    woundedRecoveryPctPerTurn: number;
  };
  interior: { reviewEnabled: boolean };
  modifierSources: Record<ModifierSource, SourceSetting>;
  food: { eraIndex: Record<FoodEraSlug, number> };
  constructionCosts: Record<ConstructionCostKey, number>;
}

/** Task #523 — 建設成本倍率（最終成本 = ceil(原成本 × 倍率)，至少 1）。 */
const CONSTRUCTION_COST_KEYS = [
  "productivityInvestment",
  "resourceBuilding",
  "cityBuilding",
] as const;
type ConstructionCostKey = (typeof CONSTRUCTION_COST_KEYS)[number];

const CONSTRUCTION_COST_LABELS: Record<ConstructionCostKey, string> = {
  productivityInvestment: "生產力投資",
  resourceBuilding: "資源建築（建造／升級）",
  cityBuilding: "一般城市建築",
};

interface CategoryAverages {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  woodCost: number;
  oreCost: number;
  upkeep: number;
  prodUpkeep: number;
  count: number;
}

/** 平均值顯示：≤1 位小數（0 也照樣顯示，方便管理員檢視全體兵種口徑）。 */
function fmtAvg(n: number | undefined): string {
  return (Math.round((n ?? 0) * 10) / 10).toString();
}

interface AbuseRecord {
  id: number;
  domain: string;
  verdict: string;
  discordUserId: string | null;
  nationId: string | null;
  nationName: string | null;
  /** Task #519 — 讀取時補出的玩家顯示名稱（globalName ?? username）。 */
  actorName: string | null;
  inputText: string;
  reason: string;
  revertedAt: string | null;
  revertNote: string | null;
  compensation: Record<string, number> | null;
  /** Task #547 — 逐案加重處罰標記（與撤銷互斥）。 */
  punishedAt: string | null;
  punishNote: string | null;
  punishment: Record<string, number> | null;
  createdAt: string;
}

/**
 * Task #519 — 行為人顯示：「國名 · 玩家名稱」；缺國名只顯示玩家，
 * 玩家名稱查不到退回 discordUserId；完全無關聯者回 null（不顯示）。
 */
function formatActor(r: AbuseRecord): string | null {
  const playerName = r.actorName ?? r.discordUserId;
  const parts = [r.nationName, playerName].filter(
    (p): p is string => Boolean(p),
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Task #459 — 撤銷/補償表單狀態（字串保存輸入，送出時轉數字）。 */
interface RevertForm {
  money: string;
  satisfactionDelta: string;
  stabilityDelta: string;
  unrestDelta: string;
  warWearinessDelta: string;
  note: string;
}

const EMPTY_REVERT_FORM: RevertForm = {
  money: "0",
  satisfactionDelta: "0",
  stabilityDelta: "0",
  unrestDelta: "0",
  warWearinessDelta: "0",
  note: "",
};

/** Task #547 — 加重處罰表單狀態（字串保存輸入，送出時轉數字）。 */
interface PunishForm {
  money: string;
  satisfactionDelta: string;
  stabilityDelta: string;
  unrestDelta: string;
  warWearinessDelta: string;
  armyCasualtyPct: string;
  note: string;
}

const EMPTY_PUNISH_FORM: PunishForm = {
  money: "0",
  satisfactionDelta: "0",
  stabilityDelta: "0",
  unrestDelta: "0",
  warWearinessDelta: "0",
  armyCasualtyPct: "0",
  note: "",
};

function numberInput(
  value: string,
  onChange: (v: string) => void,
  props?: { min?: number; max?: number; step?: number | "any" },
) {
  return (
    <Input
      type="number"
      value={value}
      min={props?.min}
      max={props?.max}
      step={props?.step ?? 1}
      onChange={(e) => onChange(e.target.value)}
      className="w-28"
    />
  );
}

export default function GameBalance() {
  const { toast } = useToast();
  const isAdmin = Boolean(getAdminToken());

  const [settings, setSettings] = useState<BalanceSettings | null>(null);
  const [averages, setAverages] = useState<Record<
    string,
    CategoryAverages
  > | null>(null);
  const [records, setRecords] = useState<AbuseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [applyingFloor, setApplyingFloor] = useState(false);
  const [domainFilter, setDomainFilter] = useState<string>("all");
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [revertOpenId, setRevertOpenId] = useState<number | null>(null);
  const [revertForm, setRevertForm] = useState<RevertForm>(EMPTY_REVERT_FORM);
  const [reverting, setReverting] = useState(false);
  const [punishOpenId, setPunishOpenId] = useState<number | null>(null);
  const [punishForm, setPunishForm] = useState<PunishForm>(EMPTY_PUNISH_FORM);
  const [punishing, setPunishing] = useState(false);

  const loadRecords = useCallback(async (domain: string) => {
    setRecordsLoading(true);
    try {
      const qs =
        domain !== "all" ? `?domain=${encodeURIComponent(domain)}` : "";
      const res = await authedFetch(`/api/game-balance/abuse-records${qs}`);
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setRecords(data.records ?? []);
    } catch {
      setRecords([]);
    } finally {
      setRecordsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const [sRes, aRes] = await Promise.all([
          authedFetch("/api/game-balance/settings"),
          authedFetch("/api/game-balance/unit-averages"),
        ]);
        if (!sRes.ok) throw new Error(await readError(sRes));
        if (!aRes.ok) throw new Error(await readError(aRes));
        const sData = await sRes.json();
        const aData = await aRes.json();
        setSettings(sData.settings);
        setAverages(aData.averages);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "載入失敗");
      } finally {
        setLoading(false);
      }
    })();
    void loadRecords("all");
  }, [isAdmin, loadRecords]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await authedFetch("/api/game-balance/settings", {
        method: "PUT",
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setSettings(data.settings);
      toast({ title: "已儲存", description: "遊戲平衡設定已更新" });
    } catch (err) {
      toast({
        title: "儲存失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const applyFloor = async () => {
    setApplyingFloor(true);
    try {
      const res = await authedFetch("/api/game-balance/apply-prod-cost-floor", { method: "POST" });
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      const r = data.updatedRecruit as number;
      const o = data.updatedOccupy as number;
      toast({
        title: "已套用生產力下限",
        description: `招募成本更新 ${r.toLocaleString("zh-TW")} 筆（下限 ${(data.recruitFloor as number).toLocaleString("zh-TW")}）、生產力佔用更新 ${o.toLocaleString("zh-TW")} 筆（下限 ${(data.occupyFloor as number).toLocaleString("zh-TW")}）`,
      });
    } catch (err) {
      toast({
        title: "套用失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setApplyingFloor(false);
    }
  };

  const patch = (fn: (s: BalanceSettings) => BalanceSettings) =>
    setSettings((s) => (s ? fn(structuredClone(s)) : s));

  const openRevert = (id: number) => {
    setRevertOpenId(id);
    setPunishOpenId(null);
    setRevertForm(EMPTY_REVERT_FORM);
  };

  const openPunish = (id: number) => {
    setPunishOpenId(id);
    setRevertOpenId(null);
    setPunishForm(EMPTY_PUNISH_FORM);
  };

  const submitRevert = async (record: AbuseRecord) => {
    setReverting(true);
    try {
      const res = await authedFetch(
        `/api/game-balance/abuse-records/${record.id}/revert`,
        {
          method: "POST",
          body: JSON.stringify({
            money: Number(revertForm.money) || 0,
            satisfactionDelta: Number(revertForm.satisfactionDelta) || 0,
            stabilityDelta: Number(revertForm.stabilityDelta) || 0,
            unrestDelta: Number(revertForm.unrestDelta) || 0,
            warWearinessDelta: Number(revertForm.warWearinessDelta) || 0,
            ...(revertForm.note.trim()
              ? { note: revertForm.note.trim() }
              : {}),
          }),
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setRecords((rs) =>
        rs.map((r) => (r.id === record.id ? { ...r, ...data.record } : r)),
      );
      setRevertOpenId(null);
      toast({ title: "已撤銷", description: "補償已套用並標記撤銷" });
    } catch (err) {
      toast({
        title: "撤銷失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setReverting(false);
    }
  };

  const submitPunish = async (record: AbuseRecord) => {
    setPunishing(true);
    try {
      const res = await authedFetch(
        `/api/game-balance/abuse-records/${record.id}/punish`,
        {
          method: "POST",
          body: JSON.stringify({
            money: Number(punishForm.money) || 0,
            satisfactionDelta: Number(punishForm.satisfactionDelta) || 0,
            stabilityDelta: Number(punishForm.stabilityDelta) || 0,
            unrestDelta: Number(punishForm.unrestDelta) || 0,
            warWearinessDelta: Number(punishForm.warWearinessDelta) || 0,
            armyCasualtyPct: Number(punishForm.armyCasualtyPct) || 0,
            ...(punishForm.note.trim()
              ? { note: punishForm.note.trim() }
              : {}),
          }),
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      const data = await res.json();
      setRecords((rs) =>
        rs.map((r) => (r.id === record.id ? { ...r, ...data.record } : r)),
      );
      setPunishOpenId(null);
      toast({ title: "已加重處罰", description: "處罰已套用並通知玩家" });
    } catch (err) {
      toast({
        title: "處罰失敗",
        description: err instanceof Error ? err.message : "未知錯誤",
        variant: "destructive",
      });
    } finally {
      setPunishing(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
        <ShieldAlert className="w-8 h-8" />
        <p>需要管理員權杖才能存取此頁面。</p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (loadError || !settings) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
        <ShieldAlert className="w-8 h-8" />
        <p>載入失敗：{loadError ?? "無資料"}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-serif font-bold text-2xl flex items-center gap-2">
            <Scale className="w-6 h-6" /> 遊戲平衡管理
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            AI 濫用防線：兵種設計夾限與退件、戰爭指令審查、內政／財政政策審查、
            加減成來源開關與夾限。
          </p>
        </div>
        <Button onClick={save} disabled={saving}>
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin mr-1" />
          ) : (
            <Save className="w-4 h-4 mr-1" />
          )}
          儲存設定
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>兵種設計防線</CardTitle>
          <CardDescription>
            AI 直接退件離譜／穿越時代需求（400、退還設計點）；通過者再依「類別
            全庫平均 × 倍率上限」與絕對上下限夾限。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={settings.unitDesign.aiRejectionEnabled}
              onCheckedChange={(v) =>
                patch((s) => {
                  s.unitDesign.aiRejectionEnabled = v === true;
                  return s;
                })
              }
            />
            啟用 AI 退件（關閉後仍套夾限）
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {UNIT_CATEGORIES.map((c) => (
              <div key={c} className="space-y-1">
                <Label className="text-xs">
                  {CATEGORY_LABELS[c]} 倍率上限
                  {averages?.[c] && averages[c].count > 0 ? (
                    <span className="text-muted-foreground">
                      （均攻 {Math.round(averages[c].attack)}・木{" "}
                      {fmtAvg(averages[c].woodCost)}・礦{" "}
                      {fmtAvg(averages[c].oreCost)}・維護 金
                      {fmtAvg(averages[c].upkeep)}/產
                      {fmtAvg(averages[c].prodUpkeep)}）
                    </span>
                  ) : (
                    <span className="text-muted-foreground">（無樣本）</span>
                  )}
                </Label>
                {numberInput(
                  String(settings.unitDesign.multiplierCaps[c] ?? 5),
                  (v) =>
                    patch((s) => {
                      s.unitDesign.multiplierCaps[c] = Number(v);
                      return s;
                    }),
                  { min: 1, max: 100 },
                )}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(
              [
                ["hpMax", "HP 絕對上限"],
                ["attackMax", "攻擊絕對上限"],
                ["defenseMax", "防禦絕對上限"],
                ["speedMax", "速度絕對上限"],
                ["moneyCostMin", "金錢成本下限"],
                ["prodCostPer100Min", "招募生產力成本下限"],
                ["prodUpkeepPerUnitMin", "生產力佔用下限"],
                ["popCostMin", "人口成本下限"],
                ["upkeepMin", "每單位維護費下限"],
                ["woodCostMax", "每單位木材成本上限"],
                ["oreCostMax", "每單位礦石成本上限"],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-1">
                <Label className="text-xs">{label}</Label>
                {numberInput(
                  String(settings.unitDesign[key]),
                  (v) =>
                    patch((s) => {
                      s.unitDesign[key] = Number(v);
                      return s;
                    }),
                  { min: 0.0001, step: "any" },
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3">
            <div className="flex-1 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">套用生產力佔用下限到現有兵種</span>
              <span className="ml-2 text-xs">——將所有低於上方「生產成本下限」的兵種設計一律提升到該下限值（請先儲存設定再執行）</span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void applyFloor()}
              disabled={applyingFloor}
            >
              {applyingFloor ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Scale className="mr-1.5 h-3.5 w-3.5" />
              )}
              立即套用
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>戰爭指令審查</CardTitle>
          <CardDescription>
            AI 只負責標旗（不合理／穿越時代／exploit）；懲罰由伺服器決定：被標旗
            一方的軍團積極度乘上懲罰係數，exploit 再減半並取消其有利領土變動。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={settings.war.reviewEnabled}
              onCheckedChange={(v) =>
                patch((s) => {
                  s.war.reviewEnabled = v === true;
                  return s;
                })
              }
            />
            啟用戰爭指令審查
          </label>
          <div className="space-y-1 max-w-xs">
            <Label className="text-xs">被標旗方積極度乘數（%）</Label>
            {numberInput(String(settings.war.penaltyAggressionPct), (v) =>
              patch((s) => {
                s.war.penaltyAggressionPct = Number(v);
                return s;
              }),
              { min: 0, max: 100 },
            )}
          </div>
          <p className="text-xs text-muted-foreground pt-2">
            反噬懲罰（Task #547）：以下全部預設 0（不啟用）；exploit 標旗一律
            加倍（傷亡／領土封頂於允許上限）。額外傷亡仍受戰力硬上限與剩餘
            兵力封頂；國家數值懲罰只套用到被標旗方主帥（限有主玩家國家）。
          </p>
          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <Label className="text-xs">反噬額外傷亡（%，0–50）</Label>
              {numberInput(String(settings.war.backlashExtraCasualtyPct), (v) =>
                patch((s) => {
                  s.war.backlashExtraCasualtyPct = Number(v);
                  return s;
                }),
                { min: 0, max: 50 },
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">反噬領土推移（百分點，0–15）</Label>
              {numberInput(String(settings.war.backlashTerritoryPct), (v) =>
                patch((s) => {
                  s.war.backlashTerritoryPct = Number(v);
                  return s;
                }),
                { min: 0, max: 15 },
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">穩定度下降（0–30）</Label>
              {numberInput(String(settings.war.backlashStabilityDrop), (v) =>
                patch((s) => {
                  s.war.backlashStabilityDrop = Number(v);
                  return s;
                }),
                { min: 0, max: 30 },
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">暴動值上升（0–30）</Label>
              {numberInput(String(settings.war.backlashUnrestRise), (v) =>
                patch((s) => {
                  s.war.backlashUnrestRise = Number(v);
                  return s;
                }),
                { min: 0, max: 30 },
              )}
            </div>
            <div className="space-y-1">
              <Label className="text-xs">厭戰度上升（0–30）</Label>
              {numberInput(
                String(settings.war.backlashWarWearinessRise),
                (v) =>
                  patch((s) => {
                    s.war.backlashWarWearinessRise = Number(v);
                    return s;
                  }),
                { min: 0, max: 30 },
              )}
            </div>
          </div>
          <div className="mt-4 border-t pt-4 space-y-1">
            <Label className="text-xs font-semibold">傷兵復原速率（%/回合）</Label>
            <p className="text-xs text-muted-foreground mb-1">
              每回合復原初始傷兵數的此百分比（線性）。10 = 10 回合完全復原；20 = 5 回合；1 = 100 回合。
            </p>
            {numberInput(
              String(settings.war.woundedRecoveryPctPerTurn),
              (v) =>
                patch((s) => {
                  s.war.woundedRecoveryPctPerTurn = Number(v);
                  return s;
                }),
              { min: 1, max: 100 },
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>內政／財政政策審查</CardTitle>
          <CardDescription>
            暴政、鎮壓、苛稅皆屬合法玩法**不會**被罰；只有離譜（現代科技穿越、
            數值指令注入、無關遊戲的要求）才會被歸零或強制失敗並記錄。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={settings.interior.reviewEnabled}
              onCheckedChange={(v) =>
                patch((s) => {
                  s.interior.reviewEnabled = v === true;
                  return s;
                })
              }
            />
            啟用內政／財政政策審查
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>加減成來源註冊表</CardTitle>
          <CardDescription>
            各系統對滿意度／穩定度等數值的每次增減，可個別停用或夾限（百分點，
            於套用點生效，不影響結算引擎內部精度）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {MODIFIER_SOURCES.map((src) => {
            const cfg = settings.modifierSources[src];
            return (
              <div
                key={src}
                className="flex flex-wrap items-center gap-3 border rounded-md p-3"
              >
                <label className="flex items-center gap-2 text-sm min-w-56">
                  <Checkbox
                    checked={cfg.enabled}
                    onCheckedChange={(v) =>
                      patch((s) => {
                        s.modifierSources[src].enabled = v === true;
                        return s;
                      })
                    }
                  />
                  {SOURCE_LABELS[src]}
                </label>
                <div className="flex items-center gap-2 text-xs">
                  <span>下限</span>
                  {numberInput(String(cfg.minDelta), (v) =>
                    patch((s) => {
                      s.modifierSources[src].minDelta = Number(v);
                      return s;
                    }),
                    { min: -100, max: 0 },
                  )}
                  <span>上限</span>
                  {numberInput(String(cfg.maxDelta), (v) =>
                    patch((s) => {
                      s.modifierSources[src].maxDelta = Number(v);
                      return s;
                    }),
                    { min: 0, max: 100 },
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>糧食時代指數</CardTitle>
          <CardDescription>
            糧食產出公式：控制面積 × 肥沃度 × 時代指數 × 農民比例 × 校準常數。
            各時代指數可個別調整（0–10000，立即影響所有國家的產出與飢荒判定）；
            括號內為系統預設值。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {FOOD_ERAS.map((e) => (
              <div key={e.slug} className="space-y-1">
                <Label className="text-xs">
                  {e.label}
                  <span className="text-muted-foreground">（預設 {e.def}）</span>
                </Label>
                {numberInput(
                  String(settings.food?.eraIndex?.[e.slug] ?? e.def),
                  (v) =>
                    patch((s) => {
                      if (!s.food?.eraIndex) {
                        s.food = {
                          eraIndex: Object.fromEntries(
                            FOOD_ERAS.map((x) => [x.slug, x.def]),
                          ) as Record<FoodEraSlug, number>,
                        };
                      }
                      s.food.eraIndex[e.slug] = Number(v);
                      return s;
                    }),
                  { min: 0, max: 10000, step: 0.1 },
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>建設成本倍率</CardTitle>
          <CardDescription>
            最終成本 = 原公式成本 × 倍率（向上取整、至少
            1）。範圍 0.0001–100，預設 1 = 現狀價格；顯示與扣款同步生效，
            維護費不受影響。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {CONSTRUCTION_COST_KEYS.map((k) => (
              <div key={k} className="space-y-1">
                <Label className="text-xs">
                  {CONSTRUCTION_COST_LABELS[k]}
                  <span className="text-muted-foreground">（預設 1）</span>
                </Label>
                {numberInput(
                  String(settings.constructionCosts?.[k] ?? 1),
                  (v) =>
                    patch((s) => {
                      if (!s.constructionCosts) {
                        s.constructionCosts = {
                          productivityInvestment: 1,
                          resourceBuilding: 1,
                          cityBuilding: 1,
                        };
                      }
                      s.constructionCosts[k] = Number(v);
                      return s;
                    }),
                  { min: 0.0001, max: 100, step: "any" },
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle>AI 濫用紀錄</CardTitle>
              <CardDescription>
                兵種退件、戰爭指令懲罰、內政／財政政策歸零紀錄（最新在前）。
              </CardDescription>
            </div>
            <Select
              value={domainFilter}
              onValueChange={(v) => {
                setDomainFilter(v);
                void loadRecords(v);
              }}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部領域</SelectItem>
                {ABUSE_DOMAINS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {DOMAIN_LABELS[d]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {recordsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : records.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">目前沒有紀錄。</p>
          ) : (
            <div className="space-y-3">
              {records.map((r) => (
                <div key={r.id} className="border rounded-md p-3 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap text-xs">
                    <Badge variant="secondary">
                      {DOMAIN_LABELS[r.domain as AbuseDomain] ?? r.domain}
                    </Badge>
                    <Badge variant="destructive">
                      {VERDICT_LABELS[r.verdict] ?? r.verdict}
                    </Badge>
                    {r.revertedAt && (
                      <Badge variant="outline">
                        已撤銷 {formatDateTime(r.revertedAt)}
                      </Badge>
                    )}
                    {r.punishedAt && (
                      <Badge variant="destructive">
                        已加重處罰 {formatDateTime(r.punishedAt)}
                      </Badge>
                    )}
                    {formatActor(r) && <span>{formatActor(r)}</span>}
                    <span className="text-muted-foreground ml-auto">
                      {formatDateTime(r.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm">{r.reason}</p>
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                    {r.inputText.length > 300
                      ? `${r.inputText.slice(0, 300)}…`
                      : r.inputText}
                  </p>
                  {r.revertedAt ? (
                    <p className="text-xs text-muted-foreground">
                      補償：金錢 +{r.compensation?.money ?? 0}、滿意度 +
                      {r.compensation?.satisfactionDelta ?? 0}、穩定度 +
                      {r.compensation?.stabilityDelta ?? 0}、暴動 −
                      {r.compensation?.unrestDelta ?? 0}、厭戰 −
                      {r.compensation?.warWearinessDelta ?? 0}
                      {r.revertNote ? `；備註：${r.revertNote}` : ""}
                    </p>
                  ) : r.punishedAt ? (
                    <p className="text-xs text-muted-foreground">
                      處罰：罰款 {r.punishment?.money ?? 0}、滿意度 −
                      {r.punishment?.satisfactionDelta ?? 0}、穩定度 −
                      {r.punishment?.stabilityDelta ?? 0}、暴動 +
                      {r.punishment?.unrestDelta ?? 0}、厭戰 +
                      {r.punishment?.warWearinessDelta ?? 0}、常備軍傷亡{" "}
                      {r.punishment?.armyCasualtyPct ?? 0}%
                      {r.punishNote ? `；備註：${r.punishNote}` : ""}
                    </p>
                  ) : revertOpenId === r.id ? (
                    <div className="mt-2 border rounded-md p-3 space-y-2 bg-muted/30">
                      <p className="text-xs font-medium">
                        撤銷/補償{formatActor(r) ? `（${formatActor(r)}）` : ""}
                        {!r.nationId &&
                          " — 此紀錄無關聯國家，只能標記撤銷（數值須為 0）"}
                      </p>
                      <div className="flex flex-wrap items-end gap-3 text-xs">
                        <div className="space-y-1">
                          <Label className="text-xs">退款金額</Label>
                          {numberInput(revertForm.money, (v) =>
                            setRevertForm((f) => ({ ...f, money: v })),
                            { min: 0 },
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">滿意度回補</Label>
                          {numberInput(revertForm.satisfactionDelta, (v) =>
                            setRevertForm((f) => ({
                              ...f,
                              satisfactionDelta: v,
                            })),
                            { min: 0, max: 100 },
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">穩定度回補</Label>
                          {numberInput(revertForm.stabilityDelta, (v) =>
                            setRevertForm((f) => ({
                              ...f,
                              stabilityDelta: v,
                            })),
                            { min: 0, max: 100 },
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">暴動下修</Label>
                          {numberInput(revertForm.unrestDelta, (v) =>
                            setRevertForm((f) => ({ ...f, unrestDelta: v })),
                            { min: 0, max: 100 },
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">厭戰下修</Label>
                          {numberInput(revertForm.warWearinessDelta, (v) =>
                            setRevertForm((f) => ({
                              ...f,
                              warWearinessDelta: v,
                            })),
                            { min: 0, max: 100 },
                          )}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">備註（選填）</Label>
                        <Input
                          value={revertForm.note}
                          maxLength={500}
                          onChange={(e) =>
                            setRevertForm((f) => ({
                              ...f,
                              note: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={reverting}
                          onClick={() => void submitRevert(r)}
                        >
                          {reverting && (
                            <Loader2 className="w-3 h-3 animate-spin mr-1" />
                          )}
                          確認撤銷並補償
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={reverting}
                          onClick={() => setRevertOpenId(null)}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  ) : punishOpenId === r.id ? (
                    <div className="mt-2 border rounded-md p-3 space-y-2 bg-destructive/5">
                      <p className="text-xs font-medium">
                        加重處罰{formatActor(r) ? `（${formatActor(r)}）` : ""}
                        {!r.nationId &&
                          " — 此紀錄無關聯國家，只能標記處罰（數值須為 0）"}
                        （與撤銷互斥，執行後不可撤銷補償）
                      </p>
                      <div className="flex flex-wrap items-end gap-3 text-xs">
                        <div className="space-y-1">
                          <Label className="text-xs">罰款金額</Label>
                          {numberInput(punishForm.money, (v) =>
                            setPunishForm((f) => ({ ...f, money: v })),
                            { min: 0 },
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">滿意度下修</Label>
                          {numberInput(punishForm.satisfactionDelta, (v) =>
                            setPunishForm((f) => ({
                              ...f,
                              satisfactionDelta: v,
                            })),
                            { min: 0, max: 100 },
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">穩定度下修</Label>
                          {numberInput(punishForm.stabilityDelta, (v) =>
                            setPunishForm((f) => ({
                              ...f,
                              stabilityDelta: v,
                            })),
                            { min: 0, max: 100 },
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">暴動上修</Label>
                          {numberInput(punishForm.unrestDelta, (v) =>
                            setPunishForm((f) => ({ ...f, unrestDelta: v })),
                            { min: 0, max: 100 },
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">厭戰上修</Label>
                          {numberInput(punishForm.warWearinessDelta, (v) =>
                            setPunishForm((f) => ({
                              ...f,
                              warWearinessDelta: v,
                            })),
                            { min: 0, max: 100 },
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">常備軍傷亡（%）</Label>
                          {numberInput(punishForm.armyCasualtyPct, (v) =>
                            setPunishForm((f) => ({
                              ...f,
                              armyCasualtyPct: v,
                            })),
                            { min: 0, max: 100 },
                          )}
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">備註（選填）</Label>
                        <Input
                          value={punishForm.note}
                          maxLength={500}
                          onChange={(e) =>
                            setPunishForm((f) => ({
                              ...f,
                              note: e.target.value,
                            }))
                          }
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={punishing}
                          onClick={() => void submitPunish(r)}
                        >
                          {punishing && (
                            <Loader2 className="w-3 h-3 animate-spin mr-1" />
                          )}
                          確認加重處罰
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={punishing}
                          onClick={() => setPunishOpenId(null)}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-2 mt-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openRevert(r.id)}
                      >
                        <Undo2 className="w-3 h-3 mr-1" /> 撤銷/補償
                      </Button>
                      {r.domain === "war_order" && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => openPunish(r.id)}
                        >
                          <Gavel className="w-3 h-3 mr-1" /> 加重處罰
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
