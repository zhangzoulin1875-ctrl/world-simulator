/**
 * 廢棄油井勝利條件 — 純函式核心(無資料庫、無時間依賴,方便測試)。
 *
 * 規則(2026-10-09 定案):
 *  - 計分以「經過的真實小時數」為準,而非回合數:管理員可把回合頻率調成每天 1~24 次,
 *    綁回合會讓賽季長度跟著亂。每小時得分 = n × (1 + 0.25 × (n−1)),n = 佔領油井數。
 *  - 先達 10000 分者勝,賽季結束進入冷卻,等管理員選下一賽季年代後重開。
 *  - 只有「擁有沿海掛靠區且研發海戰」的國家能爭奪。
 */
import { COASTAL_REGION_NAMES, OIL_RIG_SEEDS, type OilRigSeed } from "./oilRigSeeds";

export const OIL_WIN_SCORE = 10000;
export const OIL_BASE_POINTS_PER_HOUR = 1;
export const OIL_CLUSTER_BONUS = 0.25;
/** 單次結算最多補算幾小時,避免伺服器停擺很久後一次灌入天量分數造成「瞬間勝利」。 */
export const OIL_MAX_CATCHUP_HOURS = 24;
export const NAVAL_TECH_SLUG = "naval_warfare";
/** 一個地區的控制比例達此值才算「擁有」(region_controls 允許多國共同持有,沒有單一擁有者)。 */
export const OWN_REGION_MIN_PERCENT = 50;

/** 由 region_controls 列挑出該國「擁有」的地區名稱。 */
export function ownedRegionNames(
  controls: readonly { regionName: string; percent: number }[],
): string[] {
  return controls.filter((c) => c.percent >= OWN_REGION_MIN_PERCENT).map((c) => c.regionName);
}

/** 佔領 n 座時,每小時得分。n 必須是非負整數。 */
export function pointsPerHour(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`佔領數必須是非負整數: ${n}`);
  if (n === 0) return 0;
  return OIL_BASE_POINTS_PER_HOUR * n * (1 + OIL_CLUSTER_BONUS * (n - 1));
}

/**
 * 結算區間得分。hours 是距上次結算經過的小時數(可含小數)。
 * 非有限、負數一律視為 0(時鐘倒退或壞資料不可倒扣分);超過 OIL_MAX_CATCHUP_HOURS 截斷。
 * 回傳四捨五入到小數 2 位,避免浮點累積誤差。
 */
export function scoreGain(heldCount: number, hours: number): number {
  const h = Number.isFinite(hours) && hours > 0 ? Math.min(hours, OIL_MAX_CATCHUP_HOURS) : 0;
  return Math.round(pointsPerHour(heldCount) * h * 100) / 100;
}

export function hoursBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Number.isFinite(ms) && ms > 0 ? ms / 3_600_000 : 0;
}

// ── 資格 ────────────────────────────────────────────────

export type OilEligibility =
  | { ok: true }
  | { ok: false; reason: "no_naval_tech" | "no_coastal_region" | "rig_out_of_range" | "unknown_rig" };

export const OIL_INELIGIBLE_MESSAGE: Record<Exclude<OilEligibility, { ok: true }>["reason"], string> = {
  no_naval_tech: "需先研發「海戰」才能出海爭奪油井",
  no_coastal_region: "你的國家沒有任何沿海地區,無法出海",
  rig_out_of_range: "這座油井不在你的沿海地區航程內",
  unknown_rig: "找不到這座油井",
};

export function anchorRegionsOf(rigSlug: string): readonly string[] | null {
  return OIL_RIG_SEEDS.find((r) => r.slug === rigSlug)?.anchorRegions ?? null;
}

/** 地區是否沿海:海岸比例名單,或被任一油井列為掛靠區(人工審定)。 */
export function isCoastalRegionName(name: string): boolean {
  return COASTAL_REGION_NAMES.has(name) || OIL_RIG_SEEDS.some((r) => r.anchorRegions.includes(name));
}

/**
 * 國家能否爭奪指定油井。
 * ownedRegionNames:該國目前控制的地區名稱;researchedSlugs:已研發的科技 slug。
 * 檢查順序固定(科技 → 沿海 → 航程),回傳第一個不符合的原因,UI 才能給出明確提示。
 */
export function canContestRig(
  ownedRegionNames: readonly string[],
  researchedSlugs: readonly string[],
  rigSlug: string,
): OilEligibility {
  const anchors = anchorRegionsOf(rigSlug);
  if (!anchors) return { ok: false, reason: "unknown_rig" };
  if (!researchedSlugs.includes(NAVAL_TECH_SLUG)) return { ok: false, reason: "no_naval_tech" };
  if (!ownedRegionNames.some(isCoastalRegionName)) return { ok: false, reason: "no_coastal_region" };
  if (!ownedRegionNames.some((n) => anchors.includes(n))) return { ok: false, reason: "rig_out_of_range" };
  return { ok: true };
}

// ── 賽季 ────────────────────────────────────────────────

export type OilSeasonStatus = "active" | "cooldown";

export interface OilScoreRow { nationId: string; score: number }

/**
 * 找出本次結算的勝者。多國同時越線時,分數最高者勝;分數相同則取「較早達到該分數」者
 * (呼叫端以 scoredAt 提供)。沒有人達標回傳 null。
 */
export function pickWinner(
  rows: readonly (OilScoreRow & { reachedAt?: Date | null })[],
  winScore: number = OIL_WIN_SCORE,
): string | null {
  const over = rows.filter((r) => Number.isFinite(r.score) && r.score >= winScore);
  if (over.length === 0) return null;
  over.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ta = a.reachedAt?.getTime() ?? Infinity;
    const tb = b.reachedAt?.getTime() ?? Infinity;
    if (ta !== tb) return ta - tb;
    return a.nationId < b.nationId ? -1 : 1;   // 完全相同時用 id 排序,確保結果決定論
  });
  return over[0]!.nationId;
}

export type { OilRigSeed };
