import type { FocusEffect } from "./types";

/**
 * 效果接線狀態。
 *
 * 只有「有安全下游」的效果會真的生效;其餘(持續性 modifier、unlock)目前只記錄、
 * 不生效,避免做出假效果。要讓某個效果生效,先接好下游系統,再把它加進白名單。
 */
export const WIRED_MODIFIER_STATS: ReadonlySet<string> = new Set<string>([
  // 第一批尚未接線;接線一項加一項(例:pointsPerTurn、focusSpeed 由本模組自己讀,最先接)
]);

export const WIRED_UNLOCKS: ReadonlySet<string> = new Set<string>([]);

export function isEffectWired(e: FocusEffect): boolean {
  switch (e.kind) {
    case "modifier":
      return WIRED_MODIFIER_STATS.has(e.stat);
    case "unlock":
      return WIRED_UNLOCKS.has(e.capability);
    case "transition":
      return true; // 政體轉型:由 service.ts 的轉型執行器處理(applyRegimeTransition)
    case "revolution":
      return true; // 革命奪權:由 service.ts 開內戰(startCivilWar)
    default:
      return true; // grant / lean / 議會 / 軍方 滿意度:一次性,直接寫欄位
  }
}

export interface NationPatch {
  money?: number;
  techPoints?: number;
  stability?: number;
  politicalSupport?: number;
  satisfactionMilitary?: number;
}

const clamp = (v: number) => Math.min(100, Math.max(0, Math.round(v)));

/**
 * 把一次性效果彙整成對國家欄位的 patch(純函式)。
 * 回傳 patch(相對變動已套用到目前值並夾限)、傾向值增量、議會滿意度增量、未生效的效果。
 */
export function summarizeEffects(
  effects: readonly FocusEffect[],
  current: {
    money: number;
    techPoints: number;
    stability: number;
    politicalSupport: number;
    satisfactionMilitary: number;
  },
): {
  patch: NationPatch;
  blackLeanDelta: number;
  redLeanDelta: number;
  parliamentDelta: number;
  unwired: FocusEffect[];
  transitionTo: string | null;
  revolution: { ideology: "red" | "black"; landShare: number } | null;
} {
  const patch: NationPatch = {};
  let blackLeanDelta = 0;
  let redLeanDelta = 0;
  let parliamentDelta = 0;
  const unwired: FocusEffect[] = [];
  let transitionTo: string | null = null;
  let revolution: { ideology: "red" | "black"; landShare: number } | null = null;

  for (const e of effects) {
    if (!isEffectWired(e)) {
      unwired.push(e);
      continue;
    }
    switch (e.kind) {
      case "grant":
        if (e.stat === "money") patch.money = (patch.money ?? current.money) + Math.round(e.value);
        else if (e.stat === "techPoints") patch.techPoints = Math.max(0, (patch.techPoints ?? current.techPoints) + Math.round(e.value));
        else if (e.stat === "stability") patch.stability = clamp((patch.stability ?? current.stability) + e.value);
        else if (e.stat === "politicalSupport") patch.politicalSupport = clamp((patch.politicalSupport ?? current.politicalSupport) + e.value);
        break;
      case "militarySatisfaction":
        patch.satisfactionMilitary = clamp((patch.satisfactionMilitary ?? current.satisfactionMilitary) + e.value);
        break;
      case "parliamentSatisfaction":
        parliamentDelta += e.value;
        break;
      case "transition":
        transitionTo = e.toGovernment;
        break;
      case "revolution":
        revolution = { ideology: e.ideology, landShare: e.landShare };
        break;
      case "lean":
        if (e.side === "black") blackLeanDelta += e.value;
        else redLeanDelta += e.value;
        break;
      default:
        break;
    }
  }
  return { patch, blackLeanDelta, redLeanDelta, parliamentDelta, unwired, transitionTo, revolution };
}
