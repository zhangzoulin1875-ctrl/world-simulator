import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import {
  Bot,
  Clock,
  Eye,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  Swords,
  Timer,
  XCircle,
} from "lucide-react";

interface AdminCampaign {
  id: number;
  warId: number;
  attackerNationId: string;
  attackerName: string;
  attackerIsNpc: boolean;
  defenderNationId: string;
  defenderName: string;
  defenderIsNpc: boolean;
  attackerRegionId: number;
  attackerRegionName: string;
  defenderRegionId: number;
  defenderRegionName: string;
  status: string;
  endReason: string | null;
  winnerNationId: string | null;
  cycleNumber: number;
  cycleHours: number;
  nextResolveAt: string;
  createdAt: string;
  endedAt: string | null;
  isSeaLanding: boolean;
}

const END_REASON_LABELS: Record<string, string> = {
  territory: "領土陷落",
  ceasefire: "停戰協議",
  nation_removed: "國家消失",
  stalemate: "長期僵持",
  annihilation: "軍隊全滅",
};

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

/** Task #412 — 全域戰爭參數設定卡（world_game_state，raw fetch admin API）。 */
function WarSettingsCard() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [intensity, setIntensity] = useState("");
  const [captureBase, setCaptureBase] = useState("");

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authedFetch("/api/world-sim/settings");
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as {
        settings?: {
          warIntensityPct?: number;
          territoryCaptureBasePct?: number;
        };
      };
      setIntensity(String(data.settings?.warIntensityPct ?? 100));
      setCaptureBase(String(data.settings?.territoryCaptureBasePct ?? 15));
    } catch (err) {
      toast({
        title: "讀取戰爭參數失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const save = async () => {
    const intensityNum = Number(intensity);
    const captureNum = Number(captureBase);
    if (!Number.isInteger(intensityNum) || intensityNum < 10 || intensityNum > 500) {
      toast({
        title: "戰鬥激烈度倍率無效",
        description: "必須是 10–500 的整數（%）",
        variant: "destructive",
      });
      return;
    }
    if (!Number.isInteger(captureNum) || captureNum < 1 || captureNum > 30) {
      toast({
        title: "領土奪取基礎值無效",
        description: "必須是 1–30 的整數（百分點）",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const res = await authedFetch("/api/world-sim/settings", {
        method: "PUT",
        body: JSON.stringify({
          warIntensityPct: intensityNum,
          territoryCaptureBasePct: captureNum,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "戰爭參數已更新" });
      void loadSettings();
    } catch (err) {
      toast({
        title: "儲存戰爭參數失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="card-war-settings">
      <CardHeader>
        <CardTitle className="text-base">全域戰爭參數</CardTitle>
        <CardDescription>
          戰鬥激烈度倍率影響每週期傷亡規模（100 = 標準）；領土奪取基礎值決定每週期
          領土推進幅度上限（預設 15 百分點）。大面積地區推進較慢、小地區較快。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入中…
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">戰鬥激烈度倍率（%，10–500）</span>
              <input
                type="number"
                min={10}
                max={500}
                value={intensity}
                onChange={(e) => setIntensity(e.target.value)}
                className="w-36 rounded-md border bg-background px-3 py-1.5 text-sm"
                data-testid="input-war-intensity"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">領土奪取基礎值（百分點，1–30）</span>
              <input
                type="number"
                min={1}
                max={30}
                value={captureBase}
                onChange={(e) => setCaptureBase(e.target.value)}
                className="w-36 rounded-md border bg-background px-3 py-1.5 text-sm"
                data-testid="input-territory-capture-base"
              />
            </label>
            <Button
              onClick={() => void save()}
              disabled={saving}
              data-testid="button-save-war-settings"
            >
              {saving ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : null}
              {saving ? "儲存中…" : "儲存"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** 距離下次結算的倒數字串。 */
function formatCountdown(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "即將結算";
  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小時後結算`;
  if (hours > 0) return `${hours} 小時 ${minutes} 分後結算`;
  return `${minutes} 分鐘後結算`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function NationLabel({ name, isNpc }: { name: string; isNpc: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 font-medium">
      {name}
      {isNpc && (
        <Badge variant="outline" className="gap-0.5 px-1 py-0 text-[10px]">
          <Bot className="h-2.5 w-2.5" />
          NPC
        </Badge>
      )}
    </span>
  );
}

function CampaignCard({
  campaign,
  onChanged,
}: {
  campaign: AdminCampaign;
  onChanged: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [settling, setSettling] = useState(false);
  const [ending, setEnding] = useState(false);

  const isActive = campaign.status === "active";

  const settle = async () => {
    if (
      !window.confirm(
        `確定要立即結算「${campaign.attackerName} → ${campaign.defenderName}」這場戰役嗎？將執行一次 AI 結算週期。`,
      )
    ) {
      return;
    }
    setSettling(true);
    try {
      const res = await authedFetch(
        `/api/war/admin/campaigns/${campaign.id}/settle`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "已立即結算", description: "戰役狀態已更新。" });
      await onChanged();
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

  const forceEnd = async () => {
    if (
      !window.confirm(
        `確定要強制結束「${campaign.attackerName} → ${campaign.defenderName}」這場戰役嗎？將以「停戰」結束，釋放地區交戰鎖、寫入冷卻並回收傷兵，不判勝負。`,
      )
    ) {
      return;
    }
    setEnding(true);
    try {
      const res = await authedFetch(
        `/api/war/admin/campaigns/${campaign.id}/end`,
        { method: "POST", body: JSON.stringify({ endReason: "ceasefire" }) },
      );
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "已強制結束戰役", description: "戰役已安全收尾。" });
      await onChanged();
    } catch (err) {
      toast({
        title: "強制結束失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setEnding(false);
    }
  };

  return (
    <Card data-testid={`card-campaign-${campaign.id}`}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Swords className="h-4 w-4 text-red-500" />
            <NationLabel
              name={campaign.attackerName}
              isNpc={campaign.attackerIsNpc}
            />
            <span className="text-muted-foreground">→</span>
            <NationLabel
              name={campaign.defenderName}
              isNpc={campaign.defenderIsNpc}
            />
            {campaign.isSeaLanding && (
              <Badge variant="secondary" className="text-[10px]">
                海上登陸
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {isActive ? (
              <Badge className="bg-emerald-600 hover:bg-emerald-600">
                進行中・第 {campaign.cycleNumber} 週期
              </Badge>
            ) : (
              <Badge variant="outline">
                已結束・
                {END_REASON_LABELS[campaign.endReason ?? ""] ?? "已結束"}
              </Badge>
            )}
            <Link href={`/campaign-management/${campaign.id}`}>
              <Button
                variant="outline"
                size="sm"
                data-testid={`button-view-detail-${campaign.id}`}
              >
                <Eye className="mr-1.5 h-4 w-4" />
                查看細節
              </Button>
            </Link>
          </div>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
          <span>
            爭奪地區：
            <span className="font-medium text-foreground">
              {campaign.attackerRegionName}
            </span>
            <span className="mx-1">→</span>
            <span className="font-medium text-foreground">
              {campaign.defenderRegionName}
            </span>
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Timer className="h-3.5 w-3.5" />
            結算週期：
            <span className="font-medium text-foreground">
              每 {campaign.cycleHours} 小時
            </span>
          </span>
          {isActive && (
            <span className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-amber-500" />
              {formatCountdown(campaign.nextResolveAt)}
              <span className="text-xs">
                （{formatDateTime(campaign.nextResolveAt)}）
              </span>
            </span>
          )}
        </div>

        {isActive && (
          <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground sm:max-w-xs">
              結算週期已統一由「AI 世界模擬」頁的「戰役週期長度」設定，套用到所有進行中的戰役。
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={settle}
                disabled={settling || ending}
                data-testid={`button-settle-${campaign.id}`}
              >
                {settling ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-1.5 h-4 w-4" />
                )}
                立即結算
              </Button>
              <Button
                variant="destructive"
                onClick={forceEnd}
                disabled={ending || settling}
                data-testid={`button-force-end-${campaign.id}`}
              >
                {ending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="mr-1.5 h-4 w-4" />
                )}
                強制結束
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function CampaignManagement() {
  const { toast } = useToast();
  const [campaigns, setCampaigns] = useState<AdminCampaign[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [includeEnded, setIncludeEnded] = useState(false);
  const [search, setSearch] = useState("");

  const isAdmin = Boolean(getAdminToken());

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const res = await authedFetch(
        `/api/war/admin/campaigns${includeEnded ? "?includeEnded=1" : ""}`,
      );
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { campaigns: AdminCampaign[] };
      setCampaigns(data.campaigns);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [includeEnded]);

  const [settlingAll, setSettlingAll] = useState(false);
  const settleAll = async () => {
    setSettlingAll(true);
    try {
      const res = await authedFetch("/api/war/admin/campaigns/settle-all", {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { settledCount?: number };
      const n = data.settledCount ?? 0;
      toast({
        title: "已完成立即結算",
        description:
          n > 0 ? `共結算 ${n} 場進行中的戰役` : "目前沒有可結算的戰役",
      });
      void load();
    } catch (err) {
      toast({
        title: "立即結算全部失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSettlingAll(false);
    }
  };

  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    void load();
  }, [isAdmin, load]);

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
              請先在側邊欄底部輸入管理金鑰，才能檢視與管理戰役。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const q = search.trim().toLowerCase();
  const filteredCampaigns =
    campaigns?.filter((c) =>
      q
        ? c.attackerName.toLowerCase().includes(q) ||
          c.defenderName.toLowerCase().includes(q)
        : true,
    ) ?? null;
  const activeCount =
    filteredCampaigns?.filter((c) => c.status === "active").length ?? 0;

  return (
    <div
      className="mx-auto max-w-4xl space-y-6 p-6"
      data-testid="page-campaign-management"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-bold">
            <Swords className="h-6 w-6" />
            戰役管理
          </h1>
          <p className="text-sm text-muted-foreground">
            檢視所有進行中的戰役，直接立即結算或調整結算週期（小時）。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={includeEnded}
              onCheckedChange={(v) => setIncludeEnded(v === true)}
              data-testid="checkbox-include-ended"
            />
            顯示近期已結束
          </label>
          <Button
            variant="outline"
            onClick={() => void load()}
            disabled={loading}
            data-testid="button-refresh"
          >
            {loading ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1.5 h-4 w-4" />
            )}
            重新整理
          </Button>
          <Button
            onClick={() => void settleAll()}
            disabled={settlingAll || activeCount === 0}
            data-testid="button-settle-all"
          >
            {settlingAll ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-4 w-4" />
            )}
            {settlingAll ? "結算中…" : "立即結算全部"}
          </Button>
        </div>
      </div>

      <WarSettingsCard />

      <Input
        placeholder="搜尋攻方或守方國名…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        data-testid="input-search-campaigns"
      />

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          載入戰役中…
        </div>
      ) : loadError ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {loadError}
          </CardContent>
        </Card>
      ) : !filteredCampaigns || filteredCampaigns.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {q
              ? "沒有符合搜尋的戰役。"
              : `目前沒有${includeEnded ? "任何" : "進行中的"}戰役。`}
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            進行中 {activeCount} 場
            {includeEnded && filteredCampaigns.length - activeCount > 0
              ? `，已結束 ${filteredCampaigns.length - activeCount} 場`
              : ""}
          </p>
          <div className="space-y-4">
            {filteredCampaigns.map((c) => (
              <CampaignCard key={c.id} campaign={c} onChanged={load} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
