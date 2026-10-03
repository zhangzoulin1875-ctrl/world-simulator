import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useSetBotToken,
  getGetBotStatusQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyRound, CheckCircle2, XCircle, Loader2 } from "lucide-react";

export function TokenSetup({ hasToken }: { hasToken: boolean }) {
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(!hasToken);
  const [feedback, setFeedback] = useState<
    { type: "success"; username?: string } | { type: "error"; message: string } | null
  >(null);
  const queryClient = useQueryClient();

  const mutation = useSetBotToken({
    mutation: {
      onSuccess: (data) => {
        if (data.ok) {
          setFeedback({ type: "success", username: data.username });
          setToken("");
          setTimeout(() => {
            queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
          }, 1500);
        } else {
          setFeedback({ type: "error", message: "Token 驗證失敗" });
        }
      },
      onError: (err: unknown) => {
        const e = err as { response?: { data?: { error?: string } }; message?: string };
        const msg = e?.response?.data?.error ?? e?.message ?? "未知錯誤";
        setFeedback({ type: "error", message: msg });
      },
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
      >
        更換 Bot Token
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-secondary/30 p-3">
      <div className="flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-muted-foreground" />
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {hasToken ? "更換 Bot Token" : "設定 Bot Token"}
        </h4>
      </div>
      <Input
        type="password"
        placeholder="貼上 Discord Bot Token"
        value={token}
        onChange={(e) => {
          setToken(e.target.value);
          setFeedback(null);
        }}
        className="h-8 text-xs font-mono"
        disabled={mutation.isPending}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          className="h-7 text-xs flex-1"
          onClick={() => {
            setFeedback(null);
            mutation.mutate({ data: { token: token.trim() } });
          }}
          disabled={mutation.isPending || token.trim().length < 10}
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="w-3 h-3 animate-spin" /> 測試中…
            </>
          ) : (
            "測試並啟動"
          )}
        </Button>
        {hasToken && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => {
              setOpen(false);
              setFeedback(null);
              setToken("");
            }}
            disabled={mutation.isPending}
          >
            取消
          </Button>
        )}
      </div>
      {feedback?.type === "success" && (
        <div className="flex items-start gap-1.5 text-xs text-green-700 dark:text-green-400">
          <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>已啟動 {feedback.username ? `(${feedback.username})` : ""}，正在連線…</span>
        </div>
      )}
      {feedback?.type === "error" && (
        <div className="flex items-start gap-1.5 text-xs text-destructive">
          <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="break-all">{feedback.message}</span>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Token 僅儲存在你的伺服器資料庫，並會立即用 Discord 驗證後再啟動 Bot。
      </p>
    </div>
  );
}
