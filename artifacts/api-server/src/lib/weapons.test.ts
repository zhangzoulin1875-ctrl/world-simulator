import test from "node:test";
import assert from "node:assert/strict";
import {
  WEAPON_INCOMPATIBLE_PENALTY_PCT,
  clampCompatibleCategories,
  describeWeaponMods,
  weaponCombatMods,
  weaponCompatibleWith,
} from "./weapons";
import { computeEffectivePower, type PowerLegionInput } from "./war";

/** 武器系統純函式：相容/不相容乘數與技能效果分佈。 */
test("weaponCombatMods：未裝備 = 乘數 1", () => {
  const mods = weaponCombatMods({
    equipped: false,
    compatible: true,
    attackPct: 15,
    defensePct: 15,
    skillEffect: "offense",
    skillBonusPct: 10,
  });
  assert.equal(mods.offenseMult, 1);
  assert.equal(mods.defenseMult, 1);
});

test("weaponCombatMods：相容 → 攻防加成 + 技能效果（offense 全額進攻）", () => {
  const mods = weaponCombatMods({
    equipped: true,
    compatible: true,
    attackPct: 10,
    defensePct: 5,
    skillEffect: "offense",
    skillBonusPct: 8,
  });
  assert.equal(mods.offenseMult, 1 + 0.1 + 0.08);
  assert.equal(mods.defenseMult, 1 + 0.05);
});

test("weaponCombatMods：versatile 技能攻守各半", () => {
  const mods = weaponCombatMods({
    equipped: true,
    compatible: true,
    attackPct: 0,
    defensePct: 0,
    skillEffect: "versatile",
    skillBonusPct: 10,
  });
  assert.equal(mods.offenseMult, 1.05);
  assert.equal(mods.defenseMult, 1.05);
});

test("weaponCombatMods：不相容 → 攻防同乘懲罰、加成不生效", () => {
  const mods = weaponCombatMods({
    equipped: true,
    compatible: false,
    attackPct: 15,
    defensePct: 15,
    skillEffect: "offense",
    skillBonusPct: 10,
  });
  const penalty = 1 - WEAPON_INCOMPATIBLE_PENALTY_PCT / 100;
  assert.equal(mods.offenseMult, penalty);
  assert.equal(mods.defenseMult, penalty);
});

test("weaponCompatibleWith：相容類別判定", () => {
  const weapon = { compatibleCategories: ["infantry", "ranged"] } as Parameters<
    typeof weaponCompatibleWith
  >[0];
  assert.equal(weaponCompatibleWith(weapon, "infantry"), true);
  assert.equal(weaponCompatibleWith(weapon, "armor"), false);
});

test("clampCompatibleCategories：非法值過濾、去重、上限 3、空陣列回退全類別", () => {
  const clamped = clampCompatibleCategories([
    "infantry",
    "infantry",
    "hacker",
    "ranged",
    "armor",
    "artillery",
  ]);
  assert.deepEqual(clamped, ["infantry", "ranged", "armor"]);
  assert.ok(clampCompatibleCategories([]).length > 0, "空陣列回退為全類別");
  assert.ok(Array.isArray(clampCompatibleCategories(undefined)));
});

test("describeWeaponMods：顯示摘要", () => {
  assert.equal(
    describeWeaponMods({
      equipped: false,
      compatible: true,
      attackPct: 0,
      defensePct: 0,
      skillEffect: "versatile",
      skillBonusPct: 0,
    }),
    "未裝備",
  );
  assert.match(
    describeWeaponMods({
      equipped: true,
      compatible: false,
      attackPct: 10,
      defensePct: 10,
      skillEffect: "versatile",
      skillBonusPct: 10,
    }),
    /不合用/,
  );
  const label = describeWeaponMods({
    equipped: true,
    compatible: true,
    attackPct: 10,
    defensePct: 5,
    skillEffect: "offense",
    skillBonusPct: 8,
  });
  assert.ok(label.includes("攻 +10%") && label.includes("防 +5%"));
  assert.ok(label.includes("技能效果：攻 +8%"));
});

/** 戰鬥結算：武器乘數必須放大該兵種的攻/防貢獻。 */
function makeSide(
  units: PowerLegionInput["units"],
): import("./war").SidePowerInput {
  return {
    legions: [
      { morale: 100, supply: 100, garrisoning: false, aggressionPct: 50, units },
    ],
    attackModifierPct: 0,
    wallDefenseBonusPct: 0,
  };
}

test("computeEffectivePower：武器乘數放大單兵種攻擊貢獻", () => {
  const plain = makeSide([{ quantity: 100, attack: 10, defense: 5, hp: 5 }]);
  const armed = makeSide([
    { quantity: 100, attack: 10, defense: 5, hp: 5, offenseMult: 1.2, defenseMult: 1.1 },
  ]);
  const a = computeEffectivePower(plain);
  const b = computeEffectivePower(armed);
  // 基準攻擊力 = 100 × 10；防禦貢獻 = 100 × (5 + 5)
  assert.equal(b.offense, a.offense * 1.2);
  assert.equal(b.defense, a.defense * 1.1);
  assert.equal(b.troops, a.troops, "武器不影響兵力總數");
});

test("computeEffectivePower：缺省乘數（未裝備）與舊路徑完全一致", () => {
  const a = computeEffectivePower(makeSide([{ quantity: 50, attack: 8, defense: 4, hp: 6 }]));
  const b = computeEffectivePower(
    makeSide([
      { quantity: 50, attack: 8, defense: 4, hp: 6, offenseMult: 1, defenseMult: 1 },
    ]),
  );
  assert.equal(a.offense, b.offense);
  assert.equal(a.defense, b.defense);
});

test("computeEffectivePower：不相容懲罰乘數降低戰力", () => {
  const plain = makeSide([{ quantity: 100, attack: 10, defense: 5, hp: 5 }]);
  const bad = makeSide([
    { quantity: 100, attack: 10, defense: 5, hp: 5, offenseMult: 0.9, defenseMult: 0.9 },
  ]);
  const a = computeEffectivePower(plain);
  const c = computeEffectivePower(bad);
  assert.ok(c.offense < a.offense && c.defense < a.defense);
});

import { inferExplicitCategories, mergeCompatibleCategories } from "./weapons";

test("clampCompatibleCategories：帶 allowed 時剔除被鎖定類別，全空回退 allowed", () => {
  const allowed = ["infantry", "armor"] as const;
  assert.deepEqual(
    clampCompatibleCategories(["ranged", "infantry", "air"], allowed),
    ["infantry"],
  );
  assert.deepEqual(clampCompatibleCategories(["ranged"], allowed), ["infantry", "armor"]);
});

test("inferExplicitCategories / mergeCompatibleCategories：騎兵槍必含 armor（即使 AI 只給步兵）", () => {
  const explicit = inferExplicitCategories("騎兵長槍", "我要一把騎兵用的長槍");
  assert.ok(explicit.includes("armor"));
  const merged = mergeCompatibleCategories(["infantry"], explicit, ["infantry", "armor", "artillery"]);
  assert.equal(merged[0], "armor", "明確指名者排最前");
  assert.ok(merged.includes("infantry"));
});

test("mergeCompatibleCategories：被鎖定的類別即使名稱提到也不會出現", () => {
  const explicit = inferExplicitCategories("強弩", "");
  assert.ok(explicit.includes("ranged"));
  const merged = mergeCompatibleCategories([], explicit, ["infantry", "armor"]);
  assert.ok(!merged.includes("ranged"));
  assert.deepEqual(merged, ["infantry", "armor"]);
});
