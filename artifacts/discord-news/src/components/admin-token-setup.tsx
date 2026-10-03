import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ShieldCheck, ShieldAlert, KeyRound } from "lucide-react";
import {
  getAdminToken,
  setAdminToken,
  subscribeAdminToken,
} from "@/lib/admin-token";

function useAdminToken(): string | null {
  return useSyncExternalStore(
    subscribeAdminToken,
    getAdminToken,
    () => null,
  );
}

export function AdminTokenSetup() {
  const current = useAdminToken();
  const hasToken = !!current;
  const [open, setOpen] = useState(!hasToken);
  const [value, setValue] = useState("");

  if (!open) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border bg-secondary/30 px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
          <span>已設定管理金鑰</span>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            setValue("");
          }}
          className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
        >
          更換
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-secondary/30 p-3">
      <div className="flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-muted-foreground" />
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {hasToken ? "更換管理金鑰" : "設定管理金鑰"}
        </h4>
      </div>
      {!hasToken && (
        <div className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
          <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>未填寫前無法觸發 AI 簡報、AI 建議與分析。</span>
        </div>
      )}
      <Input
        type="password"
        placeholder="貼上 ADMIN_TOKEN"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-8 text-xs font-mono"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-7 text-xs flex-1"
          onClick={() => {
            setAdminToken(value);
            setValue("");
            setOpen(false);
          }}
          disabled={value.trim().length === 0}
        >
          儲存
        </Button>
        {hasToken && (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => {
                setOpen(false);
                setValue("");
              }}
            >
              取消
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive"
              onClick={() => {
                setAdminToken(null);
                setValue("");
              }}
            >
              清除
            </Button>
          </>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        金鑰只會保存在這台瀏覽器的 localStorage，並隨每個 AI 觸發請求附上。
      </p>
    </div>
  );
}
