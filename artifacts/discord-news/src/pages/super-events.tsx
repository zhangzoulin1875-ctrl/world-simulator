import { useCallback, useEffect, useMemo, useState } from "react";
import { useListMapRegions } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Loader2, Plus, Siren } from "lucide-react";
import {
  API,
  authedFetch,
  readError,
  type AdminSuperEvent,
  type NationOption,
  type RegionOption,
} from "@/components/super-events/shared";
import { EventGroup } from "@/components/super-events/event-group";
import { SettingsPanel } from "@/components/super-events/settings-panel";
import { EventEditor } from "@/components/super-events/event-editor";
import { EventDetailModal } from "@/components/super-events/event-detail-modal";

export default function SuperEvents() {
  const { toast } = useToast();
  const { data: regionData } = useListMapRegions();
  const allRegions: RegionOption[] = useMemo(
    () =>
      (regionData?.macroRegions ?? []).flatMap((g) =>
        g.regions.map((r) => ({ id: r.id, name: r.name })),
      ),
    [regionData],
  );
  const regionNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const r of allRegions) m.set(r.id, r.name);
    return m;
  }, [allRegions]);

  const [events, setEvents] = useState<AdminSuperEvent[]>([]);
  const [nations, setNations] = useState<NationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AdminSuperEvent | null>(null);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<AdminSuperEvent | null>(null);

  const nationNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nations) m.set(n.id, n.name);
    return m;
  }, [nations]);

  const loadNations = useCallback(async () => {
    try {
      const res = await authedFetch(`${API}/npc-nations`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        npcs?: { id: string; name: string | null }[];
        players?: { id: string; name: string | null }[];
      };
      const opts: NationOption[] = [
        ...(data.npcs ?? []).map((n) => ({
          id: n.id,
          name: n.name?.trim() || "（未命名 NPC）",
          isNpc: true,
        })),
        ...(data.players ?? []).map((n) => ({
          id: n.id,
          name: n.name?.trim() || "（未命名國家）",
          isNpc: false,
        })),
      ];
      setNations(opts);
    } catch {
      /* ignore — nation picker just stays empty */
    }
  }, []);

  useEffect(() => {
    void loadNations();
  }, [loadNations]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await authedFetch(`${API}/super-events/admin/list`);
      if (!res.ok) {
        setLoadError(await readError(res));
        setEvents([]);
        return;
      }
      const data = (await res.json()) as { events: AdminSuperEvent[] };
      setEvents(data.events);
    } catch {
      setLoadError("無法連線至伺服器");
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleDelete = async (ev: AdminSuperEvent) => {
    if (!window.confirm(`確定要刪除「${ev.title}」？此動作無法復原。`)) return;
    const res = await authedFetch(`${API}/super-events/admin/${ev.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      toast({ title: "刪除失敗", description: await readError(res), variant: "destructive" });
      return;
    }
    toast({ title: "已刪除超事件" });
    void load();
  };

  const active = events.filter((e) => e.status === "active");
  const ended = events.filter((e) => e.status !== "active");

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Siren className="h-6 w-6 text-red-500" />
          <div>
            <h1 className="text-xl font-bold">超事件管理</h1>
            <p className="text-sm text-muted-foreground">
              建立、生成與管理牽動全球或多國的重大事件。
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> 手動建立
          </Button>
        </div>
      </div>

      <SettingsPanel regions={allRegions} nations={nations} onGenerated={load} />

      <div className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 rounded-lg border bg-card p-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" /> 載入超事件中…
          </div>
        ) : loadError ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm">
            <p className="mb-3 font-medium text-destructive">{loadError}</p>
            <p className="text-muted-foreground">
              請確認已在右上角「管理金鑰」面板輸入有效的管理員權杖。
            </p>
            <Button variant="outline" className="mt-3" onClick={() => void load()}>
              重新載入
            </Button>
          </div>
        ) : events.length === 0 ? (
          <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
            目前沒有任何超事件。
          </div>
        ) : (
          <>
            <EventGroup
              title="進行中"
              events={active}
              regionNameById={regionNameById}
              nationNameById={nationNameById}
              onEdit={setEditing}
              onDelete={handleDelete}
              onView={setViewing}
            />
            {ended.length > 0 && (
              <EventGroup
                title="已結束"
                events={ended}
                regionNameById={regionNameById}
                nationNameById={nationNameById}
                onEdit={setEditing}
                onDelete={handleDelete}
                onView={setViewing}
              />
            )}
          </>
        )}
      </div>

      {viewing && (
        <EventDetailModal
          event={viewing}
          onClose={() => setViewing(null)}
        />
      )}

      {(creating || editing) && (
        <EventEditor
          event={editing}
          regions={allRegions}
          regionNameById={regionNameById}
          nations={nations}
          nationNameById={nationNameById}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
