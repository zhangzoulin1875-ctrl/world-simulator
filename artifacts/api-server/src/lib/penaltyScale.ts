/**
 * 「事件、憲法送審、國策」這類遊戲內決策的金錢代價縮放(2026-10-06)。
 *
 * 問題:這些系統的金額原本是寫死的古典量級(例如 -1250、送審 1000),中後期國庫動輒數百萬到數千萬,
 *       扣這點錢完全沒感覺。
 *
 * 做法:實際金額 = 基準價 × 時代係數 × 國力倍率。
 *   - 時代係數用 eraCostScale(古典=1)。它的定義就是「國家層級稅基相對古典的倍數」(見 eraCostScale.ts),
 *     與「標準稅率下的每回合稅收」成正比,所以基準價在各時代都約等於「同樣幾回合的稅收」,痛感一致。
 *   - 不用 effectivePriceScale:它含 GLOBAL_COST_DISCOUNT(1/12),是為建築/兵種造價校準的,
 *     套在這裡會讓古典時代反而比原本更便宜。
 *   - 國力倍率沿用 priceFactor(小國有補貼、大國不無限滾雪球),與其他價格一致。
 *   - 錨點是「標準稅率」下的稅基,與玩家自己調的稅率無關(防止調稅率把代價歸零或放大)。
 *
 * 只縮放「金錢」。穩定/支持/滿意度是 0~100 的百分點,不隨時代變。
 * 純函式、DB-free;載入國家人口的部分在 loadPenaltyScale。
 */
import { eraCostScale } from "./eraCostScale";
import { powerRatio, priceFactor } from "./nationCostScale";

/**
 * 整體壓低係數(2026-10-06 第二次調整)。
 * 第一版直接用 時代倍率 × 國力倍率,標準國一個事件平均要 6.5 回合稅收、最大 9.1 回合,
 * 而玩家的稅收還要先付軍隊與建築維護費,實際淨盈餘遠少於稅收,導致「做完兩件事就沒錢」。
 * 乘上 0.154 後,中後期標準國:事件平均約 1 回合稅收、最大約 1.4、國策約 0.7,
 * 一個回合最壞的四件事同時發生約 2.5 回合稅收。
 */
export const PENALTY_SCALE_RATIO = 0.154;

/**
 * 古典標準國 = 倍率 1;計算細節見檔頭。回傳 >= 1 的倍率。
 * 下限 1:縮放只會「讓後期的金額跟上國庫」,不會讓任何時代比原本寫死的基準價更便宜。
 * (古典/羅馬時代基準價本身對當時的稅收就偏高,那是原本的數值,這裡不動它。)
 */
export function penaltyScaleFor(population: number, statsEra: string | null | undefined): number {
  const era = eraCostScale(statsEra);
  const f = priceFactor(powerRatio(population, statsEra));
  const v = era * f * PENALTY_SCALE_RATIO;
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.max(1, Math.round(v * 10000) / 10000);
}

/** 依倍率縮放一個基準金額(保留正負號;四捨五入成整數;非有限值原樣回傳)。 */
export function scaleMoney(baseAmount: number, scale: number): number {
  if (!Number.isFinite(baseAmount) || !Number.isFinite(scale)) return baseAmount;
  if (baseAmount === 0) return 0;
  const v = Math.round(baseAmount * scale);
  // 非零的基準金額縮放後不得變成 0(例如小國古典時代的小額代價),至少保留 1 的量級與方向
  return v === 0 ? Math.sign(baseAmount) : v;
}

/** 縮放事件選項的效果:只動 money,其他欄位原樣。 */
export function scaleEffectsMoney<T extends object>(effects: T & { money?: number }, scale: number): T & { money?: number } {
  if (effects.money === undefined) return effects;
  return { ...effects, money: scaleMoney(effects.money, scale) };
}

/** 縮放國策效果清單裡的金錢類 grant(獎勵與代價都縮,才不會失衡);其他效果原樣。 */
export function scaleFocusMoneyEffects<T extends { kind: string; stat?: string; value?: number }>(effects: readonly T[], scale: number): T[] {
  return effects.map((e) =>
    e.kind === "grant" && e.stat === "money" && typeof e.value === "number"
      ? { ...e, value: scaleMoney(e.value, scale) }
      : e,
  );
}
