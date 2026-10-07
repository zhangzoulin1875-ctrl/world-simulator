/**
 * 補給系統純函式（DB-free、可單元測試）。
 *
 * 設計：軍團每個戰役結算週期要「吃」兩種物資：
 *  - 口糧：按兵力算，由所屬國家的糧食狀況決定能不能吃飽（沿用糧食系統，不另設庫存）。
 *  - 彈藥：新資源庫存 `ammo`，需求依兵種火力與時代而定；冷兵器時代幾乎為零。
 *
 * 軍團的 `supply`（0–100）是「補給狀態」：吃飽打足時緩慢回升，缺糧缺彈時快速下降。
 * 補給低於 SUPPLY_COLLAPSE_BELOW 時，部隊每週期組織度（士氣）額外暴跌、戰力因子
 * 掉到接近 0——即使面對弱小的敵人也會瞬間崩潰。
 *
 * 結算順序：先算補給 → 補給決定本週期戰力 → 再算傷亡。所以缺補給的部隊
 * 在「這一輪」就已經變弱，不是下一輪才有感。
 */

/** 軍團需要的兵種資訊（最小形狀，讓測試不必造完整的 LoadedLegion）。 */
export interface SupplyUnit {
  quantity: number;
  category: string;
}

export interface SupplyDemand {
  /** 口糧需求（單位 = 人·週期）。 */
  ration: number;
  /** 彈藥需求（整數 ≥ 0）。 */
  ammo: number;
}

/** 每個兵種分類每單位每週期消耗的彈藥（火力係數）。後勤型/近戰低、火砲高。 */
export const AMMO_PER_UNIT_BY_CATEGORY: Readonly<Record<string, number>> = {
  infantry: 0.2,
  ranged: 0.6,
  armor: 1.0,
  artillery: 2.0,
  ship: 1.2,
  air: 1.5,
  siege: 0.8,
};

/** 沒列出的分類走這個預設值。 */
export const AMMO_PER_UNIT_DEFAULT = 0.3;

/**
 * 時代彈藥係數：冷兵器時代（古典到文藝復興）趨近 0，火藥時代起逐步上升。
 * key 涵蓋 mapRegionEras.ts 的所有 ERAS slug（單元測試驗證）。
 * 古代戰爭以口糧為主，不會被彈藥卡死。
 */
export const AMMO_ERA_FACTOR: Readonly<Record<string, number>> = {
  classical: 0,
  roman: 0,
  early_medieval: 0.02,
  high_medieval: 0.05,
  renaissance: 0.3,
  discovery: 0.6,
  scientific: 0.8,
  enlightenment: 1,
  industrial: 1.5,
  ww1: 2.5,
  ww2: 3.5,
  cold_war: 5,
  modern: 7,
  future: 10,
};

export function ammoEraFactor(eraSlug: string): number {
  return eraSlug in AMMO_ERA_FACTOR ? AMMO_ERA_FACTOR[eraSlug]! : 0;
}

/** 單一軍團本週期的物資需求。 */
export function legionSupplyDemand(units: readonly SupplyUnit[], eraSlug: string): SupplyDemand {
  const eraF = ammoEraFactor(eraSlug);
  let ration = 0;
  let ammo = 0;
  for (const u of units) {
    const q = Math.max(0, u.quantity);
    ration += q;
    ammo += q * (AMMO_PER_UNIT_BY_CATEGORY[u.category] ?? AMMO_PER_UNIT_DEFAULT) * eraF;
  }
  // 彈藥需求取整數往上進位：有火力就一定要有最小消耗，不被捨入成 0。
  return { ration, ammo: ammo > 0 ? Math.ceil(ammo) : 0 };
}

/**
 * 一個國家同一週期內所有軍團共用同一個庫存池。把需求依比例分配給庫存，
 * 回傳每個軍團的「滿足度」（0–1）。庫存夠 → 全部 1；不夠 → 依比例縮水。
 * 注意：不依軍團優先序，避免第一個軍團吃光、後面的全餓死造成結果取決於排序。
 */
export function allocateSupplyFill(demands: readonly number[], stock: number): number[] {
  const total = demands.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return demands.map(() => 1);
  const ratio = Math.max(0, Math.min(1, stock / total));
  return demands.map((d) => (d > 0 ? ratio : 1));
}

/** 本週期實際消耗的量（不會超過庫存，也不會超過總需求）。 */
export function consumedFromStock(demands: readonly number[], stock: number): number {
  const total = demands.reduce((a, b) => a + Math.max(0, b), 0);
  return Math.min(Math.max(0, stock), total);
}

/**
 * 口糧滿足度：沿用糧食系統的「連續饑荒回合數」（player_nations.consecutive_famine_turns，
 * 回合引擎每回合維護），不另設糧食庫存、也不在戰役結算時重跑昂貴的糧食報告。
 * 本土沒在鬧饑荒 → 1；饑荒越久，前線越吃不飽（後勤先被民間搶光）。
 */
export function rationFillFromFamine(consecutiveFamineTurns: number): number {
  const t = Math.max(0, Math.floor(consecutiveFamineTurns));
  if (t === 0) return 1;
  if (t === 1) return 0.7;
  if (t === 2) return 0.5;
  return 0.25;
}

// ── 補給狀態轉換 ─────────────────────────────────────────────────────

/** 補給狀態（0–100）每週期的變化量常數。 */
export const SUPPLY_RECOVER_PER_CYCLE = 5;
/** 缺糧時每週期的下降量（滿足度 0 時）；實際 = 此值 × (1 − 滿足度)。 */
export const SUPPLY_DRAIN_RATION = 30;
/** 缺彈時每週期的下降量（滿足度 0 時）。 */
export const SUPPLY_DRAIN_AMMO = 20;
/** 補給低於此值 = 組織崩潰（士氣額外暴跌、戰力近乎歸零）。 */
export const SUPPLY_COLLAPSE_BELOW = 20;
/** 崩潰狀態下每週期士氣額外扣減。 */
export const COLLAPSE_MORALE_PENALTY = 20;

/**
 * 依本週期的口糧/彈藥滿足度（0–1）更新補給狀態。
 * 兩者都吃飽 → 緩慢回升；缺任一種 → 依缺口大小下降。
 * 無彈藥需求的軍團（冷兵器時代）彈藥滿足度視為 1，所以只看口糧。
 */
export function nextSupplyState(current: number, rationFill: number, ammoFill: number): number {
  const rf = Math.max(0, Math.min(1, rationFill));
  const af = Math.max(0, Math.min(1, ammoFill));
  const drain = SUPPLY_DRAIN_RATION * (1 - rf) + SUPPLY_DRAIN_AMMO * (1 - af);
  const delta = drain > 0 ? -drain : SUPPLY_RECOVER_PER_CYCLE;
  return Math.max(0, Math.min(100, Math.round(current + delta)));
}

/** 補給狀態是否已崩潰。 */
export function isSupplyCollapsed(supply: number): boolean {
  return supply < SUPPLY_COLLAPSE_BELOW;
}

/** 崩潰造成的士氣額外扣減（沒崩潰 = 0）。 */
export function collapseMoralePenalty(supply: number): number {
  return isSupplyCollapsed(supply) ? COLLAPSE_MORALE_PENALTY : 0;
}

/**
 * 補給對戰力的乘數：取代 war.ts 的舊版（0.5–1.0）。
 * 補給 100 → 1.0；補給 0 → SUPPLY_MIN_FACTOR；崩潰區間內再壓低一截。
 * 士氣因子仍由 combatConditionFactor 的士氣部分負責，這裡只管補給。
 */
export const SUPPLY_MIN_FACTOR = 0.1;
export function supplyPowerFactor(supply: number): number {
  const s = Math.max(0, Math.min(100, supply)) / 100;
  const base = SUPPLY_MIN_FACTOR + (1 - SUPPLY_MIN_FACTOR) * s;
  // 崩潰區再打七折，讓「補給斷了」和「補給少一點」在體感上有明顯斷層。
  return isSupplyCollapsed(supply) ? base * 0.7 : base;
}

// ── NPC 自動配給 ─────────────────────────────────────────────────────

/**
 * NPC 沒有玩家的庫存管理，所以每回合依「控制地區數」給一份彈藥配額。
 * 這樣 NPC 也吃補給（配額不夠、遠征太久、對手劫掠都會讓它缺料崩潰），
 * 但不用 NPC 去蓋工廠。配額刻意偏緊：大國撐得住長戰，小國撐不久。
 */
export const NPC_AMMO_PER_REGION_PER_TURN = 40;

export function npcAmmoStipend(controlledRegions: number, eraSlug: string): number {
  if (ammoEraFactor(eraSlug) <= 0) return 0;
  return Math.max(0, Math.floor(controlledRegions)) * NPC_AMMO_PER_REGION_PER_TURN * ammoEraFactor(eraSlug);
}

/**
 * 庫存上限：避免彈藥無限囤積。
 * 玩家 = 軍工廠總等級 × 每級倉容；NPC 沒有工廠，改用「控制地區數 × 每區倉容」，
 * 否則 NPC 的上限會是 0、配額根本存不下來。
 */
export const AMMO_STOCK_CAP_PER_PLANT_LEVEL = 5_000;
export const AMMO_STOCK_CAP_PER_NPC_REGION = 2_000;
export function ammoStockCap(plantLevels: number): number {
  return Math.max(0, Math.floor(plantLevels)) * AMMO_STOCK_CAP_PER_PLANT_LEVEL;
}
export function npcAmmoStockCap(controlledRegions: number): number {
  return Math.max(0, Math.floor(controlledRegions)) * AMMO_STOCK_CAP_PER_NPC_REGION;
}
