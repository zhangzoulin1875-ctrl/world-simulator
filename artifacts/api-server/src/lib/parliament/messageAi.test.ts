import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { generateParliamentMessage } from "./messageAi";
import { planParliamentTurn } from "./plan";

type Create = typeof anthropic.messages.create;
const real: Create = anthropic.messages.create.bind(anthropic.messages);
afterEach(() => { anthropic.messages.create = real; });
const stub = (reply: string | Error) => {
  const c = { n: 0 };
  anthropic.messages.create = (async () => {
    c.n++;
    if (reply instanceof Error) throw reply;
    return { content: [{ type: "text", text: reply }], usage: { input_tokens: 1, output_tokens: 1 } };
  }) as unknown as Create;
  return c;
};
const input = {
  eraSlug: "early_medieval", stance: "pacifist" as const, partyName: "和平黨", wantsDemand: true,
  context: "戰爭狀態：承平時期（無進行中戰役）", worldSituation: "世界上另有 2 場戰爭正在進行；本國暫未捲入", satisfaction: 55,
};

test("AI 依國情寫的文字被採用", async () => {
  stub(JSON.stringify({ protest: "鄰邦戰火連綿，議員憂心國境不寧。", demand: "請在三回合內與鄰國維持克制，勿輕啟戰端。" }));
  const m = await generateParliamentMessage(input);
  assert.equal(m?.protest, "鄰邦戰火連綿，議員憂心國境不寧。");
  assert.match(m!.demandText!, /克制/);
});

test("格式壞掉會重問；全壞才回 null（呼叫端退回模板）", async () => {
  const c = stub("not json");
  assert.equal(await generateParliamentMessage(input), null);
  assert.equal(c.n, 3);
});

test("AI 呼叫失敗 → null，不拋錯", async () => {
  stub(new Error("503"));
  assert.equal(await generateParliamentMessage(input), null);
});

test("wantsDemand=false 時即使 AI 回了要求也丟棄", async () => {
  stub(JSON.stringify({ protest: "議會一致擁護領袖，但憂心邊防。", demand: "不該出現的要求文字" }));
  const m = await generateParliamentMessage({ ...input, wantsDemand: false });
  assert.equal(m?.demandText, null);
});

const base = {
  tier: "democracy" as const, tick: 0, satisfaction: 60, lastDemandTick: null, activeDemand: null,
  snapshot: { atWar: false, militarySpendChange: 0, taxChange: 0, religionLean: 0 as 0 | 1 | -1, commerceUp: false },
  militarySatisfaction: null,
  parties: [{ id: "p0", name: "和平黨", stance: "pacifist" as const, weight: 30, seats: 60 },
            { id: "p1", name: "擴軍黨", stance: "militarist" as const, weight: 20, seats: 40 }],
};

test("planParliamentTurn：有 aiMessage 就用 AI 文字，立場仍由規則決定", () => {
  const r = planParliamentTurn({ ...base, aiMessage: { protest: "AI抗議文字測試", demandText: "AI要求文字測試" } });
  assert.equal(r.protestText, "AI抗議文字測試");
  assert.equal(r.activeDemand?.text, "AI要求文字測試");
  assert.equal(r.activeDemand?.stance, "pacifist");
});

test("planParliamentTurn：沒有 aiMessage → 退回模板", () => {
  const r = planParliamentTurn({ ...base, aiMessage: null });
  assert.ok(r.protestText && r.protestText.length > 5);
  assert.match(r.activeDemand!.text, /避免發動戰爭/);
});
