import type { EventCategory } from "./categories";

export type ChoiceStyle = "comply" | "crackdown" | "delay";

/** 一個選項對國家造成的固定效果 */
export interface ChoiceEffects {
  stability?: number;
  money?: number;
  politicalSupport?: number;
  militarySatisfaction?: number;
  parliamentSatisfaction?: number;
  /** 鎮壓類選項:穩定度低於門檻時有機率爆發內戰 */
  civilWarRisk?: boolean;
  /** 社會黨多數事件專用:順應 = 議會被福利派掌握;鎮壓 = 福利派被逐出議會 */
  parliamentShift?: "socialists_in" | "socialists_out";
}

export interface EventChoiceDef {
  id: string;
  style: ChoiceStyle;
  /** 模板文字(沒有 AI 或 AI 失敗時使用) */
  label: string;
  hint: string;
  effects: ChoiceEffects;
}

export interface DomesticEventDef {
  kind: string;
  /** 分類(2026-10-06):方便管理,也用於「先抽類別再抽事件」 */
  category: EventCategory;
  title: string;
  /** 模板敘述 */
  body: string;
  choices: readonly EventChoiceDef[];
  /** 逾時自動套用的選項 id */
  defaultChoiceId: string;
  /** 抽到的相對權重 */
  weight: number;
}
