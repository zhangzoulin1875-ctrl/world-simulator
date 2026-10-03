import { getAdminToken } from "@/lib/admin-token";

export interface WorldSimChange {
  action: string;
  nationName: string;
  detail: string;
}

export interface ProposeResult {
  proposal: unknown;
  summary: string;
  changes: WorldSimChange[];
  counts: { creates: number; updates: number; deletes: number };
}

export interface AuditEntry {
  id: string;
  source: string;
  instruction: string | null;
  summary: string;
  changes: WorldSimChange[];
  createdAt: string;
}

export interface WorldSimSettings {
  enabled: boolean;
  intensity: number;
  hostileToPlayers: boolean;
  frequencyMinutes: number;
  lastRunAt: string | null;
  nextRunAt: string | null;
  aiJudgmentEnabled: boolean;
  aiJudgmentFrequencyMinutes: number;
  aiJudgmentLastRunAt: string | null;
  aiJudgmentNextRunAt: string | null;
  warCycleHours: number;
  settlementBlackoutStartHour: number;
  settlementBlackoutEndHour: number;
  aiJudgmentDirective: string | null;
  chatActionLevel: number;
  /** Task #570 — NPC 締約可提供資源的上限。 */
  npcTreatyStockCapPct: number;
  npcTreatyMaxRegions: number;
  npcTreatyRegionMaxPct: number;
  npcTreatyPerTurnCapPct: number;
}

export interface GuardEventEntry {
  id: string;
  playerNationId: string | null;
  npcNationId: string | null;
  playerName: string;
  npcName: string;
  actionType: string;
  reason: string;
  createdAt: string;
}

export interface GuardPlayerSummaryEntry {
  playerNationId: string | null;
  playerName: string;
  count: number;
}

export interface AttitudeNation {
  id: string;
  name: string | null;
  government: string | null;
  isNpc: boolean;
  isOwned: boolean;
  diplomaticAttitude: string | null;
  politicalNote: string | null;
}

export const INSTRUCTION_MAX = 2000;
export const DIRECTIVE_MAX = 1000;
export const ATTITUDE_MAX = 300;

export const INTENSITY_LABELS: Record<number, string> = {
  1: "低（每回合變動小、成本低）",
  2: "中（適度變動）",
  3: "高（每回合變動大、成本高）",
};

export const CHAT_ACTION_LEVEL_LABELS: Record<number, string> = {
  1: "保守（僅在關係惡劣或交戰時才動武，行動最少）",
  2: "中等（適度主動）",
  3: "積極（主動宣戰／締約／送禮／交換，行動最多）",
};

export const WS_FREQ_OPTIONS = [60, 360, 720, 1440, 2880, 10080];
/** Task #570 — NPC 締約上限選項。 */
export const NPC_TREATY_PCT_OPTIONS = [0, 5, 10, 20, 30, 50, 75, 100];
export const NPC_TREATY_REGION_COUNT_OPTIONS = [0, 1, 2, 3, 5, 10];
export const AJ_FREQ_OPTIONS = [30, 60, 180, 240, 360, 720, 1440];
export const WAR_CYCLE_OPTIONS = [4, 6, 12, 24, 48, 72, 168];
export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);
export const SETTLEMENT_TZ_LABEL = "Asia/Taipei";

export function formatMinutes(m: number): string {
  if (m % 1440 === 0) return `每 ${m / 1440} 天`;
  if (m % 60 === 0) return `每 ${m / 60} 小時`;
  return `每 ${m} 分鐘`;
}

export function formatHours(h: number): string {
  if (h % 24 === 0) return `${h / 24} 天`;
  return `${h} 小時`;
}

export function formatHourLabel(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

export function mergeOption(options: number[], current: number): number[] {
  return options.includes(current)
    ? options
    : [...options, current].sort((a, b) => a - b);
}

export function formatRunTs(ts: string | null): string {
  if (!ts) return "尚未執行";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-TW", { hour12: false });
}

export async function authedFetch(url: string, init?: RequestInit) {
  const token = getAdminToken();
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

export async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => ({}));
  return typeof (data as { error?: unknown })?.error === "string"
    ? (data as { error: string }).error
    : `HTTP ${res.status}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Taipei",
  }).format(d);
}
