/**
 * 人口負載狀態(人口 ÷ 土地承載量)。純函式,首頁人口格與來源明細彈窗共用,
 * 兩處的顏色與文字永遠一致。
 *  - 超過 1.05:超載,人口緩慢回落(紅)
 *  - 0.9 ~ 1.05:接近上限,在上限附近起伏(黃)
 *  - 低於 0.9:仍有成長空間(綠)
 */
export type PopulationLoadTone = "grow" | "near" | "over";

export const POPULATION_LOAD_OVER = 1.05;
export const POPULATION_LOAD_NEAR = 0.9;

export function populationLoadState(loadRatio: number): {
  label: string;
  tone: PopulationLoadTone;
} {
  if (loadRatio > POPULATION_LOAD_OVER) return { label: "超載・緩慢回落中", tone: "over" };
  if (loadRatio >= POPULATION_LOAD_NEAR) return { label: "接近上限・在上限附近起伏", tone: "near" };
  return { label: "仍有成長空間", tone: "grow" };
}

/** 文字顏色(Tailwind class)。首頁百分比用。 */
export function populationLoadTextClass(loadRatio: number): string {
  const tone = populationLoadState(loadRatio).tone;
  return tone === "over" ? "text-red-400" : tone === "near" ? "text-yellow-300" : "text-green-400";
}
