import { Loader2 } from "lucide-react";
import { useAiQueueStatus, formatWaitMs } from "@/hooks/use-ai-queue";

/**
 * 全站浮動的「AI 排隊中」提示（固定右下角）。佇列閒置時完全隱藏；
 * 有 AI 請求在跑或排隊時顯示：排隊件數＋新操作預計等待時間，
 * 讓玩家知道系統沒有卡死，只是 AI 在依序消化請求。
 */
export function AiQueueBadge() {
  const { data } = useAiQueueStatus();

  if (!data) return null;
  const busy = data.active > 0 || data.queued > 0;
  if (!busy) return null;

  const label =
    data.queued > 0
      ? `AI 排隊中：${data.queued} 件，新操作預計要等 ${formatWaitMs(data.estNewWaitMs)}`
      : "AI 處理中…";

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full border border-border bg-background/95 px-4 py-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/85"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      <span className="text-sm text-muted-foreground">{label}</span>
    </div>
  );
}
