import type { DomesticEventDef } from "../types";
import { POLITICS_EVENTS } from "./politics";
import { ECONOMY_EVENTS } from "./economy";
import { MILITARY_EVENTS } from "./military";
import { SOCIETY_EVENTS } from "./society";
import { RELIGION_EVENTS } from "./religion";
import { DISASTER_EVENTS } from "./disaster";
import { HEALTH_EVENTS } from "./health";
import { DIPLOMACY_EVENTS } from "./diplomacy";
import { TECH_EVENTS } from "./tech";
import { CULTURE_EVENTS } from "./culture";

/** 所有分類事件的合併清單(100 個)。新增分類時在這裡加一行,並更新 categories.ts。 */
export const ALL_CATALOG_EVENTS: readonly DomesticEventDef[] = [
  ...POLITICS_EVENTS,
  ...ECONOMY_EVENTS,
  ...MILITARY_EVENTS,
  ...SOCIETY_EVENTS,
  ...RELIGION_EVENTS,
  ...DISASTER_EVENTS,
  ...HEALTH_EVENTS,
  ...DIPLOMACY_EVENTS,
  ...TECH_EVENTS,
  ...CULTURE_EVENTS,
];
