import type { EventCategory } from "../categories";
import type { ChoiceEffects, DomesticEventDef } from "../types";

/** 一個選項的簡寫:[標題, 提示, 效果] */
export type ChoiceSpec = readonly [label: string, hint: string, effects: ChoiceEffects];

/**
 * 建立一個事件。三個選項固定順序:順應 / 鎮壓 / 拖延(對應 comply / crackdown / delay),
 * 預設選項一律是「拖延」。效果數字由 validateEventCatalog 的強度規則把關。
 */
export function ev(
  category: EventCategory,
  kind: string,
  title: string,
  body: string,
  weight: number,
  comply: ChoiceSpec,
  crackdown: ChoiceSpec,
  delay: ChoiceSpec,
): DomesticEventDef {
  const mk = (id: "comply" | "crackdown" | "delay", s: ChoiceSpec) =>
    ({ id, style: id, label: s[0], hint: s[1], effects: s[2] }) as const;
  return {
    kind, category, title, body, weight, defaultChoiceId: "delay",
    choices: [mk("comply", comply), mk("crackdown", crackdown), mk("delay", delay)],
  };
}
