import { useCallback, useEffect, useMemo, useState } from "react";
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
import { Label } from "@/components/ui/label";
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
  Clock,
  Flag,
  Gauge,
  Loader2,
  RefreshCw,
  Save,
  ShieldAlert,
  Swords,
  Users,
  XCircle,
} from "lucide-react";

interface AdminWar {
  id: number;
  nationAId: string;
  nationAName: string;
  nationAIsNpc: boolean;
  nationBId: string;
  nationBName: string;
  nationBIsNpc: boolean;
  declaredByNationId: string;
  declaredByName: string;
  activeCampaignCount: number;
  createdAt: string;
  endedAt: string | null;
}

interface NationOption {
  id: string;
  name: string | null;
  isNpc: boolean;
  isOwned: boolean;
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

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    if (data && typeof data.error === "string" && data.error) return data.error;
  } catch {
    /* ignore */
  }
  return `請求失敗（${res.status}）`;
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

function NationBadge({ name, isNpc }: { name: string; isNpc: boolean }) {
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

/** 可搜尋的國家下拉。 */
function NationCombobox({
  value,
  onChange,
  options,
  placeholder,
  testId,
}: {
  value: string;
  onChange: (id: string) => void;
  options: NationOption[];
  placeholder: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid={testId}
        >
          <span className={selected ? "" : "text-muted-foreground"}>
            {selected ? (selected.name ?? "（未命名）") : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜尋國名…" />
          <CommandList>
            <CommandEmpty>找不到符合的國家</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.id}
                  value={`${o.name ?? "（未命名）"} ${o.id}`}
                  onSelect={() => {
                    onChange(o.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      o.id === value ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex items-center gap-1.5">
                    {o.name ?? "（未命名）"}
                    {o.isNpc && (
                      <Badge
                        variant="outline"
                        className="gap-0.5 px-1 py-0 text-[10px]"
                      >
                        <Bot className="h-2.5 w-2.5" />
                        NPC
                      </Badge>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** 讓 NPC 對真人玩家宣戰的表單卡片。 */
function NpcDeclareCard({
  npcs,
  players,
  onDeclared,
}: {
  npcs: NationOption[];
  players: NationOption[];
  onDeclared: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [attackerId, setAttackerId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [declaring, setDeclaring] = useState(false);

  // 對象必須是真人玩家國家（有主），無主國家不可作為對象。
  const targetOptions = useMemo(
    () => players.filter((p) => p.isOwned),
    [players],
  );

  const declare = async () => {
    if (!attackerId || !targetId) {
      toast({ title: "請選擇發動方 NPC 與對象玩家", variant: "destructive" });
      return;
    }
    setDeclaring(true);
    try {
      const res = await authedFetch("/api/war/admin/wars/npc-declare", {
        method: "POST",
        body: JSON.stringify({
          attackerNationId: attackerId,
          targetNationId: targetId,
        }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as {
        attackerName: string;
        targetName: string;
        autoJoined: { name: string }[];
      };
      const joined =
        data.autoJoined.length > 0
          ? `（${data.autoJoined.map((j) => j.name).join("、")} 自動參戰）`
          : "";
      toast({
        title: "已宣戰",
        description: `「${data.attackerName}」對「${data.targetName}」宣戰${joined}`,
      });
      setAttackerId("");
      setTargetId("");
      await onDeclared();
    } catch (err) {
      toast({
        title: "宣戰失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setDeclaring(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Flag className="h-4 w-4 text-red-500" />
          讓 NPC 對玩家宣戰
        </CardTitle>
        <CardDescription>
          選擇一個 NPC 國家作為發動方，對一位真人玩家國家宣戰。（NPC 不能對 NPC
          或無主國家宣戰。）
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              發動方（NPC）
            </p>
            <NationCombobox
              value={attackerId}
              onChange={setAttackerId}
              options={npcs}
              placeholder="選擇 NPC 國家"
              testId="select-attacker"
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              對象（玩家）
            </p>
            <NationCombobox
              value={targetId}
              onChange={setTargetId}
              options={targetOptions}
              placeholder="選擇玩家國家"
              testId="select-target"
            />
          </div>
        </div>
        <Button
          onClick={() => void declare()}
          disabled={declaring || !attackerId || !targetId}
          data-testid="button-npc-declare"
        >
          {declaring ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <Swords className="mr-1.5 h-4 w-4" />
          )}
          {declaring ? "宣戰中…" : "宣戰"}
        </Button>
      </CardContent>
    </Card>
  );
}

function WarCard({
  war,
  onChanged,
}: {
  war: AdminWar;
  onChanged: () => void | Promise<void>;
}) {
  const { toast } = useToast();
  const [ending, setEnding] = useState(false);
  const isActive = war.endedAt === null;

  const terminate = async () => {
    if (
      !window.confirm(
        `確定要終止「${war.nationAName}」與「${war.nationBName}」之間的戰爭嗎？其下所有進行中的戰役會一併安全結束。`,
      )
    )
      return;
    setEnding(true);
    try {
      const res = await authedFetch(`/api/war/admin/wars/${war.id}/end`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(await readError(res));
      toast({ title: "戰爭已終止" });
      await onChanged();
    } catch (err) {
      toast({
        title: "終止戰爭失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setEnding(false);
    }
  };

  return (
    <Card data-testid={`war-${war.id}`}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <Swords className="h-4 w-4 text-red-500" />
            <NationBadge name={war.nationAName} isNpc={war.nationAIsNpc} />
            <span className="text-muted-foreground">對</span>
            <NationBadge name={war.nationBName} isNpc={war.nationBIsNpc} />
          </CardTitle>
          {isActive ? (
            <Badge className="bg-emerald-600 hover:bg-emerald-600">交戰中</Badge>
          ) : (
            <Badge variant="outline">已結束</Badge>
          )}
        </div>
        <CardDescription className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
          <span>宣戰方：{war.declaredByName}</span>
          <span className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            {formatDateTime(war.createdAt)} 開戰
          </span>
          <span>進行中戰役：{war.activeCampaignCount} 場</span>
          {war.endedAt && <span>結束於 {formatDateTime(war.endedAt)}</span>}
        </CardDescription>
      </CardHeader>
      {isActive && (
        <CardContent className="pt-0">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void terminate()}
            disabled={ending}
            data-testid={`button-terminate-${war.id}`}
          >
            {ending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <XCircle className="mr-1.5 h-4 w-4" />
            )}
            終止戰爭
          </Button>
        </CardContent>
      )}
    </Card>
  );
}

/** 遊戲平衡設定中與厭戰度變化幅度相關的欄位（其餘欄位原封不動回送）。 */
type WarWearinessKnobs = {
  warWearinessGainMultiplierPct: number;
  warWearinessPeacetimeRecovery: number;
  warWearinessWartimeRecovery: number;
};
type FullBalanceSettings = {
  war: WarWearinessKnobs & Record<string, unknown>;
} & Record<string, unknown>;

/** 調整厭戰度（0–100）每回合上升幅度倍率與和平／戰時自動回復的卡片。 */
function WarWearinessSettingsCard() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<FullBalanceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await authedFetch("/api/game-balance/settings");
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { settings: FullBalanceSettings };
      setSettings(data.settings);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "載入設定失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // 只改厭戰度相關欄位；其餘設定保留原值一併回送（PUT 需完整物件）。
  const setWarField = (key: keyof WarWearinessKnobs, raw: string) => {
    setSettings((s) => {
      if (!s) return s;
      const next = structuredClone(s);
      const parsed = Math.round(Number(raw));
      next.war[key] = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      return next;
    });
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await authedFetch("/api/game-balance/settings", {
        method: "PUT",
        body: JSON.stringify({ settings }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { settings: FullBalanceSettings };
      setSettings(data.settings);
      toast({ title: "已儲存", description: "厭戰度變化幅度設定已更新" });
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4 text-amber-500" />
          厭戰度變化幅度
        </CardTitle>
        <CardDescription>
          調整厭戰度（0–100）每回合的變化。「上升幅度倍率」縮放戰役結算造成的厭戰度增加；
          「和平／戰時回復」是每回合自動下降的點數——無進行中戰爭套用和平回復，仍在交戰中套用戰時回復。設定套用於所有國家。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入設定中…
          </div>
        ) : loadError ? (
          <p className="py-4 text-sm text-muted-foreground">{loadError}</p>
        ) : settings ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="ww-gain-mult">上升幅度倍率（%）</Label>
                <Input
                  id="ww-gain-mult"
                  type="number"
                  min={0}
                  max={500}
                  value={String(settings.war.warWearinessGainMultiplierPct)}
                  onChange={(e) =>
                    setWarField("warWearinessGainMultiplierPct", e.target.value)
                  }
                  data-testid="input-ww-gain-mult"
                />
                <p className="text-xs text-muted-foreground">
                  100＝原幅度、0＝不上升、500＝五倍
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ww-peace">和平回復（每回合）</Label>
                <Input
                  id="ww-peace"
                  type="number"
                  min={0}
                  max={30}
                  value={String(settings.war.warWearinessPeacetimeRecovery)}
                  onChange={(e) =>
                    setWarField("warWearinessPeacetimeRecovery", e.target.value)
                  }
                  data-testid="input-ww-peace"
                />
                <p className="text-xs text-muted-foreground">
                  無進行中戰爭時每回合下降的點數
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ww-war">戰時回復（每回合）</Label>
                <Input
                  id="ww-war"
                  type="number"
                  min={0}
                  max={30}
                  value={String(settings.war.warWearinessWartimeRecovery)}
                  onChange={(e) =>
                    setWarField("warWearinessWartimeRecovery", e.target.value)
                  }
                  data-testid="input-ww-war"
                />
                <p className="text-xs text-muted-foreground">
                  仍在交戰中時每回合下降的點數（預設 0）
                </p>
              </div>
            </div>
            <Button
              onClick={() => void save()}
              disabled={saving}
              data-testid="button-save-ww"
            >
              {saving ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-4 w-4" />
              )}
              {saving ? "儲存中…" : "儲存"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default function WarManagement() {
  const isAdmin = Boolean(getAdminToken());
  const { toast } = useToast();
  const [wars, setWars] = useState<AdminWar[] | null>(null);
  const [npcs, setNpcs] = useState<NationOption[]>([]);
  const [players, setPlayers] = useState<NationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [includeEnded, setIncludeEnded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLoadError(null);
      const [warsRes, nationsRes] = await Promise.all([
        authedFetch(
          `/api/war/admin/wars${includeEnded ? "?includeEnded=1" : ""}`,
        ),
        authedFetch("/api/npc-nations"),
      ]);
      if (!warsRes.ok) throw new Error(await readError(warsRes));
      if (!nationsRes.ok) throw new Error(await readError(nationsRes));
      const warsData = (await warsRes.json()) as { wars: AdminWar[] };
      const nationsData = (await nationsRes.json()) as {
        npcs: NationOption[];
        players: NationOption[];
      };
      setWars(warsData.wars ?? []);
      setNpcs(nationsData.npcs ?? []);
      setPlayers(nationsData.players ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "載入失敗");
    } finally {
      setLoading(false);
    }
  }, [includeEnded]);

  useEffect(() => {
    if (!isAdmin) return;
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
              請先在側邊欄底部輸入管理金鑰，才能檢視與管理戰爭。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const activeCount = wars?.filter((w) => w.endedAt === null).length ?? 0;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6" data-testid="page-war-management">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-2xl font-bold">
            <Swords className="h-6 w-6" />
            戰爭管理
          </h1>
          <p className="text-sm text-muted-foreground">
            檢視進行中的戰爭（diplomacy 層級），可終止整場戰爭，或讓 NPC
            對玩家宣戰。終止戰爭時其下所有戰役會一併安全結束。
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
        </div>
      </div>

      <NpcDeclareCard npcs={npcs} players={players} onDeclared={load} />

      <WarWearinessSettingsCard />

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          載入戰爭中…
        </div>
      ) : loadError ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {loadError}
          </CardContent>
        </Card>
      ) : !wars || wars.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <Users className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
            目前沒有{includeEnded ? "任何" : "進行中的"}戰爭。
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            交戰中 {activeCount} 場
            {includeEnded && wars.length - activeCount > 0
              ? `，已結束 ${wars.length - activeCount} 場`
              : ""}
          </p>
          <div className="space-y-4">
            {wars.map((w) => (
              <WarCard key={w.id} war={w} onChanged={load} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
