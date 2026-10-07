import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_MAX_CANDIDATES, buildDecisionPrompt, describeNation, guardDecisions, parseDecisionOutput, resolveAiDecisions,
} from "./aiDecision";
import type { DecisionContext, NationSituation } from "./core";

const N = (id: string, o: Partial<NationSituation> = {}): NationSituation => ({
  nationId: id, parliamentSat: 60, radicalSeatShare: 0, stability: 70, atWar: false, inCivilWar: false, isPlayer: false, ...o,
});
const HOT = { parliamentSat: 15, stability: 20, radicalSeatShare: 0.3 };
const ctx = (nations: NationSituation[], o: Partial<DecisionContext> = {}): DecisionContext =>
  ({ influence: 80, nations, lastTargetedTick: {}, alreadyPlanned: [], tick: 20, ...o });
const brief = { ideology: "red", eraSlug: "industrial" };

test("prompt：匿名代號、不含任何 nationId 或名稱；只列已解鎖的行動", () => {
  const c = ctx([N("secret-uuid-1", HOT), N("secret-uuid-2")], { influence: 35 });
  const { prompt, anon } = buildDecisionPrompt(c, brief);
  assert.ok(!prompt.includes("secret-uuid"), "不能洩漏 nationId");
  assert.match(prompt, /N1:/); assert.deepEqual(anon.map((a) => a.code), ["N1", "N2"]);
  assert.match(prompt, /propaganda/); assert.match(prompt, /funding/);
  assert.ok(!/strikes|subvert/.test(prompt.split("你目前能用的行動")[1]!.split("規則")[0]!), "影響力 35 不應列出罷工潮/策反");
});

test("prompt：只在策反已解鎖時才帶策反規則；內戰國不入候選；候選依動盪度排序並設上限", () => {
  const many = Array.from({ length: 20 }, (_, i) => N(`n${String(i).padStart(2, "0")}`, { parliamentSat: 50 - i }));
  many.push(N("civil", { ...HOT, inCivilWar: true }));
  const { prompt, anon } = buildDecisionPrompt(ctx(many, { influence: 80 }), brief);
  assert.equal(anon.length, AI_MAX_CANDIDATES); assert.ok(!anon.some((a) => a.nationId === "civil"));
  assert.equal(anon[0]!.nationId, "n19", "最不滿的排第一");
  assert.match(prompt, /subvert 只能用於/);
  assert.ok(!/subvert 只能用於/.test(buildDecisionPrompt(ctx(many, { influence: 40 }), brief).prompt));
});

test("描述只給分級，不給精確數字", () => {
  const d = describeNation("N1", N("a", { ...HOT, atWar: true }));
  assert.match(d, /議會極度不滿/); assert.match(d, /局勢動盪/); assert.match(d, /左翼黨勢大/); assert.match(d, /交戰中/);
  assert.ok(!/\d{2}/.test(d.replace("N1", "")), "不應含兩位數以上數字");
});

test("解析：標準 JSON、markdown 圍欄、前後說明文字都能抓", () => {
  const anon = [{ code: "N1", nationId: "a" }, { code: "N2", nationId: "b" }];
  assert.deepEqual(parseDecisionOutput('[{"target":"N1","action":"strikes"}]', anon), [{ targetNationId: "a", action: "strikes" }]);
  assert.deepEqual(parseDecisionOutput('好的:\n```json\n[{"target":"n2","action":"PROPAGANDA"}]\n```', anon), [{ targetNationId: "b", action: "propaganda" }]);
  assert.deepEqual(parseDecisionOutput("[]", anon), []);
});

test("解析：壞項目被略過；整個不是陣列才丟錯", () => {
  const anon = [{ code: "N1", nationId: "a" }];
  assert.deepEqual(parseDecisionOutput('[{"target":"N9","action":"strikes"},{"target":"N1","action":"nuke"},null,5,{"target":"N1","action":"funding"}]', anon),
    [{ targetNationId: "a", action: "funding" }]);
  assert.throws(() => parseDecisionOutput("我決定不行動", anon));
  assert.throws(() => parseDecisionOutput("[not json", anon));
  assert.throws(() => parseDecisionOutput('{"target":"N1"}', anon));
});

test("護欄：玩家國動盪度不夠不能被選；NPC 國不受此限；動盪夠的玩家國可以", () => {
  const nations = [N("p-calm", { isPlayer: true }), N("p-hot", { ...HOT, isPlayer: true }), N("npc-calm")];
  const out = guardDecisions([
    { targetNationId: "p-calm", action: "propaganda" }, { targetNationId: "p-hot", action: "propaganda" },
  ], ctx(nations));
  assert.deepEqual(out, [{ targetNationId: "p-hot", action: "propaganda" }]);
  assert.equal(guardDecisions([{ targetNationId: "npc-calm", action: "propaganda" }], ctx(nations)).length, 1);
});

test("整合：AI 想策反但影響力/門檻不足 → 被 validateDecisions 擋；不存在的國家 → 擋", () => {
  const nations = [N("a", { ...HOT, parliamentSat: 40 })];
  const { anon } = buildDecisionPrompt(ctx(nations), brief);
  assert.deepEqual(resolveAiDecisions('[{"target":"N1","action":"subvert"}]', anon, ctx(nations)), [], "議會 40 > 25 不能策反");
  assert.deepEqual(resolveAiDecisions('[{"target":"N5","action":"propaganda"}]', anon, ctx(nations)), []);
  assert.equal(resolveAiDecisions('[{"target":"N1","action":"strikes"}]', anon, ctx(nations)).length, 1);
});

test("整合：AI 超過 2 個目標被截斷；同國重複被去重", () => {
  const nations = ["a", "b", "c"].map((id) => N(id, HOT));
  const { anon } = buildDecisionPrompt(ctx(nations), brief);
  const raw = JSON.stringify(anon.map((a) => ({ target: a.code, action: "propaganda" })).concat([{ target: "N1", action: "strikes" }]));
  const out = resolveAiDecisions(raw, anon, ctx(nations));
  assert.equal(out.length, 2); assert.equal(new Set(out.map((d) => d.targetNationId)).size, 2);
});
