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
  assert.ok(stanceWeights(f({ atWar: true }), (() => 0.5)).militarist > stanceWeights(f({ atWar: false }), (() => 0.5)).militarist + 20);
  // 隨機之下神權國的宗教派「多半」居首（不必每次）：300 次裡至少 55%。
  let top = 0;
  for (let i = 0; i < 300; i++) {
    const t = [...allocateSeats(buildParties(f({ governmentSlug: "theocracy", tier: "semi" })))].sort((a, b) => b.seats - a.seats)[0]!;
    if (t.stance === "religious") top++;
  }
  assert.ok(top / 300 >= 0.55, `神權國宗教派居首僅 ${top}/300`);
});

test("高稅率推高節流派；低穩定推高福利派", () => {
  assert.ok(stanceWeights(f({ taxRatePct: 8 }), (() => 0.5)).fiscal_hawk > stanceWeights(f({ taxRatePct: 1 }), (() => 0.5)).fiscal_hawk);
  assert.ok(stanceWeights(f({ stability: 10 }), (() => 0.5)).welfare > stanceWeights(f({ stability: 90 }), (() => 0.5)).welfare);
});

/** 固定序列的 rng（循環），用來得到可重現的結果。 */
const seq = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]!; };

test("注入相同 rng → 同輸出；黨名不重複；席次合計 100", () => {
  const a = buildParties(f(), seq([0.2, 0.9, 0.5, 0.7, 0.1, 0.8, 0.4, 0.6, 0.3]));
  const b = buildParties(f(), seq([0.2, 0.9, 0.5, 0.7, 0.1, 0.8, 0.4, 0.6, 0.3]));
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((p) => p.name)).size, a.length);
  assert.equal(allocateSeats(a).reduce((s, p) => s + p.seats, 0), 100);
});

test("極端輸入（NaN/負值）不產生 NaN 權重", () => {
  const w = stanceWeights(f({ stability: NaN as any, warWeariness: -5, militarySatisfaction: NaN as any, taxRatePct: NaN as any }), (() => 0.5));
  for (const v of Object.values(w)) assert.ok(Number.isFinite(v) && v >= 1, String(v));
});

test("席次隨機性：同一個承平國情重建 400 次，各立場都有機會成為第一大黨，和平派不再壟斷", () => {
  const first: Record<string, number> = {};
  const seatsOfFirst: number[] = [];
  const signatures = new Set<string>();
  for (let i = 0; i < 400; i++) {
    const parties = buildParties(f());
    const seated = allocateSeats(parties);
    const top = [...seated].sort((a, b) => b.seats - a.seats)[0]!;
    first[top.stance] = (first[top.stance] ?? 0) + 1;
    seatsOfFirst.push(top.seats);
    signatures.add(seated.map((p) => `${p.stance}:${p.seats}`).join("|"));
  }
  const pacifistShare = (first["pacifist"] ?? 0) / 400;
  assert.ok(pacifistShare < 0.35, `和平派仍佔第一大黨 ${(pacifistShare * 100).toFixed(0)}%`);
  assert.ok(Object.keys(first).length >= 4, `只有 ${Object.keys(first).join(",")} 當過第一大黨`);
  assert.ok(signatures.size > 100, `席次組合只有 ${signatures.size} 種，隨機性不足`);
  assert.ok(Math.max(...seatsOfFirst) - Math.min(...seatsOfFirst) >= 12, "第一大黨席次範圍太窄");
});

test("戰時仍明顯偏向擴軍派（隨機不推翻國情）", () => {
  let militaristTop = 0;
  for (let i = 0; i < 300; i++) {
    const top = [...allocateSeats(buildParties(f({ atWar: true, warWeariness: 10 })))].sort((a, b) => b.seats - a.seats)[0]!;
    if (top.stance === "militarist") militaristTop++;
  }
  assert.ok(militaristTop / 300 > 0.4, `戰時擴軍派第一大黨僅 ${militaristTop}/300`);
});
