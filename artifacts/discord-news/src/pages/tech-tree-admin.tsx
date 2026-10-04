import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { authedFetch, readError } from "@/components/world-sim/shared";
import {
  FlaskConical,
  GitBranch,
  Loader2,
  Pencil,
  Plus,
  Star,
  Trash2,
} from "lucide-react";

/** Task #469 — 全球科技樹管理員編輯器（admin raw-fetch，不在 OpenAPI spec）。 */

const DOMAINS = ["social", "production", "military"] as const;
type Domain = (typeof DOMAINS)[number];

const DOMAIN_LABELS: Record<Domain, string> = {
  social: "社會",
  production: "生產",
  military: "軍事",
};

/** 與伺服器 lib/mapRegionEras.ts ERAS 同步的 14 時代（順序即先後）。 */
const ERAS: { slug: string; label: string }[] = [
  { slug: "classical", label: "古典時代(秦朝)" },
  { slug: "roman", label: "羅馬帝國時期(漢朝)" },
  { slug: "early_medieval", label: "中世紀早期(唐朝)" },
  { slug: "high_medieval", label: "中世紀中期(宋朝)" },
  { slug: "renaissance", label: "文藝復興時期(明朝)" },
  { slug: "discovery", label: "大航海時代(清朝)" },
  { slug: "scientific", label: "科學革命" },
  { slug: "enlightenment", label: "啟蒙運動" },
  { slug: "industrial", label: "工業革命" },
  { slug: "ww1", label: "一戰時期" },
  { slug: "ww2", label: "二戰時期" },
  { slug: "cold_war", label: "冷戰時期" },
  { slug: "modern", label: "現代時期" },
  { slug: "future", label: "未來科技" },
];
const ERA_LABEL = new Map(ERAS.map((e) => [e.slug, e.label]));
const ERA_ORDER = new Map(ERAS.map((e, i) => [e.slug, i]));

/**
 * 效果語彙（與伺服器 lib/techTreeEffectVocab.ts 白名單同步；admin raw fetch，
 * 不在 OpenAPI spec，故此處維護一份 zh-TW 標籤對照）。
 */
const SOCIAL_EFFECT_OPTIONS: { value: string; label: string }[] = [
  { value: "taxEfficiency", label: "徵稅效率" },
  { value: "techPoints", label: "科技點數" },
  { value: "populationGrowth", label: "人口成長" },
  { value: "warWearinessGrowth", label: "厭戰成長" },
  { value: "buildingSlots", label: "建築槽位" },
  { value: "enableBuildingSlots", label: "啟用建築槽位（旗標）" },
  { value: "enableReligionSatisfaction", label: "啟用宗教滿意度（旗標）" },
  { value: "enableRightsSatisfaction", label: "啟用權利滿意度（旗標）" },
  { value: "enableNationalReligion", label: "啟用國教（旗標）" },
  { value: "enableAdvisorSlot", label: "啟用顧問席位（旗標）" },
];

const PRODUCTION_EFFECT_OPTIONS: { value: string; label: string }[] = [
  { value: "productivity", label: "生產素質" },
  { value: "techPoints", label: "科技點數" },
  { value: "populationGrowth", label: "人口成長" },
  { value: "tempPopulationGrowth", label: "暫時人口成長" },
  { value: "buildingUpkeepReduction", label: "建築維護減免" },
  { value: "enableCulture", label: "啟用文化（旗標）" },
  { value: "enableCityWall", label: "啟用城牆（旗標）" },
  { value: "enableColonization", label: "啟用殖民（旗標）" },
  { value: "enableNaval", label: "啟用海軍（旗標）" },
];

const MILITARY_EFFECT_OPTIONS: { value: string; label: string }[] = [
  { value: "hp", label: "生命" },
  { value: "attack", label: "攻擊" },
  { value: "defense", label: "防禦" },
  { value: "speed", label: "速度" },
  { value: "accuracy", label: "命中" },
  { value: "prodCost", label: "生產成本" },
  { value: "popCost", label: "人口成本" },
  { value: "moneyCost", label: "金錢成本" },
  { value: "upkeep", label: "維護費" },
  { value: "recoverySpeed", label: "復原速度" },
  { value: "recoveryRate", label: "復原率" },
  { value: "seaLandingCapacity", label: "登陸容量" },
  { value: "landingAttackReduction", label: "登陸攻擊減免" },
  { value: "foodConsumption", label: "糧食消耗" },
];

/** 兵種類別（空字串＝全類別 → 送出時轉 null）。 */
const MILITARY_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "全類別" },
  { value: "infantry", label: "步兵" },
  { value: "ranged", label: "遠程" },
  { value: "armor", label: "裝甲" },
  { value: "artillery", label: "砲兵" },
  { value: "ship", label: "船艦" },
  { value: "air", label: "空軍" },
  { value: "siege", label: "攻城" },
];

function effectOptionsForDomain(domain: Domain) {
  if (domain === "military") return MILITARY_EFFECT_OPTIONS;
  if (domain === "production") return PRODUCTION_EFFECT_OPTIONS;
  return SOCIAL_EFFECT_OPTIONS;
}

/** 結構化效果列（value 以字串存放供輸入框編輯）。 */
interface EffectRow {
  target: string;
  /** 軍事領域專用；"all"＝全類別（null）。 */
  category: string;
  value: string;
}

/** 嘗試把節點 effects 映射成結構化列；形狀不符（舊資料/手寫）回 null → 原始 JSON 模式。 */
function rowsFromEffects(domain: Domain, effects: unknown[]): EffectRow[] | null {
  const targets = new Set(effectOptionsForDomain(domain).map((o) => o.value));
  const categories = new Set(
    MILITARY_CATEGORY_OPTIONS.map((o) => o.value).filter((v) => v !== "all"),
  );
  const rows: EffectRow[] = [];
  for (const raw of effects) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const e = raw as Record<string, unknown>;
    if (typeof e.target !== "string" || !targets.has(e.target)) return null;
    if (domain === "military") {
      const keys = Object.keys(e);
      if (keys.some((k) => k !== "target" && k !== "category" && k !== "pct")) {
        return null;
      }
      if (typeof e.pct !== "number" || !Number.isFinite(e.pct)) return null;
      const cat = e.category ?? null;
      if (cat !== null && (typeof cat !== "string" || !categories.has(cat))) {
        return null;
      }
      rows.push({
        target: e.target,
        category: cat === null ? "all" : cat,
        value: String(e.pct),
      });
    } else {
      const keys = Object.keys(e);
      if (keys.some((k) => k !== "target" && k !== "value")) return null;
      if (typeof e.value !== "number" || !Number.isFinite(e.value)) return null;
      rows.push({ target: e.target, category: "all", value: String(e.value) });
    }
  }
  return rows;
}

/** 由結構化列組出送給伺服器的 effects；輸入不合法回 zh-TW 錯誤字串。 */
function effectsFromRows(
  domain: Domain,
  rows: EffectRow[],
): { effects: unknown[] } | { error: string } {
  const effects: unknown[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.target === "") {
      return { error: `第 ${i + 1} 條效果尚未選擇類型` };
    }
    const num = Number(row.value);
    if (row.value.trim() === "" || !Number.isFinite(num)) {
      return { error: `第 ${i + 1} 條效果的數值必須是數字` };
    }
    if (domain === "military") {
      effects.push({
        target: row.target,
        category: row.category === "all" ? null : row.category,
        pct: num,
      });
    } else {
      effects.push({ target: row.target, value: num });
    }
  }
  return { effects };
}

interface AdminTechNode {
  id: number;
  domain: Domain;
  eraSlug: string;
  lineKey: string;
  lineLabel: string;
  lineKind: "main" | "branch";
  sortOrder: number;
  name: string;
  description: string;
  baseCost: number;
  effects: unknown[];
  keySlug: string | null;
  branchFromNodeId: number | null;
  researchedCount: number;
  activeCount: number;
}

interface NodeForm {
  domain: Domain;
  eraSlug: string;
  lineKey: string;
  lineLabel: string;
  lineKind: "main" | "branch";
  sortOrder: string;
  name: string;
  description: string;
  baseCost: string;
  /** 結構化效果列（rawEffectsMode=false 時為 SSOT）。 */
  effectRows: EffectRow[];
  /** 原始 JSON 檢視（rawEffectsMode=true 時為 SSOT）。 */
  effectsJson: string;
  /** 效果形狀不符結構化編輯器時退回原始 JSON 模式。 */
  rawEffectsMode: boolean;
  keySlug: string;
  branchFromNodeId: string;
}

function emptyForm(domain: Domain): NodeForm {
  return {
    domain,
    eraSlug: "classical",
    lineKey: "",
    lineLabel: "",
    lineKind: "main",
    sortOrder: "10",
    name: "",
    description: "",
    baseCost: "10",
    effectRows: [],
    effectsJson: "[]",
    rawEffectsMode: false,
    keySlug: "",
    branchFromNodeId: "",
  };
}

function formFromNode(n: AdminTechNode): NodeForm {
  const effects = n.effects ?? [];
  const rows = rowsFromEffects(n.domain, effects);
  return {
    domain: n.domain,
    eraSlug: n.eraSlug,
    lineKey: n.lineKey,
    lineLabel: n.lineLabel,
    lineKind: n.lineKind,
    sortOrder: String(n.sortOrder),
    name: n.name,
    description: n.description,
    baseCost: String(n.baseCost),
    effectRows: rows ?? [],
    effectsJson: JSON.stringify(effects, null, 2),
    rawEffectsMode: rows === null,
    keySlug: n.keySlug ?? "",
    branchFromNodeId: n.branchFromNodeId === null ? "" : String(n.branchFromNodeId),
  };
}

export default function TechTreeAdmin() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [domain, setDomain] = useState<Domain>("social");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<NodeForm>(emptyForm("social"));
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-tech-tree"],
    queryFn: async () => {
      const res = await authedFetch("/api/admin/tech-tree");
      if (!res.ok) throw new Error(await readError(res));
      return (await res.json()) as { nodes: AdminTechNode[] };
    },
  });

  const nodes = useMemo(
    () => (data?.nodes ?? []).filter((n) => n.domain === domain),
    [data, domain],
  );

  /** era → lineKey → nodes（era 依時代順序，line 主幹優先）。 */
  const grouped = useMemo(() => {
    const byEra = new Map<string, Map<string, AdminTechNode[]>>();
    for (const n of nodes) {
      let lines = byEra.get(n.eraSlug);
      if (!lines) {
        lines = new Map();
        byEra.set(n.eraSlug, lines);
      }
      const arr = lines.get(n.lineKey);
      if (arr) arr.push(n);
      else lines.set(n.lineKey, [n]);
    }
    return [...byEra.entries()]
      .sort(
        (a, b) => (ERA_ORDER.get(a[0]) ?? 99) - (ERA_ORDER.get(b[0]) ?? 99),
      )
      .map(([eraSlug, lines]) => ({
        eraSlug,
        lines: [...lines.entries()]
          .sort((a, b) => {
            const ka = a[1][0]?.lineKind === "main" ? 0 : 1;
            const kb = b[1][0]?.lineKind === "main" ? 0 : 1;
            if (ka !== kb) return ka - kb;
            return a[0].localeCompare(b[0]);
          })
          .map(([lineKey, arr]) => ({
            lineKey,
            nodes: arr
              .slice()
              .sort((x, y) => x.sortOrder - y.sortOrder || x.id - y.id),
          })),
      }));
  }, [nodes]);

  const nodeById = useMemo(() => {
    const m = new Map<number, AdminTechNode>();
    for (const n of data?.nodes ?? []) m.set(n.id, n);
    return m;
  }, [data]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm(domain));
    setDialogOpen(true);
  }

  function openEdit(n: AdminTechNode) {
    setEditingId(n.id);
    setForm(formFromNode(n));
    setDialogOpen(true);
  }

  async function submit() {
    let effects: unknown;
    if (form.rawEffectsMode) {
      try {
        effects = JSON.parse(form.effectsJson || "[]");
      } catch {
        toast({ title: "效果 JSON 格式錯誤", variant: "destructive" });
        return;
      }
      if (!Array.isArray(effects)) {
        toast({ title: "效果必須是 JSON 陣列", variant: "destructive" });
        return;
      }
    } else {
      const built = effectsFromRows(form.domain, form.effectRows);
      if ("error" in built) {
        toast({ title: built.error, variant: "destructive" });
        return;
      }
      effects = built.effects;
    }
    const body = {
      domain: form.domain,
      eraSlug: form.eraSlug,
      lineKey: form.lineKey.trim(),
      lineLabel: form.lineLabel.trim(),
      lineKind: form.lineKind,
      sortOrder: Number(form.sortOrder),
      name: form.name.trim(),
      description: form.description,
      baseCost: Number(form.baseCost),
      effects,
      keySlug: form.keySlug.trim() === "" ? null : form.keySlug.trim(),
      branchFromNodeId:
        form.branchFromNodeId.trim() === "" ? null : Number(form.branchFromNodeId),
    };
    setSaving(true);
    try {
      const res = await authedFetch(
        editingId === null
          ? "/api/admin/tech-tree/nodes"
          : `/api/admin/tech-tree/nodes/${editingId}`,
        {
          method: editingId === null ? "POST" : "PUT",
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        toast({ title: await readError(res), variant: "destructive" });
        return;
      }
      toast({ title: editingId === null ? "已新增科技節點" : "已更新科技節點" });
      setDialogOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["admin-tech-tree"] });
    } finally {
      setSaving(false);
    }
  }

  async function remove(n: AdminTechNode) {
    if (!window.confirm(`確定要刪除「${n.name}」（#${n.id}）？`)) return;
    setDeletingId(n.id);
    try {
      let res = await authedFetch(`/api/admin/tech-tree/nodes/${n.id}`, {
        method: "DELETE",
      });
      if (res.status === 409) {
        const msg = await readError(res);
        if (!window.confirm(`${msg}\n\n仍要強制刪除嗎？`)) return;
        res = await authedFetch(`/api/admin/tech-tree/nodes/${n.id}?force=1`, {
          method: "DELETE",
        });
      }
      if (!res.ok) {
        toast({ title: await readError(res), variant: "destructive" });
        return;
      }
      toast({ title: `已刪除「${n.name}」` });
      await queryClient.invalidateQueries({ queryKey: ["admin-tech-tree"] });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6" data-testid="page-tech-tree-admin">
      <div
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
        data-testid="banner-tech-tree-offline"
      >
        <div className="font-semibold text-amber-600">科技樹已下線,此頁的編輯目前不會影響遊戲</div>
        <p className="mt-1 text-muted-foreground">
          關鍵技術改為隨世界時代自動解鎖(數值與解鎖內容由程式內的關鍵技術目錄決定),
          一般節點不再生效,玩家也無法再研發。這裡的資料只是保留,日後若要還原舊科技樹才會用到。
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FlaskConical className="w-6 h-6" />
            科技樹編輯器
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            全球共用一棵科技樹：改動立即影響所有國家（含研發成本與可研發清單）。
          </p>
        </div>
        <Button onClick={openCreate} data-testid="button-create-node">
          <Plus className="w-4 h-4 mr-1" />
          新增節點
        </Button>
      </div>

      <div className="flex gap-2">
        {DOMAINS.map((d) => (
          <Button
            key={d}
            variant={domain === d ? "default" : "outline"}
            size="sm"
            onClick={() => setDomain(d)}
            data-testid={`tab-domain-${d}`}
          >
            {DOMAIN_LABELS[d]}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground py-12 justify-center">
          <Loader2 className="w-5 h-5 animate-spin" />
          載入中…
        </div>
      ) : error ? (
        <p className="text-destructive py-8 text-center">
          {(error as Error).message}
        </p>
      ) : grouped.length === 0 ? (
        <p className="text-muted-foreground py-8 text-center">
          此領域目前沒有任何節點。
        </p>
      ) : (
        grouped.map(({ eraSlug, lines }) => (
          <Card key={eraSlug}>
            <CardHeader className="py-3">
              <CardTitle className="text-base">
                {ERA_LABEL.get(eraSlug) ?? eraSlug}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {lines.map(({ lineKey, nodes: lineNodes }) => (
                <div key={lineKey}>
                  <div className="flex items-center gap-2 mb-2">
                    {lineNodes[0]?.lineKind === "branch" ? (
                      <GitBranch className="w-4 h-4 text-muted-foreground" />
                    ) : null}
                    <span className="font-medium text-sm">
                      {lineNodes[0]?.lineLabel ?? lineKey}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {lineKey} ·{" "}
                      {lineNodes[0]?.lineKind === "main" ? "主幹線" : "支線"}
                      {lineNodes[0]?.branchFromNodeId
                        ? ` · 掛在 #${lineNodes[0].branchFromNodeId} ${
                            nodeById.get(lineNodes[0].branchFromNodeId)?.name ?? ""
                          }`
                        : ""}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {lineNodes.map((n) => (
                      <div
                        key={n.id}
                        className="flex items-center gap-2 rounded-md border px-3 py-2"
                        data-testid={`row-node-${n.id}`}
                      >
                        <span className="text-xs text-muted-foreground w-12 shrink-0">
                          #{n.id}
                        </span>
                        <span className="text-xs text-muted-foreground w-10 shrink-0">
                          {n.sortOrder}
                        </span>
                        <span className="font-medium text-sm flex items-center gap-1 min-w-0">
                          {n.keySlug ? (
                            <Star className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                          ) : null}
                          <span className="truncate">{n.name}</span>
                        </span>
                        <Badge variant="outline" className="shrink-0">
                          成本 {n.baseCost}
                        </Badge>
                        {(n.effects?.length ?? 0) > 0 ? (
                          <Badge variant="secondary" className="shrink-0">
                            效果 ×{n.effects.length}
                          </Badge>
                        ) : null}
                        <span className="text-xs text-muted-foreground ml-auto shrink-0">
                          已研發 {n.researchedCount} · 研發中 {n.activeCount}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEdit(n)}
                          data-testid={`button-edit-node-${n.id}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive"
                          disabled={deletingId === n.id}
                          onClick={() => remove(n)}
                          data-testid={`button-delete-node-${n.id}`}
                        >
                          {deletingId === n.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5" />
                          )}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingId === null ? "新增科技節點" : `編輯節點 #${editingId}`}
            </DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>領域</Label>
              <Select
                value={form.domain}
                onValueChange={(v) => {
                  const nextDomain = v as Domain;
                  const targets = new Set(
                    effectOptionsForDomain(nextDomain).map((o) => o.value),
                  );
                  setForm({
                    ...form,
                    domain: nextDomain,
                    // 換領域時保留仍屬新領域語彙的效果列，其餘捨棄；
                    // 離開軍事領域時類別歸回全類別。
                    effectRows: form.effectRows
                      .filter((r) => r.target === "" || targets.has(r.target))
                      .map((r) =>
                        nextDomain === "military" ? r : { ...r, category: "all" },
                      ),
                  });
                }}
              >
                <SelectTrigger data-testid="select-node-domain">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOMAINS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {DOMAIN_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>時代</Label>
              <Select
                value={form.eraSlug}
                onValueChange={(v) => setForm({ ...form, eraSlug: v })}
              >
                <SelectTrigger data-testid="select-node-era">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ERAS.map((e) => (
                    <SelectItem key={e.slug} value={e.slug}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>線識別字（lineKey）</Label>
              <Input
                value={form.lineKey}
                onChange={(e) => setForm({ ...form, lineKey: e.target.value })}
                placeholder="例：governance"
                data-testid="input-node-line-key"
              />
            </div>
            <div className="space-y-1.5">
              <Label>線顯示名稱</Label>
              <Input
                value={form.lineLabel}
                onChange={(e) => setForm({ ...form, lineLabel: e.target.value })}
                placeholder="例：治理"
                data-testid="input-node-line-label"
              />
            </div>
            <div className="space-y-1.5">
              <Label>線種</Label>
              <Select
                value={form.lineKind}
                onValueChange={(v) =>
                  setForm({ ...form, lineKind: v as "main" | "branch" })
                }
              >
                <SelectTrigger data-testid="select-node-line-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="main">主幹線</SelectItem>
                  <SelectItem value="branch">支線</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>線內順序（sortOrder）</Label>
              <Input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                data-testid="input-node-sort-order"
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>科技名稱</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                data-testid="input-node-name"
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>描述</Label>
              <Textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                data-testid="input-node-description"
              />
            </div>
            <div className="space-y-1.5">
              <Label>基準成本</Label>
              <Input
                type="number"
                min={1}
                value={form.baseCost}
                onChange={(e) => setForm({ ...form, baseCost: e.target.value })}
                data-testid="input-node-base-cost"
              />
            </div>
            <div className="space-y-1.5">
              <Label>關鍵科技識別字（選填，★）</Label>
              <Input
                value={form.keySlug}
                onChange={(e) => setForm({ ...form, keySlug: e.target.value })}
                placeholder="留空＝一般科技"
                data-testid="input-node-key-slug"
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <Label>支線掛點節點編號（選填，支線第一格才需要）</Label>
              <Input
                type="number"
                value={form.branchFromNodeId}
                onChange={(e) =>
                  setForm({ ...form, branchFromNodeId: e.target.value })
                }
                placeholder="留空＝不掛"
                data-testid="input-node-branch-from"
              />
            </div>
            <div className="space-y-1.5 col-span-2">
              <div className="flex items-center justify-between">
                <Label>效果</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    if (form.rawEffectsMode) {
                      // 原始 JSON → 結構化：可解析且形狀相符才切換。
                      let parsed: unknown;
                      try {
                        parsed = JSON.parse(form.effectsJson || "[]");
                      } catch {
                        toast({
                          title: "效果 JSON 格式錯誤，無法切換到結構化編輯",
                          variant: "destructive",
                        });
                        return;
                      }
                      if (!Array.isArray(parsed)) {
                        toast({
                          title: "效果必須是 JSON 陣列，無法切換到結構化編輯",
                          variant: "destructive",
                        });
                        return;
                      }
                      const rows = rowsFromEffects(form.domain, parsed);
                      if (rows === null) {
                        toast({
                          title:
                            "效果內容不符此領域的結構化語彙，請先修正 JSON",
                          variant: "destructive",
                        });
                        return;
                      }
                      setForm({ ...form, effectRows: rows, rawEffectsMode: false });
                    } else {
                      // 結構化 → 原始 JSON：序列化目前列。
                      const built = effectsFromRows(form.domain, form.effectRows);
                      const effects =
                        "effects" in built ? built.effects : [];
                      setForm({
                        ...form,
                        effectsJson: JSON.stringify(effects, null, 2),
                        rawEffectsMode: true,
                      });
                    }
                  }}
                  data-testid="button-toggle-effects-mode"
                >
                  {form.rawEffectsMode ? "切換到結構化編輯" : "切換到原始 JSON"}
                </Button>
              </div>
              {form.rawEffectsMode ? (
                <>
                  <Textarea
                    rows={6}
                    className="font-mono text-xs"
                    value={form.effectsJson}
                    onChange={(e) =>
                      setForm({ ...form, effectsJson: e.target.value })
                    }
                    data-testid="input-node-effects"
                  />
                  <p className="text-xs text-muted-foreground">
                    原始 JSON 檢視。伺服器會依領域語彙驗證，不合法會回報錯誤。
                  </p>
                </>
              ) : (
                <div className="space-y-2">
                  {form.effectRows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      尚無效果。點「新增效果」加入。
                    </p>
                  ) : (
                    form.effectRows.map((row, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Select
                          value={row.target === "" ? undefined : row.target}
                          onValueChange={(v) => {
                            const next = [...form.effectRows];
                            next[idx] = { ...row, target: v };
                            setForm({ ...form, effectRows: next });
                          }}
                        >
                          <SelectTrigger
                            className="flex-1"
                            data-testid={`select-effect-target-${idx}`}
                          >
                            <SelectValue placeholder="選擇效果類型" />
                          </SelectTrigger>
                          <SelectContent>
                            {effectOptionsForDomain(form.domain).map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {form.domain === "military" ? (
                          <Select
                            value={row.category}
                            onValueChange={(v) => {
                              const next = [...form.effectRows];
                              next[idx] = { ...row, category: v };
                              setForm({ ...form, effectRows: next });
                            }}
                          >
                            <SelectTrigger
                              className="w-28 shrink-0"
                              data-testid={`select-effect-category-${idx}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {MILITARY_CATEGORY_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={o.value}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : null}
                        <Input
                          type="number"
                          className="w-24 shrink-0"
                          value={row.value}
                          onChange={(e) => {
                            const next = [...form.effectRows];
                            next[idx] = { ...row, value: e.target.value };
                            setForm({ ...form, effectRows: next });
                          }}
                          placeholder={form.domain === "military" ? "%" : "數值"}
                          data-testid={`input-effect-value-${idx}`}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0 text-destructive"
                          onClick={() =>
                            setForm({
                              ...form,
                              effectRows: form.effectRows.filter(
                                (_, i) => i !== idx,
                              ),
                            })
                          }
                          data-testid={`button-remove-effect-${idx}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ))
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setForm({
                        ...form,
                        effectRows: [
                          ...form.effectRows,
                          { target: "", category: "all", value: "" },
                        ],
                      })
                    }
                    data-testid="button-add-effect"
                  >
                    <Plus className="w-3.5 h-3.5 mr-1" />
                    新增效果
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {form.domain === "military"
                      ? "軍事效果＝兵種百分比加成；「全類別」代表套用到所有兵種。負數＝減免（如維護費 -5%）。"
                      : "數值效果為每回合／即時加成；「啟用…（旗標）」類效果數值填 1 即可。"}
                  </p>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button onClick={submit} disabled={saving} data-testid="button-save-node">
              {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              儲存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
