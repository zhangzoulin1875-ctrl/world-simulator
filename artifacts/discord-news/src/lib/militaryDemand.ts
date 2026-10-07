import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getGetPoliticsOverviewQueryKey } from "@workspace/api-client-react";

export interface MilitaryDemandView {
  pending: { id: number; regionName: string; targetNationName: string | null; createdAt: string; turnsLeft: number | null } | null;
  refusePenalty: number;
  autoWarBelow: number;
  coupBelow: number;
  /** 回應時限(回合數);逾時視同拒絕。 */
  deadlineTurns: number;
  /** 軍方滿意度有效值(與政治頁同一個數字)。 */
  satisfaction: number;
}

export const MILITARY_DEMAND_QUERY_KEY = ["military-demand"] as const;

async function readError(res: Response): Promise<Error> {
  try {
    const j = await res.json();
    return new Error(typeof j?.error === "string" ? j.error : `請求失敗 (${res.status})`);
  } catch {
    return new Error(`請求失敗 (${res.status})`);
  }
}

async function fetchDemand(): Promise<MilitaryDemandView> {
  const res = await fetch("/api/military-demand", { credentials: "include" });
  if (!res.ok) throw await readError(res);
  return res.json();
}

async function postRespond(v: { id: number; accept: boolean }): Promise<{ warStarted?: boolean; newSatisfaction?: number }> {
  const res = await fetch(`/api/military-demand/${v.id}/respond`, {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accept: v.accept }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export function useMilitaryDemand(enabled = true) {
  return useQuery({ queryKey: MILITARY_DEMAND_QUERY_KEY, queryFn: fetchDemand, enabled, staleTime: 15_000, refetchInterval: 60_000 });
}

export function useRespondDemand() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postRespond,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: MILITARY_DEMAND_QUERY_KEY });
      qc.invalidateQueries({ queryKey: getGetPoliticsOverviewQueryKey() });
      qc.invalidateQueries({ queryKey: ["player-nation"] });
    },
  });
}
