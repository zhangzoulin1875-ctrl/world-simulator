/**
 * 貿易系統 — 地區特產每回合產出(純函式、DB-free,2026-10-08 定案)。
 *
 * 公式:產量 = 強度(主產 3 / 次產 1) × 控制比例 × 基準量,向下取整。
 * - 實物貨物比照建築木材礦石(50 × level):**不隨時代縮放**。eraCostScale 是
 *   金錢開銷的稅基縮放(古典 1 → 未來數千倍),套在實物上後期會爆量。
 * - 後期差異靠「時代解鎖」(石油、稀有金屬工業前產量 0),不靠係數。
 * - 糧食不在特產內(全圖依肥沃度產),不在此處理。
 * - 基準量預設 10:全控一個主產區 30/回合、次產區 10/回合,約一級建築的 60% 與 20%。
 */
import { GOODS, GOOD_SLUGS, type GoodSlug } from "./goods";
import { isGoodUnlocked } from "./stock";
import { specialtyOf } from "./regionSpecialties";

export const SPECIALTY_BASE_OUTPUT = 10;

/** 特產貨物(不含糧食;木材/礦石特產併入既有 player_nations 欄位,見 splitProduction)。 */
export type SpecialtyGood = Exclude<GoodSlug, "food">;

export type GoodsAmounts = Partial<Record<SpecialtyGood, number>>;

export interface ControlledRegion {
  /** 地區名稱(特產表以名稱為鍵)。 */
  name: string;
  /** 控制比例 0–100。 */
  percent: number;
}

function safePercent(p: number): number {
  return Number.isFinite(p) ? Math.min(100, Math.max(0, p)) : 0;
}

/** 單一地區對各貨物的產量(已套控制比例與時代解鎖,向下取整,0 的貨物不出現)。 */
export function regionSpecialtyOutput(
  region: ControlledRegion,
  statsEra: string,
  baseOutput: number = SPECIALTY_BASE_OUTPUT,
): GoodsAmounts {
  const out: GoodsAmounts = {};
  const pct = safePercent(region.percent);
  const base = Number.isFinite(baseOutput) ? Math.max(0, baseOutput) : 0;
  if (pct <= 0 || base <= 0) return out;
  const spec = specialtyOf(region.name);
  for (const good of Object.keys(spec) as SpecialtyGood[]) {
    if (!isGoodUnlocked(good, statsEra)) continue;
    const strength = spec[good] ?? 0;
    const amount = Math.floor((strength * pct * base) / 100);
    if (amount > 0) out[good] = amount;
  }
  return out;
}

/** 一個國家控制的所有地區加總。 */
export function nationSpecialtyOutput(
  regions: readonly ControlledRegion[],
  statsEra: string,
  baseOutput: number = SPECIALTY_BASE_OUTPUT,
): GoodsAmounts {
  const total: GoodsAmounts = {};
  for (const r of regions) {
    const o = regionSpecialtyOutput(r, statsEra, baseOutput);
    for (const g of Object.keys(o) as SpecialtyGood[]) {
      total[g] = (total[g] ?? 0) + (o[g] ?? 0);
    }
  }
  return total;
}

/**
 * 分流:木材/礦石沿用 player_nations 欄位(storedInGoodsTable=false,避免雙帳),
 * 其餘進 nation_goods。
 */
export function splitProduction(amounts: GoodsAmounts): {
  playerColumns: { wood: number; ore: number };
  goodsTable: Partial<Record<SpecialtyGood, number>>;
} {
  const goodsTable: Partial<Record<SpecialtyGood, number>> = {};
  for (const g of GOOD_SLUGS) {
    if (g === "food") continue;
    const v = amounts[g as SpecialtyGood] ?? 0;
    if (v > 0 && GOODS[g].storedInGoodsTable) goodsTable[g as SpecialtyGood] = v;
  }
  return {
    playerColumns: { wood: amounts.wood ?? 0, ore: amounts.ore ?? 0 },
    goodsTable,
  };
}
