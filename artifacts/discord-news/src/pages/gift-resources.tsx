import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import {
  Gift,
  Loader2,
  Rocket,
  ShieldAlert,
  Sparkles,
  Coins,
  Smile,
  Users,
} from "lucide-react";

type GiftResource =
  | "techPoints"
  | "money"
  | "satisfaction"
  | "populationGrowth";
type GiftTargetType = "all" | "allPlayers" | "allNpcs" | "nation";
type GiftDirection = "law" | "culture" | "religion" | "rights" | "all";

interface NationRow {
  id: string;
  name: string | null;
  leaderName: string | null;
  isNpc: boolean;
  isOwned: boolean;
}

interface NationsPayload {
  npcs: NationRow[];
  players: NationRow[];
}

/** 各資源上限，與後端 GIFT_RESOURCE_SPECS 一致。 */
const RESOURCE_MAX: Record<GiftResource, number> = {
  techPoints: 2_000_000_000,
  money: 1_000_000_000_000_000,
  satisfaction: 100,
  populationGrowth: 100,
};

const RESOURCE_LABEL: Record<GiftResource, string> = {
  techPoints: "科技點數",
  money: "金錢",
  satisfaction: "滿意度",
  populationGrowth: "人口增長率",
};

/** 暫時 buff 資源（需指定持續回合數，只對玩家國家生效）。 */
const TEMPORARY_RESOURCES: ReadonlySet<GiftResource> = new Set<GiftResource>([
  "satisfaction",
  "populationGrowth",
]);

/** 持續回合數上限，與後端 GIFT_DURATION_MAX 一致。 */
const DURATION_MAX = 1000;

const DIRECTION_LABEL: Record<GiftDirection, string> = {
  all: "全部方向",
  law: "農民",
  culture: "工人",
  religion: "教士",
  rights: "貴族(資本家)",
};

const TARGET_LABEL: Record<GiftTargetType, string> = {
  all: "全體國家（玩家＋NPC）",
  allPlayers: "全體玩家",
  allNpcs: "全體 NPC",
  nation: "指定國家",
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

function nationLabel(n: NationRow): string {
  return n.name || n.leaderName || "（未命名國家）";
}

interface StartingResourcesPayload {
  startingTechPoints: number;
  startingMoney: number;
  foundingProductionCap: number;
  maxTechPoints: number;
  maxMoney: number;
  maxFoundingProductionCap: number;
}

/**
 * Task #504 — 開局資源設定卡片：查看與修改「自創建國」時新國家獲得的
 * 開局科技點數與金錢（預設 200 / 5000）。接手無主國家不受影響。
 */
function StartingResourcesCard() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [limits, setLimits] = useState<{
    tech: number;
    money: number;
    productionCap: number;
  }>({
    tech: 2_000_000_000,
    money: 1_000_000_000_000_000,
    productionCap: 1_000_000_000,
  });
  const [techPoints, setTechPoints] = useState("");
  const [money, setMoney] = useState("");
  const [productionCap, setProductionCap] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const res = await authedFetch("/api/gifts/starting-resources");
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as StartingResourcesPayload;
      setTechPoints(String(data.startingTechPoints));
      setMoney(String(data.startingMoney));
      setProductionCap(String(data.foundingProductionCap));
      setLimits({
        tech: data.maxTechPoints,
        money: data.maxMoney,
        productionCap: data.maxFoundingProductionCap,
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const parsedTech = useMemo(() => {
    if (techPoints === "") return null;
    const n = Number(techPoints);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
  }, [techPoints]);
  const parsedMoney = useMemo(() => {
    if (money === "") return null;
    const n = Number(money);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
  }, [money]);
  const parsedProductionCap = useMemo(() => {
    if (productionCap === "") return null;
    const n = Number(productionCap);
    return Number.isFinite(n) && Number.isInteger(n) ? n : null;
  }, [productionCap]);

  const techValid =
    parsedTech !== null && parsedTech >= 0 && parsedTech <= limits.tech;
  const moneyValid =
    parsedMoney !== null && parsedMoney >= 0 && parsedMoney <= limits.money;
  const productionCapValid =
    parsedProductionCap !== null &&
    parsedProductionCap >= 0 &&
    parsedProductionCap <= limits.productionCap;
  const canSave =
    techValid && moneyValid && productionCapValid && !saving && !loading && !loadError;

  const save = async () => {
    if (!techValid || !moneyValid || !productionCapValid) {
      toast({
        title: "數值不正確",
        description: "所有欄位必須是 0 以上的整數，且不可超過上限。",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      const res = await authedFetch("/api/gifts/starting-resources", {
        method: "PUT",
        body: JSON.stringify({
          startingTechPoints: parsedTech,
          startingMoney: parsedMoney,
          foundingProductionCap: parsedProductionCap,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as {
        startingTechPoints: number;
        startingMoney: number;
        foundingProductionCap: number;
      };
      setTechPoints(String(data.startingTechPoints));
      setMoney(String(data.startingMoney));
      setProductionCap(String(data.foundingProductionCap));
      toast({
        title: "已儲存開局資源設定",
        description: `新建國家將獲得 ${data.startingTechPoints.toLocaleString("zh-TW")} 科技點數與 ${data.startingMoney.toLocaleString("zh-TW")} 金錢；開局生產力上限 ${data.foundingProductionCap.toLocaleString("zh-TW")}。`,
      });
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

  return (
    <Card data-testid="card-starting-resources">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Rocket className="h-4 w-4 text-orange-500" />
          開局資源設定
        </CardTitle>
        <CardDescription>
          玩家「自創建國」時，新國家獲得的開局科技點數與金錢（預設 200 /
          5000）。修改後立即生效，只影響之後建立的新國家；接手無主國家與既有
          國家不受影響。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入開局資源設定…
          </div>
        ) : loadError ? (
          <p className="text-sm text-destructive">{loadError}</p>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="starting-tech">開局科技點數</Label>
              <Input
                id="starting-tech"
                value={techPoints}
                onChange={(e) =>
                  setTechPoints(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                data-testid="input-starting-tech"
              />
              <p className="text-xs text-muted-foreground">
                0 到 {limits.tech.toLocaleString("en-US")} 之間的整數。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="starting-money">開局金錢</Label>
              <Input
                id="starting-money"
                value={money}
                onChange={(e) =>
                  setMoney(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                data-testid="input-starting-money"
              />
              <p className="text-xs text-muted-foreground">
                0 到 {limits.money.toLocaleString("en-US")} 之間的整數。
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="starting-production-cap">開局領土生產力上限</Label>
              <Input
                id="starting-production-cap"
                value={productionCap}
                onChange={(e) =>
                  setProductionCap(e.target.value.replace(/[^\d]/g, ""))
                }
                inputMode="numeric"
                data-testid="input-founding-production-cap"
              />
              <p className="text-xs text-muted-foreground">
                選 2–3 塊起始地區時，各地區生產力（= 生產素質 × 人口 ÷ 1,000,000）加總不可超過此值。
                選 1 塊不受限制。預設 10,000；0 到 {limits.productionCap.toLocaleString("en-US")} 之間的整數。
              </p>
            </div>
            <Button
              onClick={() => void save()}
              disabled={!canSave}
              className="w-full"
              data-testid="button-save-starting-resources"
            >
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              儲存開局資源設定
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function GiftResources() {
  const { toast } = useToast();
  const isAdmin = Boolean(getAdminToken());

  const [nations, setNations] = useState<NationsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [resource, setResource] = useState<GiftResource>("techPoints");
  const [amount, setAmount] = useState("");
  const [durationTurns, setDurationTurns] = useState("");
  const [direction, setDirection] = useState<GiftDirection>("all");
  const [targetType, setTargetType] = useState<GiftTargetType>("all");
  const [nationId, setNationId] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isTemporary = TEMPORARY_RESOURCES.has(resource);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const res = await authedFetch("/api/npc-nations");
      if (!res.ok) throw new Error(await readError(res));
      setNations((await res.json()) as NationsPayload);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    setLoading(true);
    void load();
  }, [isAdmin, load]);

  const players = nations?.players ?? [];
  const npcs = nations?.npcs ?? [];

  const parsedAmount = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    return n;
  }, [amount]);

  const amountValid =
    parsedAmount !== null &&
    parsedAmount >= 1 &&
    parsedAmount <= RESOURCE_MAX[resource];

  const parsedDuration = useMemo(() => {
    const n = Number(durationTurns);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    return n;
  }, [durationTurns]);

  const durationValid =
    !isTemporary ||
    (parsedDuration !== null &&
      parsedDuration >= 1 &&
      parsedDuration <= DURATION_MAX);

  const canSubmit =
    amountValid &&
    durationValid &&
    (targetType !== "nation" || nationId !== "") &&
    !submitting;

  const submit = async () => {
    if (parsedAmount === null || !amountValid) {
      toast({
        title: "數量不正確",
        description: `請輸入 1 到 ${RESOURCE_MAX[resource].toLocaleString("en-US")} 之間的整數。`,
        variant: "destructive",
      });
      return;
    }
    if (targetType === "nation" && !nationId) {
      toast({ title: "請選擇要發放的國家", variant: "destructive" });
      return;
    }
    if (isTemporary && (parsedDuration === null || !durationValid)) {
      toast({
        title: "持續回合數不正確",
        description: `請輸入 1 到 ${DURATION_MAX} 之間的整數。`,
        variant: "destructive",
      });
      return;
    }
    const target =
      targetType === "nation"
        ? { type: "nation" as const, nationId }
        : { type: targetType };

    setSubmitting(true);
    try {
      const res = await authedFetch("/api/gifts", {
        method: "POST",
        body: JSON.stringify({
          resource,
          amount: parsedAmount,
          target,
          note: note.trim() || undefined,
          ...(isTemporary ? { durationTurns: parsedDuration } : {}),
          ...(resource === "satisfaction" ? { direction } : {}),
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as {
        affectedCount: number;
        notifiedCount: number;
        targetLabel: string;
      };
      const suffix = isTemporary
        ? `+${parsedAmount?.toLocaleString("zh-TW")} ${RESOURCE_LABEL[resource]}${
            resource === "satisfaction"
              ? `（${DIRECTION_LABEL[direction]}）`
              : ""
          }，持續 ${parsedDuration} 回合`
        : `${parsedAmount?.toLocaleString("zh-TW")} ${RESOURCE_LABEL[resource]}`;
      toast({
        title: "發放完成",
        description: `已對 ${data.targetLabel} 的 ${data.affectedCount} 個國家發放 ${suffix}，通知了 ${data.notifiedCount} 位玩家。`,
      });
      setAmount("");
      setDurationTurns("");
      setNote("");
    } catch (err) {
      toast({
        title: "發放失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
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
              請先在側邊欄底部輸入管理金鑰，才能發放資源。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6" data-testid="page-gift-resources">
      <div>
        <h1 className="flex items-center gap-2 font-serif text-2xl font-bold">
          <Gift className="h-6 w-6 text-pink-500" />
          發放資源
        </h1>
        <p className="text-sm text-muted-foreground">
          給指定國家、全體玩家、全體 NPC 或全體國家普發資源。科技點數與金錢為一次性
          加值；滿意度與人口增長率為暫時加成（指定持續回合數，用完後自動失效，只對玩家
          國家生效）。若要設定絕對值或扣除，請使用「國家管理」。有主玩家會收到站內通知。
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">發放設定</CardTitle>
          <CardDescription>
            選擇資源與對象，輸入要「增加」的數量。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* 資源類型 */}
          <div className="space-y-1.5">
            <Label>資源類型</Label>
            <Select
              value={resource}
              onValueChange={(v) => setResource(v as GiftResource)}
            >
              <SelectTrigger data-testid="select-resource">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="techPoints">
                  <span className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-sky-500" />
                    科技點數
                  </span>
                </SelectItem>
                <SelectItem value="money">
                  <span className="flex items-center gap-2">
                    <Coins className="h-4 w-4 text-amber-500" />
                    金錢
                  </span>
                </SelectItem>
                <SelectItem value="satisfaction">
                  <span className="flex items-center gap-2">
                    <Smile className="h-4 w-4 text-emerald-500" />
                    滿意度（暫時）
                  </span>
                </SelectItem>
                <SelectItem value="populationGrowth">
                  <span className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-violet-500" />
                    人口增長率（暫時）
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            {isTemporary && (
              <p className="text-xs text-muted-foreground">
                暫時加成：每回合遞減，持續回合數用完後自動失效還原。只對玩家國家生效
                （NPC／無主國家會略過）。
              </p>
            )}
          </div>

          {/* 滿意度方向 */}
          {resource === "satisfaction" && (
            <div className="space-y-1.5">
              <Label>滿意度方向</Label>
              <Select
                value={direction}
                onValueChange={(v) => setDirection(v as GiftDirection)}
              >
                <SelectTrigger data-testid="select-direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    [
                      "all",
                      "law",
                      "culture",
                      "religion",
                      "rights",
                    ] as GiftDirection[]
                  ).map((d) => (
                    <SelectItem key={d} value={d}>
                      {DIRECTION_LABEL[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* 持續回合數（暫時 buff） */}
          {isTemporary && (
            <div className="space-y-1.5">
              <Label htmlFor="gift-duration">持續回合數</Label>
              <Input
                id="gift-duration"
                value={durationTurns}
                onChange={(e) =>
                  setDurationTurns(e.target.value.replace(/[^\d]/g, ""))
                }
                placeholder="例如：5"
                inputMode="numeric"
                data-testid="input-duration"
              />
              <p className="text-xs text-muted-foreground">
                1 到 {DURATION_MAX} 之間的整數。
              </p>
            </div>
          )}

          {/* 數量 */}
          <div className="space-y-1.5">
            <Label htmlFor="gift-amount">
              {isTemporary ? "每回合加成量（增加）" : "數量（增加）"}
            </Label>
            <Input
              id="gift-amount"
              value={amount}
              onChange={(e) =>
                setAmount(e.target.value.replace(/[^\d]/g, ""))
              }
              placeholder={isTemporary ? "例如：10" : "例如：1000"}
              inputMode="numeric"
              data-testid="input-amount"
            />
            <p className="text-xs text-muted-foreground">
              1 到 {RESOURCE_MAX[resource].toLocaleString("en-US")} 之間的整數。
            </p>
          </div>

          {/* 發放對象 */}
          <div className="space-y-1.5">
            <Label>發放對象</Label>
            <Select
              value={targetType}
              onValueChange={(v) => {
                setTargetType(v as GiftTargetType);
                if (v !== "nation") setNationId("");
              }}
            >
              <SelectTrigger data-testid="select-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  ["all", "allPlayers", "allNpcs", "nation"] as GiftTargetType[]
                ).map((t) => (
                  <SelectItem key={t} value={t}>
                    {TARGET_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* 指定國家挑選 */}
          {targetType === "nation" && (
            <div className="space-y-1.5">
              <Label>選擇國家</Label>
              {loading ? (
                <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  載入國家清單…
                </div>
              ) : loadError ? (
                <p className="text-sm text-destructive">{loadError}</p>
              ) : (
                <Select value={nationId} onValueChange={setNationId}>
                  <SelectTrigger data-testid="select-nation">
                    <SelectValue placeholder="選擇一個國家…" />
                  </SelectTrigger>
                  <SelectContent>
                    {players.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>玩家國家</SelectLabel>
                        {players.map((n) => (
                          <SelectItem key={n.id} value={n.id}>
                            {nationLabel(n)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {npcs.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>NPC 國家</SelectLabel>
                        {npcs.map((n) => (
                          <SelectItem key={n.id} value={n.id}>
                            {nationLabel(n)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          {/* 附註 */}
          <div className="space-y-1.5">
            <Label htmlFor="gift-note">附註（選填，會顯示在玩家通知中）</Label>
            <Textarea
              id="gift-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例如：活動獎勵、補償…"
              maxLength={200}
              rows={2}
              data-testid="input-note"
            />
          </div>

          <Button
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="w-full"
            data-testid="button-submit-gift"
          >
            {submitting ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Gift className="mr-1.5 h-4 w-4" />
            )}
            發放{RESOURCE_LABEL[resource]}
          </Button>
        </CardContent>
      </Card>

      <StartingResourcesCard />
    </div>
  );
}
