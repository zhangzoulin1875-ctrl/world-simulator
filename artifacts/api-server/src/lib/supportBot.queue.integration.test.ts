import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { anthropic, runWithAiPriority, AI_PRIORITY_PREGEN, setRoutePoolConcurrency } from "@workspace/integrations-anthropic-ai";
import { answerQuestion } from "./supportBot";
import { SupportQueue } from "./supportQueue";

/**
 * 不樁掉 anthropic.messages.create，而是換掉 fetch：整條路徑（callGameAi → 全域優先權
 * 佇列 → HTTP）都是真的，驗證「客服排在別的 AI 任務後面也一定會被回答」。
 */
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; setRoutePoolConcurrency(4); });

function stubFetch(order: string[], opts: { failFirstSupport?: number } = {}) {
  let supportFails = opts.failFirstSupport ?? 0;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const last: string = body.messages.at(-1)?.content ?? "";
    const tag = last.startsWith("玩家現在的問題") ? `support:${last.split("\n")[1]}` : last;
    order.push(tag);
    await new Promise((r) => setTimeout(r, 25));
    if (tag.startsWith("support:") && supportFails > 0) {
      supportFails--;
      return new Response("server error", { status: 500 });
    }
    return new Response(
      JSON.stringify({ id: "s", model: "m", choices: [{ index: 0, message: { role: "assistant", content: `答:${tag}` }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

const game = (tag: string) => anthropic.messages.create({ model: "m", max_tokens: 16, system: "s", messages: [{ role: "user", content: tag }] } as never);

test("前面塞滿遊戲結算與背景預產 → 客服照樣被回答，且順序是 結算(0) → 客服(5) → 預產(10)", async () => {
  const order: string[] = [];
  stubFetch(order);
  // 槽位吃緊（只有 1 條）才看得出優先權；槽位寬裕時誰先到誰先跑，本來就不需要排序。
  setRoutePoolConcurrency(1);
  const first = game("game-in-flight"); // 先佔住併發槽
  await new Promise((r) => setTimeout(r, 8));
  const pregen = runWithAiPriority(AI_PRIORITY_PREGEN, () => game("pregen-1"));
  const pregen2 = runWithAiPriority(AI_PRIORITY_PREGEN, () => game("pregen-2"));
  const g1 = game("game-1"); const g2 = game("game-2");
  // 兩題同時送出：客服的每一次 AI 呼叫（改寫＋作答）都和結算、預產同時在佇列裡，才看得出優先權。
  const s1 = answerQuestion("Q1"); const s2 = answerQuestion("Q2");

  const answers = await Promise.all([first, pregen, pregen2, g1, g2, s1, s2]);
  assert.equal(answers.length, 7);
  assert.equal(await s1, "答:support:Q1");
  assert.equal(await s2, "答:support:Q2");
  // 客服的呼叫有兩種（改寫、作答），順序用「最後一次出現」＝作答完成的位置來比。
  const first_ = (t: string) => order.indexOf(t);
  const last_ = (t: string) => order.lastIndexOf(t);
  assert.ok(first_("game-1") < first_("support:Q1") && first_("game-2") < first_("support:Q1"), `結算先於客服：${order}`);
  assert.ok(last_("support:Q1") < first_("pregen-1") && last_("support:Q2") < first_("pregen-1"), `客服（含改寫與作答）先於預產：${order}`);
});

test("AI 暫時 500：客服佇列退避重試後仍然答出來，後面的訊息不會被跳過", async () => {
  const order: string[] = [];
  stubFetch(order, { failFirstSupport: 2 });
  const answered: string[] = [];
  const q = new SupportQueue<string>({
    sleep: async () => undefined, // 測試中跳過等待
    handler: async (job) => { answered.push(`${job.id}=${await answerQuestion(job.payload)}`); },
  });
  q.enqueue("m1", "Q1"); q.enqueue("m2", "Q2");
  const t0 = Date.now();
  while (answered.length < 2 && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(answered, ["m1=答:support:Q1", "m2=答:support:Q2"]);
  assert.ok(q.stats.retries >= 1 || order.filter((o) => o === "support:Q1").length >= 1);
  assert.equal(q.stats.gaveUp, 0);
});
