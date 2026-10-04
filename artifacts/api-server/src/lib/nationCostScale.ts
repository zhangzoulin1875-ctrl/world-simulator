/**
 * 國家動態開銷尺度（純函式、DB-free）。
 *
 * 背景：eraCostScale 只看時代，等於假設每個國家都是「時代標準國」。實際上單區小國
 * 與多區大國的稅基差了十倍以上，同一個價格對小國是天價、對大國是零用錢。
 *
 * 做法：價格 = 基準價 × 時代係數 × 國力倍率 f(r)。
 *   r = 該國「標準稅率下的每回合稅收能力」÷ 該時代「標準國」同口徑稅收能力。
 *   標準稅率固定（STANDARD_TAX_RATE_PCT），玩家調稅率不影響價格（防操縱、防歸零）。
 *   f(r) 是刻意「不完美平衡」的分段冪次曲線：
 *     r < 1（小國）：f = r^0.7 → 價格降得比國力慢（有補貼，但仍比標準國吃力）。
 *     r > 1（大國）：f = r^0.5 → 價格漲得比收入慢（大國保有規模優勢，但不無限滾雪球）。
 *   夾在 [MIN, MAX] 避免歸零或爆炸。
 *
 * 一次性價格（造價、招募、購買、開局資源）用即時國力；持續性維護費另用
 * upkeepPowerRatio（夾得更窄），避免「人口↑→稅收↑→維護費↑」的回饋迴路，
 * 也避免人口被打爆時維護費崩盤。
 */
import { ERA_GLOBAL_POPULATION } from "./eraCostScale";

/** 計價用的標準稅率（%）。固定值：玩家調稅率不會改變價格。 */
export const STANDARD_TAX_RATE_PCT = 5;

/**
 * 全域開銷折扣（錨點校正）。基準價原以「稅基=100% 效率的理想稅收」設計，但新手預設稅率
 * 僅 1%，標準國實際稅收只有理想值的一小部分：未折扣時糧倉需約 14 回合、區域建築 lv1 約 86
 * 回合，且單座區建維護費 ≈ 稅收 1.7 倍（一蓋就赤字）。乘上 1/6 後標準國約為：糧倉 2.3 回合、
 * 區建 14 回合、維護 ≈ 稅收 0.29。一次性價格與維護費共用同一個折扣，兩者才不會失衡。
 * 調整遊戲節奏只需改這一個常數（各時代比例一致，不必逐時代調）。
 */
export const GLOBAL_COST_DISCOUNT = 1 / 6;

/** 全球區數（map_regions 373 區）。標準國 = 擁有「平均一區」人口的國家。 */
export const GLOBAL_REGION_COUNT = 373;

/** 小國（r<1）指數：<1 → 價格降得比國力慢（補貼）。 */
export const SMALL_NATION_EXPONENT = 0.7;
/** 大國（r>1）指數：<1 → 價格漲得比收入慢（大國優勢）。 */
export const LARGE_NATION_EXPONENT = 0.5;

/** 一次性價格倍率的夾限。 */
export const PRICE_FACTOR_MIN = 0.05;
export const PRICE_FACTOR_MAX = 20;

/** 維護費倍率的夾限（比一次性價格窄：維護費是持續負債，不該隨人口劇烈起伏）。 */
export const UPKEEP_FACTOR_MIN = 0.25;
export const UPKEEP_FACTOR_MAX = 4;

/** 該時代「標準國」人口 = 全球人口 ÷ 區數（平均一區）。未知時代回古典。 */
export function standardNationPopulation(eraSlug: string | null | undefined): number {
  const pop =
    (eraSlug ? ERA_GLOBAL_POPULATION[eraSlug] : undefined) ??
    ERA_GLOBAL_POPULATION["classical"]!;
  return pop / GLOBAL_REGION_COUNT;
}

/**
 * 國力比例 r = 該國人口 ÷ 標準國人口。
 * 稅收 = 人口 × 稅率 × 效率，標準稅率與效率對所有國家相同，故稅收能力比 = 人口比；
 * 直接用人口比可省去效率參數，且不受國家個別稅收加成影響（加成是玩家的獎勵，不該抬高物價）。
 */
export function powerRatio(population: number, eraSlug: string | null | undefined): number {
  const std = standardNationPopulation(eraSlug);
  if (!Number.isFinite(population) || population <= 0 || std <= 0) return 0;
  return population / std;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 一次性價格倍率 f(r)。r≤0 或非法 → 下限。 */
export function priceFactor(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return PRICE_FACTOR_MIN;
  const raw = r < 1 ? Math.pow(r, SMALL_NATION_EXPONENT) : Math.pow(r, LARGE_NATION_EXPONENT);
  return clamp(raw, PRICE_FACTOR_MIN, PRICE_FACTOR_MAX);
}

/** 維護費倍率：同曲線但夾得更窄。 */
export function upkeepFactor(r: number): number {
  if (!Number.isFinite(r) || r <= 0) return UPKEEP_FACTOR_MIN;
  const raw = r < 1 ? Math.pow(r, SMALL_NATION_EXPONENT) : Math.pow(r, LARGE_NATION_EXPONENT);
  return clamp(raw, UPKEEP_FACTOR_MIN, UPKEEP_FACTOR_MAX);
}

/** 四捨五入到 4 位小數，讓倍率在序列化／比對時穩定。 */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * 一次性價格的有效尺度 = 時代係數 × 國力倍率。
 * eraScale 由呼叫端傳入（eraCostScale(statsEra)），本模組不依賴 DB。
 */
export function effectivePriceScale(
  eraScale: number,
  population: number,
  eraSlug: string | null | undefined,
): number {
  return round4(eraScale * GLOBAL_COST_DISCOUNT * priceFactor(powerRatio(population, eraSlug)));
}

/** 維護費的有效尺度 = 時代係數 × 維護費倍率。 */
export function effectiveUpkeepScale(
  eraScale: number,
  population: number,
  eraSlug: string | null | undefined,
): number {
  return round4(eraScale * GLOBAL_COST_DISCOUNT * upkeepFactor(powerRatio(population, eraSlug)));
}
