import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getListMapCitiesQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/hooks/use-toast";
import { getAdminToken } from "@/lib/admin-token";
import { Loader2, RotateCcw } from "lucide-react";

/**
 * Task #503 — 管理端專用：一鍵把所有城市名稱恢復為種子預設名。
 * 僅由 admin /world-map 頁的 wrapper 傳入（headerExtra），玩家端的
 * /game/map 與未登入唯讀地圖不會渲染此按鈕。後端為 requireAdmin 的
 * raw-fetch 端點，不進 OpenAPI spec。
 */
export function ResetCityNamesButton() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const doReset = async () => {
    setPending(true);
    try {
      const token = getAdminToken();
      const res = await fetch(
        `${import.meta.env.BASE_URL}api/admin/map/cities/reset-names`,
        {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );
      if (!res.ok) {
        let msg = `請求失敗（${res.status}）`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data && typeof data.error === "string" && data.error) msg = data.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const data = (await res.json()) as { restoredCount: number };
      await queryClient.invalidateQueries({ queryKey: getListMapCitiesQueryKey() });
      toast({
        title: "已恢復所有城市預設名稱",
        description: `共恢復 ${data.restoredCount} 座城市的名稱。`,
      });
      setOpen(false);
    } catch (err) {
      toast({
        title: "恢復失敗",
        description: err instanceof Error ? err.message : "請稍後再試",
        variant: "destructive",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-reset-city-names">
          <RotateCcw className="mr-1 h-4 w-4" />
          恢復所有城市預設名稱
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>恢復所有城市預設名稱？</AlertDialogTitle>
          <AlertDialogDescription>
            此操作會清除所有玩家為城市設定的自訂名稱，把全部城市恢復為種子預設名，
            且無法復原。確定要繼續嗎？
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending} data-testid="button-reset-city-names-cancel">
            取消
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(e) => {
              e.preventDefault();
              void doReset();
            }}
            data-testid="button-reset-city-names-confirm"
          >
            {pending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            確認恢復
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
