// Task #469 — 科技樹預設種子（military 領域，前/後半）

import type { MilitarySeedDomain } from "./types";
import { MILITARY_ERAS_EARLY } from "./militaryEarly";
import { MILITARY_ERAS_LATE } from "./militaryLate";

export const MILITARY_TECH_TREE_SEED: MilitarySeedDomain = {
  domain: "military",
  eras: [...MILITARY_ERAS_EARLY, ...MILITARY_ERAS_LATE],
};
