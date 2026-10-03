import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import { History, Loader2, RefreshCw } from "lucide-react";

/**
 * Task #392 — 領土變化歷史查詢（AdminOnly，raw fetch，不走 OpenAPI）。
 * 依國家篩選的時間軸（新→舊），cursor 分頁載入更多。
 */

interface HistoryItem {
  id: number;
  nationId: string;
  nationName: string | null;
  regionId: number;
  regionName: string | null;
  percentBefore: number;
  percentAfter: number;
  changeType: string;
  changeTypeLabel: string;
  reason: string;
  warId: number | null;
  treatyId: number | null;
  createdAt: string;
}

interface NationOption {
  id: string;
  name: string | null;
  isNpc: boolean;
  discordUserId: string | null;
}

const ALL_NATIONS = "__all__";

async function authedFetch(url: string, init?: RequestInit) {
  const token = getAdminToken();
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
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

const TYPE_BADGE_CLASS: Record<string, string> = {
  founding: "bg-emerald-100 text-emerald-800",
  war: "bg-red-100 text-red-800",
  treaty: "bg-blue-100 text-blue-800",
  admin_edit: "bg-amber-100 text-amber-800",
  admin_nation_replace: "bg-amber-100 text-amber-800",
  overfull_repair: "bg-purple-100 text-purple-800",
  world_sim: "bg-cyan-100 text-cyan-800",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-TW", { hour12: false });
}

export default function TerritoryHistory() {
  const { toast } = useToast();
  const [nations, setNations] = useState<NationOption[]>([]);
  const [selectedNation, setSelectedNation] = useState<string>(ALL_NATIONS);
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadNations = useCallback(async () => {
    try {
      const res = await authedFetch("/api/region-controls");
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { nations: NationOption[] };
      setNations(data.nations);
    } catch (err) {
      toast({
        title: "讀取國家清單失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    }
  }, [toast]);

  const loadHistory = useCallback(
    async (nation: string, beforeId: number | null) => {
      const params = new URLSearchParams();
      if (nation !== ALL_NATIONS) params.set("nationId", nation);
      if (beforeId !== null) params.set("beforeId", String(beforeId));
      params.set("limit", "50");
      const res = await authedFetch(
        `/api/territory-history?${params.toString()}`,
      );
      if (!res.ok) throw new Error(await readError(res));
      return (await res.json()) as {
        items: HistoryItem[];
        nextBeforeId: number | null;
      };
    },
    [],
  );

  const refresh = useCallback(
    async (nation: string) => {
      setLoading(true);
      try {
        const data = await loadHistory(nation, null);
        setItems(data.items);
        setNextBeforeId(data.nextBeforeId);
      } catch (err) {
        toast({
          title: "讀取領土變化歷史失敗",
          description: err instanceof Error ? err.message : "請稍後再試",
          variant: "destructive",
        });
      } finally {
        setLoading(false);
      }
    },
    [loadHistory, toast],
  );

  const loadMore = useCallback(async () => {
    if (nextBeforeId === null) return;
    setLoadingMore(true);
    try {
      const data = await loadHistory(selectedNation, nextBeforeId);
      setItems((prev) => [...prev, ...data.items]);
      setNextBeforeId(data.nextBeforeId);
    } catch (err) {
      toast({
        title: "載入更多失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setLoadingMore(false);
    }
  }, [loadHistory, nextBeforeId, selectedNation, toast]);

  useEffect(() => {
    void loadNations();
    void refresh(ALL_NATIONS);
  }, [loadNations, refresh]);

  const onNationChange = (value: string) => {
    setSelectedNation(value);
    void refresh(value);
  };

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center gap-2">
        <History className="w-5 h-5" />
        <h1 className="text-2xl font-bold">領土變化歷史</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        所有地區掌控變更的完整時間軸（新→舊）：建國、戰爭、條約割讓、管理員編輯、
        超額修復與世界模擬皆會自動記錄變更理由。
      </p>

      <div className="flex items-center gap-3">
        <Select value={selectedNation} onValueChange={onNationChange}>
          <SelectTrigger className="w-72" data-testid="select-nation">
            <SelectValue placeholder="選擇國家" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_NATIONS}>全部國家</SelectItem>
            {nations.map((n) => (
              <SelectItem key={n.id} value={n.id}>
                {n.name ?? "（未命名國家）"}
                {n.isNpc ? "（NPC）" : n.discordUserId ? "" : "（無主）"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh(selectedNation)}
          disabled={loading}
          data-testid="button-refresh"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          <span className="ml-1">重新整理</span>
        </Button>
      </div>

      {loading && items.length === 0 ? (
        <div className="flex items-center gap-2 text-muted-foreground py-8">
          <Loader2 className="w-4 h-4 animate-spin" />
          載入中…
        </div>
      ) : items.length === 0 ? (
        <div className="text-muted-foreground py-8">目前沒有領土變化紀錄。</div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const delta = item.percentAfter - item.percentBefore;
            return (
              <div
                key={item.id}
                className="border rounded-lg p-4 space-y-2"
                data-testid={`history-item-${item.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    className={
                      TYPE_BADGE_CLASS[item.changeType] ??
                      "bg-gray-100 text-gray-800"
                    }
                  >
                    {item.changeTypeLabel}
                  </Badge>
                  <span className="font-medium">
                    {item.nationName ?? "（國家已刪除）"}
                  </span>
                  <span className="text-muted-foreground">·</span>
                  <span>{item.regionName ?? `地區 #${item.regionId}`}</span>
                  <span
                    className={
                      delta > 0
                        ? "text-emerald-600 font-medium"
                        : "text-red-600 font-medium"
                    }
                  >
                    {item.percentBefore}% → {item.percentAfter}%（
                    {delta > 0 ? `+${delta}` : delta}%）
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">
                  {item.reason}
                  {item.warId !== null && `（戰爭 #${item.warId}）`}
                  {item.treatyId !== null && `（條約 #${item.treatyId}）`}
                </div>
                <div className="text-xs text-muted-foreground">
                  {formatTime(item.createdAt)}
                </div>
              </div>
            );
          })}
          {nextBeforeId !== null && (
            <Button
              variant="outline"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              data-testid="button-load-more"
            >
              {loadingMore && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              載入更多
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
