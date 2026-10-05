/**
 * 決策代價縮放的 DB 載入層。純計算見 penaltyScale.ts。
 * 沿用 loadNationScales 的人口口徑(含累積成長),與造價、招募一致。
 */
import { loadNationScales } from "./nationScale";
import { getEraSlugs } from "./nationStats";
import { penaltyScaleFor } from "./penaltyScale";

/** 測試用覆寫:設定後所有國家都回這個倍率(整合測試的國家沒有地區,人口為 0,會落到下限)。 */
let overrideForTest: number | null = null;
export function setPenaltyScaleForTest(v: number | null): void {
  overrideForTest = v;
}

/** 該國目前的「決策代價倍率」。查不到人口(沒有任何地區)時以人口 0 計,落在國力倍率下限。 */
export async function loadPenaltyScale(nationId: string): Promise<number> {
  if (overrideForTest !== null) return overrideForTest;
  const { statsEra } = await getEraSlugs();
  const s = await loadNationScales(nationId, statsEra);
  return penaltyScaleFor(s.population, statsEra);
}
