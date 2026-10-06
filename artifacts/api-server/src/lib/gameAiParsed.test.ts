/**
 * callGameAiParsed：玩家政策判定（政策構想／政府決策／經濟政策）過去只問 AI 一次，
 * 空回應或壞 JSON 就整筆跳過、等下一回合。現在輸出不可用會自動重問。
 */
import { strict as assert } from "node:assert";
import test, { after, afterEach, before } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runAiUsageMigrations } from "./aiUsageMigrations";
import { callGameAiParsed, invalidateAiFeatureSettingsCache } from "./gameAi";

const FEATURE = "npc_initiative.proposals" as const;
type MessagesCreate = typeof anthropic.messages.create;
const real: MessagesCreate = anthropic.messages.create.bind(anthropic.messages);

function script(replies: Array<string | Error>) {
  let i = 0;
  const calls = { n: 0 };
  anthropic.messages.create = (async () => {
    calls.n++;
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return { content: [{ type: "text", text: r }], usage: { input_tokens: 1, output_tokens: 1 } };
  }) as unknown as MessagesCreate;
  return calls;
}
const parse = (raw: string) => {
  const v = JSON.parse(raw) as { ok?: number };
  if (typeof v.ok !== "number") throw new Error("schema");
  return v.ok;
};
const params = { system: "s", messages: [{ role: "user" as const, content: "u" }] };

before(async () => { await runAiUsageMigrations(); });
afterEach(async () => {
  anthropic.messages.create = real;
  await db.execute(sql`DELETE FROM ai_usage_logs WHERE feature = ${FEATURE}`);
  invalidateAiFeatureSettingsCache();
});
after(() => { anthropic.messages.create = real; });

test("第一次就正確：只問 1 次", async () => {
  const c = script(['{"ok":1}']);
  assert.equal(await callGameAiParsed(FEATURE, "bulk", params, parse), 1);
  assert.equal(c.n, 1);
});

test("空回應 → 重問，第二次成功就採用", async () => {
  const c = script(["", '{"ok":2}']);
  assert.equal(await callGameAiParsed(FEATURE, "bulk", params, parse), 2);
  assert.equal(c.n, 2);
});

test("壞 JSON、欄位不符 → 連續重問，第三次成功", async () => {
  const c = script(["not json at all", '{"nope":1}', '{"ok":3}']);
  assert.equal(await callGameAiParsed(FEATURE, "bulk", params, parse), 3);
  assert.equal(c.n, 3);
});

test("三次都壞 → 丟出最後的錯誤（呼叫端照舊保留想法下回合重試），不無限重問", async () => {
  const c = script(["", "x", "{}"]);
  await assert.rejects(callGameAiParsed(FEATURE, "bulk", params, parse));
  assert.equal(c.n, 3);
});

test("AI 呼叫本身失敗（逾時／額度）→ 不在這層重試，直接丟出", async () => {
  const c = script([new Error("AI provider error 503")]);
  await assert.rejects(callGameAiParsed(FEATURE, "bulk", params, parse), /503/);
  assert.equal(c.n, 1, "請求量不被放大");
});
