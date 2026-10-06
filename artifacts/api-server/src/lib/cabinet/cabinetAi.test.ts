import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { generateMinisterCandidates } from "./cabinetAi";

type Create = typeof anthropic.messages.create;
const real: Create = anthropic.messages.create.bind(anthropic.messages);
afterEach(() => { anthropic.messages.create = real; });
const script = (replies: Array<string | Error>) => {
  let i = 0; const c = { n: 0 };
  anthropic.messages.create = (async () => {
    c.n++;
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return { content: [{ type: "text", text: r }], usage: { input_tokens: 1, output_tokens: 1 } };
  }) as unknown as Create;
  return c;
};
const params = { domain: "interior" as const, nationName: "測試國", eraLabel: "古典時代", regionNames: ["關中"], cityNames: ["長安"] };
const cand = (n: string, o: unknown = 50, t: unknown = 50) => ({
  name: n, origin: "出身背景", style: { overreach: o, timidity: t, description: "執政風格" },
});
const wrap = (cs: unknown[]) => JSON.stringify({ candidates: cs });

test("標準三位候選人正常通過", async () => {
  const c = script([wrap([cand("甲", 80, 10), cand("乙", 20, 70), cand("丙", 50, 50)])]);
  const r = await generateMinisterCandidates(params);
  assert.equal(r.length, 3); assert.equal(c.n, 1);
});

test("數字回成字串／小數／超範圍 → 轉成整數並夾在 0–100，不再整批失敗", async () => {
  script([wrap([cand("甲", "75", 72.6), cand("乙", 150, -5), cand("丙", "0", 100)])]);
  const r = await generateMinisterCandidates(params);
  assert.deepEqual(r.map((x) => [x.style.overreach, x.style.timidity]), [[75, 73], [100, 0], [0, 100]]);
});

test("「一句話」寫超長 → 截斷而不是失敗", async () => {
  const long = "長".repeat(500);
  script([wrap([{ name: "甲", origin: long, style: { overreach: 1, timidity: 1, description: long } }, cand("乙"), cand("丙")])]);
  const r = await generateMinisterCandidates(params);
  assert.equal(r[0]!.origin.length, 200); assert.equal(r[0]!.style.description.length, 300);
});

test("AI 回了四位 → 取前三位", async () => {
  script([wrap([cand("甲"), cand("乙"), cand("丙"), cand("丁")])]);
  const r = await generateMinisterCandidates(params);
  assert.deepEqual(r.map((x) => x.name), ["甲", "乙", "丙"]);
});

test("JSON 前後有說明文字或 <think> 區塊 → 仍可解析", async () => {
  script([`<think>先想想</think>好的，以下是結果：\n${wrap([cand("甲"), cand("乙"), cand("丙")])}\n希望有幫助`]);
  const r = await generateMinisterCandidates(params);
  assert.equal(r.length, 3);
});

test("第一次空回應 → 自動重問，第二次成功", async () => {
  const c = script(["", wrap([cand("甲"), cand("乙"), cand("丙")])]);
  const r = await generateMinisterCandidates(params);
  assert.equal(r.length, 3); assert.equal(c.n, 2);
});

test("只回兩位（缺人）三次都不行 → 丟錯，不寫半套", async () => {
  const c = script([wrap([cand("甲"), cand("乙")])]);
  await assert.rejects(generateMinisterCandidates(params), /格式不正確/);
  assert.equal(c.n, 3);
});
