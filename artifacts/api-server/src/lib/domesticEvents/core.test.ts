import test from "node:test";
import assert from "node:assert/strict";
import {
  DOMESTIC_EVENTS, EVENT_CHANCE, EVENT_EVERY_TURNS, CIVIL_WAR_STABILITY_BELOW, CIVIL_WAR_CHANCE,
  isRollTurn, rollsEvent, pickEventKind, eventKindsOnCooldown, pickEventKindWithCooldown, EVENT_REPEAT_COOLDOWN_TURNS, triggersCivilWar, applyEffects, validateEventCatalog, getEventDef,
} from "./core";
import { EVENT_CATEGORIES, EVENT_CATEGORY_META } from "./categories";

test("目錄:100 個事件、10 個分類各 10 個、通過自檢;每個事件恰好 順應/鎮壓/拖延 各一", () => {
  assert.equal(DOMESTIC_EVENTS.length, 100);
  assert.deepEqual(validateEventCatalog(), []);
  for (const m of EVENT_CATEGORY_META) {
    assert.equal(DOMESTIC_EVENTS.filter((e) => e.category === m.id).length, 10, `${m.id} 應有 10 個`);
  }
  assert.equal(EVENT_CATEGORY_META.length, EVENT_CATEGORIES.length);
});

test("舊事件 id 與數值保持不變（資料庫裡已存在的事件仍能解析）", () => {
  const expect: Record<string, string> = {
    recall_wave: "politics", socialist_majority: "politics", military_petition: "military",
    economic_crisis: "economy", religious_revival: "religion",
  };
  for (const [k, cat] of Object.entries(expect)) {
    const d = getEventDef(k)!;
    assert.ok(d, k); assert.equal(d.category, cat);
    assert.deepEqual(d.choices.map((c) => c.id), ["comply", "crackdown", "delay"]);
  }
  assert.deepEqual(getEventDef("recall_wave")!.choices[0]!.effects, { stability: 8, parliamentSatisfaction: 10, militarySatisfaction: -5 });
  assert.deepEqual(getEventDef("economic_crisis")!.choices[1]!.effects, { money: 1500, stability: -8, parliamentSatisfaction: -6 });
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

test("抽事件:兩段式（先分類再事件）、可排除、排除光時退回全部、永遠回傳合法種類", () => {
  const kinds = new Set(DOMESTIC_EVENTS.map((e) => e.kind));
  assert.equal(pickEventKind(() => 0), DOMESTIC_EVENTS[0]!.kind, "rand=0：第一個分類的第一個事件");
  const last = EVENT_CATEGORY_META[EVENT_CATEGORY_META.length - 1]!.id;
  const lastOfLast = DOMESTIC_EVENTS.filter((e) => e.category === last).at(-1)!.kind;
  assert.equal(pickEventKind(() => 0.999999), lastOfLast, "rand≈1：最後一個分類的最後一個事件");
  assert.notEqual(pickEventKind(() => 0, ["recall_wave"]), "recall_wave");
  assert.ok(kinds.has(pickEventKind(() => 0, [...kinds])), "全被排除時退回全池");
  for (let i = 0; i < 2000; i++) assert.ok(kinds.has(pickEventKind(Math.random)));
});

test("抽事件:各分類被抽到的比例貼近分類權重（不會因某類事件多而壓過其他類）", () => {
  const N = 60000; const byCat: Record<string, number> = {};
  const cat = new Map(DOMESTIC_EVENTS.map((e) => [e.kind, e.category]));
  for (let i = 0; i < N; i++) { const c = cat.get(pickEventKind(Math.random))!; byCat[c] = (byCat[c] ?? 0) + 1; }
  const totalW = EVENT_CATEGORY_META.reduce((a, m) => a + m.weight, 0);
  for (const m of EVENT_CATEGORY_META) {
    const want = m.weight / totalW; const got = (byCat[m.id] ?? 0) / N;
    assert.ok(Math.abs(got - want) < 0.015, `${m.id} 期望 ${want.toFixed(3)} 實際 ${got.toFixed(3)}`);
  }
});

test("抽事件:某分類整類都在冷卻時，不會抽到該類，其餘分類照常", () => {
  const politics = DOMESTIC_EVENTS.filter((e) => e.category === "politics").map((e) => e.kind);
  const cat = new Map(DOMESTIC_EVENTS.map((e) => [e.kind, e.category]));
  for (let i = 0; i < 3000; i++) assert.notEqual(cat.get(pickEventKind(Math.random, politics)), "politics");
});

test("抽事件:同分類內依事件權重，權重大的較常出現", () => {
  const cat = DOMESTIC_EVENTS.filter((e) => e.category === "politics");
  const hi = cat.reduce((a, b) => (b.weight > a.weight ? b : a)); const lo = cat.reduce((a, b) => (b.weight < a.weight ? b : a));
  assert.ok(hi.weight > lo.weight);
  const counts: Record<string, number> = {};
  for (let i = 0; i < 80000; i++) { const k = pickEventKind(Math.random); counts[k] = (counts[k] ?? 0) + 1; }
  assert.ok((counts[hi.kind] ?? 0) > (counts[lo.kind] ?? 0), `${hi.kind}(${hi.weight}) 應多於 ${lo.kind}(${lo.weight})`);
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

test("重複冷卻：同種事件 32 回合內不能再發，第 32 回合起解禁", () => {
  assert.equal(EVENT_REPEAT_COOLDOWN_TURNS, 32);
  const h = [{ kind: "recall_wave", createdTick: 10 }];
  assert.deepEqual(eventKindsOnCooldown(h, 10), ["recall_wave"]);
  assert.deepEqual(eventKindsOnCooldown(h, 41), ["recall_wave"], "差 31 回合仍在冷卻");
  assert.deepEqual(eventKindsOnCooldown(h, 42), [], "差 32 回合解禁");
});

test("重複冷卻：同種有多筆時以最近一次為準", () => {
  const h = [{ kind: "recall_wave", createdTick: 2 }, { kind: "recall_wave", createdTick: 40 }];
  assert.deepEqual(eventKindsOnCooldown(h, 60), ["recall_wave"]);
});

test("重複冷卻：抽選絕不抽到冷卻中的種類（隨機 20000 次）", () => {
  const h = [{ kind: "recall_wave", createdTick: 50 }, { kind: "economic_crisis", createdTick: 48 }];
  for (let i = 0; i < 20000; i++) {
    const k = pickEventKindWithCooldown(Math.random, h, 60);
    assert.ok(k !== null && k !== "recall_wave" && k !== "economic_crisis");
  }
});

test("重複冷卻：全部種類都在冷卻 → 回傳 null（這回合不發），不會退回全池", () => {
  const h = DOMESTIC_EVENTS.map((e, i) => ({ kind: e.kind, createdTick: 100 + i }));
  assert.equal(pickEventKindWithCooldown(Math.random, h, 110), null);
  assert.notEqual(pickEventKindWithCooldown(Math.random, h, 100 + 31 + DOMESTIC_EVENTS.length), null, "冷卻陸續解禁後又能抽");
});

test("重複冷卻：沒有歷史時行為與原本相同", () => {
  assert.equal(pickEventKindWithCooldown(() => 0, [], 5), DOMESTIC_EVENTS[0]!.kind);
});
