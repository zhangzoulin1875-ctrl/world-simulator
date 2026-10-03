/**
 * Task #9 — 14 個模擬時代的定義。
 *
 * 生產素質各時代「全世界平均值」由使用者指定：
 * 5/10/15/20/30/100/200/300(啟蒙運動)/500/1000/1500/3000/5000/10000。
 * 科技點數與生產素質同方向但浮動幅度較小；錨點（使用者指定）：
 * 古典 10、中世紀 ~20、科學革命 ~50、現代 500，其餘平滑內插/外推。
 */

export interface EraDef {
  /** 穩定識別字（存 DB、API 傳輸用）。 */
  slug: string;
  /** zh-TW 顯示名稱。 */
  label: string;
  /** 生產素質全世界平均值。 */
  prodAvg: number;
  /** 科技點數全世界平均值。 */
  techAvg: number;
}

export const ERAS: readonly EraDef[] = [
  { slug: "classical", label: "古典時代(秦朝)", prodAvg: 5, techAvg: 10 },
  { slug: "roman", label: "羅馬帝國時期(漢朝)", prodAvg: 10, techAvg: 12 },
  { slug: "early_medieval", label: "中世紀早期(唐朝)", prodAvg: 15, techAvg: 15 },
  { slug: "high_medieval", label: "中世紀中期(宋朝)", prodAvg: 20, techAvg: 20 },
  { slug: "renaissance", label: "文藝復興時期(明朝)", prodAvg: 30, techAvg: 25 },
  { slug: "discovery", label: "大航海時代(清朝)", prodAvg: 100, techAvg: 35 },
  { slug: "scientific", label: "科學革命", prodAvg: 200, techAvg: 50 },
  { slug: "enlightenment", label: "啟蒙運動", prodAvg: 300, techAvg: 65 },
  { slug: "industrial", label: "工業革命", prodAvg: 500, techAvg: 90 },
  { slug: "ww1", label: "一戰時期", prodAvg: 1000, techAvg: 130 },
  { slug: "ww2", label: "二戰時期", prodAvg: 1500, techAvg: 180 },
  { slug: "cold_war", label: "冷戰時期", prodAvg: 3000, techAvg: 280 },
  { slug: "modern", label: "現代時期", prodAvg: 5000, techAvg: 500 },
  { slug: "future", label: "未來科技", prodAvg: 10000, techAvg: 900 },
];

export const ERA_COUNT = ERAS.length; // 14

/** 遊戲起始（世界初始）時代。 */
export const DEFAULT_ERA_SLUG = "classical";

const ERA_INDEX = new Map(ERAS.map((e, i) => [e.slug, i]));

export function getEraIndex(slug: string): number {
  const i = ERA_INDEX.get(slug);
  if (i === undefined) throw new Error(`unknown era slug: ${slug}`);
  return i;
}

export function isEraSlug(slug: string): boolean {
  return ERA_INDEX.has(slug);
}
