import { useQuery } from "@tanstack/react-query";

export interface AiQueueStatus {
  /** 正在執行中的 AI 請求數（0 或 1）。 */
  active: number;
  /** 排隊等待中的請求數。 */
  queued: number;
  /** 單次呼叫的估計成本（毫秒）。 */
  estPerCallMs: number;
  /** 現在新觸發的操作預計要等多久（毫秒）。 */
  estNewWaitMs: number;
}

/**
 * AI 佇列即時狀態。閒置時每 15 秒輪詢一次；佇列有人排隊時加快到
 * 每 5 秒，讓「預計等待時間」的數字跟得上實際消化速度。
 */
export function useAiQueueStatus() {
  return useQuery<AiQueueStatus>({
    queryKey: ["/api/ai-queue"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/ai-queue", { signal });
      if (!res.ok) throw new Error("無法取得 AI 排隊狀態");
      return (await res.json()) as AiQueueStatus;
    },
    refetchInterval: (query) => {
      const data = query.state.data as AiQueueStatus | undefined;
      return data && data.queued > 0 ? 5_000 : 45_000;
    },
    refetchOnWindowFocus: true,
    staleTime: 3_000,
  });
}

/** 把毫秒格式化成人話：「約 45 秒」「約 2 分 15 秒」。 */
export function formatWaitMs(ms: number): string {
  const seconds = Math.max(5, Math.round(ms / 1000));
  if (seconds < 60) return `約 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (rest === 0) return `約 ${minutes} 分`;
  return `約 ${minutes} 分 ${rest} 秒`;
}
