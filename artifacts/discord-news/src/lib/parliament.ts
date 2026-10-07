import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type ParliamentTier = "autocracy" | "semi" | "democracy";
export type ParliamentAlert = "ok" | "warn" | "critical" | "revolt";

export interface ParliamentParty {
  id: number; name: string; stance: string; stanceLabel: string;
  seats: number; color: string; isRuling: boolean;
  /** 是否為執政聯合政府成員(含總理黨)。 */
  inCoalition?: boolean;
  /** AI 寫的一句黨綱(尚未命名或專制時為空字串)。 */
  description?: string;
}
export interface ParliamentDemand {
  text: string; stance: string; stanceLabel: string;
  turnsElapsed: number; turnsTotal: number; levels: string[];
}
export interface ParliamentLogItem {
  id: number; tick: number; kind: string; summary: string; satDelta: number; createdAt: string;
}
export interface ParliamentView {
  ready: boolean; tier: ParliamentTier; tierLabel: string;
  satisfaction: number; alert: ParliamentAlert; totalSeats: number;
  parties: ParliamentParty[];
  protest: string; demand: ParliamentDemand | null; maxPenalty: number;
  report: { allowed: boolean; cooldownLeft: number; cooldownTicks: number; cost: number; lastFeedback: string };
  log: ParliamentLogItem[];
  /** 被議會否決、等待玩家決定的政策(沒有則 null)。 */
  pendingVeto?: PendingVeto | null;
  election?: ElectionView;
  government?: GovernmentView;
  orgs?: OrgView[];
}
export type OrgAttention = "high" | "watched" | "none";
export interface OrgView {
  slug: string; name: string; influence: number;
  level: "weak" | "growing" | "strong";
  capabilities: string[];
  attention: OrgAttention;
  forYou: { action: string; eta: string }[];
  elsewhere: { action: string; eta: string }[];
  recent: { action: string; summary: string }[];
}
export interface OrgDetail extends OrgView {
  ideology: string;
  nextUnlock: { action: string; at: number } | null;
  actions: { action: string; unlockAt: number; unlocked: boolean }[];
  worldRecent: { action: string; ago: string; onYou: boolean }[];
  stats: { plannedTotal: number; executedTotal: number; fizzled: number; targetingYou: number };
  decisionEvery: number;
}
export type CoalitionRisk = "low" | "mid" | "high";
export interface GovernmentView {
  enabled: boolean;
  kind: "coalition" | "single" | "caretaker" | "none";
  primeId: number | null;
  members: { id: number; name: string; seats: number }[];
  seats: number; caretaker: boolean;
  /** 看守政府時:還要失敗幾次就提前大選。 */
  failuresLeft: number;
  stability: number; risk: CoalitionRisk;
}
export type ElectionAction = "canvass" | "bribe" | "suppress";
export type ElectionPhase = "none" | "campaign" | "polling";
export interface ElectionActionRow { id: number; partyId: string; action: ElectionAction; caught: boolean; cost: number }
export interface ElectionView {
  enabled: boolean; phase: ElectionPhase; turnsUntil: number; nextElectionTick: number;
  interval: number; campaignTurns: number; actions: ElectionActionRow[];
  prices: Record<ElectionAction, { label: string; cost: number; caughtChance: number }>;
}
export interface CampaignResponse {
  ok: true; caught: boolean; cost: number; satisfactionAfter: number | null; action: ElectionAction; partyName: string;
}
export interface VetoVote { partyId: string; name: string; stanceLabel?: string; stance: string; seats: number; stand: "for" | "against" | "abstain" }
export interface PendingVeto {
  ideaId: number; idea: string; votes: VetoVote[];
  seatsFor: number; seatsAgainst: number; seatsAbstain: number;
  overridePenalty: number; successTitle: string; failureTitle: string;
}
export type VetoDecision = "override" | "accept";
export interface VetoResponse { ok: true; decision: VetoDecision; title: string; satisfactionAfter?: number }
export interface ReportResponse {
  score: number; delta: number; feedback: string; source: "ai" | "fallback"; view: ParliamentView;
}

export const PARLIAMENT_QUERY_KEY = ["parliament"] as const;

async function readError(res: Response): Promise<Error> {
  const data = await res.json().catch(() => ({}));
  const err = new Error(typeof data?.error === "string" ? data.error : `HTTP ${res.status}`);
  (err as any).status = res.status;
  return err;
}

async function fetchParliament(): Promise<ParliamentView> {
  const res = await fetch("/api/parliament", { credentials: "include" });
  if (!res.ok) throw await readError(res);
  return res.json();
}

async function postReport(text: string): Promise<ReportResponse> {
  const res = await fetch("/api/parliament/report", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

async function postVeto(decision: VetoDecision): Promise<VetoResponse> {
  const res = await fetch("/api/parliament/veto", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

async function postCampaign(input: { partyId: number; action: ElectionAction }): Promise<CampaignResponse> {
  const res = await fetch("/api/parliament/campaign", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export const INTL_ORGS_QUERY_KEY = ["intl-orgs"] as const;
async function fetchIntlOrgs(): Promise<{ orgs: OrgDetail[] }> {
  const res = await fetch("/api/intl-orgs", { credentials: "include" });
  if (!res.ok) throw new Error("讀取國際組織失敗");
  return res.json();
}
export function useIntlOrgs(enabled = true) {
  return useQuery({ queryKey: INTL_ORGS_QUERY_KEY, queryFn: fetchIntlOrgs, enabled, staleTime: 15_000, refetchInterval: 60_000 });
}

export function useParliament(enabled = true) {
  return useQuery({ queryKey: PARLIAMENT_QUERY_KEY, queryFn: fetchParliament, enabled, staleTime: 15_000, refetchInterval: 60_000 });
}

export function useSubmitReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postReport,
    onSuccess: (res) => {
      qc.setQueryData(PARLIAMENT_QUERY_KEY, res.view);
      qc.invalidateQueries({ queryKey: ["player-nation"] });
    },
  });
}

export function useCampaign() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postCampaign,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: PARLIAMENT_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["player-nation"] });
    },
  });
}

export function useDecideVeto() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: postVeto,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: PARLIAMENT_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["player-nation"] });
      qc.invalidateQueries({ queryKey: ["politics"] });
    },
  });
}

// ── 半圓席次圖幾何(純函式,可單元測試) ──────────────────────────────
export interface SeatDot { x: number; y: number; partyIndex: number; angle: number }

/**
 * 把 total 個席次排成半圓:由內而外分成數圈,每圈席數與弧長成正比;
 * 全部席位依「角度」排序後,依序分給各黨 → 每黨佔一個連續的扇形。
 */
export function layoutHemicycle(
  seatsPerParty: readonly number[], opts: { rings?: number; innerR?: number; outerR?: number } = {},
): SeatDot[] {
  const seats = seatsPerParty.map((n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0));
  const total = seats.reduce((a, b) => a + b, 0);
  if (total === 0) return [];
  const rings = Math.max(1, Math.min(opts.rings ?? Math.ceil(Math.sqrt(total / 3)), total));
  const inner = opts.innerR ?? 0.42, outer = opts.outerR ?? 1;
  const radii = Array.from({ length: rings }, (_, i) => (rings === 1 ? outer : inner + ((outer - inner) * i) / (rings - 1)));
  const radiusSum = radii.reduce((a, b) => a + b, 0);
  // 每圈席數 ∝ 半徑;用最大餘數法讓總和恰為 total
  const raw = radii.map((r) => (r / radiusSum) * total);
  const per = raw.map((v) => Math.floor(v));
  let left = total - per.reduce((a, b) => a + b, 0);
  raw.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f || a.i - b.i)
    .forEach(({ i }) => { if (left > 0) { per[i]!++; left--; } });
  const dots: Omit<SeatDot, "partyIndex">[] = [];
  radii.forEach((r, ri) => {
    const n = per[ri]!;
    for (let k = 0; k < n; k++) {
      const angle = n === 1 ? Math.PI / 2 : Math.PI - (Math.PI * k) / (n - 1); // 左(π)→右(0)
      dots.push({ x: r * Math.cos(angle), y: r * Math.sin(angle), angle });
    }
  });
  // 由左到右(角度大→小);同角度內圈先
  dots.sort((a, b) => b.angle - a.angle || Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
  const owner: number[] = [];
  seats.forEach((n, pi) => { for (let i = 0; i < n; i++) owner.push(pi); });
  return dots.map((d, i) => ({ ...d, partyIndex: owner[i]! }));
}
