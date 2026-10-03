import { useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useIsAdmin } from "@/lib/admin-token";
import { AdminTokenSetup } from "./admin-token-setup";
import { TokenSetup } from "./token-setup";
import {
  getGetBotStatusQueryKey,
  useGetBotStatus,
} from "@workspace/api-client-react";

/**
 * Discreet admin entry point. Visitors see only a tiny faded lock icon at the
 * sidebar footer; clicking opens a dialog that hosts the ADMIN_TOKEN setup
 * (and, once admin, the Bot Token panel as well). Clearing the key inside the
 * dialog acts as logout.
 */
export function AdminGate() {
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const { data: status } = useGetBotStatus({
    query: { enabled: isAdmin, queryKey: getGetBotStatusQueryKey() },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={isAdmin ? "管理員模式（點擊以登出或更換金鑰）" : "管理員登入"}
        aria-label={isAdmin ? "管理員模式" : "管理員登入"}
        className={
          isAdmin
            ? "inline-flex items-center justify-center w-8 h-8 rounded-md text-green-600/80 dark:text-green-400/80 hover:bg-secondary/80 hover:text-green-600 dark:hover:text-green-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
            : "inline-flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground/40 hover:bg-secondary/60 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
        }
      >
        {isAdmin ? <ShieldCheck className="w-4 h-4" /> : <Lock className="w-3.5 h-3.5" />}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>管理員入口</DialogTitle>
            <DialogDescription>
              貼上 ADMIN_TOKEN 即可解鎖編輯介面，再從同一面板清除金鑰即可登出。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <AdminTokenSetup />
            {isAdmin && status && <TokenSetup hasToken={status.hasToken ?? false} />}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
