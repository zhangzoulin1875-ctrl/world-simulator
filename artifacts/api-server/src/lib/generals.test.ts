import test from "node:test";
import assert from "node:assert/strict";
import {
  drawCost,
  upgradeCost,
  upgradeSuccessPct,
  unlockedSkills,
  generalCombatMods,
  GENERAL_CAP_RECRUITED,
  GENERAL_MAX_GRADE,
} from "./generals";
import type { GeneralSkill } from "@workspace/db";

const skill = (
  effect: "offense" | "defense" | "versatile",
  bonusPct: number,
  unlockGrade: number,
): GeneralSkill => ({
  name: `測試技能_${effect}_${bonusPct}`,
  description: "測試用",
  effect,
  bonusPct,
  unlockGrade,
});

/** 抽取成本：5% 國庫 + 5% 可用生產力；無條件進位、最小 1。 */
test("drawCost：5% 無條件進位、下限 1", () => {
  assert.deepEqual(drawCost(1000, 2000), { money: 50, production: 100 });
  // 5% = 0.5 → 進位為 1（最小值）
  assert.deepEqual(drawCost(10, 5), { money: 1, production: 1 });
  // 0 資源也要付 1（防呆）
  assert.deepEqual(drawCost(0, 0), { money: 1, production: 1 });
  // 5% 非整數 → ceil
  assert.deepEqual(drawCost(101, 103), { money: 6, production: 6 });
});

/** 升階成本：國庫/可用生產力的 10% × 2^(grade−1)，上限 90%。 */
test("upgradeCost：按比例、逐階翻倍", () => {
  assert.deepEqual(upgradeCost(1000, 2000, 1), { money: 100, production: 200 });
  assert.deepEqual(upgradeCost(1000, 2000, 2), { money: 200, production: 400 });
  assert.deepEqual(upgradeCost(1000, 2000, 3), { money: 400, production: 800 });
  assert.deepEqual(upgradeCost(1000, 2000, 4), { money: 800, production: 1600 });
  // 封頂 90%
  assert.deepEqual(upgradeCost(1000, 2000, 5), { money: 900, production: 1800 });
  // 0 資源也要付 1（防呆）
  assert.deepEqual(upgradeCost(0, 0, 1), { money: 1, production: 1 });
});

/** 升階成功率：80% × 0.6^(grade−1)，整數化、下限 5%。 */
test("upgradeSuccessPct：指數遞減、下限 5", () => {
  assert.equal(upgradeSuccessPct(1), 80);
  assert.equal(upgradeSuccessPct(2), 48);
  assert.equal(upgradeSuccessPct(3), 29);
  // grade 5：80×0.6^4≈10.37 → 10
  assert.equal(upgradeSuccessPct(5), 10);
  // 超過上限品級也回下限（呼叫端會先擋）
  assert.equal(upgradeSuccessPct(99), 5);
});

/** 技能解鎖：品級過濾。 */
test("unlockedSkills：品級過濾", () => {
  const skills = [
    skill("offense", 6, 1),
    skill("defense", 6, 2),
    skill("versatile", 8, 4),
  ];
  assert.equal(unlockedSkills(skills, 1).length, 1);
  assert.equal(unlockedSkills(skills, 2).length, 2);
  assert.equal(unlockedSkills(skills, 5).length, 3);
});

/** 戰力乘數：品級 4%/級；攻/防技能 +6%；全才 +8% 攻防皆全額。 */
test("generalCombatMods：品級與技能合成", () => {
  // 純品級：grade 5 → 20% → 1.20
  const bare = generalCombatMods({ grade: 5, skills: [] });
  assert.equal(bare.offenseMult, 1.2);
  assert.equal(bare.defenseMult, 1.2);

  // 品級 1 + 攻擊 6% → 攻 1.10、防 1.04
  const off = generalCombatMods({
    grade: 1,
    skills: [skill("offense", 6, 1)],
  });
  assert.equal(off.offenseMult, 1.1);
  assert.equal(off.defenseMult, 1.04);

  // 品級 2（8%）+ 防 6%（品級 2 解鎖）；全才 8%（品級 4 才解鎖 → 不計）
  // → 攻 1.08、防 1.14
  const gated = generalCombatMods({
    grade: 2,
    skills: [skill("defense", 6, 2), skill("versatile", 8, 4)],
  });
  assert.ok(Math.abs(gated.offenseMult - 1.08) < 1e-9);
  assert.ok(Math.abs(gated.defenseMult - 1.14) < 1e-9);

  // 品級 5（20%）+ 防 6% + 全才 8%（攻防皆全額）→ 攻 1.28、防 1.34
  const full = generalCombatMods({
    grade: 5,
    skills: [skill("defense", 6, 2), skill("versatile", 8, 4)],
  });
  assert.ok(Math.abs(full.offenseMult - 1.28) < 1e-9);
  assert.ok(Math.abs(full.defenseMult - 1.34) < 1e-9);
});

/** 常數防呆：改動上限會影響多處文案與規則，測試鎖定。 */
test("常數鎖定", () => {
  assert.equal(GENERAL_CAP_RECRUITED, 8);
  assert.equal(GENERAL_MAX_GRADE, 5);
});
