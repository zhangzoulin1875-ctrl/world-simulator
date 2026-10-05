import test from "node:test";
import assert from "node:assert/strict";
import { passiveLeanRates, stochasticRound, calculatePassiveLeanDeltas, type PassiveLeanInput } from "./core";

const base: PassiveLeanInput = {
  satisfactionMilitary: 50, atWar: false, armyRatioPct: 1, tier: "autocracy",
  stability: 50, politicalSupport: 50, parliamentSatisfaction: 50, blackLean: 0, redLean: 0,
};
const mk = (o: Partial<PassiveLeanInput>): PassiveLeanInput => ({ ...base, ...o });

test("情境A:長期動盪的獨裁國家,紅線每回合 +2(封頂),約 33 回合到 65", () => {
  const r = passiveLeanRates(mk({ stability: 20, politicalSupport: 15, parliamentSatisfaction: 20 }));
  assert.equal(r.red, 2);
  assert.equal(Math.ceil(65 / r.red), 33);
});

test("中度不滿:期望約 +1.15/回合,約 57~65 回合到 65(數天到一週以上)", () => {
  const r = passiveLeanRates(mk({ stability: 30, politicalSupport: 25, parliamentSatisfaction: 30 }));
  assert.ok(Math.abs(r.red - 1.15) < 1e-9);
  assert.ok(65 / r.red > 50 && 65 / r.red < 70);
});

test("情境B:軍國擴張(軍方85、戰爭、軍隊占10%),黑線每回合 +2,25 回合到 50", () => {
  const r = passiveLeanRates(mk({ satisfactionMilitary: 85, atWar: true, armyRatioPct: 10 }));
  assert.equal(r.black, 2);
  assert.equal(50 / r.black, 25);
});

test("情境C:和平民主國家,黑線每回合約 -1.3(含自然回歸),會衰減到 0 不永久鎖死", () => {
  const r = passiveLeanRates(mk({ tier: "democracy", stability: 80, blackLean: 30 }));
  assert.ok(Math.abs(r.black - -1.3) < 1e-9);
});

test("穩定度高時紅線衰減;半專制壓制黑線較輕", () => {
  assert.ok(passiveLeanRates(mk({ stability: 80, redLean: 40 })).red < 0);
  const semi = passiveLeanRates(mk({ tier: "semi", satisfactionMilitary: 85 })).black;
  const auto = passiveLeanRates(mk({ tier: "autocracy", satisfactionMilitary: 85 })).black;
  assert.ok(semi < auto);
});

test("平靜無事:雙線都不動(沒有憑空增長)", () => {
  assert.deepEqual(passiveLeanRates(mk({})), { black: 0, red: 0 });
});

test("每回合變動夾在 ±2", () => {
  const r = passiveLeanRates(mk({ satisfactionMilitary: 100, atWar: true, armyRatioPct: 50, stability: 0, politicalSupport: 0, parliamentSatisfaction: 0 }));
  assert.ok(r.black <= 2 && r.red <= 2);
  assert.ok(passiveLeanRates(mk({ tier: "democracy", stability: 100, blackLean: 50, redLean: 50 })).red >= -2);
});

test("stochasticRound:整數原樣;小數依機率進位", () => {
  assert.equal(stochasticRound(2), 2);
  assert.equal(stochasticRound(-1), -1);
  assert.equal(stochasticRound(0.4, () => 0.39), 1);
  assert.equal(stochasticRound(0.4, () => 0.41), 0);
  assert.equal(stochasticRound(-1.3, () => 0.2), -2);
  assert.equal(stochasticRound(-1.3, () => 0.5), -1);
});

test("stochasticRound 的期望值等於原值(+0.4 跑 20000 次平均約 0.4;不會被四捨五入吃掉)", () => {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const x of [0.4, -0.3, 1.15, -1.3]) {
    let sum = 0;
    for (let i = 0; i < 20000; i++) sum += stochasticRound(x, rand);
    assert.ok(Math.abs(sum / 20000 - x) < 0.03, `${x} -> ${sum / 20000}`);
  }
});

test("calculatePassiveLeanDeltas 不會把值推出 0~100", () => {
  const atTop = calculatePassiveLeanDeltas(mk({ stability: 0, politicalSupport: 0, parliamentSatisfaction: 0, redLean: 100 }), () => 0);
  assert.equal(atTop.redDelta, 0);
  const atZero = calculatePassiveLeanDeltas(mk({ tier: "democracy", blackLean: 0 }), () => 0);
  assert.equal(atZero.blackDelta, 0);
});
