import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Settings2 } from "lucide-react";
import {
  CHAT_ACTION_LEVEL_LABELS,
  INTENSITY_LABELS,
  NPC_TREATY_PCT_OPTIONS,
  NPC_TREATY_REGION_COUNT_OPTIONS,
  WS_FREQ_OPTIONS,
  formatMinutes,
  formatRunTs,
  mergeOption,
  type WorldSimSettings,
} from "./shared";

interface WorldSimSettingsCardProps {
  settingsLoading: boolean;
  settings: WorldSimSettings | null;
  savingField: keyof WorldSimSettings | null;
  saveSetting: (patch: Partial<WorldSimSettings>) => Promise<void>;
}

export function WorldSimSettingsCard({
  settingsLoading,
  settings,
  savingField,
  saveSetting,
}: WorldSimSettingsCardProps) {
  return (
    <Card data-testid="card-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings2 className="h-4 w-4" />
          自動世界模擬設定
        </CardTitle>
        <CardDescription>
          開啟後，每回合結算末會自動呼叫 AI 依推進後的年份／時代生成或調整 NPC
          並在非玩家之間搬動領土。玩家國家與其領土永不受影響。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {settingsLoading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            載入設定中…
          </div>
        ) : !settings ? (
          <p className="py-2 text-sm text-muted-foreground">
            讀取設定失敗，請重新整理頁面。
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="ws-enabled" className="text-sm font-medium">
                  每回合自動模擬
                </Label>
                <p className="text-xs text-muted-foreground">
                  總開關。關閉時世界只會在你手動生成並套用提案時變動。
                </p>
              </div>
              <div className="flex items-center gap-2">
                {savingField === "enabled" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
                <Switch
                  id="ws-enabled"
                  checked={settings.enabled}
                  disabled={savingField !== null}
                  onCheckedChange={(v) => void saveSetting({ enabled: v })}
                  data-testid="switch-enabled"
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="ws-intensity" className="text-sm font-medium">
                  模擬強度
                </Label>
                {savingField === "intensity" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                控制每回合最多新增的 NPC 數與領土搬動幅度，藉此控制成本與世界變動。
              </p>
              <Select
                value={String(settings.intensity)}
                disabled={savingField !== null}
                onValueChange={(v) =>
                  void saveSetting({ intensity: Number(v) })
                }
              >
                <SelectTrigger
                  id="ws-intensity"
                  className="w-full"
                  data-testid="select-intensity"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3].map((lvl) => (
                    <SelectItem key={lvl} value={String(lvl)}>
                      {INTENSITY_LABELS[lvl]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label
                  htmlFor="ws-chat-action-level"
                  className="text-sm font-medium"
                >
                  NPC 對話行動等級
                </Label>
                {savingField === "chatActionLevel" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                控制 NPC 在與玩家的外交對話中主動採取行動（宣戰／出兵／停戰／締約／送禮／土地資源交換）的積極度與每則訊息的行動數量上限。
              </p>
              <Select
                value={String(settings.chatActionLevel)}
                disabled={savingField !== null}
                onValueChange={(v) =>
                  void saveSetting({ chatActionLevel: Number(v) })
                }
              >
                <SelectTrigger
                  id="ws-chat-action-level"
                  className="w-full"
                  data-testid="select-chat-action-level"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3].map((lvl) => (
                    <SelectItem key={lvl} value={String(lvl)}>
                      {CHAT_ACTION_LEVEL_LABELS[lvl]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="ws-hostile" className="text-sm font-medium">
                  允許 NPC 對玩家敵對
                </Label>
                <p className="text-xs text-muted-foreground">
                  開啟後 NPC 可能對玩家提案宣戰或發動戰爭；關閉時 NPC
                  只在 NPC／無主之間互動。
                </p>
              </div>
              <div className="flex items-center gap-2">
                {savingField === "hostileToPlayers" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
                <Switch
                  id="ws-hostile"
                  checked={settings.hostileToPlayers}
                  disabled={savingField !== null}
                  onCheckedChange={(v) =>
                    void saveSetting({ hostileToPlayers: v })
                  }
                  data-testid="switch-hostile"
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="ws-freq" className="text-sm font-medium">
                  自動演變頻率
                </Label>
                {savingField === "frequencyMinutes" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                NPC 自動演變迴圈的執行間隔（獨立於每日回合）。
              </p>
              <Select
                value={String(settings.frequencyMinutes)}
                disabled={savingField !== null}
                onValueChange={(v) =>
                  void saveSetting({ frequencyMinutes: Number(v) })
                }
              >
                <SelectTrigger
                  id="ws-freq"
                  className="w-full"
                  data-testid="select-ws-freq"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mergeOption(
                    WS_FREQ_OPTIONS,
                    settings.frequencyMinutes,
                  ).map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {formatMinutes(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                上次執行：{formatRunTs(settings.lastRunAt)}｜下次到期：
                {formatRunTs(settings.nextRunAt)}
              </p>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">
                  NPC 締約可提供資源的上限
                </Label>
                <p className="text-xs text-muted-foreground">
                  約束「NPC 付出」的一側：玩家對 NPC
                  的條約要求、NPC 主動提案與對案都不得超過。真人↔真人條約不受影響。
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="ws-npc-treaty-stock"
                      className="text-xs font-medium"
                    >
                      一次性庫存上限（% of 存量）
                    </Label>
                    {savingField === "npcTreatyStockCapPct" && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    金錢／科技點／木材／礦石各 ≤ NPC 現有存量的此百分比。
                  </p>
                  <Select
                    value={String(settings.npcTreatyStockCapPct)}
                    disabled={savingField !== null}
                    onValueChange={(v) =>
                      void saveSetting({ npcTreatyStockCapPct: Number(v) })
                    }
                  >
                    <SelectTrigger
                      id="ws-npc-treaty-stock"
                      className="w-full"
                      data-testid="select-npc-treaty-stock-pct"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {mergeOption(
                        NPC_TREATY_PCT_OPTIONS,
                        settings.npcTreatyStockCapPct,
                      ).map((p) => (
                        <SelectItem key={p} value={String(p)}>
                          {p === 0 ? "0%（完全不可要求）" : `${p}%`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="ws-npc-treaty-regions"
                      className="text-xs font-medium"
                    >
                      單一條約地區數上限
                    </Label>
                    {savingField === "npcTreatyMaxRegions" && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    一筆條約最多可要求 NPC 讓出的地區數。
                  </p>
                  <Select
                    value={String(settings.npcTreatyMaxRegions)}
                    disabled={savingField !== null}
                    onValueChange={(v) =>
                      void saveSetting({ npcTreatyMaxRegions: Number(v) })
                    }
                  >
                    <SelectTrigger
                      id="ws-npc-treaty-regions"
                      className="w-full"
                      data-testid="select-npc-treaty-max-regions"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {mergeOption(
                        NPC_TREATY_REGION_COUNT_OPTIONS,
                        settings.npcTreatyMaxRegions,
                      ).map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n === 0 ? "0 區（完全不可要求）" : `${n} 區`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="ws-npc-treaty-region-pct"
                      className="text-xs font-medium"
                    >
                      每區讓渡比例上限（% of 掌控）
                    </Label>
                    {savingField === "npcTreatyRegionMaxPct" && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    每區可要求讓渡 ≤ NPC 掌控 % × 此百分比。
                  </p>
                  <Select
                    value={String(settings.npcTreatyRegionMaxPct)}
                    disabled={savingField !== null}
                    onValueChange={(v) =>
                      void saveSetting({ npcTreatyRegionMaxPct: Number(v) })
                    }
                  >
                    <SelectTrigger
                      id="ws-npc-treaty-region-pct"
                      className="w-full"
                      data-testid="select-npc-treaty-region-pct"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {mergeOption(
                        NPC_TREATY_PCT_OPTIONS,
                        settings.npcTreatyRegionMaxPct,
                      ).map((p) => (
                        <SelectItem key={p} value={String(p)}>
                          {p === 0 ? "0%（完全不可要求）" : `${p}%`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="ws-npc-treaty-perturn"
                      className="text-xs font-medium"
                    >
                      每回合輸送上限（% of 產出）
                    </Label>
                    {savingField === "npcTreatyPerTurnCapPct" && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    每回合金錢／科技／生產／糧食／木礦各 ≤ NPC
                    對應每回合產出的此百分比。
                  </p>
                  <Select
                    value={String(settings.npcTreatyPerTurnCapPct)}
                    disabled={savingField !== null}
                    onValueChange={(v) =>
                      void saveSetting({ npcTreatyPerTurnCapPct: Number(v) })
                    }
                  >
                    <SelectTrigger
                      id="ws-npc-treaty-perturn"
                      className="w-full"
                      data-testid="select-npc-treaty-perturn-pct"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {mergeOption(
                        NPC_TREATY_PCT_OPTIONS,
                        settings.npcTreatyPerTurnCapPct,
                      ).map((p) => (
                        <SelectItem key={p} value={String(p)}>
                          {p === 0 ? "0%（完全不可要求）" : `${p}%`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
