/**
 * 貿易系統 — 貨物定義(2026-10-08 定案 8 種,設計見筆記 trade-design.md)。
 *
 * 分三層:基礎(人人都要)、工業(靠地區特產)、奢侈(換錢換穩定度)。
 * 木材與礦石沿用 player_nations.wood / ore 欄位,不搬進 nation_goods(避免雙帳);
 * 糧食庫存化後存在 nation_goods。其餘 6 種只存在 nation_goods。
 */

export const GOOD_SLUGS = [
  "food",
  "wood",
  "ore",
  "ironcoal",
  "oil",
  "rare",
  "spice",
  "cloth",
] as const;

export type GoodSlug = (typeof GOOD_SLUGS)[number];

export type GoodTier = "basic" | "industrial" | "luxury";

export interface GoodDef {
  slug: GoodSlug;
  label: string;
  tier: GoodTier;
  /** 世界基準價(金錢/單位),黑市與關稅以此為準。 */
  basePrice: number;
  /**
   * 起始時代(statsEra slug)。早於此時代,地區特產產量為 0:
   * 舊地圖不用重做,後期自然浮現新的爭奪點。null = 一開始就有。
   */
  unlockEra: string | null;
  /**
   * true = 庫存存在 nation_goods;false = 沿用 player_nations 既有欄位
   * (wood / ore),由 goodsLedger 讀寫時橋接。
   */
  storedInGoodsTable: boolean;
}

export const GOODS: Readonly<Record<GoodSlug, GoodDef>> = {
  food: { slug: "food", label: "糧食", tier: "basic", basePrice: 2, unlockEra: null, storedInGoodsTable: true },
  wood: { slug: "wood", label: "木材", tier: "basic", basePrice: 4, unlockEra: null, storedInGoodsTable: false },
  ore: { slug: "ore", label: "礦石", tier: "basic", basePrice: 6, unlockEra: null, storedInGoodsTable: false },
  ironcoal: { slug: "ironcoal", label: "鐵煤", tier: "industrial", basePrice: 8, unlockEra: null, storedInGoodsTable: true },
  oil: { slug: "oil", label: "石油", tier: "industrial", basePrice: 14, unlockEra: "industrial", storedInGoodsTable: true },
  rare: { slug: "rare", label: "橡膠與稀有金屬", tier: "industrial", basePrice: 20, unlockEra: "industrial", storedInGoodsTable: true },
  spice: { slug: "spice", label: "香料茶", tier: "luxury", basePrice: 12, unlockEra: null, storedInGoodsTable: true },
  cloth: { slug: "cloth", label: "布料絲", tier: "luxury", basePrice: 10, unlockEra: null, storedInGoodsTable: true },
};

export function isGoodSlug(v: unknown): v is GoodSlug {
  return typeof v === "string" && (GOOD_SLUGS as readonly string[]).includes(v);
}

/** 存在 nation_goods 表的貨物(木材、礦石除外)。 */
export const TABLE_GOOD_SLUGS: readonly GoodSlug[] = GOOD_SLUGS.filter(
  (g) => GOODS[g].storedInGoodsTable,
);
