import React, { useState } from "react";
import {
  Bot,
  Shield,
  Zap,
  Activity,
  Clock,
  Power,
  Loader2,
  AlertTriangle,
  History,
  Compass,
} from "lucide-react";
import {
  useAutopilot,
  useEnableAutopilot,
  useDisableAutopilot,
  AutopilotStyle,
} from "@/lib/autopilot";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";

const STYLE_OPTIONS: {
  value: AutopilotStyle;
  label: string;
  description: string;
  icon: typeof Shield;
}[] = [
  {
    value: "steady",
    label: "穩健發展",
    description: "優先維持財政健康與國防穩定，不進行激進擴張。",
    icon: Shield,
  },
  {
    value: "balanced",
    label: "均衡發展",
    description: "在發展經濟、國防與科技之間取得動態平衡。",
    icon: Compass,
  },
  {
    value: "expansion",
    label: "擴張導向",
    description: "積極開展建設與軍事整備，迅速提升國家影響力。",
    icon: Zap,
  },
];

export function AutopilotPanel() {
  const { data, isLoading, isError } = useAutopilot();
  const enableMutation = useEnableAutopilot();
  const disableMutation = useDisableAutopilot();
  const { toast } = useToast();

  const [selectedStyle, setSelectedStyle] = useState<AutopilotStyle>("balanced");
  const [directive, setDirective] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        <span>載入託管設定中…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4 text-center text-sm text-destructive">
        無法讀取 AI 託管狀態，請稍後再試。
      </div>
    );
  }

  const isEnabled = data?.enabled === true;

  const handleEnable = async () => {
    try {
      await enableMutation.mutateAsync({
        style: selectedStyle,
        directive: directive.trim(),
      });
      toast({
        title: "AI 全權託管已啟用",
        description: "系統將自動託管所有國家決策與運作。",
      });
      setConfirmOpen(false);
    } catch (err: any) {
      toast({
        title: "啟用託管失敗",
        description: err.message || "發生未知錯誤",
        variant: "destructive",
      });
    }
  };

  const handleDisable = async () => {
    try {
      await disableMutation.mutateAsync();
      toast({
        title: "AI 全權託管已解除",
        description: "你已恢復國家手動操作權限。",
      });
    } catch (err: any) {
      toast({
        title: "解除託管失敗",
        description: err.message || "發生未知錯誤",
        variant: "destructive",
      });
    }
  };

  if (isEnabled) {
    const styleLabel =
      STYLE_OPTIONS.find((s) => s.value === data?.style)?.label || data?.style;
    const formattedDate = data?.enabledAt
      ? new Date(data.enabledAt).toLocaleString("zh-TW")
      : "未知";

    return (
      <div className="space-y-6">
        <div className="rounded-lg border border-primary/30 bg-primary/10 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium text-primary">
              <Bot className="h-5 w-5" />
              <span>AI 全權託管進行中</span>
            </div>
            <Badge variant="default" className="bg-emerald-600 text-white hover:bg-emerald-700">
              託管中
            </Badge>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            所有玩家操作已鎖定，由 AI 根據設定之風格與方針自動執行決策。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="rounded-lg border bg-card p-3 text-card-foreground">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Shield className="h-4 w-4" />
              <span>治理風格</span>
            </div>
            <div className="mt-1 font-semibold">{styleLabel}</div>
          </div>

          <div className="rounded-lg border bg-card p-3 text-card-foreground">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span>啟用時間</span>
            </div>
            <div className="mt-1 text-xs font-semibold">{formattedDate}</div>
          </div>

          <div className="rounded-lg border bg-card p-3 text-card-foreground">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Activity className="h-4 w-4" />
              <span>已處理回合</span>
            </div>
            <div className="mt-1 font-semibold">{data?.turnsRun ?? 0} 回合</div>
          </div>
        </div>

        {data?.directive && (
          <div className="rounded-lg border bg-card p-3">
            <div className="text-xs font-medium text-muted-foreground">施政方針</div>
            <div className="mt-1 text-sm whitespace-pre-wrap">{data.directive}</div>
          </div>
        )}

        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <History className="h-4 w-4 text-muted-foreground" />
            <span>近期 AI 託管記錄</span>
          </div>

          {data?.recentActions && data.recentActions.length > 0 ? (
            <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border bg-muted/30 p-2 text-xs">
              {data.recentActions.map((act, idx) => (
                <div
                  key={idx}
                  className="flex items-start justify-between gap-2 rounded border border-border/50 bg-background/60 p-2"
                >
                  <div className="flex items-start gap-2">
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {act.area}
                    </Badge>
                    <span className="text-muted-foreground">{act.text}</span>
                  </div>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {act.at ? new Date(act.at).toLocaleTimeString("zh-TW") : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              尚無處理記錄
            </div>
          )}
        </div>

        <div className="pt-2">
          <Button
            variant="destructive"
            className="w-full gap-2"
            onClick={handleDisable}
            disabled={disableMutation.isPending}
            data-testid="button-disable-autopilot"
          >
            {disableMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Power className="h-4 w-4" />
            )}
            解除託管
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="flex items-center gap-2 font-serif text-lg font-bold">
          <Bot className="h-5 w-5 text-primary" />
          AI 全權託管設定
        </h3>
        <p className="text-xs text-muted-foreground">
          啟用全權託管後，AI
          將自動處理國家建設、國防與經濟決策。託管期間所有手動操作將會鎖定，直到你手動解除。
        </p>
      </div>

      <div className="space-y-3">
        <label className="text-sm font-medium">1. 選擇治理風格</label>
        <div className="grid grid-cols-1 gap-2.5">
          {STYLE_OPTIONS.map((item) => {
            const Icon = item.icon;
            const selected = selectedStyle === item.value;
            return (
              <div
                key={item.value}
                onClick={() => setSelectedStyle(item.value)}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
                  selected
                    ? "border-primary bg-primary/10 shadow-sm"
                    : "border-border bg-card hover:bg-accent/50"
                }`}
                data-testid={`radio-style-${item.value}`}
              >
                <input
                  type="radio"
                  name="autopilot-style"
                  value={item.value}
                  checked={selected}
                  onChange={() => setSelectedStyle(item.value)}
                  className="mt-1 h-4 w-4 accent-primary"
                />
                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-1.5 font-medium text-sm">
                    <Icon className="h-4 w-4 text-primary" />
                    <span>{item.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {item.description}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">2. 額外施政方針（選填）</label>
          <span className="text-xs text-muted-foreground">
            {directive.length}/500 字
          </span>
        </div>
        <Textarea
          placeholder="例如：優先發展海軍與貿易，盡量避免擴大軍備赤字…"
          maxLength={500}
          value={directive}
          onChange={(e) => setDirective(e.target.value)}
          rows={3}
          className="text-sm"
          data-testid="textarea-directive"
        />
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogTrigger asChild>
          <Button
            className="w-full gap-2"
            disabled={enableMutation.isPending}
            data-testid="button-enable-autopilot"
          >
            <Bot className="h-4 w-4" />
            啟用 AI 託管
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              確認啟用 AI 全權託管？
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2 text-sm text-muted-foreground">
              <p>
                啟用後所有操作會被鎖定，需手動解除。AI 將依據「
                <span className="font-semibold text-foreground">
                  {STYLE_OPTIONS.find((s) => s.value === selectedStyle)?.label}
                </span>
                」風格自動為你做出國家決策。
              </p>
              <p className="text-xs">
                你可以隨時透過頂部橫幅或點擊 AI 託管按鈕手動解除託管。
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-enable">
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleEnable}
              disabled={enableMutation.isPending}
              data-testid="button-confirm-enable"
            >
              {enableMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              確認啟用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
