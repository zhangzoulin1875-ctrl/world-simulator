import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getListWarCampaignsQueryKey } from "@workspace/api-client-react";

export interface MercenaryCompanyView {
  id: string;
  name: string;
  blurb: string;
  troops: number;
  attack: number;
  defense: number;
  hp: number;
  rentPerTurn: number;
  deployFeePerTurn: number;
  /** 小國補償倍率(1 = 無補償)。 */
  smallNationBoost: number;
}

export interface MercenaryOverview {
  disarmed: boolean;
  hasActiveCampaign: boolean;
  contract: {
    companyId: string;
    name: string;
    signedAt: string | null;
    rentPerTurn: number;
    deployFeePerTurn: number;
    /** 目前派遣中的所有戰場(可同時多場)。 */
    deployments: { campaignId: number; slot: string; mode: "defend" | "attack" }[];
    /** 本回合預估總費用 = 租金 + 出動費 × 場次。 */
    totalPerTurn: number;
  } | null;
  lastTerminationNote: string | null;
  totals: { rentPaid: number; deployPaid: number };
  companies: MercenaryCompanyView[];
}

export const MERCENARY_QUERY_KEY = ["mercenary-overview"] as const;

async function readError(res: Response): Promise<Error> {
  try {
    const j = await res.json();
    return new Error(typeof j?.error === "string" ? j.error : `操作失敗 (${res.status})`);
  } catch {
    return new Error(`操作失敗 (${res.status})`);
  }
}

async function fetchOverview(): Promise<MercenaryOverview> {
  const res = await fetch("/api/mercenary/overview", { credentials: "include" });
  if (!res.ok) throw await readError(res);
  return res.json();
}

async function post<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/mercenary/${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export function useMercenaryOverview(enabled = true) {
  return useQuery({
    queryKey: MERCENARY_QUERY_KEY,
    queryFn: fetchOverview,
    enabled,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}

export interface DisarmResult {
  disbandedUnits: number;
  refundedProduction: number;
  refundedPopulation: number;
  refundedMoney: number;
}

/** 所有僱傭兵操作共用:成功後刷新概況、軍事總覽與戰役列表。 */
export function useMercenaryActions() {
  const qc = useQueryClient();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: MERCENARY_QUERY_KEY });
    await qc.invalidateQueries({ queryKey: getListWarCampaignsQueryKey() });
    await qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").includes("military") });
  };
  const opts = { onSuccess: refresh };
  return {
    disarm: useMutation({ mutationFn: () => post<DisarmResult>("disarm"), ...opts }),
    restoreArmy: useMutation({ mutationFn: () => post("restore-army"), ...opts }),
    sign: useMutation({ mutationFn: (companyId: string) => post("sign", { companyId }), ...opts }),
    terminate: useMutation({ mutationFn: () => post("terminate"), ...opts }),
    deploy: useMutation({
      mutationFn: (v: { campaignId: number; slot: string; mode: "defend" | "attack" }) => post("deploy", v),
      ...opts,
    }),
    /** campaignId 省略 = 全部召回。 */
    recall: useMutation({
      mutationFn: (campaignId?: number) => post("recall", campaignId === undefined ? undefined : { campaignId }),
      ...opts,
    }),
  };
}
