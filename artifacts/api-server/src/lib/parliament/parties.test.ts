import test from "node:test";
import assert from "node:assert/strict";
import { buildParties, partyCountForTier, stanceWeights, type NationFacts } from "./parties";
import { allocateSeats } from "./core";

const f = (o: Partial<NationFacts> = {}): NationFacts => ({
  nationName: "測試國", tier: "democracy", stability: 50, warWeariness: 0,
  militarySatisfaction: 60, atWar: false, taxRatePct: 1, governmentSlug: "parliamentary", ...o,
});

test("專制只有一個黨；半專制 3 黨；民主 5 黨", () => {
  assert.equal(buildParties(f({ tier: "autocracy" })).length, 1);
  assert.equal(buildParties(f({ tier: "semi" })).length, 3);
  assert.equal(buildParties(f({ tier: "democracy" })).length, 5);
  assert.equal(partyCountForTier("democracy"), 5);
});

test("專制黨為效忠派，席次 100", () => {
  const p = buildParties(f({ tier: "autocracy" }));
  assert.equal(p[0]!.stance, "loyalist");
  assert.equal(allocateSeats(p)[0]!.seats, 100);
});

test("戰爭中擴軍派權重大幅上升；神權政體宗教派居首", () => {
  assert.ok(stanceWeights(f({ atWar: true })).militarist > stanceWeights(f({ atWar: false })).militarist + 20);
  const theo = buildParties(f({ governmentSlug: "theocracy", tier: "semi" }));
  assert.equal(theo[0]!.stance, "religious");
});

test("高稅率推高節流派；低穩定推高福利派", () => {
  assert.ok(stanceWeights(f({ taxRatePct: 8 })).fiscal_hawk > stanceWeights(f({ taxRatePct: 1 })).fiscal_hawk);
  assert.ok(stanceWeights(f({ stability: 10 })).welfare > stanceWeights(f({ stability: 90 })).welfare);
});

test("確定性：同輸入同輸出；黨名不重複；席次合計 100", () => {
  const a = buildParties(f()); const b = buildParties(f());
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((p) => p.name)).size, a.length);
  assert.equal(allocateSeats(a).reduce((s, p) => s + p.seats, 0), 100);
});

test("極端輸入（NaN/負值）不產生 NaN 權重", () => {
  const w = stanceWeights(f({ stability: NaN as any, warWeariness: -5, militarySatisfaction: NaN as any, taxRatePct: NaN as any }));
  for (const v of Object.values(w)) assert.ok(Number.isFinite(v) && v >= 1, String(v));
});
