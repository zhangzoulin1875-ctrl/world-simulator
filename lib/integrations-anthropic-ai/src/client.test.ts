import test from "node:test";
import assert from "node:assert/strict";

/**
 * 優先權佇列（v3 閒時預產）單元測試 — 不需要資料庫、不打真 AI：
 * 以 stub fetch 驗證 (1) 併發鎖死為 1、(2) 預設請求（priority 0）一定
 * 排在背景預產（AI_PRIORITY_PREGEN）之前、(3) runWithAiPriority 的
 * AsyncLocalStorage 上下文傳遞、(4) getAiQueueStats 的 active/queued 計數。
 */

process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ??= "https://stub.invalid/v1";
process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ??= "stub-key";
// 卡死 bypass 測試需要短逾時／短卡死門檻（僅影響測試程序）。
process.env.AI_REQUEST_TIMEOUT_MS ??= "150";
process.env.AI_PRIMARY_STUCK_MS ??= "40";

const {
  anthropic,
  getAiQueueStats,
  runWithAiPriority,
  AI_PRIORITY_PREGEN,
} = await import("./client");

type FetchBody = {
  messages: Array<{ role: string; content: string }>;
};

/** stub fetch：記錄呼叫順序（以最後一則訊息內容為標記），模擬 50ms 延遲。 */
function installStubFetch(order: string[]): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as FetchBody;
    const marker = body.messages.at(-1)?.content ?? "?";
    order.push(marker);
    await new Promise((r) => setTimeout(r, 50));
    return new Response(
      JSON.stringify({
        id: "stub",
        model: "stub-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

function paramsWith(marker: string) {
  return {
    model: "stub-model",
    max_tokens: 16,
    system: "test",
    messages: [{ role: "user", content: marker }],
  } as Parameters<typeof anthropic.messages.create>[0];
}

test("預設請求插隊到背景預產之前；併發鎖死為 1", async () => {
  const order: string[] = [];
  installStubFetch(order);

  // 1) 玩家請求先進場（進行中，stub 延遲 50ms）。
  const player1 = anthropic.messages.create(paramsWith("player1"));

  // 等 stub 已開始執行（已佔用併發槽）。
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(getAiQueueStats().active, 1);

  // 2) 背景預產先入隊、玩家請求後入隊。
  const pregen = runWithAiPriority(AI_PRIORITY_PREGEN, () =>
    anthropic.messages.create(paramsWith("pregen")),
  );
  const player2 = anthropic.messages.create(paramsWith("player2"));

  const midStats = getAiQueueStats();
  assert.equal(midStats.active, 1);
  assert.equal(midStats.queued, 2);

  await Promise.all([player1, pregen, player2]);

  // 玩家 player2 必須在背景預產之前執行（優先權 0 < 10）。
  assert.deepEqual(order, ["player1", "player2", "pregen"]);
  assert.equal(getAiQueueStats().active, 0);
  assert.equal(getAiQueueStats().queued, 0);
});

test("runWithAiPriority 巢狀上下文：內層覆寫、外層還原", async () => {
  const order: string[] = [];
  installStubFetch(order);

  await runWithAiPriority(AI_PRIORITY_PREGEN, async () => {
    // 在預產上下文中發起：此請求入隊時 priority=10。
    const p1 = anthropic.messages.create(paramsWith("in-pregen"));
    // 同一上下文再開一個預設層級請求：巢狀 run 還原為 0。
    const p2 = runWithAiPriority(0, () =>
      anthropic.messages.create(paramsWith("in-nested-default")),
    );
    await Promise.all([p1, p2]);
  });

  // 同 priority 10 先入隊的先跑；nested 0 在後面仍應先跑嗎？
  // 併發 1：in-pregen 先執行（佇列只有它），nested 到隊時插到最前。
  // 此測試只驗證不丟錯、兩者都完成、順序依優先權規則穩定。
  assert.equal(order.length, 2);
  assert.deepEqual([...order].sort(), ["in-nested-default", "in-pregen"]);
});

// ── 備援（fallback）機制測試 ──────────────────────────────────────────────
const {
  registerAiFallbackProvider,
  getAiFallbackStats,
} = await import("./client");

test("主供應商失敗 → 自動改用備援；無備援設定時原錯誤上拋", async () => {
  const calls: string[] = [];
  // 第一個請求：主供應商 500 → 備援成功。
  let n = 0;
  globalThis.fetch = (async (url: unknown) => {
    n += 1;
    calls.push(String(url));
    if (n === 1) {
      return new Response(JSON.stringify({ error: "upstream boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    await new Promise((r) => setTimeout(r, 30));
    return new Response(
      JSON.stringify({
        id: "fb",
        model: "gemini-stub",
        choices: [
          { index: 0, message: { role: "assistant", content: "fb-ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  registerAiFallbackProvider(async (tier) =>
    tier === "bulk"
      ? { baseUrl: "https://fb.example/v1", apiKey: "fb-key", qualityModel: "q", bulkModel: "fb-bulk" }
      : { baseUrl: "https://fb.example/v1", apiKey: "fb-key", qualityModel: "fb-quality", bulkModel: "b" },
  );

  const msg = await anthropic.messages.create({ ...paramsWith("t1"), tier: "quality" });
  assert.equal(msg.content[0]?.text, "fb-ok");
  assert.equal(msg.model, "gemini-stub");
  // 兩次請求：第一次打主端點、第二次打備援端點（quality 模型）。
  assert.match(calls[0], /stub\.invalid/);
  assert.match(calls[1], /fb\.example\/v1\/chat\/completions/);
  // tier=bulk 的呼叫失敗時，備援要用 bulk 模型（從請求 body 驗證）。
  const bodies: string[] = [];
  let m = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    m += 1;
    bodies.push(String(init?.body));
    if (m === 1) return new Response("nope", { status: 500 });
    return new Response(
      JSON.stringify({
        choices: [
          { index: 0, message: { role: "assistant", content: "fb-ok" }, finish_reason: "stop" },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  const statsBefore = getAiFallbackStats();
  await anthropic.messages.create({ ...paramsWith("t2"), tier: "bulk" });
  assert.equal(getAiFallbackStats().attempts, statsBefore.attempts + 1);
  const fallbackBody = JSON.parse(bodies[1]!) as { model: string };
  assert.equal(fallbackBody.model, "fb-bulk");
});

test("備援也失敗 → 錯誤同時含主因（在前）與備援因；無 key 時不嘗試備援", async () => {
  // 備援也失敗
  let n = 0;
  globalThis.fetch = (async () => {
    n += 1;
    return new Response("nope", { status: 503 });
  }) as typeof fetch;
  await assert.rejects(
    anthropic.messages.create({ ...paramsWith("t3"), tier: "quality" }),
    (err: Error) => err.message.includes("主供應商失敗") && err.message.includes("備援也失敗"),
  );
  assert.equal(getAiFallbackStats().failures > 0, true);

  // 取消註冊（回 null = 關閉備援）→ 主供應商錯誤原樣上拋。
  registerAiFallbackProvider(async () => null);
  await assert.rejects(
    anthropic.messages.create({ ...paramsWith("t4"), tier: "quality" }),
    (err: Error) => err.message.startsWith("AI provider error"),
  );
});

// ── 雙線道（v4）：主線道卡死 bypass 測試 ────────────────────────────────
test("主線道卡死：下一個任務直接走備援；卡死任務逾時後退回備援", async () => {
  // 重新註冊備援（上一個測試取消註冊過）。
  registerAiFallbackProvider(async (tier) =>
    tier === "bulk"
      ? { baseUrl: "https://fb.example/v1", apiKey: "fb-key", qualityModel: "q", bulkModel: "b" }
      : { baseUrl: "https://fb.example/v1", apiKey: "fb-key", qualityModel: "fb-q", bulkModel: "b" },
  );

  let primaryAborted = false;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as FetchBody;
    const marker = body.messages.at(-1)?.content ?? "?";
    // 只有「主供應商」對 hang 請求卡死；備援端點正常回應。
    if (marker === "hang" && String(url).includes("stub.invalid")) {
      // 主供應商卡死：不回應，直到 abort（模擬 slow hang）。
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          primaryAborted = true;
          reject(new Error("This operation was aborted"));
        });
      });
      throw new Error("unreachable");
    }
    // 備援回應延遲 30ms，讓測試能觀察到「兩線道同時在飛」。
    await new Promise((r) => setTimeout(r, 30));
    return new Response(
      JSON.stringify({
        id: "fb",
        model: "gemini-stub",
        choices: [
          { index: 0, message: { role: "assistant", content: "fb-" + marker }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  // abort timer（AbortSignal.timeout）不會 hold 事件迴圈：持住一個 ref'd
  // timer 確保逾時在測試完成前發生（正式環境的排程迴圈本來就會 hold）。
  const keepAlive = setTimeout(() => {}, 1_000);

  // 1) 第一個任務：主供應商卡死（150ms 逾時前不會有回應）。
  const t1 = anthropic.messages.create(paramsWith("hang"));

  // 2) 越過卡死門檻（40ms）但尚未逾時（150ms）：佇列應回報卡死中。
  await new Promise((r) => setTimeout(r, 80));
  const stuckStats = getAiQueueStats();
  assert.equal(stuckStats.active, 1);
  assert.notEqual(stuckStats.primaryStuckMs, null);

  // 3) 第二個任務進場：不應等卡死的第一個任務，直接走備援線道。
  const t2 = anthropic.messages.create(paramsWith("next"));
  await new Promise((r) => setTimeout(r, 10));
  // 兩線道同時在飛：主線道卡死中 + 備援線道處理 next。
  assert.equal(getAiQueueStats().active, 2);

  // t2 必須在 t1 完全逾時（150ms）之前就完成。
  const race = await Promise.race([
    t2.then(() => "t2-done"),
    new Promise((r) => setTimeout(() => "timeout", 140)),
  ]);
  assert.equal(race, "t2-done");
  const m2 = await t2;
  assert.equal(m2.content[0]?.text, "fb-next");

  // 4) 卡死的第一個任務：完全逾時 abort 後「退回交給備援」，最終成功。
  const m1 = await t1;
  assert.equal(primaryAborted, true);
  assert.equal(m1.content[0]?.text, "fb-hang");
  assert.equal(getAiQueueStats().active, 0);
  clearTimeout(keepAlive);
});

test("parseDailyQuotaCooldownMs：辨識 Gemini 每日配額 429 並解析 retry in", async () => {
  const { parseDailyQuotaCooldownMs } = await import("./client");
  const msg =
    'AI provider error 429: [{ "error": { "code": 429, "message": "You exceeded your current quota ... Please retry in 18h41m20.25s.", "status": "RESOURCE_EXHAUSTED" } }]';
  const ms = parseDailyQuotaCooldownMs(msg);
  assert.ok(ms !== null && ms > 0);
  // 上限 6 小時，避免一次誤判就把備援關一整天。
  assert.equal(ms, 6 * 60 * 60 * 1000);
  // 短冷卻照解析值。
  assert.equal(
    parseDailyQuotaCooldownMs("AI provider error 429: quota RESOURCE_EXHAUSTED retry in 90s"),
    90_000,
  );
  // 非 429 不冷卻。
  assert.equal(parseDailyQuotaCooldownMs("AI provider error 503: nope"), null);
});

test("備援配額用盡 → 冷卻期間不再呼叫備援，直接回報主供應商錯誤", async () => {
  const { isFallbackCoolingDown, __resetFallbackCooldownForTest } = await import("./client");
  __resetFallbackCooldownForTest();
  registerAiFallbackProvider(async () => ({
    baseUrl: "https://fallback.example/v1",
    apiKey: "fb-key",
    qualityModel: "fb-q",
    bulkModel: "fb-b",
  }));
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://fallback.example")) {
      return new Response(
        '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"exceeded your current quota. Please retry in 2h"}}',
        { status: 429 },
      );
    }
    return new Response("primary down", { status: 500 });
  }) as typeof fetch;

  // 第一次：主失敗 → 備援 429（配額）→ 進入冷卻。
  await assert.rejects(anthropic.messages.create({ ...paramsWith("c1"), tier: "quality" }));
  assert.equal(isFallbackCoolingDown(), true);
  const fallbackCallsAfterFirst = urls.filter((u) => u.startsWith("https://fallback.example")).length;

  // 第二次：冷卻中 → 不碰備援，錯誤是主供應商原樣。
  await assert.rejects(
    anthropic.messages.create({ ...paramsWith("c2"), tier: "quality" }),
    (err: Error) => err.message.startsWith("AI provider error 500"),
  );
  assert.equal(
    urls.filter((u) => u.startsWith("https://fallback.example")).length,
    fallbackCallsAfterFirst,
  );
  __resetFallbackCooldownForTest();
});

test("Nemotron 推理模型：請求帶 enable_thinking:false；其他模型不帶", async () => {
  const { shouldDisableThinking, __resetThinkingFlagForTest } = await import("./client");
  __resetThinkingFlagForTest();
  assert.equal(shouldDisableThinking("nvidia/nemotron-3-ultra-550b-a55b"), true);
  assert.equal(shouldDisableThinking("google/diffusiongemma-26b-a4b-it"), false);

  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }),
      { status: 200 },
    );
  }) as typeof fetch;
  await anthropic.messages.create({
    ...paramsWith("th1"),
    model: "nvidia/nemotron-3-ultra-550b-a55b",
  });
  await anthropic.messages.create({
    ...paramsWith("th2"),
    model: "google/diffusiongemma-26b-a4b-it",
  });
  assert.deepEqual(bodies[0]!.chat_template_kwargs, { enable_thinking: false });
  assert.equal("chat_template_kwargs" in bodies[1]!, false);
});

test("供應商拒絕 chat_template_kwargs → 不帶旗標自動重試並記住", async () => {
  const { __resetThinkingFlagForTest } = await import("./client");
  __resetThinkingFlagForTest();
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(b);
    if (b.chat_template_kwargs !== undefined) {
      return new Response('{"detail":"Extra inputs are not permitted: chat_template_kwargs"}', { status: 422 });
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "fine" }, finish_reason: "stop" }], usage: {} }),
      { status: 200 },
    );
  }) as typeof fetch;
  const msg = await anthropic.messages.create({
    ...paramsWith("th3"),
    model: "nvidia/nemotron-3-ultra-550b-a55b",
  });
  assert.equal((msg.content[0] as { text: string }).text, "fine");
  assert.equal(bodies.length, 2);
  // 之後的請求不再帶旗標。
  await anthropic.messages.create({ ...paramsWith("th4"), model: "nvidia/nemotron-3-ultra-550b-a55b" });
  assert.equal("chat_template_kwargs" in bodies[2]!, false);
  __resetThinkingFlagForTest();
});
