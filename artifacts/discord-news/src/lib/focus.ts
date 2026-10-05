import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type FocusTrack = "stable" | "black" | "red" | "reform";
export type FocusDomain = "military" | "economy" | "interior" | "diplomacy" | "regime";
export type FocusCardStatus = "available" | "locked" | "active" | "completed";

export interface FocusCard {
  id: string;
  title: string;
  description: string;
  domain: FocusDomain;
  track: FocusTrack;
  slot: "main" | "side";
  cost: number;
  turns: number;
  milestone: boolean;
  status: FocusCardStatus;
  lockedReason: string | null;
  permanentlyLocked: boolean;
  conditions: string[];
  benefits: string[];
  costs: string[];
  transitionTo: string | null;
}

export interface ActiveFocus {
  id: string;
  title: string;
  slot: "main" | "side";
  progress: number;
  totalTurns: number;
  remainingTurns: number | null;
  canCancel: true;
  refundOnCancel: number;
}

export interface FocusView {
  points: number;
  pointsPerTurn: number;
  pointsCap: number;
  parliamentSatisfaction: number;
  speedMultiplier: number;
  stalled: boolean;
  policyLockTurns: number;
  blackLean: number;
  redLean: number;
  active: ActiveFocus[];
  focuses: FocusCard[];
}

export const FOCUS_QUERY_KEY = ["focus"] as const;

async function readError(res: Response): Promise<Error> {
  let msg = `請求失敗(${res.status})`;
  try {
    const j = await res.json();
    if (j && typeof j.error === "string") msg = typeof j.detail === "string" && j.detail ? `${j.error}(${j.detail})` : j.error;
  } catch { /* 非 JSON 回應:沿用預設訊息 */ }
  return new Error(msg);
}

async function fetchFocus(): Promise<FocusView> {
  const res = await fetch("/api/focus", { credentials: "include" });
  if (!res.ok) throw await readError(res);
  return res.json();
}

async function postFocus(path: "start" | "cancel", focusId: string): Promise<{ view: FocusView }> {
  const res = await fetch(`/api/focus/${path}`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ focusId }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export function useFocus(enabled = true) {
  return useQuery({ queryKey: FOCUS_QUERY_KEY, queryFn: fetchFocus, enabled, staleTime: 15_000, refetchInterval: 60_000 });
}

function useFocusMutation(path: "start" | "cancel") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (focusId: string) => postFocus(path, focusId),
    onSuccess: (res) => {
      // 伺服器回傳最新畫面,直接寫入快取,免再打一次 GET
      qc.setQueryData(FOCUS_QUERY_KEY, res.view);
      // 政治點數/支持度等會變,連動刷新國家資料與政治總覽
      qc.invalidateQueries({ queryKey: ["player-nation"] });
    },
  });
}
export const useStartFocus = () => useFocusMutation("start");
export const useCancelFocus = () => useFocusMutation("cancel");

// ── 顯示用的純函式(可單元測試)────────────────────────────────

export const TRACK_LABEL: Record<FocusTrack, string> = {
  stable: "穩定路線",
  reform: "改革路線",
  black: "黑線",
  red: "紅線",
};

/** 軌道顏色:只用在小徽章上,不鋪滿畫面。 */
export const TRACK_STYLE: Record<FocusTrack, string> = {
  stable: "border-emerald-400/40 bg-emerald-500/15 text-emerald-200",
  reform: "border-sky-400/40 bg-sky-500/15 text-sky-200",
  black: "border-zinc-300/40 bg-zinc-500/25 text-zinc-100",
  red: "border-red-400/40 bg-red-500/20 text-red-200",
};

/** 國策按軌道分組,顯示順序固定:穩定 → 改革 → 黑 → 紅。 */
export function groupByTrack(focuses: readonly FocusCard[]): Array<{ track: FocusTrack; items: FocusCard[] }> {
  const order: FocusTrack[] = ["stable", "reform", "black", "red"];
  return order
    .map((track) => ({ track, items: focuses.filter((f) => f.track === track) }))
    .filter((g) => g.items.length > 0);
}

/** 進度百分比(0-100),總回合為 0 時回 0,不會 NaN。 */
export function progressPct(progress: number, totalTurns: number): number {
  if (!(totalTurns > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((progress / totalTurns) * 100)));
}

/** 「還需幾回合」的說明文字;停擺(null)時提示原因。 */
export function remainingText(remaining: number | null): string {
  if (remaining === null) return "進度停擺(議會滿意度過低)";
  if (remaining <= 0) return "即將完成";
  return `約 ${remaining} 回合`;
}

/** 傾向值條的寬度(夾在 0-100)。 */
export function leanPct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}
