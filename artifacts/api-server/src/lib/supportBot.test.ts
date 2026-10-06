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

// ── 程式碼檢索整合（兩段式）──────────────────────────────────────────────
import { buildIndex } from "./supportCodeIndex";
import { __setCodeIndexForTest } from "./supportCodeSource";
import { resetRewriteCache, lookupCode } from "./supportBot";

const codeIdx = () => buildIndex(new Map([
  ["src/lib/populationCapacity.ts", "// 人口超過上限時每回合最多減少 6%\nexport const MAX_LOSS = 0.06;\nexport function capacity() { return 1; }\n"],
  ["src/other.ts", "export const unrelated = 'nothing here';\n"],
]), "deadbee");

function stubAi(handler: (p: any) => string) {
  const calls: any[] = [];
  anthropic.messages.create = (async (p: any) => {
    calls.push(p);
    return { content: [{ type: "text", text: handler(p) }], usage: { input_tokens: 1, output_tokens: 1 } };
  }) as unknown as Create;
  return calls;
}

test("兩段式：第1次改寫關鍵字、第2次帶程式碼依據作答；兩次都走 bulk", async () => {
  resetRewriteCache(); __setCodeIndexForTest(codeIdx());
  const calls = stubAi((p) => (/程式碼搜尋助手/.test(p.system ?? "") ? '{"keywords":["populationCapacity","MAX_LOSS"]}' : "人口超過上限每回合最多少 6%。"));
  const a = await answerQuestion("為什麼我的人口一直掉？");
  assert.equal(a, "人口超過上限每回合最多少 6%。");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.tier === "bulk"));
  const answerCall = calls[1];
  assert.match(answerCall.messages[0].content, /【程式碼依據】/);
  assert.match(answerCall.messages[0].content, /src\/lib\/populationCapacity\.ts/);
  assert.match(answerCall.messages[0].content, /MAX_LOSS/);
  assert.ok(!answerCall.messages[0].content.includes("unrelated"), "無關檔不應塞進去");
  __setCodeIndexForTest(null);
});

test("改寫失敗／亂回 → 退回用原問題搜尋，仍然作答", async () => {
  resetRewriteCache(); __setCodeIndexForTest(codeIdx());
  let n = 0;
  const calls = stubAi((p) => { n++; if (/程式碼搜尋助手/.test(p.system ?? "")) return "我不輸出 JSON"; return "答案"; });
  assert.equal(await answerQuestion("人口 上限 減少"), "答案");
  assert.match(calls[1].messages[0].content, /【程式碼依據】/, "原問題的中文詞仍能搜到");
  assert.equal(n, 2);
  __setCodeIndexForTest(null);
});

test("改寫呼叫丟錯 → 不影響作答", async () => {
  resetRewriteCache(); __setCodeIndexForTest(codeIdx());
  let first = true;
  anthropic.messages.create = (async (p: any) => {
    if (first) { first = false; throw new Error("429"); }
    return { content: [{ type: "text", text: "照樣回答" }], usage: { input_tokens: 1, output_tokens: 1 } };
  }) as unknown as Create;
  assert.equal(await answerQuestion("人口 上限"), "照樣回答");
  __setCodeIndexForTest(null);
});

test("索引不可用（GitHub 掛了）→ 只改用知識底稿作答，客服不中斷、也不多耗一次改寫", async () => {
  resetRewriteCache(); __setCodeIndexForTest(null);
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  try {
    const calls = stubAi(() => "只靠說明的回答");
    assert.equal(await answerQuestion("怎麼建國"), "只靠說明的回答");
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].messages[0].content.includes("【程式碼依據】"));
  } finally { globalThis.fetch = real; }
});

test("佇列重試同一問題時，改寫只做一次（省額度）", async () => {
  resetRewriteCache(); __setCodeIndexForTest(codeIdx());
  let rewrites = 0, answers = 0;
  anthropic.messages.create = (async (p: any) => {
    if (/程式碼搜尋助手/.test(p.system ?? "")) { rewrites++; return { content: [{ type: "text", text: '{"keywords":["MAX_LOSS"]}' }], usage: { input_tokens: 1, output_tokens: 1 } }; }
    answers++; if (answers < 3) throw new Error("暫時失敗");
    return { content: [{ type: "text", text: "成功" }], usage: { input_tokens: 1, output_tokens: 1 } };
  }) as unknown as Create;
  for (let i = 0; i < 3; i++) { try { await answerQuestion("人口 上限 同一題"); } catch { /* 模擬佇列重試 */ } }
  assert.equal(rewrites, 1);
  assert.equal(answers, 3);
  __setCodeIndexForTest(null);
});

test("lookupCode：沒有命中時回空字串（不塞無關程式碼）", async () => {
  resetRewriteCache(); __setCodeIndexForTest(codeIdx());
  stubAi(() => '{"keywords":["zzzqqq"]}');
  assert.equal(await lookupCode("zzzqqq 完全無關"), "");
  __setCodeIndexForTest(null);
});

test("客服 prompt 含程式碼依據使用規則：優先採信、不貼大段碼、不洩密、分清事實與推測、疑似 Bug 的處理", () => {
  for (const kw of ["程式碼依據", "不要貼大段程式碼", "金鑰", "沒找到明確依據", "推測", "不要斷言", "聯絡管理員"]) {
    assert.ok(SUPPORT_SYSTEM_PROMPT.includes(kw), `缺少：${kw}`);
  }
});
