import type { Dispatch, SetStateAction } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { Check, Loader2, ShieldAlert, TimerOff } from "lucide-react";
import {
  AJ_FREQ_OPTIONS,
  DIRECTIVE_MAX,
  HOUR_OPTIONS,
  SETTLEMENT_TZ_LABEL,
  WAR_CYCLE_OPTIONS,
  formatHourLabel,
  formatHours,
  formatMinutes,
  formatRunTs,
  mergeOption,
  type WorldSimSettings,
} from "./shared";

interface AiJudgmentCardProps {
  settingsLoading: boolean;
  settings: WorldSimSettings | null;
  savingField: keyof WorldSimSettings | null;
  saveSetting: (patch: Partial<WorldSimSettings>) => Promise<void>;
  runningNow: boolean;
  runJudgmentNow: () => Promise<void>;
  clearingCooldowns: boolean;
  clearRegionCooldowns: () => Promise<void>;
  directive: string;
  setDirective: Dispatch<SetStateAction<string>>;
}

export function AiJudgmentCard({
  settingsLoading,
  settings,
  savingField,
  saveSetting,
  runningNow,
  runJudgmentNow,
  clearingCooldowns,
  clearRegionCooldowns,
  directive,
  setDirective,
}: AiJudgmentCardProps) {
  return (
    <Card data-testid="card-ai-judgment">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4" />
          AI 戰役判定
        </CardTitle>
        <CardDescription>
          獨立背景迴圈，驅動 NPC 在既有戰爭中的開戰決策，以及戰役週期推進與結算。（NPC
          主動外交／宣戰已停用，NPC 不會自行發動外交或戰爭。）
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
                <Label htmlFor="aj-enabled" className="text-sm font-medium">
                  啟用判定迴圈
                </Label>
                <p className="text-xs text-muted-foreground">
                  關閉時 NPC 不會在既有戰爭中開戰，戰役也不會自動推進與結算。
                </p>
              </div>
              <div className="flex items-center gap-2">
                {savingField === "aiJudgmentEnabled" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
                <Switch
                  id="aj-enabled"
                  checked={settings.aiJudgmentEnabled}
                  disabled={savingField !== null}
                  onCheckedChange={(v) =>
                    void saveSetting({ aiJudgmentEnabled: v })
                  }
                  data-testid="switch-aj-enabled"
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">立即判定</Label>
              <p className="text-xs text-muted-foreground">
                不必等排程器，立刻手動觸發一次判定：NPC
                開戰決策（對進行中戰爭發起戰役），並結算目前所有進行中的戰役。即使「啟用判定迴圈」關閉也可執行。
              </p>
              <Button
                onClick={() => void runJudgmentNow()}
                disabled={runningNow}
                data-testid="button-run-judgment-now"
              >
                {runningNow ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <ShieldAlert className="mr-1.5 h-4 w-4" />
                )}
                {runningNow ? "判定執行中…" : "立即判定"}
              </Button>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="aj-freq" className="text-sm font-medium">
                  判定頻率
                </Label>
                {savingField === "aiJudgmentFrequencyMinutes" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                判定迴圈的執行間隔（預設每 4 小時）。
              </p>
              <Select
                value={String(settings.aiJudgmentFrequencyMinutes)}
                disabled={savingField !== null}
                onValueChange={(v) =>
                  void saveSetting({
                    aiJudgmentFrequencyMinutes: Number(v),
                  })
                }
              >
                <SelectTrigger
                  id="aj-freq"
                  className="w-full"
                  data-testid="select-aj-freq"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mergeOption(
                    AJ_FREQ_OPTIONS,
                    settings.aiJudgmentFrequencyMinutes,
                  ).map((m) => (
                    <SelectItem key={m} value={String(m)}>
                      {formatMinutes(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                上次執行：{formatRunTs(settings.aiJudgmentLastRunAt)}｜下次到期：
                {formatRunTs(settings.aiJudgmentNextRunAt)}
              </p>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="aj-warcycle" className="text-sm font-medium">
                  戰役週期長度
                </Label>
                {savingField === "warCycleHours" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                戰役每週期長度，影響戰役推進速度。調整後會立即套用到所有進行中的戰役（下次結算時間依新頻率重算），並成為新發起戰役的預設週期。
              </p>
              <Select
                value={String(settings.warCycleHours)}
                disabled={savingField !== null}
                onValueChange={(v) =>
                  void saveSetting({ warCycleHours: Number(v) })
                }
              >
                <SelectTrigger
                  id="aj-warcycle"
                  className="w-full"
                  data-testid="select-warcycle"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mergeOption(
                    WAR_CYCLE_OPTIONS,
                    settings.warCycleHours,
                  ).map((h) => (
                    <SelectItem key={h} value={String(h)}>
                      {formatHours(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label className="text-sm font-medium">解除地區冷卻</Label>
              <p className="text-xs text-muted-foreground">
                戰役結束後，戰場地區會有 30
                分鐘冷卻，期間無法再次於該地區發起戰役。此按鈕一鍵解除目前所有冷卻中的地區冷卻，立即可再開戰。
              </p>
              <Button
                variant="outline"
                onClick={() => void clearRegionCooldowns()}
                disabled={clearingCooldowns}
                data-testid="button-clear-region-cooldowns"
              >
                {clearingCooldowns ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <TimerOff className="mr-1.5 h-4 w-4" />
                )}
                {clearingCooldowns ? "解除中…" : "解除所有地區冷卻"}
              </Button>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label className="text-sm font-medium">結算靜默時段</Label>
                {(savingField === "settlementBlackoutStartHour" ||
                  savingField === "settlementBlackoutEndHour") && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                在此時段內（{SETTLEMENT_TZ_LABEL} 當地時間）不進行戰爭／外交結算；落在時段內的到期時間會延到時段結束才結算。開始與結束設為同一小時＝停用（全天皆可結算）。預設 00:00–08:00。
              </p>
              <div className="flex items-center gap-2">
                <Select
                  value={String(settings.settlementBlackoutStartHour)}
                  disabled={savingField !== null}
                  onValueChange={(v) =>
                    void saveSetting({
                      settlementBlackoutStartHour: Number(v),
                    })
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    data-testid="select-blackout-start"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUR_OPTIONS.map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {formatHourLabel(h)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="shrink-0 text-sm text-muted-foreground">
                  至
                </span>
                <Select
                  value={String(settings.settlementBlackoutEndHour)}
                  disabled={savingField !== null}
                  onValueChange={(v) =>
                    void saveSetting({ settlementBlackoutEndHour: Number(v) })
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    data-testid="select-blackout-end"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUR_OPTIONS.map((h) => (
                      <SelectItem key={h} value={String(h)}>
                        {formatHourLabel(h)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground">
                {settings.settlementBlackoutStartHour ===
                settings.settlementBlackoutEndHour
                  ? "目前：停用（全天皆可結算）。"
                  : `目前：每日 ${formatHourLabel(
                      settings.settlementBlackoutStartHour,
                    )}–${formatHourLabel(
                      settings.settlementBlackoutEndHour,
                    )} 不進行結算。`}
              </p>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="aj-directive" className="text-sm font-medium">
                  干預指令（管理員方針）
                </Label>
                {savingField === "aiJudgmentDirective" && (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                持續生效的自然語言方針，會注入 NPC 外交（條約回應／對話）與戰役結算的 AI
                判定提示。例：「讓德國對玩家更具侵略性」。清空即代表無方針。
              </p>
              <Textarea
                id="aj-directive"
                value={directive}
                onChange={(e) =>
                  setDirective(e.target.value.slice(0, DIRECTIVE_MAX))
                }
                placeholder="輸入給 AI 判定迴圈的持續方針…（留空代表無）"
                rows={3}
                disabled={savingField !== null}
                data-testid="input-directive"
              />
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  {directive.length} / {DIRECTIVE_MAX}
                </span>
                <Button
                  size="sm"
                  onClick={() =>
                    void saveSetting({
                      aiJudgmentDirective:
                        directive.trim() === "" ? null : directive.trim(),
                    })
                  }
                  disabled={
                    savingField !== null ||
                    directive.trim() === (settings.aiJudgmentDirective ?? "")
                  }
                  data-testid="button-save-directive"
                >
                  {savingField === "aiJudgmentDirective" ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-1.5 h-4 w-4" />
                  )}
                  儲存指令
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
