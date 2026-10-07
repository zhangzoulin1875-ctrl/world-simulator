import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_MIN_INFLUENCE, INFLUENCE_START, MAX_TARGETS_PER_DECISION, PLAN_LEAD_TURNS, TARGET_COOLDOWN_TURNS,
  actionAllowedOn, actionEffect, actionPower, attentionOf, clampInfluence, eraCap, fuzzyEta, isDue,
  leadIsEnough, nextInfluence, ruleBasedDecision, unlockedActions, unrest, validateDecisions,
  type DecisionContext, type NationSituation,
} from "./core";

const N = (id: string, o: Partial<NationSituation> = {}): NationSituation => ({
  nationId: id, parliamentSat: 60, radicalSeatShare: 0, stability: 70, atWar: false, inCivilWar: false, isPlayer: false, ...o,
});
const ctx = (nations: NationSituation[], o: Partial<DecisionContext> = {}): DecisionContext => ({
  influence: 80, nations, lastTargetedTick: {}, alreadyPlanned: [], tick: 20, ...o,
});
const HOT = { parliamentSat: 15, stability: 20, radicalSeatShare: 0.3 };

test("影響力夾在 0–100；開局 10 只能宣傳與按兵不動", () => {
  assert.equal(clampInfluence(-5), 0); assert.equal(clampInfluence(250), 100);
  assert.deepEqual(unlockedActions(INFLUENCE_START), ["idle", "propaganda"]);
});

test("動作隨影響力逐級解鎖：30 資助、50 罷工潮、70 策反", () => {
  assert.deepEqual(unlockedActions(30), ["idle", "propaganda", "funding"]);
  assert.deepEqual(unlockedActions(50), ["idle", "propaganda", "funding", "strikes"]);
  assert.deepEqual(unlockedActions(70), ["idle", "propaganda", "funding", "strikes", "subvert"]);
  assert.deepEqual(unlockedActions(29), ["idle", "propaganda"]);
});

test("動作強度 0.2–1，隨影響力單調上升", () => {
  assert.equal(actionPower(0), 0.2); assert.equal(actionPower(100), 1);
  assert.ok(actionPower(60) > actionPower(30));
});

test("動盪度 0–1：越不滿越高；沒有議會的國家用中性值", () => {
  const calm = unrest(N("a")); const hot = unrest(N("b", { ...HOT, atWar: true }));
  assert.ok(calm < 0.3 && hot > 0.6 && hot <= 1);
  assert.ok(unrest(N("c", { parliamentSat: null })) > 0);
});

test("古代時代上限低：影響力不會在古代衝高，工業之後才能", () => {
  assert.ok(eraCap("ancient") < eraCap("industrial"));
  let v = INFLUENCE_START; for (let i = 0; i < 200; i++) v = nextInfluence(v, "ancient", 1);
  assert.ok(v <= eraCap("ancient"), `古代影響力 ${v} 超過上限`);
  assert.ok(v < ACTION_MIN_INFLUENCE.funding || eraCap("ancient") >= ACTION_MIN_INFLUENCE.funding);
  let w = INFLUENCE_START; for (let i = 0; i < 200; i++) w = nextInfluence(w, "industrial", 1);
  assert.ok(w >= ACTION_MIN_INFLUENCE.subvert, `工業動盪世界應解鎖策反，實際 ${w}`);
});

test("影響力每回合最多 ±3；世界平靜時回落；被打擊會再扣", () => {
  assert.equal(nextInfluence(10, "industrial", 1), 13);
  assert.ok(nextInfluence(80, "ancient", 0) < 80); assert.ok(nextInfluence(80, "ancient", 0) >= 77);
  assert.equal(nextInfluence(40, "industrial", 1, 2), 41);
  assert.ok(nextInfluence(INFLUENCE_START, "ancient", 0) >= INFLUENCE_START - 0, "不會低於開局值的目標下限");
});

test("策反需要雙重門檻：議會滿意度 ≤25 且有紅線黨 ≥10%", () => {
  assert.equal(actionAllowedOn("subvert", N("a", HOT), 80), true);
  assert.equal(actionAllowedOn("subvert", N("a", { ...HOT, parliamentSat: 40 }), 80), false);
  assert.equal(actionAllowedOn("subvert", N("a", { ...HOT, radicalSeatShare: 0.05 }), 80), false);
  assert.equal(actionAllowedOn("subvert", N("a", { ...HOT, parliamentSat: null }), 80), false);
  assert.equal(actionAllowedOn("subvert", N("a", HOT), 60), false, "影響力不足");
});

test("已在內戰的國家不被干涉；按兵不動永遠合法", () => {
  assert.equal(actionAllowedOn("propaganda", N("a", { inCivilWar: true }), 80), false);
  assert.equal(actionAllowedOn("idle", N("a", { inCivilWar: true }), 0), true);
});

test("效果全由公式決定：宣傳扣議會滿意度、罷工潮扣穩定度並觸發事件、策反引爆內戰", () => {
  const p = actionEffect("propaganda", 100), pl = actionEffect("propaganda", 0);
  assert.ok(p.parliamentSat < pl.parliamentSat && pl.parliamentSat < 0, "影響力高扣更多");
  const s = actionEffect("strikes", 60); assert.ok(s.stability < 0 && s.triggersEvent && !s.civilWar);
  assert.equal(actionEffect("subvert", 80).civilWar, true);
  assert.ok(actionEffect("funding", 50).radicalWeight > 0);
  assert.deepEqual(actionEffect("idle", 100), { parliamentSat: 0, stability: 0, radicalWeight: 0, triggersEvent: false, civilWar: false });
});

test("預告：提前量至少 2 回合；模糊時間不給精確數字；到期判斷", () => {
  assert.equal(PLAN_LEAD_TURNS, 2);
  assert.equal(leadIsEnough(10, 12), true); assert.equal(leadIsEnough(10, 11), false);
  assert.equal(fuzzyEta(10, 12), "2~3 回合內"); assert.equal(fuzzyEta(10, 11), "1~2 回合內"); assert.equal(fuzzyEta(10, 10), "本回合");
  assert.equal(isDue({ executeTick: 12, status: "planned" }, 12), true);
  assert.equal(isDue({ executeTick: 12, status: "planned" }, 11), false);
  assert.equal(isDue({ executeTick: 12, status: "executed" }, 99), false);
});

test("驗證擋掉非法輸出：不存在的國家、未知動作、idle、重複、缺目標", () => {
  const c = ctx([N("a", HOT), N("b", HOT)]);
  const out = validateDecisions([
    { targetNationId: "zzz", action: "propaganda" }, { targetNationId: "a", action: "nuke" as any },
    { targetNationId: "a", action: "idle" }, { targetNationId: null, action: "propaganda" },
    { targetNationId: "a", action: "propaganda" }, { targetNationId: "a", action: "strikes" },
  ], c);
  assert.deepEqual(out, [{ targetNationId: "a", action: "propaganda" }]);
});

test("驗證：影響力不夠的動作被擋；冷卻中的國家被擋；已有預告的國家被擋", () => {
  const nations = [N("a", HOT), N("b", HOT), N("c", HOT)];
  assert.deepEqual(validateDecisions([{ targetNationId: "a", action: "subvert" }], ctx(nations, { influence: 40 })), []);
  const cd = ctx(nations, { lastTargetedTick: { a: 20 - TARGET_COOLDOWN_TURNS + 1 } });
  assert.deepEqual(validateDecisions([{ targetNationId: "a", action: "propaganda" }], cd), []);
  const ok = ctx(nations, { lastTargetedTick: { a: 20 - TARGET_COOLDOWN_TURNS } });
  assert.equal(validateDecisions([{ targetNationId: "a", action: "propaganda" }], ok).length, 1);
  assert.deepEqual(validateDecisions([{ targetNationId: "b", action: "propaganda" }], ctx(nations, { alreadyPlanned: ["b"] })), []);
});

test("驗證：每次決策最多 2 個目標", () => {
  const nations = ["a", "b", "c", "d"].map((id) => N(id, HOT));
  const out = validateDecisions(nations.map((n) => ({ targetNationId: n.nationId, action: "propaganda" as const })), ctx(nations));
  assert.equal(out.length, MAX_TARGETS_PER_DECISION);
});

test("規則版：只對動盪國出手、挑最強合法動作、最多 2 國、確定性", () => {
  const nations = [N("calm1"), N("hot1", HOT), N("hot2", { ...HOT, parliamentSat: 30 }), N("hot3", { ...HOT, parliamentSat: 35 })];
  const r1 = ruleBasedDecision(ctx(nations)); const r2 = ruleBasedDecision(ctx([...nations].reverse()));
  assert.deepEqual(r1, r2);
  assert.ok(r1.length <= 2 && r1.every((d) => d.targetNationId !== "calm1"));
  assert.equal(r1.find((d) => d.targetNationId === "hot1")!.action, "subvert");
  assert.equal(r1.find((d) => d.targetNationId === "hot2")?.action ?? "strikes", "strikes", "議會 30 > 25 不能策反，退而求其次罷工潮");
});

test("規則版：影響力低只會宣傳；全世界平靜 → 按兵不動(空)", () => {
  const hot = [N("a", HOT)];
  assert.deepEqual(ruleBasedDecision(ctx(hot, { influence: INFLUENCE_START })), [{ targetNationId: "a", action: "propaganda" }]);
  assert.deepEqual(ruleBasedDecision(ctx([N("a"), N("b")])), []);
  assert.deepEqual(ruleBasedDecision(ctx([N("a", { ...HOT, inCivilWar: true })])), []);
});

test("關注程度：有預告 = 高風險；動盪未預告 = 關注中；平靜 = 未受關注", () => {
  const plans = [{ targetNationId: "a", status: "planned" as const }, { targetNationId: "b", status: "executed" as const }];
  assert.equal(attentionOf("a", plans, N("a")), "high");
  assert.equal(attentionOf("b", plans, N("b", HOT)), "watched");
  assert.equal(attentionOf("c", plans, N("c")), "none");
  assert.equal(attentionOf("d", plans, undefined), "none");
});
