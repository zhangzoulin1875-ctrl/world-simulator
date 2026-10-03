import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import {
  ArrowLeft,
  Bot,
  Castle,
  Clock,
  Loader2,
  Map as MapIcon,
  Play,
  RefreshCw,
  ScrollText,
  Shield,
  ShieldAlert,
  Swords,
  Timer,
  XCircle,
} from "lucide-react";

interface AdminNationSide {
  nationId: string;
  name: string;
  isNpc: boolean;
  regionId: number;
  regionName: string;
}

interface AdminLegionUnit {
  templateId: number;
  name: string;
  quantity: number;
  wounded: number;
}

interface AdminLegion {
  slot: string;
  morale: number;
  supply: number;
  garrisoningCity: boolean;
  units: AdminLegionUnit[];
}

interface AdminCityRow {
  cityId: number;
  name: string;
  wallTier: number;
  wallTierLabel: string;
  durability: number;
  maxDurability: number;
  durabilityPct: number;
}

interface AdminCityView {
  cities: AdminCityRow[];
  garrisoned: boolean;
}

interface AdminOrder {
  orderType: string;
  body: string;
}

interface AdminSideSummary {
  moraleDelta: number;
  woundedTotal: number;
  deadTotal: number;
  territoryPctDelta: number;
  warWearinessDelta: number;
  /** 傷亡成因（伺服器確定性、定性描述）；舊戰報無此欄。 */
  lossReasons?: string[];
}

interface AdminReport {
  id: number;
  cycleNumber: number;
  attackerReport: string;
  defenderReport: string;
  attackerSummary: AdminSideSummary;
  defenderSummary: AdminSideSummary;
  attackerCityHoldoutPct: number | null;
  defenderCityHoldoutPct: number | null;
  localPopulationLoss: number | null;
  stalemate: boolean;
  createdAt: string;
}

interface AdminCampaignDetail {
  id: number;
  warId: number;
  attacker: AdminNationSide;
  defender: AdminNationSide;
  status: string;
  endReason: string | null;
  winnerNationId: string | null;
  cycleNumber: number;
  cycleHours: number;
  nextResolveAt: string;
  createdAt: string;
  endedAt: string | null;
  isSeaLanding: boolean;
  landingAttackReductionPct: number | null;
  seaLandingTroopCap: number | null;
  terrainBrief: string | null;
  attackerCityState: AdminCityView | null;
  defenderCityState: AdminCityView | null;
  attackerLegions: AdminLegion[];
  defenderLegions: AdminLegion[];
  attackerOrders: AdminOrder[];
  defenderOrders: AdminOrder[];
  reports: AdminReport[];
}

const END_REASON_LABELS: Record<string, string> = {
  territory: "領土陷落",
  ceasefire: "停戰協議",
  nation_removed: "國家消失",
  stalemate: "長期僵持",
  annihilation: "軍隊全滅",
};

const ORDER_TYPE_LABELS: Record<string, string> = {
  command: "作戰指令",
  strategy: "戰略指示",
  attack: "進攻指令",
  defense: "防禦指令",
  recon: "偵查指令",
};

const SLOT_LABELS: Record<string, string> = {
  A: "第一軍團",
  B: "第二軍團",
  C: "第三軍團",
};

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

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function signed(n: number): string {
  return n > 0 ? `+${fmt(n)}` : fmt(n);
}

function NationLabel({ side }: { side: AdminNationSide }) {
  return (
    <span className="inline-flex items-center gap-1 font-medium">
      {side.name}
      {side.isNpc && (
        <Badge variant="outline" className="gap-0.5 px-1 py-0 text-[10px]">
          <Bot className="h-2.5 w-2.5" />
          NPC
        </Badge>
      )}
    </span>
  );
}

function CityStateCard({
  title,
  mine,
  side,
  state,
}: {
  title: string;
  mine: "attacker" | "defender";
  side: AdminNationSide;
  state: AdminCityView | null;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <Castle className="h-4 w-4 text-amber-500" />
            {title}
            <span className="text-xs font-normal text-muted-foreground">
              {side.regionName}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <Badge
              variant="outline"
              className={
                mine === "attacker"
                  ? "border-red-500/40 text-red-600 dark:text-red-300"
                  : "border-blue-500/40 text-blue-600 dark:text-blue-300"
              }
            >
              {mine === "attacker" ? "進攻方" : "防守方"}
            </Badge>
            {state?.garrisoned && (
              <Badge variant="secondary" className="text-[10px]">
                已駐防
              </Badge>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!state || state.cities.length === 0 ? (
          <p className="text-xs text-muted-foreground">此地區無城市防線。</p>
        ) : (
          <div className="space-y-3">
            {state.cities.map((c) => {
              const pct = Math.max(0, Math.min(100, c.durabilityPct));
              const fallen = c.durability <= 0;
              return (
                <div key={c.cityId} className={fallen ? "opacity-60" : ""}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 font-medium">
                      {c.name}
                      <Badge variant="outline" className="px-1 py-0 text-[10px]">
                        {c.wallTierLabel}
                      </Badge>
                    </span>
                    <span
                      className={`tabular-nums ${fallen ? "font-bold text-red-500" : "text-muted-foreground"}`}
                    >
                      {fmt(c.durability)} / {fmt(c.maxDurability)}（{pct}%）
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full ${
                        pct <= 25
                          ? "bg-red-500"
                          : pct <= 60
                            ? "bg-amber-400"
                            : "bg-emerald-500"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {fallen && (
                    <p className="mt-1 text-[11px] font-bold text-red-500">
                      城牆已被攻破！
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LegionsCard({
  title,
  mine,
  legions,
}: {
  title: string;
  mine: "attacker" | "defender";
  legions: AdminLegion[];
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Shield
            className={`h-4 w-4 ${mine === "attacker" ? "text-red-500" : "text-blue-500"}`}
          />
          {title}
          <span className="text-xs font-normal text-muted-foreground">
            {legions.length} 個軍團
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {legions.length === 0 ? (
          <p className="text-xs text-muted-foreground">尚未部署任何軍團。</p>
        ) : (
          legions.map((l) => (
            <div key={l.slot} className="rounded-lg border p-3">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-semibold">
                  {SLOT_LABELS[l.slot] ?? l.slot}
                </span>
                <span className="text-muted-foreground">士氣 {l.morale}</span>
                <span className="text-muted-foreground">補給 {l.supply}</span>
                {l.garrisoningCity && (
                  <Badge variant="secondary" className="text-[10px]">
                    駐守城市
                  </Badge>
                )}
              </div>
              {l.units.length === 0 ? (
                <p className="text-xs text-muted-foreground">無兵種。</p>
              ) : (
                <div className="space-y-1">
                  {l.units.map((u) => (
                    <div
                      key={u.templateId}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span>{u.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        兵力 {fmt(u.quantity)}
                        {u.wounded > 0 && (
                          <span className="ml-2 text-amber-600 dark:text-amber-400">
                            傷兵 {fmt(u.wounded)}
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function OrdersCard({
  title,
  mine,
  orders,
}: {
  title: string;
  mine: "attacker" | "defender";
  orders: AdminOrder[];
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ScrollText
            className={`h-4 w-4 ${mine === "attacker" ? "text-red-500" : "text-blue-500"}`}
          />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {orders.length === 0 ? (
          <p className="text-xs text-muted-foreground">本週期尚未下達指令。</p>
        ) : (
          orders.map((o) => (
            <div key={o.orderType} className="rounded-lg border p-2 text-xs">
              <Badge variant="outline" className="mb-1 text-[10px]">
                {ORDER_TYPE_LABELS[o.orderType] ?? o.orderType}
              </Badge>
              <p className="whitespace-pre-wrap leading-relaxed">{o.body}</p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function SummaryBlock({
  label,
  s,
}: {
  label: string;
  s: AdminSideSummary;
}) {
  return (
    <div className="rounded-lg border p-2 text-xs">
      <div className="mb-1 font-semibold">{label}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums text-muted-foreground">
        <span>士氣 {signed(s.moraleDelta)}</span>
        <span>戰損 {fmt(s.deadTotal)}</span>
        <span>傷兵 {fmt(s.woundedTotal)}</span>
        <span>領土 {signed(s.territoryPctDelta)}%</span>
        <span>厭戰 {signed(s.warWearinessDelta)}</span>
      </div>
      {s.lossReasons && s.lossReasons.length > 0 && (
        <div className="mt-1.5 border-t pt-1">
          <div className="mb-0.5 font-semibold text-muted-foreground">損失原因</div>
          <ul className="space-y-0.5 text-muted-foreground">
            {s.lossReasons.map((reason, i) => (
              <li key={i} className="flex gap-1">
                <span>•</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ReportCard({ report }: { report: AdminReport }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Timer className="h-4 w-4 text-muted-foreground" />第 {report.cycleNumber} 週期戰報
          {report.stalemate && (
            <Badge variant="outline" className="text-[10px]">
              僵持
            </Badge>
          )}
          <span className="text-xs font-normal text-muted-foreground">
            {formatDateTime(report.createdAt)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-semibold text-red-600 dark:text-red-300">
              進攻方戰報
            </div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {report.attackerReport}
            </p>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-blue-600 dark:text-blue-300">
              防守方戰報
            </div>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
              {report.defenderReport}
            </p>
          </div>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <SummaryBlock label="進攻方數據" s={report.attackerSummary} />
          <SummaryBlock label="防守方數據" s={report.defenderSummary} />
        </div>
        {report.localPopulationLoss != null && report.localPopulationLoss > 0 && (
          <p className="text-xs text-muted-foreground">
            當地人口損失：{fmt(report.localPopulationLoss)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function CampaignDetail() {
  const params = useParams();
  const idParam = params.id ?? "";
  const campaignId = Number(idParam);
  const validId = Number.isInteger(campaignId) && campaignId > 0;
  const [detail, setDetail] = useState<AdminCampaignDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const [ending, setEnding] = useState(false);
  const { toast } = useToast();

  const isAdmin = Boolean(getAdminToken());

  const load = useCallback(async () => {
    if (!validId) {
      setLoadError("無效的戰役編號");
      setLoading(false);
      return;
    }
    try {
      setLoadError(null);
      const res = await authedFetch(`/api/war/admin/campaigns/${campaignId}`);
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as AdminCampaignDetail;
      setDetail(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [campaignId, validId]);

  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    void load();
  }, [isAdmin, load]);

  const settle = async () => {
    if (
      !window.confirm(
        "確定要立即結算這場戰役嗎？將執行一次 AI 結算週期。",
      )
    )
      return;
    setSettling(true);
    try {
      const res = await authedFetch(
        `/api/war/admin/campaigns/${campaignId}/settle`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "已立即結算", description: "戰役狀態已更新。" });
      await load();
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
        "確定要強制結束這場戰役嗎？將以「停戰」結束，釋放地區交戰鎖、寫入冷卻並回收傷兵，不判勝負。",
      )
    )
      return;
    setEnding(true);
    try {
      const res = await authedFetch(
        `/api/war/admin/campaigns/${campaignId}/end`,
        { method: "POST", body: JSON.stringify({ endReason: "ceasefire" }) },
      );
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "已強制結束戰役", description: "戰役已安全收尾。" });
      await load();
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
              請先在側邊欄底部輸入管理金鑰，才能檢視戰役細節。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const isActive = detail?.status === "active";

  return (
    <div
      className="mx-auto max-w-5xl space-y-6 p-6"
      data-testid="page-campaign-detail"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/campaign-management">
          <Button variant="outline" size="sm" data-testid="button-back">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            回戰役管理
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          {isActive && (
            <>
              <Button
                size="sm"
                onClick={() => void settle()}
                disabled={settling || ending}
                data-testid="button-settle"
              >
                {settling ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-1.5 h-4 w-4" />
                )}
                {settling ? "結算中…" : "立即結算"}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void forceEnd()}
                disabled={settling || ending}
                data-testid="button-force-end"
              >
                {ending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="mr-1.5 h-4 w-4" />
                )}
                強制結束
              </Button>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
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
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          載入戰役細節中…
        </div>
      ) : loadError ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {loadError}
          </CardContent>
        </Card>
      ) : !detail ? null : (
        <>
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                  <Swords className="h-5 w-5 text-red-500" />
                  <NationLabel side={detail.attacker} />
                  <span className="text-muted-foreground">→</span>
                  <NationLabel side={detail.defender} />
                  {detail.isSeaLanding && (
                    <Badge variant="secondary" className="text-[10px]">
                      海上登陸
                    </Badge>
                  )}
                </CardTitle>
                {isActive ? (
                  <Badge className="bg-emerald-600 hover:bg-emerald-600">
                    進行中・第 {detail.cycleNumber} 週期
                  </Badge>
                ) : (
                  <Badge variant="outline">
                    已結束・
                    {END_REASON_LABELS[detail.endReason ?? ""] ?? "已結束"}
                  </Badge>
                )}
              </div>
              <CardDescription className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
                <span className="flex items-center gap-1.5">
                  <MapIcon className="h-3.5 w-3.5" />
                  {detail.attacker.regionName}
                  <span className="mx-0.5">→</span>
                  {detail.defender.regionName}
                </span>
                <span className="flex items-center gap-1.5">
                  <Timer className="h-3.5 w-3.5" />每 {detail.cycleHours} 小時
                </span>
                {isActive && (
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-amber-500" />
                    {formatCountdown(detail.nextResolveAt)}
                    <span className="text-xs">
                      （{formatDateTime(detail.nextResolveAt)}）
                    </span>
                  </span>
                )}
              </CardDescription>
              {detail.isSeaLanding && (
                <p className="pt-1 text-xs text-sky-600 dark:text-sky-300">
                  海上登陸：進攻方攻擊力減損 {detail.landingAttackReductionPct ?? 0}%
                  {detail.seaLandingTroopCap != null
                    ? `，可投入兵力上限 ${fmt(detail.seaLandingTroopCap)}`
                    : ""}
                </p>
              )}
            </CardHeader>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <MapIcon className="h-4 w-4 text-amber-500" />
                戰場地理
              </CardTitle>
            </CardHeader>
            <CardContent>
              {detail.terrainBrief ? (
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
                  {detail.terrainBrief}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  尚無戰場地理敘述。
                </p>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <LegionsCard
              title="進攻方軍團"
              mine="attacker"
              legions={detail.attackerLegions}
            />
            <LegionsCard
              title="防守方軍團"
              mine="defender"
              legions={detail.defenderLegions}
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <CityStateCard
              title="進攻方城市防線"
              mine="attacker"
              side={detail.attacker}
              state={detail.attackerCityState}
            />
            <CityStateCard
              title="防守方城市防線"
              mine="defender"
              side={detail.defender}
              state={detail.defenderCityState}
            />
          </div>

          {isActive && (
            <div className="grid gap-4 md:grid-cols-2">
              <OrdersCard
                title="進攻方本週期指令"
                mine="attacker"
                orders={detail.attackerOrders}
              />
              <OrdersCard
                title="防守方本週期指令"
                mine="defender"
                orders={detail.defenderOrders}
              />
            </div>
          )}

          <div className="space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <ScrollText className="h-4 w-4" />
              戰報（{detail.reports.length}）
            </h2>
            {detail.reports.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-sm text-muted-foreground">
                  尚無戰報。
                </CardContent>
              </Card>
            ) : (
              detail.reports.map((r) => <ReportCard key={r.id} report={r} />)
            )}
          </div>
        </>
      )}
    </div>
  );
}
