import type { FocusSlot, FocusTrack } from "./core";

/**
 * 國策目錄的資料結構(靜態內容,隨版本部署,不進資料庫)。
 *
 * 反流水帳的四條硬規則,由 validateCatalog() 在測試中強制:
 *  1. 每個國策必有「代價」(至少一項負面效果或資源消耗),沒有白拿的。
 *  2. 分岔點(exclusiveGroup)至少兩個互斥選項。
 *  3. 里程碑(milestone)必須解鎖「能力」,不能只是加百分比。
 *  4. 前置鏈不可成環;所有前置/互斥引用必須存在。
 */

/** 效果種類。數值一律由程式決定並有上限,AI 不可改。 */
export type FocusEffect =
  // 數值調整(持續性,完成後永久生效)
  | { kind: "modifier"; stat: FocusStat; value: number }
  // 一次性變動
  | { kind: "grant"; stat: "money" | "techPoints" | "stability" | "politicalSupport"; value: number }
  // 傾向值(黑/紅線)
  | { kind: "lean"; side: "black" | "red"; value: number }
  // 議會滿意度(一次性)
  | { kind: "parliamentSatisfaction"; value: number }
  // 軍方滿意度(一次性)
  | { kind: "militarySatisfaction"; value: number }
  // 能力解鎖:新兵種/新外交動作/新建築/新政策欄位等,由 key 指定
  | { kind: "unlock"; capability: string }
  // 政體轉型:完成即改政體(轉型國策專用)
  | { kind: "transition"; toGovernment: string };

/** 可被 modifier 調整的統計欄位(白名單;新增前先確認下游系統有讀取)。 */
export type FocusStat =
  | "taxIncome" // 稅收 %
  | "productionOutput" // 生產力 %
  | "armyUpkeep" // 軍隊維護費 % (負值=省錢)
  | "recruitSpeed" // 招募/訓練速度 %
  | "stabilityRegen" // 穩定度回復
  | "parliamentDrift" // 議會滿意度每回合漂移
  | "militaryDrift" // 軍方滿意度每回合漂移
  | "pointsPerTurn" // 政治點數每回合 +N
  | "focusSpeed"; // 國策完成速度 %

export interface FocusDef {
  /** 全域唯一 id,如 "mil.conscription"。 */
  id: string;
  /** 所屬領域(決定 UI 分欄與動態生成的風味方向)。 */
  domain: FocusDomain;
  track: FocusTrack;
  slot: FocusSlot;
  /** 預設名稱與敘述(模板);AI 文字層可覆寫,國名/領袖用 {國名}、{領袖} 佔位。 */
  title: string;
  description: string;
  /** 政治點數成本與完成回合(基礎值;實際回合由議會滿意度係數推進)。 */
  cost: number;
  turns: number;
  /** 全部需已完成。 */
  requires: string[];
  /** 其中至少一項需已完成(可為空=不限制)。 */
  requiresAny?: string[];
  /** 互斥分岔:同一 exclusiveGroup 內只能完成一個;完成後其餘永久鎖定。 */
  exclusiveGroup?: string;
  /** 額外互斥(跨群組),任一已完成/進行中則不可啟動。 */
  excludes?: string[];
  /** 只有這些政體(slug)能看見/啟動;省略=全部政體。 */
  governments?: string[];
  /** 最早可見的世界時代 slug;省略=任何時代。 */
  minEra?: string;
  /** 效果:至少一項為代價(負面)— 由 validateCatalog 強制。 */
  effects: FocusEffect[];
  /** 里程碑國策:必須含 unlock 或 transition 效果。 */
  milestone?: boolean;
  /** 客觀條件門檻(全部須成立才能啟動;用於轉型國策取代舊「接受度」)。 */
  conditions?: FocusCondition[];
}

export type FocusDomain =
  | "military"
  | "economy"
  | "interior"
  | "diplomacy"
  | "regime"; // 政體轉型與黑紅線

/** 客觀條件(取代舊政體變更接受度)。 */
export type FocusCondition =
  | { kind: "politicalSupportAtLeast"; value: number }
  | { kind: "politicalSupportAtMost"; value: number }
  | { kind: "parliamentSatisfactionAtLeast"; value: number }
  | { kind: "parliamentSatisfactionAtMost"; value: number }
  | { kind: "militarySatisfactionAtLeast"; value: number }
  | { kind: "militarySatisfactionAtMost"; value: number }
  | { kind: "stabilityAtLeast"; value: number }
  | { kind: "stabilityAtMost"; value: number }
  | { kind: "leanAtLeast"; side: "black" | "red"; value: number };

/** 判斷一個效果是否算「代價」(負面)。 */
export function isCostEffect(e: FocusEffect): boolean {
  switch (e.kind) {
    case "modifier":
      // armyUpkeep 的負值是省錢(好事),其餘負值是代價
      return e.stat === "armyUpkeep" ? e.value > 0 : e.value < 0;
    case "grant":
      return e.value < 0;
    case "parliamentSatisfaction":
    case "militarySatisfaction":
      return e.value < 0;
    case "lean":
      return false;
    case "unlock":
    case "transition":
      return false;
  }
}
