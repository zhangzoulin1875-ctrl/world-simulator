import { useCallback, useEffect, useState } from "react";
import { useListMapRegions } from "@workspace/api-client-react";
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
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import { cn } from "@/lib/utils";
import {
  Bot,
  Check,
  ChevronsUpDown,
  FlaskConical,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
  Users,
  X,
} from "lucide-react";

interface NationRegion {
  regionId: number;
  regionName: string;
  percent: number;
}

interface Nation {
  id: string;
  name: string | null;
  leaderName: string | null;
  government: string | null;
  flagUrl: string | null;
  emblemUrl: string | null;
  kanbanUrl: string | null;
  backgroundUrl: string | null;
  isNpc: boolean;
  isOwned: boolean;
  techPoints: number;
  money: number;
  stability: number;
  unrest: number;
  warWeariness: number;
  satisfactionFarmers: number;
  satisfactionWorkers: number;
  satisfactionNobles: number;
  satisfactionClergy: number;
  farmerPopulationPct: number;
  taxRatePct: number;
  taxEfficiencyBonus: number;
  regions: NationRegion[];
  createdAt: string;
  /** Task #389 — NPC 常備軍摘要（唯讀；玩家國家為 undefined/null）。 */
  military?: NationMilitary | null;
}

interface NationMilitary {
  standing: number;
  committed: number;
  wounded: number;
  units: {
    name: string;
    category: string;
    quantity: number;
    committed: number;
    wounded: number;
  }[];
}

interface EditRegionRow {
  regionId: string;
  percent: string;
}

type RegionOption = { id: number; name: string };

/** 數值欄位設定（label + 範圍，與後端 npcNations.ts 一致）。TAX_RATE_MAX = 50。 */
const NUMERIC_FIELDS: Record<
  string,
  { label: string; min: number; max: number }
> = {
  money: { label: "金錢", min: 0, max: 1_000_000_000_000_000 },
  techPoints: { label: "科技點數", min: 0, max: 2_000_000_000 },
  stability: { label: "安定度", min: 0, max: 100 },
  unrest: { label: "動亂度", min: 0, max: 100 },
  warWeariness: { label: "厭戰度", min: 0, max: 100 },
  satisfactionFarmers: { label: "農民滿意度", min: 0, max: 100 },
  satisfactionWorkers: { label: "工人滿意度", min: 0, max: 100 },
  satisfactionNobles: { label: "貴族(資本家)滿意度", min: 0, max: 100 },
  satisfactionClergy: { label: "教士滿意度", min: 0, max: 100 },
  farmerPopulationPct: { label: "農民人口比例（%）", min: 0, max: 100 },
  taxRatePct: { label: "稅率（%）", min: 0, max: 50 },
  taxEfficiencyBonus: { label: "稅收效率加成（%）", min: -1000, max: 1000 },
};

const STAT_GROUPS: { title: string; keys: string[] }[] = [
  { title: "資源", keys: ["money", "techPoints"] },
  {
    title: "內政數值（0–100）",
    keys: [
      "stability",
      "unrest",
      "warWeariness",
      "satisfactionFarmers",
      "satisfactionWorkers",
      "satisfactionNobles",
      "satisfactionClergy",
      "farmerPopulationPct",
    ],
  },
  {
    title: "經濟數值",
    keys: ["taxRatePct", "taxEfficiencyBonus"],
  },
];

const IMAGE_INPUTS: { key: keyof Nation; label: string }[] = [
  { key: "flagUrl", label: "國旗圖片網址" },
  { key: "emblemUrl", label: "國徽圖片網址" },
  { key: "kanbanUrl", label: "看板顧問圖片網址" },
  { key: "backgroundUrl", label: "背景圖片網址" },
];

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
    const data = (await res.json()) as { error?: string };
    if (data && typeof data.error === "string" && data.error) return data.error;
  } catch {
    /* ignore */
  }
  return `請求失敗（${res.status}）`;
}

function rowsToAssignments(
  rows: EditRegionRow[],
): { regionId: number; percent: number }[] | string {
  const out: { regionId: number; percent: number }[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const regionId = Number(row.regionId);
    const percent = Number(row.percent);
    if (!Number.isInteger(regionId) || regionId <= 0) return "請選擇地區";
    if (seen.has(regionId)) return "同一個地區只能指派一次";
    seen.add(regionId);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100)
      return "比例必須是 1 到 100 的整數";
    out.push({ regionId, percent });
  }
  return out;
}

/** 可搜尋的地區下拉（保留完整列表 + 搜尋框）。 */
function RegionCombobox({
  value,
  onChange,
  regions,
  testId,
}: {
  value: string;
  onChange: (id: string) => void;
  regions: RegionOption[];
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = regions.find((r) => String(r.id) === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="flex-1 justify-between font-normal"
          data-testid={testId}
        >
          <span className={selected ? "" : "text-muted-foreground"}>
            {selected ? selected.name : "選擇地區"}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜尋地區…" />
          <CommandList>
            <CommandEmpty>找不到符合的地區</CommandEmpty>
            <CommandGroup>
              {regions.map((r) => (
                <CommandItem
                  key={r.id}
                  value={r.name}
                  onSelect={() => {
                    onChange(String(r.id));
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      String(r.id) === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {r.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function RegionRows({
  rows,
  setRows,
  regions,
}: {
  rows: EditRegionRow[];
  setRows: (rows: EditRegionRow[]) => void;
  regions: RegionOption[];
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">掌控地區</p>
      {rows.map((row, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <RegionCombobox
            value={row.regionId}
            onChange={(v) =>
              setRows(rows.map((r, i) => (i === idx ? { ...r, regionId: v } : r)))
            }
            regions={regions}
            testId={`select-region-${idx}`}
          />
          <Input
            type="number"
            min={1}
            max={100}
            value={row.percent}
            onChange={(e) =>
              setRows(
                rows.map((r, i) =>
                  i === idx ? { ...r, percent: e.target.value } : r,
                ),
              )
            }
            className="w-20"
            data-testid={`input-percent-${idx}`}
          />
          <span className="text-xs text-muted-foreground">%</span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setRows(rows.filter((_, i) => i !== idx))}
            data-testid={`button-remove-region-${idx}`}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setRows([...rows, { regionId: "", percent: "100" }])}
        data-testid="button-add-region"
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        新增地區
      </Button>
    </div>
  );
}

/** NPC 與玩家共用的完整數據編輯器。 */
function NationEditor({
  nation,
  regions,
  onCancel,
  onSaved,
}: {
  nation: Nation;
  regions: RegionOption[];
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState(nation.name ?? "");
  const [leaderName, setLeaderName] = useState(nation.leaderName ?? "");
  const [government, setGovernment] = useState(nation.government ?? "");
  const [images, setImages] = useState<Record<string, string>>({
    flagUrl: nation.flagUrl ?? "",
    emblemUrl: nation.emblemUrl ?? "",
    kanbanUrl: nation.kanbanUrl ?? "",
    backgroundUrl: nation.backgroundUrl ?? "",
  });
  const [nums, setNums] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const key of Object.keys(NUMERIC_FIELDS)) {
      init[key] = String((nation as unknown as Record<string, number>)[key]);
    }
    return init;
  });
  const [regionRows, setRegionRows] = useState<EditRegionRow[]>(
    nation.regions.map((r) => ({
      regionId: String(r.regionId),
      percent: String(r.percent),
    })),
  );
  // 只有動過地區才會在 PATCH 送出 regions（全量替換）；未動過則省略，
  // 後端保留原本掌控地區，也避免覆蓋回合／戰爭引擎期間的變動。
  const [regionsTouched, setRegionsTouched] = useState(false);
  const [regionReason, setRegionReason] = useState("");
  const updateRegionRows = (rows: EditRegionRow[]) => {
    setRegionsTouched(true);
    setRegionRows(rows);
  };

  const doSave = async () => {
    if (name.trim() === "") {
      toast({ title: "國名不可為空", variant: "destructive" });
      return;
    }
    const body: Record<string, unknown> = {
      name: name.trim(),
      leaderName: leaderName.trim(),
      government: government.trim(),
      flagUrl: images.flagUrl.trim(),
      emblemUrl: images.emblemUrl.trim(),
      kanbanUrl: images.kanbanUrl.trim(),
      backgroundUrl: images.backgroundUrl.trim(),
    };
    for (const [key, spec] of Object.entries(NUMERIC_FIELDS)) {
      const raw = (nums[key] ?? "").trim();
      const v = Number(raw);
      if (raw === "" || !Number.isInteger(v) || v < spec.min || v > spec.max) {
        toast({
          title: `${spec.label} 必須是 ${spec.min} 到 ${spec.max} 的整數`,
          variant: "destructive",
        });
        return;
      }
      body[key] = v;
    }
    if (regionsTouched) {
      const assignments = rowsToAssignments(regionRows);
      if (typeof assignments === "string") {
        toast({ title: assignments, variant: "destructive" });
        return;
      }
      body.regions = assignments;
      if (regionReason.trim()) body.reason = regionReason.trim();
    }

    setSaving(true);
    try {
      const res = await authedFetch(`/api/npc-nations/${nation.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "國家資料已更新" });
      await onSaved();
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

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">基本資料</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="國名"
            data-testid="input-edit-name"
          />
          <Input
            value={leaderName}
            onChange={(e) => setLeaderName(e.target.value)}
            maxLength={40}
            placeholder="領導人"
            data-testid="input-edit-leader"
          />
          <Input
            value={government}
            onChange={(e) => setGovernment(e.target.value)}
            maxLength={40}
            placeholder="政體"
            data-testid="input-edit-government"
          />
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          外觀（留空 = 使用預設）
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          {IMAGE_INPUTS.map((img) => (
            <Input
              key={img.key}
              value={images[img.key] ?? ""}
              onChange={(e) =>
                setImages((prev) => ({ ...prev, [img.key]: e.target.value }))
              }
              maxLength={2000}
              placeholder={img.label}
              data-testid={`input-edit-${img.key}`}
            />
          ))}
        </div>
      </div>

      {STAT_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {group.title}
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {group.keys.map((key) => {
              const spec = NUMERIC_FIELDS[key]!;
              return (
                <label key={key} className="space-y-1 text-xs">
                  <span className="text-muted-foreground">{spec.label}</span>
                  <Input
                    type="number"
                    min={spec.min}
                    max={spec.max}
                    value={nums[key] ?? ""}
                    onChange={(e) =>
                      setNums((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    data-testid={`input-edit-${key}`}
                  />
                </label>
              );
            })}
          </div>
        </div>
      ))}

      <RegionRows rows={regionRows} setRows={updateRegionRows} regions={regions} />

      {regionsTouched && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            領土變更理由（選填，會記錄到領土變化歷史）
          </p>
          <Input
            value={regionReason}
            onChange={(e) => setRegionReason(e.target.value)}
            maxLength={500}
            placeholder="例如：劇情事件調整"
            data-testid="input-region-reason"
          />
        </div>
      )}

      <div className="flex gap-2">
        <Button onClick={doSave} disabled={saving} data-testid="button-save-npc">
          {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          儲存
        </Button>
        <Button variant="outline" onClick={onCancel}>
          取消
        </Button>
      </div>
    </div>
  );
}

function NationCard({
  nation,
  regions,
  editing,
  onStartEdit,
  onCancel,
  onSaved,
  onDelete,
  saving,
}: {
  nation: Nation;
  regions: RegionOption[];
  editing: boolean;
  onStartEdit: () => void;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onDelete?: () => void;
  saving: boolean;
}) {
  return (
    <div className="rounded-lg border p-4" data-testid={`npc-${nation.id}`}>
      {editing ? (
        <NationEditor
          nation={nation}
          regions={regions}
          onCancel={onCancel}
          onSaved={onSaved}
        />
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            {nation.flagUrl && (
              <img
                src={nation.flagUrl}
                alt="國旗"
                className="mt-0.5 h-8 w-12 shrink-0 rounded border object-cover"
                data-testid={`img-flag-${nation.id}`}
              />
            )}
            <div className="flex-1">
              <div className="font-bold">
                {nation.name ?? "（未命名）"}
                {nation.government && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {nation.government}
                  </span>
                )}
                {!nation.isNpc && !nation.isOwned && (
                  <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
                    無主
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {nation.leaderName && <>領導人 {nation.leaderName}・</>}
                金錢 {nation.money.toLocaleString("zh-TW")}・科技點數{" "}
                {nation.techPoints.toLocaleString("zh-TW")}・安定{" "}
                {nation.stability}
              </div>
            </div>
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={onStartEdit}
                data-testid={`button-edit-${nation.id}`}
              >
                編輯
              </Button>
              {onDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onDelete}
                  disabled={saving}
                  data-testid={`button-delete-${nation.id}`}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              )}
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {nation.regions.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                未掌控任何地區
              </span>
            ) : (
              nation.regions.map((r) => (
                <span
                  key={r.regionId}
                  className="rounded bg-muted px-2 py-0.5 text-xs"
                >
                  {r.regionName} {r.percent}%
                </span>
              ))
            )}
          </div>
          {nation.isNpc && (
            <div className="mt-2" data-testid={`military-${nation.id}`}>
              {!nation.military || nation.military.units.length === 0 ? (
                <span className="text-xs text-muted-foreground">
                  尚無常備軍（每回合自動生產）
                </span>
              ) : (
                <>
                  <div className="text-xs text-muted-foreground">
                    常備軍 {nation.military.standing.toLocaleString("zh-TW")}
                    ・前線{" "}
                    {nation.military.committed.toLocaleString("zh-TW")}・傷兵{" "}
                    {nation.military.wounded.toLocaleString("zh-TW")}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {nation.military.units.map((u, i) => (
                      <span
                        key={`${u.name}-${i}`}
                        className="rounded bg-muted px-2 py-0.5 text-xs"
                      >
                        {u.name} {u.quantity.toLocaleString("zh-TW")}
                        {u.wounded > 0 && <>（傷 {u.wounded.toLocaleString("zh-TW")}）</>}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

type TechDomain = "military" | "social" | "production";

const DOMAIN_LABELS: Record<TechDomain, string> = {
  military: "軍事",
  social: "社會",
  production: "生產",
};
const TECH_DOMAIN_ORDER: TechDomain[] = ["military", "social", "production"];

interface TechCatalogEntry {
  keySlug: string;
  eraSlug: string;
  name: string;
}
interface EraOption {
  slug: string;
  label: string;
}
interface DomainStatus {
  era: string;
  keySlugs: string[];
}
interface NationTechStatus {
  id: string;
  name: string | null;
  isNpc: boolean;
  isOwned: boolean;
  domains: Record<TechDomain, DomainStatus>;
}
interface TechStatusResponse {
  worldEra: string;
  catalog: Record<TechDomain, TechCatalogEntry[]>;
  eras: EraOption[];
  nations: NationTechStatus[];
}
interface KeyTechApplyResult {
  name: string;
  action: "grant" | "revoke";
  keyAboveWorld: boolean;
  playerCount: number;
  npcUpdated: number;
  npcCapped: number;
  npcSkipped: { id: string; name: string | null; reason: string }[];
}

/**
 * 科技管理：跨三領域檢視各國關鍵科技狀況，並可對「所有國家」統一授予／移除單一
 * 關鍵科技。自帶 admin raw-fetch（不在 OpenAPI spec），玩家實際增刪、NPC／無主
 * 以科技時代近似。
 */
function TechManagementSection() {
  const { toast } = useToast();
  const [status, setStatus] = useState<TechStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [domain, setDomain] = useState<TechDomain>("military");
  const [keySlug, setKeySlug] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/npc-nations/tech-status");
      if (!res.ok) throw new Error(await readError(res));
      setStatus((await res.json()) as TechStatusResponse);
    } catch (err) {
      toast({
        title: "載入科技狀況失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const catalog = status?.catalog[domain] ?? [];

  // domain 變更或載入後，確保 keySlug 落在該領域目錄內。
  useEffect(() => {
    if (catalog.length === 0) return;
    if (!catalog.some((c) => c.keySlug === keySlug)) {
      setKeySlug(catalog[0].keySlug);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, status]);

  const eraLabel = useCallback(
    (slug: string) => status?.eras.find((e) => e.slug === slug)?.label ?? slug,
    [status],
  );

  const apply = async (action: "grant" | "revoke") => {
    const entry = catalog.find((c) => c.keySlug === keySlug);
    if (!entry) return;
    const verb = action === "grant" ? "授予" : "移除";
    const playerLine =
      action === "grant"
        ? "・玩家國家：直接新增此關鍵科技"
        : "・玩家國家：直接刪除此關鍵科技";
    const npcLine =
      action === "grant"
        ? "・NPC／無主國家：以科技時代近似（時代指標推進至該科技所屬時代，受世界時代上限）"
        : "・NPC／無主國家：以科技時代近似（時代指標降至該科技前一時代，會一併移除同時代其他關鍵科技）";
    if (
      !window.confirm(
        `確定要為「所有國家」${verb}關鍵科技「${entry.name}」（${DOMAIN_LABELS[domain]}）嗎？\n\n${playerLine}\n${npcLine}\n\n此動作會立即影響科技解鎖與數據，且無法復原。`,
      )
    )
      return;
    setBusy(true);
    try {
      const res = await authedFetch("/api/npc-nations/key-techs", {
        method: "POST",
        body: JSON.stringify({ domain, keySlug, action }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as KeyTechApplyResult;
      const parts: string[] = [];
      if (action === "grant") {
        parts.push(`玩家國家 ${data.playerCount} 個`);
        parts.push(`NPC／無主國家 ${data.npcUpdated} 個已更新`);
        if (data.npcCapped > 0) parts.push(`其中 ${data.npcCapped} 個受世界時代上限`);
        if (data.keyAboveWorld)
          parts.push("此科技高於目前世界時代，NPC／無主國家暫無法取得");
      } else {
        parts.push(`玩家紀錄移除 ${data.playerCount} 筆`);
        parts.push(`NPC／無主國家 ${data.npcUpdated} 個已降階`);
        if (data.npcSkipped.length > 0)
          parts.push(`略過 ${data.npcSkipped.length} 個`);
      }
      toast({
        title: `已${verb}「${data.name}」`,
        description: parts.join("；"),
      });
      await load();
    } catch (err) {
      toast({
        title: `${verb}失敗`,
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold">
          <FlaskConical className="h-4 w-4" />
          科技管理
        </h2>
        {status && (
          <span className="text-xs text-muted-foreground">
            世界時代：{eraLabel(status.worldEra)}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        統一為「所有國家」增加或刪除一項關鍵科技。玩家直接增刪；NPC／無主國家以科技時代近似（無法逐項持有科技）。
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">科技領域</span>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={domain}
            onChange={(e) => setDomain(e.target.value as TechDomain)}
            data-testid="select-tech-domain"
          >
            {TECH_DOMAIN_ORDER.map((d) => (
              <option key={d} value={d}>
                {DOMAIN_LABELS[d]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">關鍵科技</span>
          <select
            className="h-9 min-w-[12rem] rounded-md border border-input bg-background px-3 text-sm"
            value={keySlug}
            onChange={(e) => setKeySlug(e.target.value)}
            data-testid="select-key-tech"
          >
            {catalog.map((c) => (
              <option key={c.keySlug} value={c.keySlug}>
                {c.name}（{eraLabel(c.eraSlug)}）
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <Button
            onClick={() => void apply("grant")}
            disabled={busy || loading || catalog.length === 0}
            data-testid="button-grant-tech"
          >
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            全體授予
          </Button>
          <Button
            variant="outline"
            onClick={() => void apply("revoke")}
            disabled={busy || loading || catalog.length === 0}
            data-testid="button-revoke-tech"
          >
            全體移除
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          載入中…
        </div>
      ) : status && status.nations.length > 0 ? (
        <div className="max-h-[480px] overflow-auto rounded-md border">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                <th className="px-2 py-1.5 font-medium">國家</th>
                {TECH_DOMAIN_ORDER.map((d) => (
                  <th key={d} className="px-2 py-1.5 font-medium">
                    {DOMAIN_LABELS[d]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {status.nations.map((n) => (
                <tr key={n.id} className="border-t align-top">
                  <td className="px-2 py-1.5">
                    <div className="font-medium">{n.name ?? "（未命名）"}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {n.isNpc ? "NPC" : n.isOwned ? "玩家" : "無主"}
                    </div>
                  </td>
                  {TECH_DOMAIN_ORDER.map((d) => {
                    const ds = n.domains[d];
                    const names = ds.keySlugs
                      .map(
                        (s) =>
                          status.catalog[d].find((c) => c.keySlug === s)?.name ??
                          s,
                      )
                      .join("、");
                    return (
                      <td key={d} className="px-2 py-1.5">
                        <div className="font-medium">{eraLabel(ds.era)}</div>
                        <div className="text-muted-foreground">
                          {names || "—"}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          尚無國家資料
        </div>
      )}
    </section>
  );
}

export default function NpcNationsPage() {
  const { toast } = useToast();
  const isAdmin = Boolean(getAdminToken());

  const { data: regionData } = useListMapRegions();
  const allRegions: RegionOption[] = (regionData?.macroRegions ?? []).flatMap(
    (g) => g.regions.map((r) => ({ id: r.id, name: r.name })),
  );

  const [loading, setLoading] = useState(true);
  const [npcs, setNpcs] = useState<Nation[]>([]);
  const [players, setPlayers] = useState<Nation[]>([]);
  const [saving, setSaving] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // create form (NPC only)
  const [showCreate, setShowCreate] = useState(false);
  const [cName, setCName] = useState("");
  const [cLeader, setCLeader] = useState("");
  const [cGov, setCGov] = useState("");
  const [cFlag, setCFlag] = useState("");
  const [cRegions, setCRegions] = useState<EditRegionRow[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/npc-nations");
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { npcs: Nation[]; players: Nation[] };
      setNpcs(data.npcs ?? []);
      setPlayers(data.players ?? []);
    } catch (err) {
      toast({
        title: "載入國家失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <ShieldAlert className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          此頁需要管理金鑰。請從側邊欄底部的鎖頭輸入。
        </p>
      </div>
    );
  }

  const doCreate = async () => {
    const assignments = rowsToAssignments(cRegions);
    if (typeof assignments === "string") {
      toast({ title: assignments, variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await authedFetch("/api/npc-nations", {
        method: "POST",
        body: JSON.stringify({
          name: cName.trim(),
          leaderName: cLeader.trim() || undefined,
          government: cGov.trim() || undefined,
          flagUrl: cFlag.trim() || undefined,
          regions: assignments,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "NPC 國家已建立" });
      setShowCreate(false);
      setCName("");
      setCLeader("");
      setCGov("");
      setCFlag("");
      setCRegions([]);
      await load();
    } catch (err) {
      toast({
        title: "建立失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (npc: Nation) => {
    if (
      !window.confirm(
        `確定要刪除 NPC「${npc.name ?? "（未命名）"}」嗎？其掌控地區與外交資料會一併清除。`,
      )
    )
      return;
    setSaving(true);
    try {
      const res = await authedFetch(`/api/npc-nations/${npc.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "NPC 國家已刪除" });
      if (editId === npc.id) setEditId(null);
      await load();
    } catch (err) {
      toast({
        title: "刪除失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const onSaved = async () => {
    setEditId(null);
    await load();
  };

  const matchesSearch = (n: Nation) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      (n.name ?? "").toLowerCase().includes(q) ||
      (n.leaderName ?? "").toLowerCase().includes(q)
    );
  };
  const filteredNpcs = npcs.filter(matchesSearch);
  const filteredPlayers = players.filter(matchesSearch);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-bold">
            <Bot className="h-6 w-6" />
            國家管理
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            建立、刪除 NPC 國家，並可編輯所有 NPC 與玩家國家的完整數據（資源、內政、經濟與掌控地區）。
          </p>
        </div>
        <Button
          onClick={() => setShowCreate((v) => !v)}
          data-testid="button-toggle-create"
        >
          <Plus className="mr-1 h-4 w-4" />
          新增 NPC
        </Button>
      </div>

      {showCreate && (
        <div className="space-y-3 rounded-lg border p-4">
          <h2 className="text-sm font-bold">建立 NPC 國家</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              placeholder="國名（必填）"
              value={cName}
              onChange={(e) => setCName(e.target.value)}
              maxLength={40}
              data-testid="input-create-name"
            />
            <Input
              placeholder="領導人"
              value={cLeader}
              onChange={(e) => setCLeader(e.target.value)}
              maxLength={40}
              data-testid="input-create-leader"
            />
            <Input
              placeholder="政體"
              value={cGov}
              onChange={(e) => setCGov(e.target.value)}
              maxLength={40}
              data-testid="input-create-government"
            />
          </div>
          <Input
            placeholder="國旗圖片網址（選填，例如 /api/storage/images/… 或 https://…）"
            value={cFlag}
            onChange={(e) => setCFlag(e.target.value)}
            maxLength={2000}
            data-testid="input-create-flag"
          />
          <RegionRows rows={cRegions} setRows={setCRegions} regions={allRegions} />
          <p className="text-xs text-muted-foreground">
            其餘數值（金錢、科技點數、內政、經濟…）可在建立後於卡片「編輯」中設定。
          </p>
          <div className="flex gap-2">
            <Button
              onClick={doCreate}
              disabled={saving || cName.trim() === ""}
              data-testid="button-create-npc"
            >
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              建立
            </Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              取消
            </Button>
          </div>
        </div>
      )}

      <TechManagementSection />

      <Input
        placeholder="搜尋國名或領導人…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-testid="input-search-nations"
      />

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          載入中…
        </div>
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-bold">
              <Bot className="h-4 w-4" />
              NPC 國家（{filteredNpcs.length}
              {search.trim() ? ` / ${npcs.length}` : ""}）
            </h2>
            {filteredNpcs.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                {search.trim() ? "沒有符合搜尋的 NPC 國家" : "尚無 NPC 國家"}
              </div>
            ) : (
              filteredNpcs.map((npc) => (
                <NationCard
                  key={npc.id}
                  nation={npc}
                  regions={allRegions}
                  editing={editId === npc.id}
                  onStartEdit={() => setEditId(npc.id)}
                  onCancel={() => setEditId(null)}
                  onSaved={onSaved}
                  onDelete={() => doDelete(npc)}
                  saving={saving}
                />
              ))
            )}
          </section>

          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-bold">
              <Users className="h-4 w-4" />
              玩家國家（{filteredPlayers.length}
              {search.trim() ? ` / ${players.length}` : ""}）
            </h2>
            {filteredPlayers.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                {search.trim() ? "沒有符合搜尋的玩家國家" : "尚無玩家國家"}
              </div>
            ) : (
              filteredPlayers.map((p) => (
                <NationCard
                  key={p.id}
                  nation={p}
                  regions={allRegions}
                  editing={editId === p.id}
                  onStartEdit={() => setEditId(p.id)}
                  onCancel={() => setEditId(null)}
                  onSaved={onSaved}
                  saving={saving}
                />
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
