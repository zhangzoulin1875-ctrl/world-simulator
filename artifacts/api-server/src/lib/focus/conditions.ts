import { ERAS } from "../mapRegionEras";
import type { FocusCondition } from "./types";

/** 判定條件所需的國家快照。 */
export interface ConditionFacts {
  politicalSupport: number;
  stability: number;
  militarySatisfaction: number;
  parliamentSatisfaction: number;
  blackLean: number;
  redLean: number;
}

/** 回傳第一個不成立的條件(用於顯示原因);全部成立回 null。 */
export function firstFailedCondition(
  conditions: readonly FocusCondition[] | undefined,
  f: ConditionFacts,
): FocusCondition | null {
  for (const c of conditions ?? []) {
    let ok = true;
    switch (c.kind) {
      case "politicalSupportAtLeast": ok = f.politicalSupport >= c.value; break;
      case "politicalSupportAtMost": ok = f.politicalSupport <= c.value; break;
      case "parliamentSatisfactionAtLeast": ok = f.parliamentSatisfaction >= c.value; break;
      case "parliamentSatisfactionAtMost": ok = f.parliamentSatisfaction <= c.value; break;
      case "militarySatisfactionAtLeast": ok = f.militarySatisfaction >= c.value; break;
      case "militarySatisfactionAtMost": ok = f.militarySatisfaction <= c.value; break;
      case "stabilityAtLeast": ok = f.stability >= c.value; break;
      case "stabilityAtMost": ok = f.stability <= c.value; break;
      case "leanAtLeast": ok = (c.side === "black" ? f.blackLean : f.redLean) >= c.value; break;
    }
    if (!ok) return c;
  }
  return null;
}

const COND_LABEL: Record<FocusCondition["kind"], string> = {
  politicalSupportAtLeast: "政治支持度需至少",
  politicalSupportAtMost: "政治支持度需至多",
  parliamentSatisfactionAtLeast: "議會滿意度需至少",
  parliamentSatisfactionAtMost: "議會滿意度需至多",
  militarySatisfactionAtLeast: "軍方滿意度需至少",
  militarySatisfactionAtMost: "軍方滿意度需至多",
  stabilityAtLeast: "穩定度需至少",
  stabilityAtMost: "穩定度需至多",
  leanAtLeast: "傾向值需至少",
};

export function describeCondition(c: FocusCondition): string {
  const side = c.kind === "leanAtLeast" ? (c.side === "black" ? "黑線" : "紅線") : "";
  return `${side}${COND_LABEL[c.kind]} ${c.value}`;
}

/** 世界時代是否已到達 minEra(ERAS 陣列順序即時代順序)。未知時代一律視為未到。 */
export function eraReached(currentEra: string, minEra: string | undefined): boolean {
  if (!minEra) return true;
  const slugs = (ERAS as readonly { slug: string }[]).map((e) => e.slug);
  const cur = slugs.indexOf(currentEra);
  const min = slugs.indexOf(minEra);
  if (cur < 0 || min < 0) return false;
  return cur >= min;
}
