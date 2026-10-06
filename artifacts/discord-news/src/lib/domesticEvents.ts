import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface DomesticEventChoice {
  id: string;
  label: string;
  hint: string;
}

export interface PendingDomesticEvent {
  id: string;
  kind: string;
  title: string;
  body: string;
  choices: DomesticEventChoice[];
  /** 剩幾個回合沒處理就會自動採取「拖延」 */
  turnsLeft: number;
}

export interface DomesticEventHistoryItem {
  id: string;
  kind: string;
  title: string;
  status: "resolved" | "expired";
  chosenId: string | null;
  outcome: string | null;
  resolvedAt: string | null;
}

export interface DomesticEventsView {
  pending: PendingDomesticEvent | null;
  history: DomesticEventHistoryItem[];
}

export const DOMESTIC_EVENTS_KEY = ["domestic-events"] as const;

async function readError(res: Response): Promise<Error> {
  let msg = `請求失敗(${res.status})`;
  try {
    const j = await res.json();
    if (j && typeof j.error === "string") msg = j.error;
  } catch { /* 非 JSON 回應:用預設訊息 */ }
  return new Error(msg);
}

async function fetchEvents(): Promise<DomesticEventsView> {
  const res = await fetch("/api/domestic-events", { credentials: "include" });
  if (!res.ok) throw await readError(res);
  return res.json();
}

/** 沒登入或還沒有國家時會回 401/400:當成「沒有事件」,不要一直重試或跳錯誤 */
export function useDomesticEvents(enabled = true) {
  return useQuery({
    queryKey: DOMESTIC_EVENTS_KEY,
    queryFn: fetchEvents,
    enabled,
    retry: false,
    staleTime: 20_000,
    refetchInterval: 60_000,
  });
}

export function useResolveDomesticEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; choiceId: string }): Promise<{ ok: true; outcome: string; civilWar: boolean }> => {
      const res = await fetch(`/api/domestic-events/${vars.id}/resolve`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ choiceId: vars.choiceId }),
      });
      if (!res.ok) throw await readError(res);
      return res.json();
    },
    onSuccess: () => {
      // 事件會改國家數值、議會席次與滿意度、可能開內戰:相關畫面都要重抓
      for (const key of [DOMESTIC_EVENTS_KEY, ["player-nation"], ["parliament"], ["focus"]]) {
        qc.invalidateQueries({ queryKey: key as unknown as readonly unknown[] });
      }
    },
  });
}

export const CHOICE_STYLE: Record<string, string> = {
  comply: "border-emerald-400/40 bg-emerald-500/10 hover:bg-emerald-500/20",
  crackdown: "border-red-400/50 bg-red-500/10 hover:bg-red-500/20",
  delay: "border-white/20 bg-white/5 hover:bg-white/10",
};


/**
 * 強制事件彈窗是否該顯示。
 * - 不在遊戲頁 / 教學進行中:不顯示;
 * - AI 託管中:不顯示(操作已鎖定,且彈窗會蓋住「解除託管」造成死結;事件到期自動「拖延」);
 * - 其餘:有待處理事件或結果要看才顯示。
 */
export function shouldShowEventDialog(i: {
  inGame: boolean;
  tutorialActive: boolean;
  autopilotLocked: boolean;
  hasPending: boolean;
  hasResult: boolean;
}): boolean {
  if (!i.inGame || i.tutorialActive || i.autopilotLocked) return false;
  return i.hasPending || i.hasResult;
}
