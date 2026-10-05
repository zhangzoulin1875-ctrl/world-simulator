import test from "node:test";
import assert from "node:assert/strict";
import {
  levyAmount, canStartMobilization, mobilizationBlocksContract, mobilizationStabilityDelta,
  militiaStatsForEra, MILITIA_BY_ERA, MOBILIZATION_MIN_STABILITY_TO_START,
} from "./totalMobilization";
import { ERA_COST_SCALE } from "./eraCostScale";

const ok = { isNpc: false, atWar: true, alreadyActive: false, hasActiveContract: false, stability: 50, levy: 1000 };

test("徵召量 = 可徵召人口的 10%(扣掉已在軍中的人口)", () => {
  assert.equal(levyAmount(1_000_000, 0), 100_000);
  assert.equal(levyAmount(1_000_000, 400_000), 60_000);
  assert.equal(levyAmount(1_000_000, 2_000_000), 0, "占用超過總人口 → 0,不為負");
  assert.equal(levyAmount(0, 0), 0);
  assert.equal(levyAmount(19, 0), 1, "向下取整");
});

test("開啟條件:戰時、玩家、無合約、穩定度夠、有人可徵", () => {
  assert.equal(canStartMobilization(ok).ok, true);
  assert.equal(canStartMobilization({ ...ok, isNpc: true }).ok, false);
  assert.equal(canStartMobilization({ ...ok, atWar: false }).ok, false);
  assert.equal(canStartMobilization({ ...ok, alreadyActive: true }).ok, false);
  assert.equal(canStartMobilization({ ...ok, levy: 0 }).ok, false);
  const c = canStartMobilization({ ...ok, hasActiveContract: true });
  assert.equal(c.ok, false);
  assert.match(c.reason, /僱傭兵合約/);
  assert.equal(canStartMobilization({ ...ok, stability: MOBILIZATION_MIN_STABILITY_TO_START - 1 }).ok, false);
  assert.equal(canStartMobilization({ ...ok, stability: MOBILIZATION_MIN_STABILITY_TO_START }).ok, true);
});

test("合約互斥:有合約不能開,開了也不能簽", () => {
  assert.equal(mobilizationBlocksContract(true).ok, false);
  assert.equal(mobilizationBlocksContract(false).ok, true);
});

test("穩定度:開啟每回合 −1,未開 0", () => {
  assert.equal(mobilizationStabilityDelta(true), -1);
  assert.equal(mobilizationStabilityDelta(false), 0);
});

test("每個時代都有民兵數值,且隨時代單調不減", () => {
  const eras = Object.keys(ERA_COST_SCALE);
  for (const e of eras) assert.ok(MILITIA_BY_ERA[e], `缺少 ${e}`);
  for (let i = 1; i < eras.length; i++) {
    const a = MILITIA_BY_ERA[eras[i - 1]!]!;
    const b = MILITIA_BY_ERA[eras[i]!]!;
    assert.ok(b.attack >= a.attack && b.hp >= a.hp && b.defense >= a.defense && b.accuracy >= a.accuracy, `${eras[i]} 不應弱於 ${eras[i - 1]}`);
  }
  assert.equal(militiaStatsForEra("not-an-era").label, MILITIA_BY_ERA["classical"]!.label);
});
