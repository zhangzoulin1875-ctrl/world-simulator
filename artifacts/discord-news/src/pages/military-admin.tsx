import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import { cn } from "@/lib/utils";
import {
  Bot,
  Check,
  ChevronsUpDown,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Save,
  Shield,
  Trash2,
  Users,
  X,
} from "lucide-react";

/* ============================================================ */
/*  型別定義                                                      */
/* ============================================================ */

interface NationSummary {
  id: string;
  name: string | null;
  isNpc: boolean;
  isOwned: boolean;
}

interface TemplateRow {
  id: number;
  name: string;
  category: string;
  eraSlug: string | null;
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  accuracy: number;
  range: string;
  antiCavalryPct: number;
  antiRangedPct: number;
  antiArtilleryPct: number;
  siegePct: number;
  prodCostPer100: number;
  popCostPerUnit: number;
  moneyCostPerUnit: number;
  upkeepPerUnit: number;
  prodUpkeepPerUnit: number;
  woodCostPerUnit: number;
  oreCostPerUnit: number;
  quantity: number;
  committed?: number;
  wounded?: number;
}

/* ============================================================ */
/*  HTTP 工具                                                     */
/* ============================================================ */

async function authedFetch(url: string, init?: RequestInit) {
  const token = getAdminToken();
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data && typeof data.error === "string" && data.error) return data.error;
  } catch {
    /* ignore */
  }
  return `請求失敗（${res.status}）`;
}

/* ============================================================ */
/*  類別標籤                                                      */
/* ============================================================ */

const CATEGORY_LABELS: Record<string, string> = {
  infantry: "步兵",
  ranged: "遠程",
  armor: "裝甲",
  artillery: "火炮",
  ship: "艦船",
  air: "空軍",
  siege: "攻城",
};

const RANGE_LABELS: Record<string, string> = {
  melee: "近戰",
  ranged: "遠程",
};

/* ============================================================ */
/*  可搜尋的國家下拉                                              */
/* ============================================================ */

function NationCombobox({
  value,
  onChange,
  nations,
}: {
  value: string;
  onChange: (id: string) => void;
  nations: NationSummary[];
}) {
  const [open, setOpen] = useState(false);
  const selected = nations.find((n) => n.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full max-w-xs justify-between font-normal"
        >
          <span className={selected ? "" : "text-muted-foreground"}>
            {selected ? (
              <span className="flex items-center gap-1.5">
                {selected.isNpc ? (
                  <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                {selected.name ?? "（未命名）"}
              </span>
            ) : (
              "選擇國家"
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜尋國家…" />
          <CommandList>
            <CommandEmpty>找不到符合的國家</CommandEmpty>
            <CommandGroup>
              {nations.map((n) => (
                <CommandItem
                  key={n.id}
                  value={`${n.name ?? ""} ${n.id}`}
                  onSelect={() => {
                    onChange(n.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      n.id === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {n.isNpc ? (
                    <Bot className="mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Users className="mr-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span>{n.name ?? "（未命名）"}</span>
                  {!n.isOwned && !n.isNpc && (
                    <Badge variant="outline" className="ml-auto text-xs">
                      無主
                    </Badge>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/* ============================================================ */
/*  兵種編輯表單（行內展開）                                      */
/* ============================================================ */

const COMBAT_FIELDS: { key: keyof TemplateRow; label: string; step?: number }[] = [
  { key: "hp", label: "HP" },
  { key: "attack", label: "攻擊" },
  { key: "defense", label: "防禦" },
  { key: "speed", label: "速度", step: 0.1 },
  { key: "accuracy", label: "命中（%）" },
  { key: "antiCavalryPct", label: "抗騎（%）" },
  { key: "antiRangedPct", label: "抗遠（%）" },
  { key: "antiArtilleryPct", label: "抗炮（%）" },
  { key: "siegePct", label: "攻城（%）" },
];

const COST_FIELDS: { key: keyof TemplateRow; label: string; step?: number }[] = [
  { key: "prodCostPer100", label: "生產力/100" },
  { key: "popCostPerUnit", label: "人口/單位" },
  { key: "moneyCostPerUnit", label: "金錢/單位" },
  { key: "upkeepPerUnit", label: "維護費/單位", step: 0.01 },
  { key: "prodUpkeepPerUnit", label: "生產維護/單位", step: 0.01 },
  { key: "woodCostPerUnit", label: "木材/單位" },
  { key: "oreCostPerUnit", label: "礦石/單位" },
];

function TemplateEditor({
  tmpl,
  nationId,
  isNpc,
  onSaved,
  onClose,
}: {
  tmpl: TemplateRow;
  nationId: string;
  isNpc: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const [vals, setVals] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = { name: tmpl.name };
    for (const f of [...COMBAT_FIELDS, ...COST_FIELDS]) {
      init[f.key] = String((tmpl as unknown as Record<string, number>)[f.key]);
    }
    init["range"] = tmpl.range;
    return init;
  });

  const [qty, setQty] = useState(String(tmpl.quantity));
  const [savingQty, setSavingQty] = useState(false);

  const set = (key: string, v: string) =>
    setVals((prev) => ({ ...prev, [key]: v }));

  const doSave = async () => {
    const body: Record<string, unknown> = {};
    const name = (vals["name"] ?? "").trim();
    if (!name) {
      toast({ title: "兵種名稱不可為空", variant: "destructive" });
      return;
    }
    body["name"] = name;
    body["range"] = vals["range"];

    for (const f of [...COMBAT_FIELDS, ...COST_FIELDS]) {
      const raw = (vals[f.key] ?? "").trim();
      const v = Number(raw);
      if (raw === "" || isNaN(v)) {
        toast({ title: `${f.label} 必須是數字`, variant: "destructive" });
        return;
      }
      body[f.key] = v;
    }

    setSaving(true);
    try {
      const res = await authedFetch(`/api/military-admin/templates/${tmpl.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "兵種資料已更新" });
      onSaved();
    } catch (err) {
      toast({
        title: "更新失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const doSaveQty = async () => {
    const q = Number(qty);
    if (!Number.isInteger(q) || q < 0) {
      toast({ title: "數量必須是非負整數", variant: "destructive" });
      return;
    }
    setSavingQty(true);
    try {
      const res = await authedFetch("/api/military-admin/armies", {
        method: "PUT",
        body: JSON.stringify({ nationId, templateId: tmpl.id, quantity: q }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: `數量已更新為 ${q.toLocaleString()}` });
      onSaved();
    } catch (err) {
      toast({
        title: "數量更新失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSavingQty(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border bg-muted/30 p-4 space-y-4">
      {/* 名稱 + 攻擊類型 */}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">兵種名稱</span>
          <Input
            value={vals["name"] ?? ""}
            onChange={(e) => set("name", e.target.value)}
            maxLength={60}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="text-muted-foreground">攻擊類型</span>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1"
            value={vals["range"] ?? "melee"}
            onChange={(e) => set("range", e.target.value)}
          >
            <option value="melee">近戰</option>
            <option value="ranged">遠程</option>
          </select>
        </label>
      </div>

      {/* 戰鬥數值 */}
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">戰鬥數值</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {COMBAT_FIELDS.map((f) => (
            <label key={f.key} className="space-y-1 text-xs">
              <span className="text-muted-foreground">{f.label}</span>
              <Input
                type="number"
                min={0}
                step={f.step ?? 1}
                value={vals[f.key] ?? ""}
                onChange={(e) => set(f.key, e.target.value)}
              />
            </label>
          ))}
        </div>
      </div>

      {/* 成本欄位 */}
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">成本與維護</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {COST_FIELDS.map((f) => (
            <label key={f.key} className="space-y-1 text-xs">
              <span className="text-muted-foreground">{f.label}</span>
              <Input
                type="number"
                min={0}
                step={f.step ?? 1}
                value={vals[f.key] ?? ""}
                onChange={(e) => set(f.key, e.target.value)}
              />
            </label>
          ))}
        </div>
      </div>

      {/* 數量覆蓋 */}
      <div className="flex items-end gap-2 border-t pt-3">
        <label className="flex-1 space-y-1 text-xs">
          <span className="text-muted-foreground">
            持有數量覆蓋
            {isNpc && (
              <span className="ml-1 text-xs text-muted-foreground">
                （前線：{tmpl.committed?.toLocaleString() ?? 0}，傷兵：{tmpl.wounded?.toLocaleString() ?? 0}）
              </span>
            )}
          </span>
          <Input
            type="number"
            min={0}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            className="max-w-[160px]"
          />
        </label>
        <Button
          size="sm"
          variant="secondary"
          onClick={doSaveQty}
          disabled={savingQty}
        >
          {savingQty && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
          更新數量
        </Button>
      </div>

      {/* 操作按鈕 */}
      <div className="flex gap-2 border-t pt-3">
        <Button size="sm" onClick={doSave} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="mr-1 h-3.5 w-3.5" />
          )}
          儲存數值
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>
          <X className="mr-1 h-3.5 w-3.5" />
          關閉
        </Button>
      </div>
    </div>
  );
}

/* ============================================================ */
/*  單一兵種列                                                    */
/* ============================================================ */

function TemplateListItem({
  tmpl,
  nationId,
  isNpc,
  onRefresh,
}: {
  tmpl: TemplateRow;
  nationId: string;
  isNpc: boolean;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  /** 'confirm' = 一般確認；'force' = 有進行中戰役、需二次確認 */
  const [deletePhase, setDeletePhase] = useState<"confirm" | "force">(
    "confirm",
  );
  const [activeCount, setActiveCount] = useState(0);
  const [deleting, setDeleting] = useState(false);

  /** 點擊刪除按鈕：永遠先開確認對話框，不直接呼叫 API。 */
  const openDeleteDialog = () => {
    setDeletePhase("confirm");
    setActiveCount(0);
    setDeleteOpen(true);
  };

  /** 使用者在確認對話框中按下確認（不帶 force）。 */
  const confirmDelete = async () => {
    setDeleting(true);
    try {
      const res = await authedFetch(
        `/api/military-admin/templates/${tmpl.id}`,
        { method: "DELETE" },
      );
      if (res.status === 409) {
        // 有進行中戰役 → 切換為強制確認階段，保持對話框開啟
        const data = (await res.json()) as { activeCount?: number };
        setActiveCount(data.activeCount ?? 0);
        setDeletePhase("force");
        return;
      }
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "兵種模板已刪除" });
      setDeleteOpen(false);
      onRefresh();
    } catch (err) {
      toast({
        title: "刪除失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
      setDeleteOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  /** 使用者確認強制刪除（帶 ?force=1）。 */
  const confirmForceDelete = async () => {
    setDeleting(true);
    try {
      const res = await authedFetch(
        `/api/military-admin/templates/${tmpl.id}?force=1`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "兵種模板已強制刪除" });
      setDeleteOpen(false);
      onRefresh();
    } catch (err) {
      toast({
        title: "強制刪除失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center gap-2 p-3">
        {/* 展開/收合按鈕 */}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-left flex-1 min-w-0"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="flex items-center gap-2 min-w-0">
            <Badge variant="outline" className="shrink-0 text-xs">
              {CATEGORY_LABELS[tmpl.category] ?? tmpl.category}
            </Badge>
            <span className="font-medium truncate">{tmpl.name}</span>
            {tmpl.eraSlug && (
              <span className="text-xs text-muted-foreground shrink-0">
                [{tmpl.eraSlug}]
              </span>
            )}
          </div>
        </button>

        {/* 數值摘要 */}
        <div className="hidden sm:flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          <span>HP {tmpl.hp}</span>
          <span>攻 {tmpl.attack}</span>
          <span>防 {tmpl.defense}</span>
          <span>{RANGE_LABELS[tmpl.range] ?? tmpl.range}</span>
        </div>

        {/* 持有數量 */}
        <div className="flex items-center gap-1 shrink-0 text-sm font-medium">
          <Shield className="h-3.5 w-3.5 text-muted-foreground" />
          <span>{tmpl.quantity.toLocaleString()}</span>
        </div>

        {/* 編輯 & 刪除 */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => setExpanded((v) => !v)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={openDeleteDialog}
            disabled={deleting}
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* 展開的編輯區 */}
      {expanded && (
        <div className="px-3 pb-3">
          <TemplateEditor
            tmpl={tmpl}
            nationId={nationId}
            isNpc={isNpc}
            onSaved={onRefresh}
            onClose={() => setExpanded(false)}
          />
        </div>
      )}

      {/* 刪除確認（共用同一對話框，依 phase 顯示不同文字與操作） */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deletePhase === "force" ? "強制刪除兵種模板？" : "確認刪除兵種模板？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deletePhase === "force" ? (
                <>
                  「{tmpl.name}」目前有{" "}
                  <strong>{activeCount}</strong>{" "}
                  筆進行中戰役兵種列，刪除後這些戰役的傷亡結算可能異常。確定要繼續嗎？
                </>
              ) : (
                <>確定要刪除「{tmpl.name}」嗎？此操作無法還原。</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            {/* 使用普通 Button 而非 AlertDialogAction，避免 Radix 自動關閉對話框。
                phase="confirm" 時 DELETE 可能回 409 並切換至 "force" 而保持開啟。 */}
            <Button
              onClick={deletePhase === "force" ? confirmForceDelete : confirmDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              )}
              {deletePhase === "force" ? "強制刪除" : "確認刪除"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ============================================================ */
/*  主頁面                                                        */
/* ============================================================ */

export default function MilitaryAdmin() {
  const { toast } = useToast();

  const [nations, setNations] = useState<NationSummary[]>([]);
  const [loadingNations, setLoadingNations] = useState(true);

  const [selectedId, setSelectedId] = useState("");
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [selectedNationInfo, setSelectedNationInfo] = useState<{
    name: string | null;
    isNpc: boolean;
  } | null>(null);
  const [loadingTemplates, setLoadingTemplates] = useState(false);

  /* 載入國家清單 */
  useEffect(() => {
    let cancelled = false;
    setLoadingNations(true);
    authedFetch("/api/military-admin/nations")
      .then(async (r) => {
        if (!r.ok) throw new Error(await readError(r));
        return r.json() as Promise<NationSummary[]>;
      })
      .then((data) => {
        if (!cancelled) setNations(data);
      })
      .catch(() => {
        if (!cancelled)
          toast({ title: "無法載入國家清單", variant: "destructive" });
      })
      .finally(() => {
        if (!cancelled) setLoadingNations(false);
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  /* 載入指定國家的兵種模板 */
  const loadTemplates = useCallback(
    (id: string) => {
      if (!id) return;
      setLoadingTemplates(true);
      authedFetch(`/api/military-admin/nations/${id}`)
        .then(async (r) => {
          if (!r.ok) throw new Error(await readError(r));
          return r.json() as Promise<{
            nation: { name: string | null; isNpc: boolean };
            templates: TemplateRow[];
          }>;
        })
        .then((data) => {
            setTemplates(data.templates);
            setSelectedNationInfo(data.nation);
          }
        )
        .catch(() =>
          toast({ title: "無法載入兵種資料", variant: "destructive" }),
        )
        .finally(() => setLoadingTemplates(false));
    },
    [toast],
  );

  const handleSelectNation = (id: string) => {
    setSelectedId(id);
    setTemplates([]);
    setSelectedNationInfo(null);
    loadTemplates(id);
  };

  /* 依類別分組 */
  const grouped = templates.reduce<Record<string, TemplateRow[]>>((acc, t) => {
    const cat = t.category;
    (acc[cat] ??= []).push(t);
    return acc;
  }, {});
  const categoryOrder = [
    "infantry",
    "ranged",
    "armor",
    "artillery",
    "siege",
    "ship",
    "air",
  ];
  const sortedCategories = [
    ...categoryOrder.filter((c) => grouped[c]),
    ...Object.keys(grouped).filter((c) => !categoryOrder.includes(c)),
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">軍事管理</h1>
        <p className="text-sm text-muted-foreground">
          查看與編輯各國兵種模板的戰鬥數值、成本及持有數量
        </p>
      </div>

      {/* 國家選擇 */}
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium shrink-0">選擇國家</span>
        {loadingNations ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <NationCombobox
            value={selectedId}
            onChange={handleSelectNation}
            nations={nations}
          />
        )}
        {selectedId && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => loadTemplates(selectedId)}
            disabled={loadingTemplates}
          >
            {loadingTemplates ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              "重新整理"
            )}
          </Button>
        )}
      </div>

      {/* 兵種列表 */}
      {selectedId && !loadingTemplates && (
        <div className="space-y-4">
          {templates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {selectedNationInfo?.name ?? "此國家"} 目前沒有任何兵種模板。
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {selectedNationInfo?.name ?? "此國家"} 共{" "}
                  {templates.length} 個兵種模板
                  {selectedNationInfo?.isNpc && (
                    <Badge variant="secondary" className="ml-2">
                      NPC
                    </Badge>
                  )}
                </p>
              </div>

              {sortedCategories.map((cat) => (
                <div key={cat} className="space-y-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {CATEGORY_LABELS[cat] ?? cat}
                  </h3>
                  <div className="space-y-1.5">
                    {(grouped[cat] ?? []).map((tmpl) => (
                      <TemplateListItem
                        key={tmpl.id}
                        tmpl={tmpl}
                        nationId={selectedId}
                        isNpc={selectedNationInfo?.isNpc ?? false}
                        onRefresh={() => loadTemplates(selectedId)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {selectedId && loadingTemplates && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          載入兵種資料中…
        </div>
      )}
    </div>
  );
}
