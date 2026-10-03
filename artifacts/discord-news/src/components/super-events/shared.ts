import { getAdminToken } from "@/lib/admin-token";

const BASE = import.meta.env.BASE_URL;
export const API = `${BASE}api`;

export interface AdminSuperEvent {
  id: string;
  title: string;
  summary: string;
  narrative: string;
  category: string;
  scope: string;
  kind: string;
  stage: string;
  canSpread: boolean;
  cause: string;
  status: string;
  severity: number;
  impactPct: number;
  turnsElapsed: number;
  maxTurns: number | null;
  aiContext: string | null;
  targetStats: string[] | null;
  grantedTechs: { name: string }[];
  regionIds: number[];
  nationIds: string[];
  createdAt: string;
  endedAt: string | null;
}

export type NationOption = { id: string; name: string; isNpc: boolean };

const STAGE_LABELS: Record<string, string> = {
  outbreak: "爆發",
  spreading: "擴散",
  peak: "高峰",
  receding: "消退",
  ended: "落幕",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function kindLabel(kind: string): string {
  return kind === "opportunity" ? "機會" : "災難";
}

export function scopeLabel(scope: string): string {
  if (scope === "global") return "全球";
  if (scope === "targeted") return "指定國家";
  return "區域";
}

/** 目標數據選項（key 與後端 SUPER_EVENT_TARGET_STATS 一致，zh-TW 標籤同步）。 */
export const TARGET_STAT_OPTIONS: { key: string; label: string }[] = [
  { key: "population", label: "人口" },
  { key: "production", label: "生產素質" },
  { key: "satisfactionFarmers", label: "農民滿意度" },
  { key: "satisfactionWorkers", label: "工人滿意度" },
  { key: "satisfactionNobles", label: "貴族(資本家)滿意度" },
  { key: "satisfactionClergy", label: "教士滿意度" },
  { key: "stability", label: "安定度" },
  { key: "unrest", label: "動亂度" },
];

const TARGET_STAT_LABELS = new Map(
  TARGET_STAT_OPTIONS.map((o) => [o.key, o.label]),
);

/** 把目標數據 key 陣列轉成「、」串接的 zh-TW 標籤字串（空＝""）。 */
export function targetStatsText(stats: string[] | null | undefined): string {
  if (!stats || stats.length === 0) return "";
  return stats.map((s) => TARGET_STAT_LABELS.get(s) ?? s).join("、");
}

export interface Settings {
  autoGenerateChancePct: number;
  globalImpactPct: number;
  /** 每回合負面影響（損失）下限（0–100，%／點）；只夾限本就存在的損失。 */
  lossMinPct: number;
  /** 每回合負面影響（損失）上限（0–100，%／點）；0＝取消所有負面影響。 */
  lossMaxPct: number;
  aiGenerationPrompt: string;
}

export interface EventResponseRow {
  id: string;
  nationId: string;
  nationName: string | null;
  nationLeader: string | null;
  isNpc: boolean;
  responseText: string;
  status: string;
  resultTitle: string | null;
  resultDescription: string | null;
  createdAt: string;
  judgedAt: string | null;
}

export interface EventTurnLogRow {
  id: number;
  turnNumber: number;
  narrative: string;
  effectSummary: string;
  stage: string;
  spreadRegionIds: number[];
  createdAt: string;
}

export interface EventDetail {
  eventId: string;
  title: string;
  scope: string;
  kind: string;
  stage: string;
  canSpread: boolean;
  targetStats: string[] | null;
  regionIds: number[];
  nations: { nationId: string; nationName: string | null; isNpc: boolean }[];
  responses: EventResponseRow[];
  turnLogs: EventTurnLogRow[];
}

export interface ImpactDelta {
  populationDelta: number;
  productionDelta: number;
  satisfactionFarmersDelta: number;
  satisfactionWorkersDelta: number;
  satisfactionNoblesDelta: number;
  satisfactionClergyDelta: number;
  stabilityDelta: number;
  unrestDelta: number;
}

export interface NationImpact {
  nationId: string;
  nationName: string | null;
  isNpc: boolean;
  cumulative: ImpactDelta;
  turns: (ImpactDelta & { turnNumber: number })[];
}

export interface ImpactResponse {
  eventId: string;
  nations: NationImpact[];
}

export type RegionOption = { id: number; name: string };

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
  try {
    const data = (await res.json()) as { error?: string };
    if (data && typeof data.error === "string" && data.error) return data.error;
  } catch {
    /* ignore */
  }
  return `請求失敗（${res.status}）`;
}

export function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-TW", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function fmtDelta(n: number): string {
  const r = Math.round(n * 10) / 10;
  if (r === 0) return "0";
  return r > 0 ? `+${r}` : `${r}`;
}

export function deltaClass(n: number): string {
  if (n > 0) return "text-emerald-600 dark:text-emerald-300";
  if (n < 0) return "text-red-600 dark:text-red-300";
  return "text-muted-foreground";
}

export const IMPACT_FIELDS: { key: keyof ImpactDelta; label: string }[] = [
  { key: "populationDelta", label: "人口" },
  { key: "productionDelta", label: "生產" },
  { key: "stabilityDelta", label: "安定" },
  { key: "unrestDelta", label: "動亂" },
  { key: "satisfactionFarmersDelta", label: "農民" },
  { key: "satisfactionWorkersDelta", label: "工人" },
  { key: "satisfactionNoblesDelta", label: "貴族" },
  { key: "satisfactionClergyDelta", label: "教士" },
];
