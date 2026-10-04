import type { GeneralSkill } from "@workspace/db";

/**
 * 武將系統 — 常數與純函式（數值全部伺服器決定；AI 只生成敘事）。
 *
 * 設計（2026-10-04 與玩家拍板）：
 *  - 抽取成本 = 國庫 5% ＋ 當回合可用生產力 5%；一回合一抽（flow 表判定）。
 *  - 抽出為「候選」，玩家決定招募（上限 8 名已招募）或遣返（不退資源）。
 *  - 升階：成本指數成長（×2.5/級）、成功率指數下降（80%×0.6/級，下限 5%），
 *    失敗資源照扣、品級不變。
 *  - 武將指派到戰役軍團（A/B/C），加成只作用於該軍團內「相容分類」的兵種，
 *    與武器乘數相乘疊加。
 */

/** 已招募武將上限（候選與遣返不計）。 */
export const GENERAL_CAP_RECRUITED = 8;
/** 品級上限。 */
export const GENERAL_MAX_GRADE = 5;
/** 抽取：國庫百分比。 */
export const GENERAL_DRAW_MONEY_PCT = 5;
/** 抽取：當回合可用生產力百分比。 */
export const GENERAL_DRAW_PRODUCTION_PCT = 5;
/** 升階成本倍率（每品級 ×2.5）。 */
export const GENERAL_UPGRADE_COST_MULTIPLIER = 2;
/** 升階基礎成本占「國庫 / 可用生產力」百分比（1→2 階起算，之後每階 ×倍率；單次封頂 90%）。 */
export const GENERAL_UPGRADE_BASE_PCT_OF_TREASURY = 10;
export const GENERAL_UPGRADE_MAX_PCT_OF_TREASURY = 90;
/** 升階成功率基準與衰減（80% × 0.6^級）。 */
export const GENERAL_UPGRADE_BASE_PCT = 80;
export const GENERAL_UPGRADE_DECAY = 0.6;
/** 成功率下限（%）。 */
export const GENERAL_UPGRADE_MIN_PCT = 5;
/** 每品級的攻/防加成（百分點；品級 5 = +20%）。 */
export const GENERAL_GRADE_BONUS_PCT_PER_GRADE = 4;
/** 預產池：單一「時代×文化圈」桶維持的備用卡數（worker 補位目標）。 */
export const GENERAL_POOL_TARGET_PER_BUCKET = 2;

/**
 * 三條技能的固定規格（伺服器決定；AI 只生成名稱與描述）。
 * unlockGrade = 解鎖品級：1 = 初始即有，2 / 4 = 升階解鎖。
 */
export const GENERAL_SKILL_SPECS: readonly {
  effect: "offense" | "defense" | "versatile";
  bonusPct: number;
  unlockGrade: number;
}[] = [
  { effect: "offense", bonusPct: 6, unlockGrade: 1 },
  { effect: "defense", bonusPct: 6, unlockGrade: 2 },
  { effect: "versatile", bonusPct: 8, unlockGrade: 4 },
];

/** 品級 → 已解鎖技能。 */
export function unlockedSkills(
  skills: readonly GeneralSkill[],
  grade: number,
): GeneralSkill[] {
  return skills.filter((s) => s.unlockGrade <= grade);
}

/** 抽取成本（金錢 + 生產力；無條件進位，最小 1）。 */
export function drawCost(money: number, availableProduction: number): {
  money: number;
  production: number;
} {
  return {
    money: Math.max(1, Math.ceil((money * GENERAL_DRAW_MONEY_PCT) / 100)),
    production: Math.max(
      1,
      Math.ceil((availableProduction * GENERAL_DRAW_PRODUCTION_PCT) / 100),
    ),
  };
}

/**
 * 升階成本（按比例扣除）：國庫與可用生產力的 10% × 2^(當前品級−1)，
 * 即 1→2 階 10%、2→3 階 20%、3→4 階 40%、4→5 階 80%；單次上限 90%，
 * 失敗照扣。比例制讓富國與窮國的痛感一致。
 */
export function upgradeCost(money: number, availableProduction: number, grade: number): {
  money: number;
  production: number;
} {
  const pct = Math.min(
    GENERAL_UPGRADE_MAX_PCT_OF_TREASURY,
    GENERAL_UPGRADE_BASE_PCT_OF_TREASURY *
      Math.pow(GENERAL_UPGRADE_COST_MULTIPLIER, grade - 1),
  );
  return {
    money: Math.max(1, Math.ceil((Math.max(0, money) * pct) / 100)),
    production: Math.max(
      1,
      Math.ceil((Math.max(0, availableProduction) * pct) / 100),
    ),
  };
}

/** 升階成功率（%；整數化、下限 5）。 */
export function upgradeSuccessPct(grade: number): number {
  const raw =
    GENERAL_UPGRADE_BASE_PCT *
    Math.pow(GENERAL_UPGRADE_DECAY, grade - 1);
  return Math.max(
    GENERAL_UPGRADE_MIN_PCT,
    Math.round(raw),
  );
}

/**
 * 武將戰鬥乘數（純函式）：品級加成 + 已解鎖技能效果，換算成該軍團內
 * 「相容分類」兵種的攻/防乘數。只乘相容兵種的貢獻（與武器乘數同層）。
 */
export function generalCombatMods(params: {
  grade: number;
  skills: readonly GeneralSkill[];
}): { offenseMult: number; defenseMult: number } {
  const gradeBonus =
    Math.max(1, Math.min(GENERAL_MAX_GRADE, params.grade)) *
    GENERAL_GRADE_BONUS_PCT_PER_GRADE;
  let off = gradeBonus;
  let def = gradeBonus;
  for (const s of unlockedSkills(params.skills, params.grade)) {
    if (s.effect === "offense") off += s.bonusPct;
    else if (s.effect === "defense") def += s.bonusPct;
    else {
      off += s.bonusPct;
      def += s.bonusPct;
    }
  }
  return { offenseMult: 1 + off / 100, defenseMult: 1 + def / 100 };
}

/** 洗牌用的確定性隨機整數 [0, n)。 */
export function randInt(n: number): number {
  return Math.floor(Math.random() * n);
}
