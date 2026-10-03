import { formatPopulation } from "@/lib/formatNumber";

export type ViewMode =
  | "normal"
  | "population"
  | "productivity"
  | "production"
  | "techPoints"
  | "fertility"
  | "political"
  | "superEvents";
/**
 * 純 era-stat 數值型圖層（直接用時代陣列索引的視圖）。
 * "production" 需合併政治掌控數據，另行處理；肥沃度為固定屬性，另行處理。
 */
export type MetricMode = Exclude<
  ViewMode,
  "normal" | "fertility" | "political" | "superEvents" | "production"
>;

export const VIEW_MODES: { key: ViewMode; label: string }[] = [
  { key: "normal", label: "一般" },
  { key: "population", label: "人口" },
  { key: "productivity", label: "生產素質" },
  { key: "production", label: "生產力" },
  { key: "techPoints", label: "科技點數" },
  { key: "fertility", label: "肥沃度" },
  { key: "political", label: "政治" },
  { key: "superEvents", label: "超事件" },
];

/** 超事件地圖圖層資料型別（/api/map/super-events，公開唯讀，不在 spec）。 */
export interface MapSuperEvent {
  id: string;
  title: string;
  category: string;
  scope: string;
  severity: number;
  regionIds: number[];
}

/** 國情面板的排序方式。 */
export type NationSort = "default" | "military" | "population" | "money" | "techPoints";
export const NATION_SORTS: { key: NationSort; label: string }[] = [
  { key: "default", label: "建立順序" },
  { key: "military", label: "軍隊人口高→低" },
  { key: "population", label: "人口高→低" },
  { key: "money", label: "金錢高→低" },
  { key: "techPoints", label: "科技高→低" },
];

/** 各數據圖層的深色端（白 → 深色）。 */
export const VIEW_COLORS: Record<MetricMode, string> = {
  population: "#14532d", // 深綠
  productivity: "#c2410c", // 橘
  techPoints: "#1d4ed8", // 藍
};

/** 生產力視圖的深色端（era stat × 掌控% + Σpopulation_bonus）。 */
export const PRODUCTION_VIEW_COLOR = "#7c2d12"; // 深棕紅

export const VIEW_LABELS: Record<MetricMode, string> = {
  population: "人口",
  productivity: "生產素質",
  techPoints: "科技點數",
};

/** 政治視圖的國家調色盤（與管理頁 /region-control 相同，依國家建立順序分配）。 */
export const NATION_COLORS = [
  "#dc2626", // red
  "#2563eb", // blue
  "#16a34a", // green
  "#d97706", // amber
  "#9333ea", // purple
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
  "#7c3aed", // violet
  "#ea580c", // orange
  "#0d9488", // teal
  "#4f46e5", // indigo
  "#b91c1c", // dark red
  "#1d4ed8", // dark blue
  "#15803d", // dark green
  "#a16207", // dark amber
  "#831843", // dark pink
  "#155e75", // dark cyan
  "#6b21a8", // dark purple
  "#3f6212", // dark lime
] as const;

export interface PoliticalNationEntry {
  id: string;
  name: string | null;
  isNpc: boolean;
  isUnowned?: boolean;
  flagUrl?: string | null;
  government?: string | null;
  population?: number;
  armyPopulation?: number;
  money?: number;
  techPoints?: number;
}

export function politicalNationLabel(n: PoliticalNationEntry): string {
  return n.name?.trim() || `（未命名國家 ${n.id.slice(0, 8)}）`;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** 白 → 目標色的線性內插（t ∈ [0,1]）。 */
export function tintFromWhite(target: string, t: number): string {
  const [r, g, b] = hexToRgb(target);
  const mix = (c: number) => Math.round(255 + (c - 255) * t);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

/** 將既有的 rgb(...) 填色淡化（往淺灰混合），供搜尋時弱化非目標地區。 */
export function dimFill(fill: string, t: number): string {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(fill);
  if (!m) return fill;
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  const mix = (c: number) => Math.round(c + (243 - c) * t);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

/**
 * 分位數（rank）色階：人口等數值極度偏斜（數千 vs 數億），
 * 直接線性映射會讓整張圖只有極大值有顏色；以名次映射確保
 * 全色域都有分布。相同數值共用同一名次。
 */
export function makeRankScale(values: number[]): (v: number) => number {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length <= 1) return () => 0.5;
  const rank = new Map(sorted.map((v, i) => [v, i / (sorted.length - 1)]));
  return (v: number) => rank.get(v) ?? 0;
}

export function formatMetric(mode: Exclude<ViewMode, "normal">, v: number): string {
  return mode === "population" ? formatPopulation(v) : v.toLocaleString("zh-TW");
}

export interface RegionEraStatsEntry {
  population: number[];
  productivity: number[];
  techPoints: number[];
}
