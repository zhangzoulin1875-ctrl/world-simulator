import { useEffect, useMemo, useState } from "react";
import { useListMapRegions } from "@workspace/api-client-react";
import type { MapRegionEntry } from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
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
  Loader2,
  ShieldAlert,
  Globe2,
  Plus,
  Trash2,
  AlertTriangle,
} from "lucide-react";
import { WorldDistrictMap } from "@/components/world-district-map";

interface NationEntry {
  id: string;
  name: string | null;
  discordUserId: string | null;
  /** 玩家自訂地圖顏色（#rrggbb）；null = 退回預設調色盤。 */
  mapColor?: string | null;
}

interface ControlEntry {
  regionId: number;
  nationId: string;
  percent: number;
}

interface ControlsResponse {
  nations: NationEntry[];
  controls: ControlEntry[];
}

/** 編輯面板中的一列（percent 以字串保存以便輸入中間狀態）。 */
interface EditRow {
  nationId: string;
  percent: string;
}

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

/** 依國家順序指派的地圖填色（同色系深淺代表掌控比例）。 */
const NATION_COLORS = [
  "#dc2626", // red
  "#2563eb", // blue
  "#16a34a", // green
  "#d97706", // amber
  "#9333ea", // purple
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
  "#7c3aed", // violet
  "#ea580c", // orange
  "#0d9488", // teal
  "#4f46e5", // indigo
  "#b91c1c", // dark red
  "#1d4ed8", // dark blue
  "#15803d", // dark green
  "#a16207", // dark amber
  "#831843", // dark pink
  "#155e75", // dark cyan
  "#6b21a8", // dark purple
  "#3f6212", // dark lime
] as const;

/** 白色 → 目標色，t ∈ [0,1]。 */
function tintFromWhite(hex: string, t: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const mix = (c: number) => Math.round(255 + (c - 255) * t);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

function nationLabel(n: NationEntry): string {
  const base = n.name?.trim() || `（未命名國家 ${n.id.slice(0, 8)}）`;
  return n.discordUserId ? base : `${base}〔無主〕`;
}

export default function RegionControlPage() {
  const { toast } = useToast();
  const isAdmin = Boolean(getAdminToken());

  const { data: regionData, isLoading: regionsLoading } = useListMapRegions();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nations, setNations] = useState<NationEntry[]>([]);
  const [controls, setControls] = useState<ControlEntry[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [reason, setReason] = useState("");

  const regionById = useMemo(() => {
    const m = new Map<number, MapRegionEntry>();
    for (const group of regionData?.macroRegions ?? []) {
      for (const r of group.regions) m.set(r.id, r);
    }
    return m;
  }, [regionData]);

  const regionByName = useMemo(() => {
    const m = new Map<string, MapRegionEntry>();
    for (const r of regionById.values()) m.set(r.name, r);
    return m;
  }, [regionById]);

  const nationById = useMemo(() => {
    const m = new Map<string, NationEntry>();
    for (const n of nations) m.set(n.id, n);
    return m;
  }, [nations]);

  const colorByNation = useMemo(() => {
    const m = new Map<string, string>();
    nations.forEach((n, i) => {
      m.set(n.id, n.mapColor ?? NATION_COLORS[i % NATION_COLORS.length]!);
    });
    return m;
  }, [nations]);

  const controlsByRegion = useMemo(() => {
    const m = new Map<number, ControlEntry[]>();
    for (const c of controls) {
      const list = m.get(c.regionId) ?? [];
      list.push(c);
      m.set(c.regionId, list);
    }
    return m;
  }, [controls]);

  /** 地圖填色：以掌控比例最高的國家為主色，比例越高顏色越深。 */
  const fills = useMemo(() => {
    const m = new Map<string, string>();
    for (const [regionId, list] of controlsByRegion) {
      const region = regionById.get(regionId);
      if (!region || list.length === 0) continue;
      const top = [...list].sort((a, b) => b.percent - a.percent)[0]!;
      const color = colorByNation.get(top.nationId);
      if (!color) continue;
      m.set(region.name, tintFromWhite(color, 0.25 + 0.75 * (top.percent / 100)));
    }
    return m;
  }, [controlsByRegion, regionById, colorByNation]);

  const valueByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const [regionId, list] of controlsByRegion) {
      const region = regionById.get(regionId);
      if (!region || list.length === 0) continue;
      m.set(
        region.name,
        list
          .map((c) => {
            const n = nationById.get(c.nationId);
            return `${n ? nationLabel(n) : c.nationId} ${c.percent}%`;
          })
          .join("、"),
      );
    }
    return m;
  }, [controlsByRegion, regionById, nationById]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/region-controls");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ControlsResponse = await res.json();
      setNations(Array.isArray(data.nations) ? data.nations : []);
      setControls(Array.isArray(data.controls) ? data.controls : []);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "讀取失敗",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isAdmin) load();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const selectRegion = (id: number) => {
    setSelectedId(id);
    setReason("");
    const existing = controlsByRegion.get(id) ?? [];
    setRows(
      existing.map((c) => ({
        nationId: c.nationId,
        percent: String(c.percent),
      })),
    );
  };

  const selectedRegion = selectedId != null ? regionById.get(selectedId) : null;

  const usedNationIds = new Set(rows.map((r) => r.nationId));
  const availableNations = nations.filter((n) => !usedNationIds.has(n.id));

  const rowTotal = rows.reduce((sum, r) => {
    const v = Number(r.percent);
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);

  const rowError = useMemo((): string | null => {
    for (const r of rows) {
      if (!r.nationId) return "請為每一列選擇國家";
      const v = Number(r.percent);
      if (!Number.isInteger(v) || v < 1 || v > 100) {
        return "掌控比例必須是 1 到 100 的整數";
      }
    }
    if (rowTotal > 100) return `掌控比例總和不可超過 100%（目前 ${rowTotal}%）`;
    return null;
  }, [rows, rowTotal]);

  const save = async () => {
    if (selectedId == null) return;
    if (rowError) {
      toast({ variant: "destructive", title: "無法儲存", description: rowError });
      return;
    }
    setSaving(true);
    try {
      const res = await authedFetch(`/api/region-controls/${selectedId}`, {
        method: "PUT",
        body: JSON.stringify({
          controls: rows.map((r) => ({
            nationId: r.nationId,
            percent: Number(r.percent),
          })),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      setControls((prev) => [
        ...prev.filter((c) => c.regionId !== selectedId),
        ...(data.controls as { nationId: string; percent: number }[]).map(
          (c) => ({ regionId: selectedId, ...c }),
        ),
      ]);
      toast({
        title: "已更新地區歸屬",
        description: `${selectedRegion?.name ?? ""} 的掌控設定已儲存，玩家數值即時生效。`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "儲存失敗",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!isAdmin) {
    return (
      <div className="container mx-auto py-8 px-4 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5" />
              需要管理員權限
            </CardTitle>
            <CardDescription>
              請先以管理員身分登入後再進入地區歸屬管理。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const busy = loading || regionsLoading;

  return (
    <div className="container mx-auto py-8 px-4 max-w-6xl space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Globe2 className="w-7 h-7" />
          地區歸屬管理
        </h1>
        <p className="text-muted-foreground mt-1">
          指定每個地區由哪些玩家國家掌控與其比例（每區總和最多
          100%）。玩家首頁的人口、生產力與科技成長會依此即時加權計算。
        </p>
      </div>

      {busy ? (
        <div className="space-y-3">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        <>
          {nations.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {nations.map((n) => (
                <Badge
                  key={n.id}
                  variant="outline"
                  className="gap-1.5"
                  data-testid={`nation-chip-${n.id}`}
                >
                  <span
                    className="inline-block w-3 h-3 rounded-full"
                    style={{ background: colorByNation.get(n.id) }}
                  />
                  {nationLabel(n)}
                </Badge>
              ))}
            </div>
          )}
          {nations.length === 0 && (
            <Card>
              <CardContent className="py-4 text-sm text-muted-foreground flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                目前沒有任何國家。玩家在玩家首頁完成建國後才會出現國家資料。
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="p-2 sm:p-4">
              <WorldDistrictMap
                selectedName={selectedRegion?.name ?? null}
                neighborNames={new Set()}
                onSelect={(name) => {
                  const r = regionByName.get(name);
                  if (r) selectRegion(r.id);
                }}
                fills={fills}
                valueByName={valueByName}
              />
            </CardContent>
          </Card>

          {selectedRegion ? (
            <Card data-testid="region-edit-panel">
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2 flex-wrap">
                  {selectedRegion.name}
                  <Badge variant="secondary">{selectedRegion.macroRegion}</Badge>
                </CardTitle>
                <CardDescription>
                  設定掌控這個地區的國家與比例。清空所有列＝無人掌控。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {rows.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    目前無人掌控這個地區。
                  </p>
                )}
                {rows.map((row, idx) => {
                  const selectable = nations.filter(
                    (n) => n.id === row.nationId || !usedNationIds.has(n.id),
                  );
                  return (
                    <div
                      key={idx}
                      className="flex flex-col sm:flex-row gap-2 sm:items-center"
                      data-testid={`control-row-${idx}`}
                    >
                      <div className="flex-1 min-w-0">
                        <Select
                          value={row.nationId || undefined}
                          onValueChange={(v) =>
                            setRows((prev) =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, nationId: v } : r,
                              ),
                            )
                          }
                        >
                          <SelectTrigger data-testid={`select-nation-${idx}`}>
                            <SelectValue placeholder="選擇國家" />
                          </SelectTrigger>
                          <SelectContent>
                            {selectable.map((n) => (
                              <SelectItem key={n.id} value={n.id}>
                                {nationLabel(n)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={1}
                          max={100}
                          step={1}
                          className="w-24"
                          value={row.percent}
                          onChange={(e) =>
                            setRows((prev) =>
                              prev.map((r, i) =>
                                i === idx ? { ...r, percent: e.target.value } : r,
                              ),
                            )
                          }
                          data-testid={`input-percent-${idx}`}
                        />
                        <span className="text-sm text-muted-foreground">%</span>
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() =>
                            setRows((prev) => prev.filter((_, i) => i !== idx))
                          }
                          aria-label="移除這一列"
                          data-testid={`remove-row-${idx}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}

                <div className="space-y-1 pt-1">
                  <label className="text-sm text-muted-foreground">
                    變更理由（選填，會記錄到領土變化歷史）
                  </label>
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    maxLength={500}
                    placeholder="例如：劇情事件調整"
                    data-testid="input-change-reason"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setRows((prev) => [
                        ...prev,
                        {
                          nationId: availableNations[0]?.id ?? "",
                          percent: "100",
                        },
                      ])
                    }
                    disabled={availableNations.length === 0}
                    data-testid="add-control-row"
                  >
                    <Plus className="w-4 h-4 mr-1" />
                    新增國家
                  </Button>
                  <Badge variant={rowTotal > 100 ? "destructive" : "outline"}>
                    總和 {rowTotal}%
                  </Badge>
                  {rowError && (
                    <span className="text-sm text-destructive">{rowError}</span>
                  )}
                  <div className="ml-auto">
                    <Button
                      onClick={save}
                      disabled={saving || Boolean(rowError)}
                      data-testid="save-region-controls"
                    >
                      {saving && (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      )}
                      儲存
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-6 text-sm text-muted-foreground">
                點選地圖上的任一地區開始編輯掌控設定。
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
