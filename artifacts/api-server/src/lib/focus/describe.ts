import { governmentLabel } from "../governments";
import type { FocusEffect, FocusStat } from "./types";

const sign = (v: number) => (v > 0 ? `+${v}` : `${v}`);

/** 窮盡 switch:日後新增 FocusStat 若沒補翻譯,編譯會失敗,不會悄悄顯示英文代碼。 */
function statText(stat: FocusStat, v: number): string {
  switch (stat) {
    case "taxIncome": return `稅收 ${sign(v)}%`;
    case "productionOutput": return `產出 ${sign(v)}%`;
    case "armyUpkeep": return `軍隊維護費 ${sign(v)}%`;
    case "recruitSpeed": return `徵兵/訓練速度 ${sign(v)}%`;
    case "stabilityRegen": return `穩定度每回合恢復 ${sign(v)}`;
    case "parliamentDrift": return `議會滿意度每回合漂移 ${sign(v)}`;
    case "militaryDrift": return `軍方滿意度每回合漂移 ${sign(v)}`;
    case "pointsPerTurn": return `政治點數每回合 ${sign(v)}`;
    case "focusSpeed": return `國策完成速度 ${sign(v)}%`;
    default: {
      const _never: never = stat;
      return String(_never);
    }
  }
}

const GRANT_LABEL = {
  money: "金錢",
  techPoints: "科技點",
  stability: "穩定度",
  politicalSupport: "政治支持度",
} as const;

export function describeEffect(e: FocusEffect): string {
  switch (e.kind) {
    case "modifier": return statText(e.stat, e.value);
    case "grant": return `${GRANT_LABEL[e.stat]} ${sign(e.value)}`;
    case "lean": return `${e.side === "black" ? "黑線" : "紅線"}傾向值 ${sign(e.value)}`;
    case "parliamentSatisfaction": return `議會滿意度 ${sign(e.value)}`;
    case "militarySatisfaction": return `軍方滿意度 ${sign(e.value)}`;
    case "unlock": return `解鎖:${e.capability}`;
    case "transition": return `政體轉變為「${governmentLabel(e.toGovernment) ?? e.toGovernment}」`;
    default: {
      const _never: never = e;
      return String(_never);
    }
  }
}
