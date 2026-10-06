import test from "node:test";
import assert from "node:assert/strict";
import {
  PRESSURE_START, REVOLT_AT, clampPressure, discontentBonus, nextPressure,
  regionsReadyToRevolt, responseRelief, spawnChancePct,
} from "./revolutionWave";

const base = { stage: "peak", severity: 50, impactMult: 1, stability: 50, unrest: 0, fit: null as number | null };

test("clampPressure 夾在 0~100,非有限值回 0", () => {
  assert.equal(clampPressure(150), 100);
  assert.equal(clampPressure(-5), 0);
  assert.equal(clampPressure(Number.NaN), 0);
});

test("discontentBonus:中性為 0,低穩定/高暴動為正,且夾限", () => {
  assert.equal(discontentBonus(50, 0), 0);
  assert.ok(discontentBonus(20, 40) > 0);
  assert.equal(discontentBonus(0, 100), 8);
  assert.equal(discontentBonus(100, 0), -3);
});

test("responseRelief:無應對/低契合 = 0,滿分 18,單調遞增", () => {
  assert.equal(responseRelief(null), 0);
  assert.equal(responseRelief(29), 0);
  assert.equal(responseRelief(100), 18);
  assert.ok(responseRelief(80) > responseRelief(50));
});

test("不處理:高峰期每回合上升,起始 20 約 6~7 回合內爆發", () => {
  let p = PRESSURE_START, turns = 0;
  while (p < REVOLT_AT && turns < 50) { p = nextPressure({ ...base, pressure: p }); turns++; }
  assert.ok(p >= REVOLT_AT);
  assert.ok(turns >= 4 && turns <= 10, `turns=${turns}`);
});

test("認真處理(契合 90)可壓回去;中等契合(55)擋不住高峰期", () => {
  let good = 50, mid = 50;
  for (let i = 0; i < 6; i++) {
    good = nextPressure({ ...base, pressure: good, fit: 90 });
    mid = nextPressure({ ...base, pressure: mid, fit: 55 });
  }
  assert.ok(good < 50, `good=${good}`);
  assert.ok(mid > 50, `mid=${mid}`);
});

test("消退期自然回落,且不乘嚴重度", () => {
  const a = nextPressure({ ...base, stage: "receding", pressure: 60, severity: 100 });
  const b = nextPressure({ ...base, stage: "receding", pressure: 60, severity: 10 });
  assert.equal(a, 54); assert.equal(b, 54);
});

test("regionsReadyToRevolt 只挑到線的地區", () => {
  assert.deepEqual(regionsReadyToRevolt([{ regionId: 1, pressure: 100 }, { regionId: 2, pressure: 99.9 }, { regionId: 3, pressure: 100 }]), [1, 3]);
});

test("spawnChancePct:穩定/平靜為 0,越糟越高,上限 12", () => {
  assert.equal(spawnChancePct(60, 5), 0);
  assert.equal(spawnChancePct(40, 20), 0);
  assert.ok(spawnChancePct(25, 40) > 0);
  assert.equal(spawnChancePct(0, 100), 12);
});
