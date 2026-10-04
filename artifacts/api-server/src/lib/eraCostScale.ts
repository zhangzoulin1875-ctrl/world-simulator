/**
 * 時代開銷縮放（純函式、DB-free）。
 *
 * 背景：稅收 = 人口 × 稅率 × 稅收效率，稅收效率從古典 1% 漲到未來 100%，加上
 * 人口成長，國家整體稅基從古典到未來膨脹了約 4000 倍；但建築造價、維護費、
 * 兵種價格原本是寫死的絕對數字，造成「古典開銷壓死人、一戰以後開銷等於零」。
 *
 * 做法：所有「金錢／生產力」類開銷在**讀取時**乘上「時代係數」（不改資料庫
 * 既有值，時代推進自動跟漲，可隨時調整）。
 *
 * 係數定義 = 該時代全球總人口 × 稅收效率 ÷ 古典全球總人口 × 古典稅收效率
 *   （即「國家層級稅基」相對古典的倍數；資料來源：map_region_era_stats 全 373
 *    區各時代人口加總、TAX_EFFICIENCY_BY_ERA）。四捨五入到 3 位有效數字。
 * 新增時代或改稅收效率時，請跑 eraCostScale.test.ts 的「與稅基同步」測試。
 */
import { TAX_EFFICIENCY_BY_ERA } from "./economy";

/** 各時代全球總人口（map_region_era_stats 373 區加總；種子資料）。 */
export const ERA_GLOBAL_POPULATION: Readonly<Record<string, number>> = {
  classical: 216_074_250,
  roman: 305_691_950,
  early_medieval: 345_232_650,
  high_medieval: 423_912_360,
  renaissance: 535_011_890,
  discovery: 587_391_920,
  scientific: 669_812_360,
  enlightenment: 907_177_480,
  industrial: 1_254_938_130,
  ww1: 1_758_878_500,
  ww2: 2_273_421_400,
  cold_war: 3_808_599_200,
  modern: 8_055_776_800,
  future: 9_108_293_000,
};

/** 四捨五入到 3 位有效數字（讓數字好讀、好手調）。 */
function round3sf(n: number): number {
  if (n <= 0) return 0;
  const digits = Math.floor(Math.log10(n)) + 1;
  const p = Math.pow(10, 3 - digits);
  return Math.round(n * p) / p;
}

/** 由稅基公式即時算出的係數表（測試用來驗證下方常數表沒有過期）。 */
export function computeEraCostScaleTable(): Record<string, number> {
  const base =
    ERA_GLOBAL_POPULATION["classical"]! * TAX_EFFICIENCY_BY_ERA["classical"]!;
  const out: Record<string, number> = {};
  for (const [era, pop] of Object.entries(ERA_GLOBAL_POPULATION)) {
    const eff = TAX_EFFICIENCY_BY_ERA[era];
    if (eff === undefined) continue;
    out[era] = round3sf((pop * eff) / base);
  }
  return out;
}

/** 時代開銷係數（古典 = 1）。寫成常數以免每次呼叫都重算。 */
export const ERA_COST_SCALE: Readonly<Record<string, number>> = {
  classical: 1,
  roman: 2.83,
  early_medieval: 4.79,
  high_medieval: 7.85,
  renaissance: 14.9,
  discovery: 24.5,
  scientific: 40.3,
  enlightenment: 75.6,
  industrial: 145,
  ww1: 285,
  ww2: 473,
  cold_war: 1060,
  modern: 2980,
  future: 4220,
};

/** 取得時代係數；未知時代回 1（不縮放，等同古典）。 */
export function eraCostScale(eraSlug: string | null | undefined): number {
  if (!eraSlug) return 1;
  return ERA_COST_SCALE[eraSlug] ?? 1;
}

/**
 * 依時代縮放一個金額／數量（四捨五入成整數，下限 min）。
 * scale 為 1 時原值回傳（不改變舊行為）。
 */
export function scaleByEra(
  value: number,
  scale: number,
  min = 0,
): number {
  if (!Number.isFinite(value)) return value;
  if (scale === 1) return value;
  return Math.max(min, Math.round(value * scale));
}

/** 維護費類（允許小數，保留兩位；下限 min）。 */
export function scaleUpkeepByEra(value: number, scale: number, min = 0): number {
  if (!Number.isFinite(value)) return value;
  if (scale === 1) return value;
  return Math.max(min, Math.round(value * scale * 100) / 100);
}
