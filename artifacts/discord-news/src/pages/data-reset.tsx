import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import {
  AlertTriangle,
  Bomb,
  Building2,
  Handshake,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Trash2,
} from "lucide-react";

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

interface ResetAction {
  key: string;
  title: string;
  description: string;
  endpoint: string;
  icon: React.ComponentType<{ className?: string }>;
  confirmWord: string;
  danger: boolean;
}

const ACTIONS: ResetAction[] = [
  {
    key: "nations",
    title: "刪除所有國家",
    description:
      "刪除全部國家（NPC 與玩家），並連帶清除其地區歸屬、軍事、外交、戰爭、內政與經濟資料。地圖與時代基準數據保留。",
    endpoint: "/api/admin/reset/nations",
    icon: Trash2,
    confirmWord: "刪除國家",
    danger: true,
  },
  {
    key: "era-stats",
    title: "各地數據回歸當前時代",
    description:
      "保留所有國家，將各地區人口／生產力／科技數據還原成目前時代的基準值，並清除各國累積的人口／生產偏移與人口增長加成。不更動世界時代與遊戲日期。",
    endpoint: "/api/admin/reset/era-stats",
    icon: RotateCcw,
    confirmWord: "回歸數據",
    danger: false,
  },
  {
    key: "buildings",
    title: "清空地區建築",
    description: "清除所有國家興建的地區建築（city_buildings）。其餘資料不受影響。",
    endpoint: "/api/admin/reset/buildings",
    icon: Building2,
    confirmWord: "清空建築",
    danger: false,
  },
  {
    key: "diplomacy",
    title: "清空全部外交",
    description:
      "保留所有國家，清除全部外交關係、訊息、條約、聯盟，以及進行中的戰爭戰役與相關通知。",
    endpoint: "/api/admin/reset/diplomacy",
    icon: Handshake,
    confirmWord: "清空外交",
    danger: false,
  },
  {
    key: "all",
    title: "一鍵全部重置",
    description:
      "依序執行以上所有重置：刪除所有國家與其附屬資料、清空建築與外交戰爭，並將各地數據還原成目前時代的基準值。此動作無法復原。",
    endpoint: "/api/admin/reset/all",
    icon: Bomb,
    confirmWord: "全部重置",
    danger: true,
  },
];

export default function DataReset() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isAdmin = Boolean(getAdminToken());

  const [active, setActive] = useState<ResetAction | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);

  const openDialog = (action: ResetAction) => {
    setActive(action);
    setConfirmText("");
  };

  const closeDialog = () => {
    if (running) return;
    setActive(null);
    setConfirmText("");
  };

  const run = async () => {
    if (!active) return;
    setRunning(true);
    try {
      const res = await authedFetch(active.endpoint, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data?.error === "string" ? data.error : `HTTP ${res.status}`,
        );
      }
      toast({
        title: "重置完成",
        description:
          typeof data?.message === "string" ? data.message : "已完成資料重置。",
      });
      // 重置牽涉的資料面很廣，直接讓所有查詢失效以確保各頁面重新載入。
      await queryClient.invalidateQueries();
      setActive(null);
      setConfirmText("");
    } catch (err) {
      toast({
        title: "重置失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setRunning(false);
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
              請先在側邊欄底部輸入管理金鑰，才能使用資料重置功能。
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const canRun = active !== null && confirmText.trim() === active.confirmWord;

  return (
    <div
      className="mx-auto max-w-3xl space-y-6 p-6"
      data-testid="page-data-reset"
    >
      <div>
        <h1 className="flex items-center gap-2 font-serif text-2xl font-bold">
          <Trash2 className="h-6 w-6" />
          資料重置
        </h1>
        <p className="text-sm text-muted-foreground">
          管理員專用的破壞性重置工具。每個動作都需要輸入確認字串才能執行，且無法復原，請謹慎使用。
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          以下操作會永久刪除遊戲資料且無法復原。建議在重置前先確認已無需保留的進度。
          刪除所有國家後，NPC 不會自動重生，如需 NPC 請重新以「國家管理」建立。
        </span>
      </div>

      <div className="space-y-3">
        {ACTIONS.map((action) => {
          const Icon = action.icon;
          return (
            <Card
              key={action.key}
              className={action.danger ? "border-destructive/40" : ""}
            >
              <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <div
                    className={`rounded-md p-2 ${
                      action.danger
                        ? "bg-destructive/10 text-destructive"
                        : "bg-secondary text-secondary-foreground"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="font-medium">{action.title}</h3>
                    <p className="text-xs text-muted-foreground">
                      {action.description}
                    </p>
                  </div>
                </div>
                <Button
                  variant={action.danger ? "destructive" : "secondary"}
                  onClick={() => openDialog(action)}
                  className="shrink-0"
                  data-testid={`button-reset-${action.key}`}
                >
                  執行
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog
        open={active !== null}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {active?.title}
            </DialogTitle>
            <DialogDescription>{active?.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="reset-confirm" className="text-sm">
              此操作無法復原。請輸入「
              <span className="font-mono font-semibold text-destructive">
                {active?.confirmWord}
              </span>
              」以確認執行。
            </Label>
            <Input
              id="reset-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={active?.confirmWord}
              autoComplete="off"
              disabled={running}
              data-testid="input-reset-confirm"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeDialog}
              disabled={running}
              data-testid="button-reset-cancel"
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={run}
              disabled={!canRun || running}
              data-testid="button-reset-confirm"
            >
              {running ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-1.5 h-4 w-4" />
              )}
              確認執行
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
