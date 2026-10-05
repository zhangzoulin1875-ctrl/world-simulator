import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type ConstitutionStatus = "none" | "draft" | "reviewing" | "ratified";
export type ReviewOutcome = "ratified" | "rejected_quality" | "rejected_vote";
export type VoteChoice = "yes" | "no" | "abstain";

export interface PartyVote {
  partyName: string; stanceLabel: string; seats: number; vote: VoteChoice; reason: string;
}
export interface ReviewRecord {
  outcome: ReviewOutcome; qualityScore: number; feedback: string; flaws: string[];
  votes: PartyVote[]; yesSeats: number; totalSeats: number; source: string; reviewedTick: number;
}
export interface ConstitutionView {
  status: ConstitutionStatus;
  /** 專制政體的議會是橡皮圖章,不需要憲法 */
  required: boolean;
  draftText: string;
  finalText: string | null;
  ratifiedAt: string | null;
  submissions: number;
  lastReview: ReviewRecord | null;
  limits: { maxLen: number; minSubmitLen: number };
  submit: { cost: number; cooldownTicks: number; cooldownLeft: number };
  penalty: { perTick: number; floor: number } | null;
}

export const CONSTITUTION_QUERY_KEY = ["constitution"] as const;
/** 審議中每幾毫秒輪詢一次結果。 */
export const REVIEW_POLL_MS = 3_000;

async function readError(res: Response): Promise<Error> {
  const data = await res.json().catch(() => ({}));
  const err = new Error(typeof data?.error === "string" ? data.error : `HTTP ${res.status}`);
  (err as Error & { status?: number }).status = res.status;
  return err;
}

async function fetchConstitution(): Promise<ConstitutionView> {
  const res = await fetch("/api/constitution", { credentials: "include" });
  if (!res.ok) throw await readError(res);
  return res.json();
}

/** 審議中才輪詢;其他狀態只在被 invalidate 或很久之後才重抓。純函式,可單元測試。 */
export function pollIntervalFor(status: ConstitutionStatus | undefined): number | false {
  return status === "reviewing" ? REVIEW_POLL_MS : false;
}

export function useConstitution(enabled = true) {
  return useQuery({
    queryKey: CONSTITUTION_QUERY_KEY, queryFn: fetchConstitution, enabled, staleTime: 15_000,
    refetchInterval: (q) => pollIntervalFor(q.state.data?.status),
  });
}

export function useSaveDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (text: string) => {
      const res = await fetch("/api/constitution/draft", {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
      });
      if (!res.ok) throw await readError(res);
      return res.json() as Promise<{ ok: true; status: ConstitutionStatus; length: number }>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: CONSTITUTION_QUERY_KEY }),
  });
}

export function useSubmitConstitution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/constitution/submit", { method: "POST", credentials: "include" });
      if (!res.ok) throw await readError(res);
      return res.json() as Promise<{ ok: true; status: "reviewing" }>;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CONSTITUTION_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["player-nation"] }); // 扣了 1000 金錢
    },
  });
}

// ── 純函式（可單元測試）────────────────────────────────────────────────
export const VOTE_LABEL: Record<VoteChoice, string> = { yes: "贊成", no: "反對", abstain: "棄權" };

/** 通過門檻:贊成席次必須嚴格大於總席次一半(與後端 tallyVotes 一致)。 */
export function seatsNeeded(totalSeats: number): number {
  return Math.floor(totalSeats / 2) + 1;
}

/** 投票統計(給進度條用)。 */
export function tallyForDisplay(votes: readonly PartyVote[]): { yes: number; no: number; abstain: number } {
  const t = { yes: 0, no: 0, abstain: 0 };
  for (const v of votes) t[v.vote] += v.seats;
  return t;
}

/** 草稿字數檢查:給按鈕狀態與提示用,真正的驗證仍以後端為準。 */
export function draftHint(len: number, limits: { maxLen: number; minSubmitLen: number }): string {
  if (len === 0) return `至少 ${limits.minSubmitLen} 字才能送審`;
  if (len < limits.minSubmitLen) return `還差 ${limits.minSubmitLen - len} 字才能送審`;
  if (len > limits.maxLen) return `超過上限 ${len - limits.maxLen} 字`;
  return "字數足夠，可以送審";
}

export function canSubmitNow(v: ConstitutionView, len: number, dirty: boolean): boolean {
  if (v.status !== "draft") return false;
  if (dirty) return false; // 有未儲存的修改:送審的是已儲存版本，先儲存才不會送錯稿
  if (v.submit.cooldownLeft > 0) return false;
  return len >= v.limits.minSubmitLen && len <= v.limits.maxLen;
}
