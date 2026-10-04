/**
 * Task #406 — 地區資源建築（木材廠／礦場）純函式與常數。
 * 與 DB / Express 無耦合，方便單元測試。
 */

export type BuildingType = "lumber_mill" | "mine";

export const BUILDING_TYPES: readonly BuildingType[] = ["lumber_mill", "mine"];

export function isBuildingType(v: string): v is BuildingType {
  return (BUILDING_TYPES as readonly string[]).includes(v);
}

export const BUILDING_LABEL: Record<BuildingType, string> = {
  lumber_mill: "木材廠",
  mine: "礦場",
};

/** 建築產出的資源欄位。 */
export const BUILDING_RESOURCE: Record<BuildingType, "wood" | "ore"> = {
  lumber_mill: "wood",
  mine: "ore",
};

export const RESOURCE_LABEL: Record<"wood" | "ore", string> = {
  wood: "木材",
  ore: "礦石",
};

/** 等級上限（1.2^99 仍在安全整數範圍內）。 */
export const MAX_BUILDING_LEVEL = 100;

/** 建造（level 1）的基礎成本。 */
export const BUILDING_BASE_COST = { money: 5_000, production: 200 } as const;

/** 每級每回合產出資源量。 */
export const BUILDING_OUTPUT_PER_LEVEL = 50;

/** 每級占用的工人數（全國建築工人總數 ≤ 國家人口）。 */
export const BUILDING_WORKERS_PER_LEVEL = 1_000;

/** 每級每回合金錢維護費。 */
export const BUILDING_UPKEEP_PER_LEVEL = 100;

/**
 * 建到「第 level 級」的成本：基礎 × 1.2^(level−1)，向上取整。
 * level 1 = 新建；level n（n>1）= 從 n−1 升到 n 的成本。
 */
export function buildingCost(
  level: number,
  eraScale = 1,
): {
  money: number;
  production: number;
} {
  const factor = Math.pow(1.2, level - 1);
  return {
    // 金錢軌隨時代膨脹；生產力軌不縮放——它會寫入 region_buildings.production_reserved，
    // 受「production_spent = Σ production_reserved」不變量約束（見 productionSpentHealth）。
    money: Math.ceil(BUILDING_BASE_COST.money * factor * eraScale),
    production: Math.ceil(BUILDING_BASE_COST.production * factor),
  };
}

/**
 * 建到「第 level 級」為止的累計生產力成本（基礎倍率、未含管理員成本倍率）：
 * Σ_{l=1..level} ceil(200 × 1.2^(l−1))。用於舊建築的 production_reserved 回填
 * （倍率功能上線前的建築一律以基礎成本計）。
 */
export function cumulativeBuildingProductionCost(level: number): number {
  let total = 0;
  for (let l = 1; l <= level; l += 1) {
    total += buildingCost(l).production;
  }
  return total;
}

/** 建築每回合產出（50 × level）。 */
export function buildingOutput(level: number): number {
  return BUILDING_OUTPUT_PER_LEVEL * level;
}

/** 建築占用的工人數（1000 × level）。 */
export function buildingWorkers(level: number): number {
  return BUILDING_WORKERS_PER_LEVEL * level;
}

/** 建築每回合金錢維護費（100 × level）。 */
export function buildingUpkeep(level: number, eraScale = 1): number {
  return Math.round(BUILDING_UPKEEP_PER_LEVEL * level * eraScale);
}
