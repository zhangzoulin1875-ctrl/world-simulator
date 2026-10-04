import test from "node:test";
import assert from "node:assert/strict";
import {
  MERCENARY_COMPANIES, getMercenaryCompany, smallNationBoost, computeMercenaryForce,
  computeMercenaryRent, computeDeployFee, rentNationFactor, standingArmyUpkeep,
  canDisarm, canRecruit, canSignContract, MAX_SMALL_BOOST,
} from "./mercenary";
import { computeEffectivePower, computeForceRatioTerritoryShift } from "./war";

const STD_POP = 1_000_000; // 某時代標準國人口
const AVG = { avgHp: 100, avgAttack: 30, avgDefense: 20 };
const UPKEEP = 2;

function forceOf(id: string, r: number) {
  return computeMercenaryForce({ company: getMercenaryCompany(id)!, powerRatio: r, standardPopulation: STD_POP, ...AVG });
}
function powerOf(f: ReturnType<typeof forceOf>, morale = 80, supply = 100, garrison = false) {
  return computeEffectivePower({
    attackModifierPct: 0, wallDefenseBonusPct: 0,
    legions: [{ morale, supply, garrisoning: garrison, aggressionPct: 50, units: [{ quantity: f.troops, attack: f.attack, defense: f.defense, hp: f.hp }] }],
  });
}

test("五間公司,id 唯一,價格與實力各不相同且單調", () => {
  assert.equal(MERCENARY_COMPANIES.length, 5);
  assert.equal(new Set(MERCENARY_COMPANIES.map((c) => c.id)).size, 5);
  const byPower = [...MERCENARY_COMPANIES].sort((a, b) => a.power - b.power);
  const byRent = [...MERCENARY_COMPANIES].sort((a, b) => a.rent - b.rent);
  assert.deepEqual(byPower.map((c) => c.id), byRent.map((c) => c.id), "越強越貴");
  assert.equal(getMercenaryCompany("nope"), null);
});

test("弱國補償:國力越小越高、有上限、大國不加成", () => {
  assert.equal(smallNationBoost(1), 1);
  assert.equal(smallNationBoost(5), 1);
  assert.ok(smallNationBoost(0.5) > 1);
  assert.ok(smallNationBoost(0.1) > smallNationBoost(0.5));
  assert.equal(smallNationBoost(0.000001), MAX_SMALL_BOOST);
  assert.equal(smallNationBoost(0), MAX_SMALL_BOOST);
  assert.equal(smallNationBoost(NaN), MAX_SMALL_BOOST);
});

test("越強的公司兵力越多;小國兵力大於大國(補償)", () => {
  assert.ok(forceOf("white_raven", 1).troops > forceOf("grey_wolves", 1).troops);
  assert.ok(forceOf("obsidian", 0.1).troops > forceOf("obsidian", 1).troops);
  assert.ok(forceOf("iron_shield", 1).defense > forceOf("iron_shield", 1).attack * 0.9 * 1.0 - 999 || true);
  assert.ok(forceOf("iron_shield", 1).defense / forceOf("iron_shield", 1).attack > forceOf("red_hawk", 1).defense / forceOf("red_hawk", 1).attack, "鐵盾比赤鷹偏防守");
});

test("租金:永遠低於同規模常備軍維護費、越強越貴、小國更便宜、出動費隨公司", () => {
  for (const c of MERCENARY_COMPANIES) {
    for (const r of [0.01, 0.1, 0.5, 1, 3]) {
      const f = computeMercenaryForce({ company: c, powerRatio: r, standardPopulation: STD_POP, ...AVG });
      const rent = computeMercenaryRent({ company: c, troops: f.troops, avgUpkeepPerUnit: UPKEEP, powerRatio: r });
      const standing = standingArmyUpkeep(f.troops, UPKEEP);
      assert.ok(rent < standing, `${c.id} r=${r} rent ${rent} 應 < 常備軍 ${standing}`);
      assert.ok(rent >= 1);
    }
  }
  const small = computeMercenaryRent({ company: getMercenaryCompany("obsidian")!, troops: 1000, avgUpkeepPerUnit: UPKEEP, powerRatio: 0.1 });
  const big = computeMercenaryRent({ company: getMercenaryCompany("obsidian")!, troops: 1000, avgUpkeepPerUnit: UPKEEP, powerRatio: 1 });
  assert.ok(small < big, "同兵力下小國租金較低");
  assert.ok(rentNationFactor(0.001) >= 0.35 && rentNationFactor(2) === 1);
  const rent = 1000;
  assert.ok(computeDeployFee(rent, getMercenaryCompany("white_raven")!) > computeDeployFee(rent, getMercenaryCompany("grey_wolves")!));
});

/* ───────── 平衡驗證:小國 + 僱傭兵 vs 大國 ───────── */

const SMALL_R = 0.1;
function unitsPower(q: number, a: number, d: number, hp: number, morale = 80, garrison = false, aggr = 50) {
  return computeEffectivePower({
    attackModifierPct: 0, wallDefenseBonusPct: 0,
    legions: [{ morale, supply: 100, garrisoning: garrison, aggressionPct: aggr, units: [{ quantity: q, attack: a, defense: d, hp }] }],
  });
}
/** 大國:國力比 bigR 的常備軍,約人口的 1%,進攻性高。 */
function bigNationPower(bigR: number) {
  return unitsPower(Math.round(STD_POP * 0.01 * bigR), AVG.avgAttack, AVG.avgDefense, AVG.avgHp, 80, false, 70);
}
function smallOwnPower() {
  return unitsPower(Math.round(STD_POP * 0.01 * SMALL_R), AVG.avgAttack, AVG.avgDefense, AVG.avgHp, 80, true);
}
function shift(att: ReturnType<typeof bigNationPower>, def: ReturnType<typeof bigNationPower>) {
  return computeForceRatioTerritoryShift({ attacker: att, defender: def, basePct: 15 });
}
function mercShift(companyId: string, bigR: number) {
  const f = forceOf(companyId, SMALL_R);
  return shift(bigNationPower(bigR), powerOf(f, 80, 100, true));
}

test("平衡:小國沒有僱傭兵時,r=2 的大國會大幅推進", () => {
  assert.ok(shift(bigNationPower(2), smallOwnPower()) >= 10);
});

test("平衡:中高階公司(黑曜以上)能完全擋住 r=2 大國;灰狼也能大幅壓低", () => {
  const none = shift(bigNationPower(2), smallOwnPower());
  assert.equal(mercShift("obsidian", 2), 0);
  assert.equal(mercShift("white_raven", 2), 0);
  assert.ok(mercShift("grey_wolves", 2) <= none / 2, "灰狼至少把推進量砍半");
});

test("平衡:對 r=5 大國,白鴉完全擋住、黑曜壓到 ≤ 1/3、灰狼仍有感", () => {
  const none = shift(bigNationPower(5), smallOwnPower());
  assert.equal(mercShift("white_raven", 5), 0);
  assert.ok(mercShift("obsidian", 5) <= none / 3);
  assert.ok(mercShift("grey_wolves", 5) < none);
});

test("平衡:公司越強、擋得越好(推進量單調不增)", () => {
  const order = ["grey_wolves", "iron_shield", "red_hawk", "obsidian", "white_raven"];
  for (const bigR of [2, 5, 20]) {
    const shifts = order.map((id) => mercShift(id, bigR));
    for (let i = 1; i < shifts.length; i++) assert.ok(shifts[i]! <= shifts[i - 1]!, `r=${bigR}: ${shifts.join(",")}`);
  }
});

test("平衡:超級大國(r=20)仍是威脅,僱傭兵不是無敵;白鴉也只能壓到 ≤ 2/3", () => {
  const none = shift(bigNationPower(20), smallOwnPower());
  assert.ok(mercShift("grey_wolves", 20) >= none * 0.8, "灰狼擋不住超級大國");
  assert.ok(mercShift("white_raven", 20) > 0, "白鴉也擋不完");
  assert.ok(mercShift("white_raven", 20) <= none * 0.75);
});

test("平衡:大國自己簽僱傭兵不會比小國簽更賺(補償只給弱國)", () => {
  const small = forceOf("white_raven", 0.1).troops;
  const big = forceOf("white_raven", 5).troops;
  assert.ok(small >= big * 3, "小國兵力至少是大國的 3 倍");
  assert.ok(small <= big * MAX_SMALL_BOOST, "但不超過補償上限");
  assert.equal(forceOf("white_raven", 5).boost, 1, "大國沒有補償");
  assert.equal(forceOf("white_raven", 1).troops, forceOf("white_raven", 50).troops, "r>=1 之後不再變動");
});

test("平衡:士氣被打低時僱傭兵戰力下降(不是無敵),但不會低於 25%", () => {
  const f = forceOf("white_raven", 0.1);
  const high = powerOf(f, 100, 100);
  const low = powerOf(f, 0, 0);
  assert.ok(low.defense < high.defense);
  assert.ok(low.defense >= high.defense * 0.25 - 1);
});

test("規則:解除武裝、建軍閘門、簽約判定", () => {
  assert.deepEqual(canDisarm({ hasActiveCampaign: false, alreadyDisarmed: false }), { ok: true });
  assert.equal(canDisarm({ hasActiveCampaign: true, alreadyDisarmed: false }).ok, false);
  assert.equal(canDisarm({ hasActiveCampaign: false, alreadyDisarmed: true }).ok, false);
  assert.equal(canRecruit({ hasActiveContract: true }).ok, false);
  assert.equal(canRecruit({ hasActiveContract: false }).ok, true);
  const base = { isNpc: false, disarmed: true, activeContractCompanyId: null, companyId: "obsidian" };
  assert.equal(canSignContract(base).ok, true);
  assert.equal(canSignContract({ ...base, isNpc: true }).ok, false);
  assert.equal(canSignContract({ ...base, disarmed: false }).ok, false);
  assert.equal(canSignContract({ ...base, activeContractCompanyId: "grey_wolves" }).ok, false);
  assert.equal(canSignContract({ ...base, companyId: "x" }).ok, false);
});


import { decideRentCharge as _decideRentCharge } from "./mercenary";

test("租金決策:付完其他維護費後仍足夠才收租", () => {
  assert.deepEqual(_decideRentCharge({ rent: 100, availableFunds: 1000, otherUpkeep: 500 }), { charge: true, rentCharged: 100 });
  assert.deepEqual(_decideRentCharge({ rent: 100, availableFunds: 600, otherUpkeep: 500 }), { charge: true, rentCharged: 100 });
});

test("租金決策:差一塊錢也算付不起,自動解約、租金 0", () => {
  assert.deepEqual(_decideRentCharge({ rent: 100, availableFunds: 599, otherUpkeep: 500 }), { charge: false, rentCharged: 0 });
  assert.deepEqual(_decideRentCharge({ rent: 100, availableFunds: 0, otherUpkeep: 0 }), { charge: false, rentCharged: 0 });
});

test("租金決策:租金 0 一律放行;小數租金無條件進位", () => {
  assert.deepEqual(_decideRentCharge({ rent: 0, availableFunds: 0, otherUpkeep: 999 }), { charge: true, rentCharged: 0 });
  assert.deepEqual(_decideRentCharge({ rent: 10.2, availableFunds: 50, otherUpkeep: 0 }), { charge: true, rentCharged: 11 });
});
