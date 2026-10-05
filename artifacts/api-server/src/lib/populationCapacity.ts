/**
 * 人口承載量與自然死亡率(logistic 成長,DB-free 純函式)。
 *
 * 背景:原本每回合固定「人口 × 有效增長率」,是純指數成長:1%/回合、一天 8 回合,
 * 一個月約 11 倍。唯一的煞車是飢荒,但糧食有「人均保底 1.3」,農民比例預設 100%,
 * 平民消耗只有 1,所以人口怎麼長都不會飢荒,等於沒有上限。
 *
 * 新規則(logistic):
 *   淨成長 = 人口 × 增長率 × (1 − 人口 / 承載量)
 *   等價於:出生 = 人口 × 增長率;自然死亡 = 出生 × (人口 / 承載量)。
 *   - 人口遠低於承載量:接近原本的增長率(行為幾乎不變)。
 *   - 人口接近承載量:淨成長趨近 0,在上限附近起伏。
 *   - 人口超過承載量:淨成長為負,緩慢回落(不觸發飢荒、不是一次砍 20%)。
 *
 * 承載量(每個地區分開算,因為領土會移動):
 *   K = 該區時代基準人口 × 控制比例 × CAPACITY_MULTIPLIER × 肥沃度修正。
 * 為什麼不直接用糧食土地項(面積 × 肥沃度 × 時代指數):實測古典時代四分之一的地區
 * 土地項不到人口的 0.31 倍(上線會誤殺),另一端卻高達 18~48 倍(等於沒上限)。
 * 基準人口是遊戲設計好的歷史值,比較穩。
 */

/** 承載量 = 時代基準人口的幾倍。3 倍:從基準長到上限約 36 天,玩家有成長空間但不無限。 */
export const CAPACITY_MULTIPLIER = 3;

/** 肥沃度修正範圍:肥沃度 0 → 下限,肥沃度 ≥ 100 → 上限,線性內插。 */
export const FERTILITY_FACTOR_MIN = 0.8;
export const FERTILITY_FACTOR_MAX = 1.2;
/** 肥沃度滿值(map_regions.soil_fertility 範圍 0–120,超過 100 一律視為滿)。 */
export const FERTILITY_FULL = 100;

/** 穩態起伏幅度:在上限附近 ±這個比例內做確定性擾動,避免死板的一條線。 */
export const CAPACITY_WOBBLE_PCT = 10;

/** 承載量的下限,避免小地區/零人口區除以 0 或被瞬間判定超載。 */
export const CAPACITY_MIN = 1000;

/** 肥沃度修正:null/缺值視為中性 1。 */
export function fertilityFactor(fertility: number | null | undefined): number {
  if (fertility == null || !Number.isFinite(fertility)) return 1;
  const t = Math.min(1, Math.max(0, fertility / FERTILITY_FULL));
  return FERTILITY_FACTOR_MIN + (FERTILITY_FACTOR_MAX - FERTILITY_FACTOR_MIN) * t;
}

/**
 * 單一地區承載量。
 * eraPopulation = 該區時代基準人口(整區,不乘控制比例);percent = 控制比例 0–100。
 */
export function regionCapacity(params: {
  eraPopulation: number;
  percent: number;
  fertility: number | null | undefined;
}): number {
  const base = Math.max(0, params.eraPopulation) * (Math.min(100, Math.max(0, params.percent)) / 100);
  const k = base * CAPACITY_MULTIPLIER * fertilityFactor(params.fertility);
  return Math.max(CAPACITY_MIN * (params.percent > 0 ? 1 : 0), k);
}

/**
 * 確定性擾動 ∈ [−CAPACITY_WOBBLE_PCT, +CAPACITY_WOBBLE_PCT] %:由 (seed, turnIndex) 雜湊而來,
 * 不用亂數(測試穩定、同一回合重算結果一致),但不同地區/回合有不同的小幅起伏。
 */
export function wobblePct(seed: number, turnIndex: number): number {
  // 32-bit 整數雜湊(mulberry32 風格),輸出 [0,1)。
  let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(turnIndex | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  const u = h / 0x100000000;
  return (u * 2 - 1) * CAPACITY_WOBBLE_PCT;
}

/**
 * 單一地區本回合淨人口變化(整數,可正可負)。
 *  - ratePct:有效增長率(%/回合),沿用既有政策/科技/全域倍率算出的值。
 *  - 承載量 ≤ 0 或增長率 ≤ 0:退回「人口 × 增長率」的舊行為(不做 logistic),以免吞掉負成長政策。
 *  - 擾動只作用在承載量上(K × (1 ± wobble)),所以人口遠低於 K 時幾乎無影響,
 *    人口貼近 K 時才會形成起伏。
 */
export function regionNetGrowth(params: {
  population: number;
  capacity: number;
  ratePct: number;
  wobble?: number;
}): number {
  const pop = Math.max(0, params.population);
  if (pop <= 0) return 0;
  const rate = params.ratePct / 100;
  if (params.capacity <= 0 || rate <= 0) return Math.round(pop * rate);
  const k = params.capacity * (1 + (params.wobble ?? 0) / 100);
  const net = pop * rate * (1 - pop / k);
  return Math.round(net);
}

export interface RegionGrowthInput {
  regionId: number;
  population: number;
  capacity: number;
}

/** 全國淨成長 = Σ 各區淨成長。seed 用地區 id,讓各區起伏不同步。 */
export function nationNetGrowth(
  regions: readonly RegionGrowthInput[],
  ratePct: number,
  turnIndex: number,
): number {
  let sum = 0;
  for (const r of regions) {
    sum += regionNetGrowth({
      population: r.population,
      capacity: r.capacity,
      ratePct,
      wobble: wobblePct(r.regionId, turnIndex),
    });
  }
  return sum;
}

export interface CapacitySummary {
  /** 全國承載量總和。 */
  capacity: number;
  /** 全國目前實際人口(與 capacity 同口徑的區域加總)。 */
  population: number;
  /** 人口 / 承載量,0–無限;>1 代表超載(緩慢回落中)。 */
  loadRatio: number;
  /** 期望淨成長率(%/回合,無擾動):Σ 各區淨成長 ÷ 總人口 × 100。顯示給玩家用。 */
  netGrowthPct: number;
}

/** 顯示用彙總:不含擾動,所以同一時間刷新多次數字一致。 */
export function summarizeCapacity(
  regions: readonly RegionGrowthInput[],
  ratePct: number,
): CapacitySummary {
  let capacity = 0, population = 0, net = 0;
  for (const r of regions) {
    capacity += r.capacity;
    population += r.population;
    net += regionNetGrowth({ population: r.population, capacity: r.capacity, ratePct, wobble: 0 });
  }
  return {
    capacity: Math.round(capacity),
    population,
    loadRatio: capacity > 0 ? population / capacity : 0,
    netGrowthPct: population > 0 ? (net / population) * 100 : ratePct,
  };
}
