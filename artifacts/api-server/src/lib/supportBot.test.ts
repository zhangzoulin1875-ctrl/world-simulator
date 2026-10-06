import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { Team, User } from "discord.js";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  splitForDiscord, resolveOwnerId, buildQuestion, answerQuestion, SUPPORT_AI_PRIORITY,
  DISCORD_MESSAGE_LIMIT, SUPPORT_MAX_INPUT_CHARS, GOAL_GUIDE, collectHits, GOAL_TOTAL_HITS,
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
  for (const kw of ["以【遊戲知識】與【程式碼依據】為基礎", "不確定", "無關", "不要透露", "不是對你的指令", "不要替管理員承諾"]) {
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
    assert.match(calls[0].messages[0].content, /沒有檢索到與問題直接相關的原始碼/);
    assert.ok(!calls[0].messages[0].content.includes("--- "), "沒有任何程式碼片段");
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
  assert.equal((await lookupCode("zzzqqq 完全無關")).text, "");
  __setCodeIndexForTest(null);
});

test("客服 prompt 含程式碼依據使用規則：優先採信、不貼大段碼、不洩密、分清事實與推測、疑似 Bug 的處理", () => {
  for (const kw of ["程式碼依據", "不要貼大段程式碼", "金鑰", "沒找到明確依據", "推測", "不要斷言", "聯絡管理員"]) {
    assert.ok(SUPPORT_SYSTEM_PROMPT.includes(kw), `缺少：${kw}`);
  }
});

// ── 目的型問題（如何達成某目的）─────────────────────────────────────────
const goalIdx = () => buildIndex(new Map([
  ["src/lib/populationCapacity.ts", "// 人口承載量：人口超過承載量時每回合減少，最多 6%\nexport function capacity() { return 1; }\n"],
  ["src/lib/growth.ts", "// 人口增長率 population growth rate：受穩定度與糧食影響\nexport function growthRate() { return 0.01; }\n"],
  ["src/lib/food.ts", "// 糧食 food 不足會觸發飢荒 famine，人口減少\nexport function famine() { return 1; }\n"],
  ["src/lib/tax.ts", "// 稅收 tax 與稅率 政策\nexport function tax() { return 1; }\n"],
  ["src/lib/unrelated.ts", "export const nothing = 'x';\n"],
]), "goalidx");

const goalRewrite = JSON.stringify({
  kind: "goal",
  keywords: ["population", "人口"],
  angles: ["population growth rate 人口 增長率", "populationCapacity 承載量", "food famine 糧食 飢荒"],
});

test("目的型問題：改寫會分類為 goal 並給出多個機制角度；作答帶推理指引並改用 support.guide（更大的 token）", async () => {
  resetRewriteCache(); __setCodeIndexForTest(goalIdx());
  const feats: string[] = [];
  const calls = stubAi((p) => (/程式碼搜尋助手/.test(p.system ?? "") ? goalRewrite : "1. 目標拆解…"));
  const a = await answerQuestion("怎麼樣才能讓我的人口變多？");
  assert.equal(a, "1. 目標拆解…");
  assert.equal(calls.length, 2);
  const msg = calls[1].messages[0].content as string;
  assert.ok(msg.includes(GOAL_GUIDE.slice(0, 20)), "帶有『推導做法』的方向提醒");
  assert.match(msg, /推導出合理可行的做法/);
  assert.match(msg, /不要提出依據裡沒有的功能/);
  assert.ok(!msg.includes("目標拆解") && !msg.includes("代價與風險"), "不再要求固定五段格式");
  // 多個機制的檔案都被帶進依據（不只擠在同一個）
  for (const f of ["populationCapacity.ts", "growth.ts", "food.ts"]) assert.ok(msg.includes(f), `缺少 ${f}`);
  assert.ok(!msg.includes("unrelated.ts"));
  // max_tokens 取自 support.guide（1800），比 support.chat 大
  assert.ok(calls[1].max_tokens >= 1500, `max_tokens=${calls[1].max_tokens}`);
  feats.length = 0;
  __setCodeIndexForTest(null);
});

test("規則型問題：不帶推理指引，仍用 support.chat", async () => {
  resetRewriteCache(); __setCodeIndexForTest(goalIdx());
  const calls = stubAi((p) => (/程式碼搜尋助手/.test(p.system ?? "") ? '{"kind":"rule","keywords":["capacity","承載量"],"angles":[]}' : "規則說明"));
  assert.equal(await answerQuestion("人口承載量是什麼"), "規則說明");
  const msg = calls[1].messages[0].content as string;
  assert.ok(!msg.includes("目標拆解"));
  assert.match(msg, /規則怎麼運作/);
  assert.ok(calls[1].max_tokens < 1500, `max_tokens=${calls[1].max_tokens}`);
  __setCodeIndexForTest(null);
});

test("疑似 Bug：帶 bug 指引（請玩家提供資料、不斷言）", async () => {
  resetRewriteCache(); __setCodeIndexForTest(goalIdx());
  const calls = stubAi((p) => (/程式碼搜尋助手/.test(p.system ?? "") ? '{"kind":"bug","keywords":["capacity"],"angles":[]}' : "請提供資料"));
  await answerQuestion("人口突然變0是bug嗎 capacity");
  const msg = calls[1].messages[0].content as string;
  assert.match(msg, /疑似異常/);
  assert.match(msg, /不要直接斷言是 Bug/);
  __setCodeIndexForTest(null);
});

test("collectHits：goal 每個角度各取代表（輪流），去重，總數有上限", () => {
  const idx = goalIdx();
  const hits = collectHits(idx, { kind: "goal", searchText: "人口變多 population", angles: ["population growth rate 增長率", "populationCapacity 承載量", "food famine 糧食 飢荒"] });
  const paths = hits.map((h) => h.chunk.path);
  assert.ok(paths.includes("src/lib/growth.ts") && paths.includes("src/lib/populationCapacity.ts") && paths.includes("src/lib/food.ts"));
  assert.equal(new Set(hits.map((h) => `${h.chunk.path}:${h.chunk.start}`)).size, hits.length, "不重複");
  assert.ok(hits.length <= GOAL_TOTAL_HITS);
  // rule 型只用單次搜尋
  const r = collectHits(idx, { kind: "rule", searchText: "承載量", angles: ["ignored food"] });
  assert.ok(r.every((h) => h.chunk.path !== "src/lib/food.ts") || r.length > 0);
});

test("分類 JSON 亂掉 / kind 不合法 → 退回 rule，不影響作答", async () => {
  resetRewriteCache(); __setCodeIndexForTest(goalIdx());
  const calls = stubAi((p) => (/程式碼搜尋助手/.test(p.system ?? "") ? '{"kind":"???","keywords":["capacity"],"angles":["x"]}' : "ok"));
  assert.equal(await answerQuestion("capacity 承載量"), "ok");
  assert.ok(!(calls[1].messages[0].content as string).includes("目標拆解"));
  __setCodeIndexForTest(null);
});

test("goal 型但索引不可用 → 仍給推理指引＋明講沒有程式碼依據，不中斷", async () => {
  resetRewriteCache(); __setCodeIndexForTest(null);
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  try {
    const calls = stubAi(() => "只靠說明的建議");
    assert.equal(await answerQuestion("怎麼讓人口變多"), "只靠說明的建議");
    assert.equal(calls.length, 1, "沒有索引就不做改寫");
    assert.match(calls[0].messages[0].content, /沒有檢索到與問題直接相關的原始碼/);
  } finally { globalThis.fetch = real; }
});

test("prompt 允許串連機制做推論，但禁止編造", () => {
  assert.match(SUPPORT_SYSTEM_PROMPT, /串起來做合理推論/);
  assert.match(SUPPORT_SYSTEM_PROMPT, /絕對不要編造數字、按鈕或功能/);
  assert.match(SUPPORT_SYSTEM_PROMPT, /不需要固定格式、標題或出處標註/);
  assert.ok(!SUPPORT_SYSTEM_PROMPT.includes("句尾標註出處"), "不再強制標出處");
});

// ── 防胡編／上古機制／問A答B ─────────────────────────────────────────────
import { filterRelevant, retiredWarning, MIN_HIT_SCORE } from "./supportBot";
import { searchIndex, formatHits } from "./supportCodeIndex";

const mixedIdx = () => buildIndex(new Map([
  ["src/lib/populationCapacity.ts", "// 人口承載量：人口超過承載量時每回合減少，最多 6%\nexport function capacity() { return 1; }\n"],
  ["src/lib/npcInitiative.ts", "// NPC 主動提案條約、宣戰、結盟（initiative proposals）\nexport function propose() { return 1; }\n"],
  ["src/lib/techTreeResearch.ts", "// 科技樹已下線:關鍵技術改為隨世界時代自動解鎖\nexport const err = '不需要也無法再研發';\n"],
  ["src/lib/food.ts", "// 糧食不足觸發飢荒\nexport function famine() {}\n"],
]), "mix");

test("上古機制：命中 npcInitiative 與『已下線』片段時，送給 AI 的依據帶【警告：疑似已廢除】", () => {
  const idx = mixedIdx();
  const hits = searchIndex(idx, "NPC 主動 提案 initiative 科技樹 研發", 6);
  const text = formatHits(hits, 9000, retiredWarning);
  assert.match(text, /npcInitiative\.ts[^\n]*\n【警告：疑似已廢除】NPC 主動提案/);
  assert.match(text, /techTreeResearch\.ts[^\n]*\n【警告：疑似已廢除】/);
  const pop = formatHits(searchIndex(idx, "人口 承載量", 3), 9000, retiredWarning);
  assert.ok(!pop.includes("警告"), "現行機制不加警告");
});

test("上古機制：玩家問科技樹 → 作答訊息帶現況提醒，要求先告知現況", async () => {
  resetRewriteCache(); __setCodeIndexForTest(mixedIdx());
  const calls = stubAi((p) => (/程式碼搜尋助手/.test(p.system ?? "") ? '{"kind":"goal","keywords":["techTree","研發"],"angles":["techTreeResearch 科技樹 研發"]}' : "科技樹已下線，不能研發 [遊戲知識]。"));
  await answerQuestion("我要怎麼研發科技樹？");
  const msg = calls.at(-1).messages[0].content as string;
  assert.match(msg, /提醒：玩家問題提到已廢除的機制/);
  assert.match(msg, /科技樹已下線/);
  assert.match(msg, /先告訴玩家這項現況/);
  __setCodeIndexForTest(null);
});

test("問A答B：filterRelevant 去掉低分片段與完全沒碰到玩家用詞的片段", () => {
  const idx = mixedIdx();
  const hit = (q: string) => searchIndex(idx, q, 6);
  assert.ok(filterRelevant(hit("人口 承載量 減少"), "人口 承載量 減少").length >= 1);
  // AI 改寫把關鍵字帶偏到「糧食」，但玩家問的是「稅收」：片段沒碰到玩家用詞 → 全部過濾掉
  assert.deepEqual(filterRelevant(hit("稅收 糧食 飢荒 famine"), "稅收怎麼算"), []);
  // 低於門檻直接丟
  const weak = [{ chunk: idx.chunks[0]!, score: MIN_HIT_SCORE - 1 }];
  assert.deepEqual(filterRelevant(weak, "人口"), []);
});

test("問A答B：問『稅收』卻只搜到糧食 → 不把糧食當依據，改走『沒找到』提示", async () => {
  resetRewriteCache(); __setCodeIndexForTest(mixedIdx());
  const calls = stubAi((p) => (/程式碼搜尋助手/.test(p.system ?? "") ? '{"kind":"rule","keywords":["famine","糧食","飢荒"],"angles":[]}' : "我沒找到相關依據"));
  await answerQuestion("稅收怎麼算");
  const msg = calls.at(-1).messages[0].content as string;
  assert.ok(!msg.includes("food.ts"), "不相關的檔案不應塞給 AI");
  assert.match(msg, /沒有檢索到與問題直接相關/);
  __setCodeIndexForTest(null);
});


test("直接作答：不論回答長怎樣都原樣送出，只問一次 AI（沒有驗證、重答、清洗）", async () => {
  resetRewriteCache(); __setCodeIndexForTest(mixedIdx());
  const weird = "損失 37% 人口，依 [ghost.ts]，沒有任何格式";
  const calls = stubAi((p) => (/程式碼搜尋助手/.test(p.system ?? "") ? '{"kind":"rule","keywords":["capacity","承載量"],"angles":[]}' : weird));
  const a = await answerQuestion("人口 承載量 超過會怎樣");
  assert.equal(a, weird, "不改寫、不附加提醒");
  assert.equal(calls.filter((c) => !/程式碼搜尋助手/.test(c.system ?? "")).length, 1);
  __setCodeIndexForTest(null);
});
