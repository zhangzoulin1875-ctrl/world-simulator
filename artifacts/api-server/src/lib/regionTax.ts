/**
 * 地區稅收貢獻分配（Task #420 抽出為純函式）。
 *
 * 各地區的「精確人口」= 基準時代人口 × 掌控比例 + 累積成長量（同
 * computeNationStats 的口徑，但保留小數作為分配權重），再以最大餘數法
 * （重用 war.ts 的 allocateProportionally）把全國稅收分配到各地區，
 * 保證 Σ 地區稅收 = 全國稅收（財政分頁可對帳）。
 *
 * 邊界行為（由 allocateProportionally 保證）：
 *  - 稅收 ≤ 0 → 全 0。
 *  - 權重全 0（例如全部地區 0 人口）→ 平均分配，總和仍守恆。
 *  - 缺時代數據（eraPopulation null）→ 該地區權重只剩累積成長量。
 */
import { allocateProportionally } from "./war";

export type RegionTaxInput = {
  /** 該時代地區基準人口；缺該時代數據時為 null。 */
  eraPopulation: number | string | null;
  /** 掌控比例 1–100。 */
  percent: number;
  /** 累積人口成長量（region_controls.population_bonus）。 */
  accrued: number;
};

/** 各地區精確人口權重（不四捨五入，供分配與顯示共用）。 */
export function exactRegionPopulations(
  regions: readonly RegionTaxInput[],
): number[] {
  return regions.map((r) =>
    Math.max(0, (Number(r.eraPopulation ?? 0) * r.percent) / 100 + r.accrued),
  );
}

/**
 * 把全國稅收依人口比例分配到各地區（最大餘數法）。
 * 回傳陣列順序對應輸入順序；總和恰等於 max(0, taxIncome)（taxIncome ≤ 0 → 全 0）。
 */
export function allocateRegionTax(
  regions: readonly RegionTaxInput[],
  taxIncome: number,
): number[] {
  return allocateProportionally(exactRegionPopulations(regions), taxIncome);
}

/**
 * Task #430 — 把「全國人口」（computeNationStats 的口徑）依各地區精確人口
 * 權重分配為各地區顯示人口（最大餘數法），保證 Σ 地區顯示人口 = 全國人口，
 * 讓地區列表與財政總覽完全可對帳。
 *
 * 邊界行為（由 allocateProportionally 保證）：
 *  - 全國人口 ≤ 0 → 全 0。
 *  - 權重全 0（例如缺時代數據且累積成長量 ≤ 0）→ 平均分配，總和仍守恆。
 */
export function allocateRegionPopulations(
  regions: readonly RegionTaxInput[],
  nationPopulation: number,
): number[] {
  return allocateProportionally(
    exactRegionPopulations(regions),
    nationPopulation,
  );
}
