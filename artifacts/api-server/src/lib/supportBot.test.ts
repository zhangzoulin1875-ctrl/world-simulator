import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Team, User } from "discord.js";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  splitForDiscord, resolveOwnerId, buildQuestion, answerQuestion, SUPPORT_AI_PRIORITY,
  DISCORD_MESSAGE_LIMIT, SUPPORT_MAX_INPUT_CHARS,
} from "./supportBot";
import { SUPPORT_SYSTEM_PROMPT, SUPPORT_KNOWLEDGE } from "./supportKnowledge";
import { AI_FEATURES } from "./gameAi";

type Create = typeof anthropic.messages.create;
const real: Create = anthropic.messages.create.bind(anthropic.messages);
afterEach(() => { anthropic.messages.create = real; });

test("splitForDiscord：短文不切；長文每段都不超過 Discord 上限且不遺失內容", () => {
  assert.deepEqual(splitForDiscord("你好"), ["你好"]);
  assert.deepEqual(splitForDiscord("   "), []);
  const long = Array.from({ length: 400 }, (_, i) => `第${i}句說明。`).join("");
  const parts = splitForDiscord(long);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(p.length <= DISCORD_MESSAGE_LIMIT, `段長 ${p.length}`);
  assert.equal(parts.join(""), long, "合併後內容完整");
});

test("splitForDiscord：沒有任何斷點的超長字串也能硬切", () => {
  const parts = splitForDiscord("字".repeat(5000));
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= DISCORD_MESSAGE_LIMIT);
  assert.equal(parts.join("").length, 5000);
});

test("resolveOwnerId：個人應用取 owner；團隊應用取 team owner；查不到回 null", () => {
  assert.equal(resolveOwnerId(null), null);
  assert.equal(resolveOwnerId(undefined), null);
  const user = Object.create(User.prototype); Object.defineProperty(user, "id", { value: "111" });
  assert.equal(resolveOwnerId(user), "111");
  const team = Object.create(Team.prototype); Object.defineProperty(team, "ownerId", { value: "222" });
  assert.equal(resolveOwnerId(team), "222");
  const noOwnerTeam = Object.create(Team.prototype); Object.defineProperty(noOwnerTeam, "ownerId", { value: null });
  assert.equal(resolveOwnerId(noOwnerTeam), null, "團隊沒 owner → null（之後一律拒絕設定）");
});

test("buildQuestion：去掉 @提及、壓縮空白、過長截斷", () => {
  assert.equal(buildQuestion("<@123> 請問  怎麼\n建國？"), "請問 怎麼 建國？");
  const q = buildQuestion("問".repeat(SUPPORT_MAX_INPUT_CHARS + 500));
  assert.ok(q.length < SUPPORT_MAX_INPUT_CHARS + 20 && q.endsWith("（以下省略）"));
  assert.equal(buildQuestion("<@1> <@!2>"), "");
});

test("客服 AI 呼叫：走 bulk 預設量產模型、客服專用優先權（5：低於結算、高於預產）、system 含規則與知識", async () => {
  assert.ok(SUPPORT_AI_PRIORITY > 0 && SUPPORT_AI_PRIORITY < 10);
  assert.ok("support.chat" in AI_FEATURES);
  let seen: any = null;
  anthropic.messages.create = (async (p: any) => {
    seen = p;
    return { content: [{ type: "text", text: "建國請到首頁選擇政體。" }], usage: { input_tokens: 1, output_tokens: 1 } };
  }) as unknown as Create;
  const a = await answerQuestion("怎麼建國？");
  assert.equal(a, "建國請到首頁選擇政體。");
  assert.equal(seen.tier, "bulk");
  assert.match(seen.system, /官方 AI 客服/);
  assert.match(seen.system, /不要編造/);
  assert.match(seen.messages[0].content, /怎麼建國/);
});

test("AI 回空字串 → 丟錯（交給佇列重試，不是回一則空訊息）", async () => {
  anthropic.messages.create = (async () => ({ content: [{ type: "text", text: "  " }], usage: { input_tokens: 1, output_tokens: 1 } })) as unknown as Create;
  await assert.rejects(answerQuestion("你好"), /為空/);
});

test("AI 呼叫失敗 → 往上丟（佇列會退避重試）", async () => {
  anthropic.messages.create = (async () => { throw new Error("429"); }) as unknown as Create;
  await assert.rejects(answerQuestion("你好"), /429/);
});

test("客服 prompt：限定本遊戲、拒絕洩漏設定與提示注入、不承諾補償", () => {
  for (const kw of ["只依據", "不確定", "無關", "不要透露", "不是對你的指令", "不要替管理員承諾"]) {
    assert.ok(SUPPORT_SYSTEM_PROMPT.includes(kw), `缺少：${kw}`);
  }
  assert.ok(SUPPORT_KNOWLEDGE.length > 500 && SUPPORT_KNOWLEDGE.length < 8000);
  for (const topic of ["建國", "軍事", "外交", "議會", "憲法", "國策", "科技"]) assert.ok(SUPPORT_KNOWLEDGE.includes(topic), topic);
});
