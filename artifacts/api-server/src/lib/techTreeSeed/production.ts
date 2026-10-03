// Task #469 — 科技樹預設種子（production 領域，前/後半）
import type { ProductionSeedDomain } from "./types";
import { PRODUCTION_ERAS_EARLY } from "./productionEarly";
import { PRODUCTION_ERAS_LATE } from "./productionLate";

export const PRODUCTION_TECH_TREE_SEED: ProductionSeedDomain = {
  domain: "production",
  eras: [...PRODUCTION_ERAS_EARLY, ...PRODUCTION_ERAS_LATE],
};
