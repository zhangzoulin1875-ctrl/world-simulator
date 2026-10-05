import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface MilitiaView {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  accuracy: number;
  range: "melee" | "ranged";
  label: string;
}

export interface MobilizationStatus {
  active: boolean;
  lastLevy: number;
  startedAt: string | null;
  totalStabilityLost: number;
  atWar: boolean;
  hasMercenaryContract: boolean;
  stability: number;
  /** 若現在開啟會徵召的人數(可徵召人口 × 10%)。 */
  previewLevy: number;
  popRatioPct: number;
  stabilityPerTurn: number;
  minStabilityToStart: number;
  militia: MilitiaView;
}

export const MOBILIZATION_QUERY_KEY = ["mobilization-status"] as const;

async function readError(res: Response): Promise<Error> {
  try {
    const j = await res.json();
    return new Error(typeof j?.error === "string" ? j.error : `操作失敗 (${res.status})`);
  } catch {
    return new Error(`操作失敗 (${res.status})`);
  }
}

export function useMobilizationStatus(enabled = true) {
  return useQuery({
    queryKey: MOBILIZATION_QUERY_KEY,
    queryFn: async (): Promise<MobilizationStatus> => {
      const res = await fetch("/api/player/mobilization", { credentials: "include" });
      if (!res.ok) throw await readError(res);
      return res.json();
    },
    enabled,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });
}

/** 開啟/關閉共用:成功後刷新狀態與軍事總覽(軍隊數量、人口都會變)。 */
export function useMobilizationActions() {
  const qc = useQueryClient();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: MOBILIZATION_QUERY_KEY });
    await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").includes("military") });
  };
  const call = (path: "start" | "stop") => async () => {
    const res = await fetch(`/api/player/mobilization/${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) throw await readError(res);
    return res.json() as Promise<{ levy?: number; disbanded?: number; releasedPopulation?: number }>;
  };
  return {
    start: useMutation({ mutationFn: call("start"), onSuccess: refresh }),
    stop: useMutation({ mutationFn: call("stop"), onSuccess: refresh }),
  };
}
