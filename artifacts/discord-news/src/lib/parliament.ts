import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type ParliamentTier = "autocracy" | "semi" | "democracy";
export type ParliamentAlert = "ok" | "warn" | "critical" | "revolt";

export interface ParliamentParty {
  id: number; name: string; stance: string; stanceLabel: string;
  seats: number; color: string; isRuling: boolean;
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
}
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
