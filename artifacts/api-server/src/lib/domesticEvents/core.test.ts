import test from "node:test";
import assert from "node:assert/strict";
import {
  DOMESTIC_EVENTS, EVENT_CHANCE, EVENT_EVERY_TURNS, CIVIL_WAR_STABILITY_BELOW, CIVIL_WAR_CHANCE,
  isRollTurn, rollsEvent, pickEventKind, triggersCivilWar, applyEffects, validateEventCatalog, getEventDef,
} from "./core";

test("目錄:5 個事件、通過自檢;每個事件恰好 順應/鎮壓/拖延 各一", () => {
  assert.equal(DOMESTIC_EVENTS.length, 5);
  assert.deepEqual(validateEventCatalog(), []);
});

test("目錄自檢真的會抓錯(預設選項不存在、缺風格、非鎮壓帶內戰風險)", () => {
  const good = DOMESTIC_EVENTS[0]!;
  const bad1 = { ...good, defaultChoiceId: "nope" };
  assert.ok(validateEventCatalog([bad1]).some((p) => p.includes("預設選項")));
  const bad2 = { ...good, choices: good.choices.slice(0, 2) };
  assert.ok(validateEventCatalog([bad2]).some((p) => p.includes("順應/鎮壓/拖延")));
  const bad3 = { ...good, choices: good.choices.map((c) => (c.style === "comply" ? { ...c, effects: { ...c.effects, civilWarRisk: true } } : c)) };
  assert.ok(validateEventCatalog([bad3]).some((p) => p.includes("只有鎮壓")));
});

test("擲骰回合:每 2 個回合一次,tick 0 與非整數不擲", () => {
  assert.equal(EVENT_EVERY_TURNS, 2);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(isRollTurn), [false, false, true, false, true, false, true]);
  assert.equal(isRollTurn(2.5), false);
  assert.equal(isRollTurn(Number.NaN), false);
});

test("機率:30% 門檻(0.29 中、0.30 不中)", () => {
  assert.equal(EVENT_CHANCE, 0.3);
  assert.equal(rollsEvent(() => 0.29), true);
  assert.equal(rollsEvent(() => 0.3), false);
  assert.equal(rollsEvent(() => 0.99), false);
});

test("機率:大量模擬命中率接近 30%", () => {
  let hit = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (rollsEvent(Math.random)) hit++;
  const rate = hit / N;
  assert.ok(rate > 0.28 && rate < 0.32, `rate=${rate}`);
});

test("抽事件:依權重、可排除、排除光時退回全部、永遠回傳合法種類", () => {
  const kinds = new Set(DOMESTIC_EVENTS.map((e) => e.kind));
  assert.equal(pickEventKind(() => 0), DOMESTIC_EVENTS[0]!.kind);
  assert.equal(pickEventKind(() => 0.999999), DOMESTIC_EVENTS[DOMESTIC_EVENTS.length - 1]!.kind);
  assert.notEqual(pickEventKind(() => 0, ["recall_wave"]), "recall_wave");
  assert.ok(kinds.has(pickEventKind(() => 0, [...kinds])));
  const counts: Record<string, number> = {};
  for (let i = 0; i < 20000; i++) { const k = pickEventKind(Math.random); counts[k] = (counts[k] ?? 0) + 1; }
  assert.ok(counts["recall_wave"]! > counts["religious_revival"]!, "權重大的較常出現");
});

test("內戰風險:只有鎮壓(civilWarRisk)+穩定低於門檻+擲中才爆發", () => {
  const risky = { civilWarRisk: true };
  assert.equal(triggersCivilWar(risky, CIVIL_WAR_STABILITY_BELOW - 1, () => CIVIL_WAR_CHANCE - 0.01), true);
  assert.equal(triggersCivilWar(risky, CIVIL_WAR_STABILITY_BELOW - 1, () => CIVIL_WAR_CHANCE), false, "剛好不中");
  assert.equal(triggersCivilWar(risky, CIVIL_WAR_STABILITY_BELOW, () => 0), false, "穩定度剛好等於門檻不觸發");
  assert.equal(triggersCivilWar(risky, 80, () => 0), false, "穩定度高不觸發");
  assert.equal(triggersCivilWar({ stability: -5 }, 0, () => 0), false, "沒帶風險旗標不觸發");
});

test("套用效果:夾在 0-100、金錢不為負、議會增量另外回傳", () => {
  const n = { stability: 10, money: 1000, politicalSupport: 95, satisfactionMilitary: 5 };
  const r = applyEffects(n, { stability: -25, money: -5000, politicalSupport: 20, militarySatisfaction: -30, parliamentSatisfaction: -15 });
  assert.deepEqual(r, { stability: 0, money: 0, politicalSupport: 100, satisfactionMilitary: 0, parliamentDelta: -15 });
  assert.deepEqual(applyEffects(n, {}), { ...n, parliamentDelta: 0 });
});

test("社會黨多數:順應 = 社會黨進議會;鎮壓 = 逐出議會 + 內戰風險 + 穩定大降 + 軍方上升(使用者指定的代價)", () => {
  const d = getEventDef("socialist_majority")!;
  const comply = d.choices.find((c) => c.style === "comply")!;
  const crack = d.choices.find((c) => c.style === "crackdown")!;
  assert.equal(comply.effects.parliamentShift, "socialists_in");
  assert.equal(crack.effects.parliamentShift, "socialists_out");
  assert.equal(crack.effects.civilWarRisk, true);
  assert.ok((crack.effects.stability ?? 0) <= -20, "穩定度大降");
  assert.ok((crack.effects.militarySatisfaction ?? 0) > 0, "軍方滿意度上升");
});

test("所有鎮壓選項:穩定度不會上升太多(鎮壓不能是免費午餐)", () => {
  for (const d of DOMESTIC_EVENTS) {
    const crack = d.choices.find((c) => c.style === "crackdown")!;
    const cost = (crack.effects.stability ?? 0) + Math.min(0, crack.effects.parliamentSatisfaction ?? 0) + Math.min(0, crack.effects.militarySatisfaction ?? 0);
    assert.ok(cost < 0 || d.kind === "military_petition", `${d.kind} 鎮壓沒有代價`);
  }
});
