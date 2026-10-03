
/**
 * Task #126 — 社會科技（技術樹）系統。
 *
 * 社會科技與軍事科技結構相似（AI 依「研究方向」即時生成、以科技點數研發），
 * 但另外有「關鍵技術」（星號）：由後端種入、每個時代固定、帶結構化效果
 * （解鎖政體、收稅效率、建築槽、宗教/人權滿意度、國家宗教、政治顧問槽等）。
 *
 * 每個「領域」（社會/生產/軍事）各自有一棵時代科技樹，時代獨立推進：
 * 在目前時代完成該時代全部關鍵技術、且該時代研究數達門檻 → 下一回合進代。
 */

/**
 * 社會科技效果（存於 social_techs.effects jsonb）。數值型效果（收稅效率、
 * 科技點數、人口增長率、厭戰度增長、建築槽）以 value 疊加；旗標型效果
 * （啟用建築槽/宗教滿意度/人權滿意度/國家宗教/政治顧問槽）以 value≥1 視為開啟。
 * 政體解鎖不放在這裡——由 lib/socialTech.ts 的 KEY_TECH_GOVERNMENTS 依
 * 關鍵技術 key_slug 對應（種入的關鍵技術才會解鎖政體）。
 */
export type SocialTechEffectTarget =
  | "taxEfficiency"
  | "techPoints"
  | "populationGrowth"
  | "warWearinessGrowth"
  | "buildingSlots"
  | "enableBuildingSlots"
  | "enableReligionSatisfaction"
  | "enableRightsSatisfaction"
  | "enableNationalReligion"
  | "enableAdvisorSlot";

export interface SocialTechEffect {
  target: SocialTechEffectTarget;
  value: number;
}

