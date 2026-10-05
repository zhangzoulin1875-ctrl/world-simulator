/**
 * 國內隨機事件的分類(2026-10-06):100 個事件分 10 類,方便管理與平衡。
 * 抽選時先依「分類權重」抽類別,再在類別內依事件權重抽事件,
 * 避免某一類事件寫得多就壓過其他類。
 */
export const EVENT_CATEGORIES = [
  "politics", "economy", "military", "society", "religion",
  "disaster", "health", "diplomacy", "tech", "culture",
] as const;
export type EventCategory = (typeof EVENT_CATEGORIES)[number];

export interface EventCategoryMeta {
  id: EventCategory;
  label: string;
  /** 抽到這一類的相對權重 */
  weight: number;
  /** 這一類在目錄中應有的事件數(驗證用,防止漏寫或寫多) */
  expectedCount: number;
}

export const EVENT_CATEGORY_META: readonly EventCategoryMeta[] = [
  { id: "politics", label: "政局", weight: 12, expectedCount: 10 },
  { id: "economy", label: "經濟", weight: 12, expectedCount: 10 },
  { id: "military", label: "軍事", weight: 10, expectedCount: 10 },
  { id: "society", label: "社會", weight: 11, expectedCount: 10 },
  { id: "religion", label: "宗教", weight: 7, expectedCount: 10 },
  { id: "disaster", label: "天災", weight: 9, expectedCount: 10 },
  { id: "health", label: "公共衛生", weight: 8, expectedCount: 10 },
  { id: "diplomacy", label: "外交", weight: 10, expectedCount: 10 },
  { id: "tech", label: "科技產業", weight: 9, expectedCount: 10 },
  { id: "culture", label: "教育文化", weight: 8, expectedCount: 10 },
];

export function isEventCategory(v: unknown): v is EventCategory {
  return typeof v === "string" && (EVENT_CATEGORIES as readonly string[]).includes(v);
}

export function categoryLabel(c: EventCategory): string {
  return EVENT_CATEGORY_META.find((m) => m.id === c)?.label ?? c;
}
