/**
 * 「全民皆兵」規則核心(DB-free 純函式,全部可單元測試)。
 *
 * 規則:
 *  - 只有玩家國家能開;必須處於戰爭中(有未結束的 diplomacy_wars)。
 *  - 開啟時把全國「可徵召人口」的 10% 轉成民兵。民兵在軍事系統視為正規部隊(player_armies 一列),
 *    只占人口,不占生產力、不收金錢、不吃木礦。
 *  - 開啟期間每回合固定扣一點穩定度。
 *  - 與僱傭兵合約互斥:有合約不能開;開了民兵也不能簽約(民兵算常備軍,需先解散)。
 *  - 關閉/解散民兵:釋放占用的人口,人口總數補回。
 */

/** 徵召比例:全國人口的 10%。 */
export const MOBILIZATION_POP_RATIO = 0.1;
/** 開啟期間每回合固定扣的穩定度(點)。 */
export const MOBILIZATION_STABILITY_PER_TURN = 1;
/** 穩定度低於這個值就不能再開(避免在崩潰邊緣加碼)。 */
export const MOBILIZATION_MIN_STABILITY_TO_START = 20;

/** 民兵單兵的人口成本:1 人口 = 1 名民兵。 */
export const MILITIA_POP_PER_UNIT = 1;

export interface MilitiaStats {
  hp: number;
  attack: number;
  defense: number;
  speed: number;
  accuracy: number;
  range: "melee" | "ranged";
  /** 時代武器世代名稱(給介面顯示)。 */
  label: string;
}

/**
 * 各時代民兵的預設數值。刻意低於正規兵(量大質低),隨時代成長;
 * 數值代表「拿當時代最普通的武器徵召的平民」,不是精銳。
 */
export const MILITIA_BY_ERA: Readonly<Record<string, MilitiaStats>> = {
  classical: { hp: 8, attack: 3, defense: 2, speed: 4, accuracy: 35, range: "melee", label: "持矛平民" },
  roman: { hp: 9, attack: 3, defense: 3, speed: 4, accuracy: 36, range: "melee", label: "輔助民兵" },
  early_medieval: { hp: 9, attack: 4, defense: 3, speed: 4, accuracy: 37, range: "melee", label: "鄉勇" },
  high_medieval: { hp: 10, attack: 4, defense: 4, speed: 4, accuracy: 38, range: "melee", label: "農民徵召兵" },
  renaissance: { hp: 10, attack: 5, defense: 4, speed: 4, accuracy: 40, range: "ranged", label: "火繩槍民兵" },
  discovery: { hp: 11, attack: 6, defense: 4, speed: 4, accuracy: 42, range: "ranged", label: "殖民地民兵" },
  scientific: { hp: 11, attack: 7, defense: 5, speed: 4, accuracy: 44, range: "ranged", label: "燧發槍民兵" },
  enlightenment: { hp: 12, attack: 8, defense: 5, speed: 4, accuracy: 46, range: "ranged", label: "國民衛隊" },
  industrial: { hp: 13, attack: 10, defense: 6, speed: 4, accuracy: 50, range: "ranged", label: "後膛槍民兵" },
  ww1: { hp: 14, attack: 13, defense: 7, speed: 4, accuracy: 54, range: "ranged", label: "後備役步兵" },
  ww2: { hp: 15, attack: 16, defense: 8, speed: 4, accuracy: 58, range: "ranged", label: "人民自衛隊" },
  cold_war: { hp: 16, attack: 20, defense: 9, speed: 4, accuracy: 62, range: "ranged", label: "預備役民兵" },
  modern: { hp: 17, attack: 25, defense: 10, speed: 4, accuracy: 66, range: "ranged", label: "全民國防志願兵" },
  future: { hp: 18, attack: 30, defense: 12, speed: 4, accuracy: 70, range: "ranged", label: "外骨骼後備役" },
};

/** 取某時代的民兵數值;未知時代退回古典。 */
export function militiaStatsForEra(eraSlug: string | null | undefined): MilitiaStats {
  return (eraSlug && MILITIA_BY_ERA[eraSlug]) || MILITIA_BY_ERA["classical"]!;
}

/** 徵召人數 = ⌊可徵召人口 × 10%⌋。可徵召人口 = 總人口 − 已被占用的人口(不能徵召已在軍中的人)。 */
export function levyAmount(totalPopulation: number, populationSpent: number): number {
  const available = Math.max(0, Math.floor(totalPopulation) - Math.max(0, Math.floor(populationSpent)));
  return Math.floor(available * MOBILIZATION_POP_RATIO);
}

export interface StartCheckInput {
  isNpc: boolean;
  atWar: boolean;
  alreadyActive: boolean;
  hasActiveContract: boolean;
  stability: number;
  levy: number;
}

export interface Check {
  ok: boolean;
  reason: string;
}

/** 可否開啟全民皆兵。順序即錯誤訊息優先序。 */
export function canStartMobilization(input: StartCheckInput): Check {
  if (input.isNpc) return { ok: false, reason: "NPC 國家不使用全民皆兵" };
  if (input.alreadyActive) return { ok: false, reason: "全民皆兵已經開啟" };
  if (input.hasActiveContract) {
    return { ok: false, reason: "簽有僱傭兵合約期間不能開啟全民皆兵,請先解約" };
  }
  if (!input.atWar) return { ok: false, reason: "只有處於戰爭狀態時才能開啟全民皆兵" };
  if (input.stability < MOBILIZATION_MIN_STABILITY_TO_START) {
    return {
      ok: false,
      reason: `穩定度過低(需至少 ${MOBILIZATION_MIN_STABILITY_TO_START}),無法動員全民`,
    };
  }
  if (input.levy <= 0) return { ok: false, reason: "可徵召人口不足" };
  return { ok: true, reason: "" };
}

/** 全民皆兵開啟中就不能簽僱傭兵(民兵視同常備軍;解散民兵或關閉後才能簽)。 */
export function mobilizationBlocksContract(active: boolean): Check {
  if (active) return { ok: false, reason: "全民皆兵開啟中,請先關閉並解散民兵才能簽訂軍事合約" };
  return { ok: true, reason: "" };
}

/** 回合穩定度增量(負值)。未開啟 → 0。 */
export function mobilizationStabilityDelta(active: boolean): number {
  return active ? -MOBILIZATION_STABILITY_PER_TURN : 0;
}
