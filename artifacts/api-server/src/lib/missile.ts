/**
 * 導彈系統(純函式、DB-free)。
 *
 * 1960 年後解鎖。可對「正在交戰的國家」所控制的一塊地發射導彈:
 *  - 發射國付出:國庫金錢 × costPct(當下金額)。
 *  - 目的地損失:該地區人口、地區建築等級各扣 damagePct(實體損失;不扣目標國國庫)。
 *  - 門檻:國庫須 ≥ MISSILE_MIN_TREASURY_BASE × 時代係數,避免窮國花小錢丟核彈。
 *  - 每國每回合限射一發(以世界 lastTurnAt 週期識別,見 routes/missile.ts)。
 */

export const MISSILE_UNLOCK_YEAR = 1960;

export type MissileType = "medium" | "tactical_nuke" | "strategic_nuke";

export const MISSILE_TYPES: readonly MissileType[] = ["medium", "tactical_nuke", "strategic_nuke"];

export function isMissileType(v: unknown): v is MissileType {
  return typeof v === "string" && (MISSILE_TYPES as readonly string[]).includes(v);
}

export const MISSILE_DEFS: Readonly<
  Record<MissileType, { label: string; costPct: number; damagePct: number }>
> = {
  medium: { label: "中程導彈", costPct: 10, damagePct: 3 },
  tactical_nuke: { label: "戰術核導彈", costPct: 33, damagePct: 12 },
  strategic_nuke: { label: "戰略核導彈", costPct: 50, damagePct: 20 },
};

/** 發射所需最低國庫(古典時代基準,實際 = 基準 × eraCostScale)。 */
export const MISSILE_MIN_TREASURY_BASE = 100_000;

/** 由 world_game_state.game_date(YYYY-MM-DD,可為負紀年格式以外的標準字串)取年份。 */
export function gameYearOf(gameDate: string): number {
  const m = /^(-?\d{1,6})-/.exec(gameDate.trim());
  return m ? Number(m[1]) : Number.NaN;
}

export function isMissileUnlocked(gameDate: string): boolean {
  const y = gameYearOf(gameDate);
  return Number.isFinite(y) && y >= MISSILE_UNLOCK_YEAR;
}

/** 發射費用 = floor(國庫 × costPct / 100)。 */
export function missileCost(money: number, type: MissileType): number {
  const m = Math.max(0, Math.floor(money));
  return Math.floor((m * MISSILE_DEFS[type].costPct) / 100);
}

export function missileMinTreasury(eraScale: number): number {
  return Math.ceil(MISSILE_MIN_TREASURY_BASE * Math.max(1, eraScale));
}

/** 人口損失 = floor(人口 × damagePct / 100)(人口先夾下限 0)。 */
export function populationLoss(population: number, type: MissileType): number {
  const p = Math.max(0, Math.floor(population));
  return Math.floor((p * MISSILE_DEFS[type].damagePct) / 100);
}

/**
 * 建築降級:等級 × (1 − damagePct%),向下取整(至少損失 1 級;原本 1 級 = 被摧毀)。
 * 回傳新等級,0 代表整座建築被炸毀(呼叫端刪除該列)。
 * 例:戰略核 20% → lv10 建築 = floor(10×0.8)=8;lv1 = 0(炸毀);lv3 = floor(2.4)=2。
 */
export function buildingLevelAfter(level: number, type: MissileType): number {
  const lv = Math.max(0, Math.floor(level));
  if (lv === 0) return 0;
  const kept = Math.floor((lv * (100 - MISSILE_DEFS[type].damagePct)) / 100);
  return Math.min(kept, lv - 1);
}

/**
 * 降級後應釋放的「生產力占用」:依新舊等級的比例,從 production_reserved 等比釋放,
 * 整座炸毀則全額釋放。維持不變量 production_spent = Σ軍隊占用 + Σ建築 production_reserved。
 */
export function reservedAfter(
  oldLevel: number,
  newLevel: number,
  reserved: number,
): { newReserved: number; released: number } {
  const r = Math.max(0, Math.floor(reserved));
  if (newLevel <= 0 || oldLevel <= 0) return { newReserved: 0, released: r };
  const newReserved = Math.min(r, Math.floor((r * newLevel) / oldLevel));
  return { newReserved, released: r - newReserved };
}
