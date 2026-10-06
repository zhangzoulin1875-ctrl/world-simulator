import test from "node:test";
import assert from "node:assert/strict";
import { planParliamentTurn, type PlanInput } from "./plan";
import { fallbackMessage, type ComplianceSnapshot, type ParliamentStance, type SeatedParty } from "./core";

const parties: SeatedParty[] = [
  { id: "a", name: "鷹派黨", stance: "militarist", weight: 60, seats: 60 },
  { id: "b", name: "和平黨", stance: "pacifist", weight: 40, seats: 40 },
];
const snap = (o: Partial<ComplianceSnapshot> = {}): ComplianceSnapshot => ({
  atWar: false, militarySpendChange: 0, taxChange: 0, wrotePolicy: true, religionLean: 0, commerceUp: false, ...o,
});
const base = (o: Partial<PlanInput> = {}): PlanInput => ({
  tier: "democracy", tick: 0, satisfaction: 60, lastDemandTick: null, activeDemand: null,
  parties, snapshot: snap(), militarySatisfaction: null, ...o,
});

test("民主：第一次結算就提出要求（含抗議 + 政策要求兩種內容）", () => {
  const r = planParliamentTurn(base());
  assert.equal(r.tick, 1);
  assert.ok(r.protestText && r.protestText.length > 0, "抗議內容");
  assert.ok(r.activeDemand && r.activeDemand.text.length > 0, "政策要求");
  assert.equal(r.activeDemand!.stance, "militarist"); // 執政黨 = 席次最多的鷹派黨
  assert.equal(r.lastDemandTick, 1);
  assert.ok(r.logs.some((l) => l.kind === "demand"));
});

test("專制：橡皮圖章——不提要求、不扣分、滿意度鎖高、不革命", () => {
  const r = planParliamentTurn(base({ tier: "autocracy", satisfaction: 0, snapshot: snap({ wrotePolicy: false }) }));
  assert.equal(r.activeDemand, null); assert.equal(r.revolt, false);
  assert.equal(r.satisfaction, 80); assert.equal(r.logs.length, 0);
});

test("要求期間每回合都判定；沒寫政策 = 輕度違背；三回合後結案", () => {
  let s = planParliamentTurn(base());                    // tick1 提出
  let st = { sat: s.satisfaction, tick: s.tick, last: s.lastDemandTick, act: s.activeDemand };
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = planParliamentTurn(base({ tick: st.tick, satisfaction: st.sat, lastDemandTick: st.last, activeDemand: st.act as any, snapshot: snap({ wrotePolicy: false }) }));
    const j = r.logs.find((l) => l.kind === "judgement");
    assert.ok(j, `第 ${i + 1} 回合必須判定`);
    assert.match(j!.summary, /預設輕度違背/);
    seen.push(j!.summary);
    st = { sat: r.satisfaction, tick: r.tick, last: r.lastDemandTick, act: r.activeDemand };
  }
  assert.equal(seen.length, 3);
});

function runPeriod(tier: "semi" | "democracy", s: Partial<ComplianceSnapshot>) {
  let r = planParliamentTurn(base({ tier, satisfaction: 60 }));
  const start = r.satisfaction; let sat = r.satisfaction;
  let st = { tick: r.tick, last: r.lastDemandTick, act: r.activeDemand };
  const deltas: number[] = [];
  for (let i = 0; i < 3; i++) {
    r = planParliamentTurn(base({ tier, tick: st.tick, satisfaction: sat, lastDemandTick: st.last, activeDemand: st.act as any, snapshot: snap(s) }));
    deltas.push(r.satisfaction - sat); sat = r.satisfaction; st = { tick: r.tick, last: r.lastDemandTick, act: r.activeDemand };
  }
  return { start, end: sat, deltas };
}

test("半專制：一次要求期(三回合)累計最多 -8，即使三回合都嚴重違背", () => {
  const { start, end, deltas } = runPeriod("semi", { militarySpendChange: -0.3 });
  assert.equal(start - end, 8, `deltas=${deltas}`);
  assert.ok(deltas.every((d) => d <= 0));
});

test("民主：同樣嚴重違背累計可到 -25 封頂，明顯大於半專制", () => {
  const { start, end } = runPeriod("democracy", { militarySpendChange: -0.3 });
  assert.ok(start - end > 8, "民主扣得比半專制多");
  assert.ok(start - end <= 25);
});

test("半專制全程遵守 → 不扣反加", () => {
  const { start, end } = runPeriod("semi", { militarySpendChange: 0.2 });
  assert.ok(end > start);
});

test("議會滿意度歸零 → 革命，之後回到 40 並清空要求", () => {
  const r = planParliamentTurn(base({
    satisfaction: 1,
    tick: 5, lastDemandTick: 3,
    activeDemand: { stance: "militarist", text: "x", issuedTick: 3, levels: [] },
    snapshot: snap({ militarySpendChange: -0.5 }),
  }));
  assert.equal(r.revolt, true);
  assert.equal(r.satisfaction, 40);
  assert.equal(r.activeDemand, null);
  assert.ok(r.logs.some((l) => l.kind === "revolution"));
});

test("沒有政黨時不會崩，也不提要求", () => {
  const r = planParliamentTurn(base({ parties: [] }));
  assert.equal(r.activeDemand, null); assert.equal(r.revolt, false);
});

test("要求在期內不會重複提出新的", () => {
  const first = planParliamentTurn(base());
  const second = planParliamentTurn(base({ tick: first.tick, satisfaction: first.satisfaction, lastDemandTick: first.lastDemandTick, activeDemand: first.activeDemand as any }));
  assert.equal(second.logs.filter((l) => l.kind === "demand").length, 0);
});

// ── 回歸:沒有戰爭時,議會不可抱怨「連年征戰」(使用者回報) ───────────────
const pacifistRuling: SeatedParty[] = [
  { id: "p", name: "和平黨", stance: "pacifist", weight: 70, seats: 70 },
  { id: "m", name: "鷹派黨", stance: "militarist", weight: 30, seats: 30 },
];

test("和平派執政但國家沒有戰爭:抗議不得提到征戰/流血", () => {
  const r = planParliamentTurn(base({ parties: pacifistRuling, atWar: false }));
  assert.ok(r.protestText, "仍要有抗議內容");
  assert.doesNotMatch(r.protestText!, /征戰|流血/);
  assert.equal(r.activeDemand!.stance, "pacifist"); // 政策要求照常提出
});

test("沒傳 atWar 視為和平(預設值安全)", () => {
  const r = planParliamentTurn(base({ parties: pacifistRuling }));
  assert.doesNotMatch(r.protestText!, /征戰|流血/);
});

test("和平派執政且確實在打仗:才可以抱怨連年征戰", () => {
  const r = planParliamentTurn(base({ parties: pacifistRuling, atWar: true }));
  assert.match(r.protestText!, /征戰/);
});

test("所有立場在和平時的抗議都不得提到戰事", () => {
  const stances: ParliamentStance[] = ["militarist", "pacifist", "fiscal_hawk", "welfare", "religious", "secular", "mercantile"];
  for (const st of stances) {
    const m = fallbackMessage(st, "測試黨", "democracy", false);
    assert.doesNotMatch(m.protest, /連年征戰|流血|戰火/, `${st}: ${m.protest}`);
  }
});
