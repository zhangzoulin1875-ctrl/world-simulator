// Task #469 — 科技樹預設種子（social 領域，前/後半）

import type { SocialSeedDomain } from "./types";
import { SOCIAL_ERAS_EARLY } from "./socialEarly";
import { SOCIAL_ERAS_LATE } from "./socialLate";

export const SOCIAL_TECH_TREE_SEED: SocialSeedDomain = {
  domain: "social",
  eras: [...SOCIAL_ERAS_EARLY, ...SOCIAL_ERAS_LATE],
};
