/**
 * 奪權內戰的純邏輯(無資料庫,可單元測試)。
 *
 * 定案(2026-10-05):
 *  - 民主國家議會革命:革命方分走 40% 土地。
 *  - 獨裁國家被共產革命:革命方只分走 35% 土地。
 *  - 黑線奪權(軍事強人起事):革命方分走 40%。
 *  - 內戰無法停戰,必須有一方被完全消滅(守衛見 civilWar.ts)。
 */
import { AUTOCRACY_RED_REVOLUTION_LAND_SHARE } from "./focus/regimeGraph";
import { REVOLUTION_SPLIT_RATIO } from "./parliament/core";

export type RebelIdeology = "black" | "red" | "parliament";

/** 革命方分走的土地比例:共產革命打獨裁 35%,其餘 40%。 */
export function splitRatioFor(ideology: RebelIdeology, originIsAutocracy: boolean): number {
  if (ideology === "red" && originIsAutocracy) return AUTOCRACY_RED_REVOLUTION_LAND_SHARE;
  return REVOLUTION_SPLIT_RATIO;
}

/** 革命方若贏,原政權轉成哪個政體(slug)。 */
export const VICTORY_GOVERNMENT: Record<RebelIdeology, string> = {
  red: "council_system",
  black: "military_dictatorship",
  parliament: "parliamentary_republic",
};

export type CivilWarOutcome =
  | { finished: false }
  | { finished: true; winner: "incumbent" | "rebel"; reason: string };

/**
 * 勝負判定:一方完全沒有土地 = 被消滅。
 * 兩邊都沒地(不應發生)保守判原政權勝,避免無主的國家被硬改政體。
 */
export function judgeCivilWar(incumbentLand: number, rebelLand: number): CivilWarOutcome {
  const incumbentDead = incumbentLand <= 0;
  const rebelDead = rebelLand <= 0;
  if (!incumbentDead && !rebelDead) return { finished: false };
  if (rebelDead) {
    return { finished: true, winner: "incumbent", reason: incumbentDead ? "雙方皆無土地,視為原政權保有正統" : "革命軍已被完全消滅" };
  }
  return { finished: true, winner: "rebel", reason: "原政權已被完全推翻" };
}

/** 分裂政權的名字(去掉標點空白,限 25 字,與既有命名規則一致)。 */
export function rebelNationName(regionName: string | undefined, ideology: RebelIdeology): string {
  const suffix = ideology === "red" ? "革命政權" : ideology === "black" ? "軍閥政權" : "獨立政權";
  return `${regionName ?? "叛亂"}${suffix}`.slice(0, 25).replace(/[\s\p{P}]/gu, "");
}

export const INCUMBENT_VICTORY_STABILITY = 10;
export const REBEL_VICTORY_STABILITY = -10;
