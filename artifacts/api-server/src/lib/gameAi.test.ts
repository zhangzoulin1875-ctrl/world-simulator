import { strict as assert } from "node:assert";
import test, { after, afterEach, before } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runAiUsageMigrations } from "./aiUsageMigrations";
import {
  AI_FEATURES,
  AI_MAX_TOKENS_FLOOR,
  AiQuotaExceededError,
  callGameAi,
  getTodayTokenUsage,
  invalidateAiFeatureSettingsCache,
  isAiFeatureKey,
  pruneAiUsageLogs,
} from "./gameAi";
import { generateAdvisorTips } from "./advisorAi";

/**
 * Task #593 — callGameAi 包裝層測試（真 DB：ai_usage_logs／ai_feature_settings）。
 *
 * 測試專用功能 key 選 `npc_initiative.proposals`（NPC 主動行動已停用，正式
 * 流程不會寫入該功能的列，與其他測試/背景迴圈不相撞）；每個案例前清空該
 * 功能的用量列與設定列並失效快取。anthropic 以「屬性覆寫」為樁——這正是
 * 包裝層必須在**呼叫當下**動態取用 messages.create 的原因，一併鎖住。
 *
 *  1. max_tokens：無覆寫 → 用註冊表預設；有覆寫 → 用覆寫；低於下限 → 夾到 256。
 *  2. 每日配額：用量達配額 → 丟 AiQuotaExceededError（zh-TW 訊息、不打模型）。
 *  3. 成功呼叫 → 寫入一列 success=true、token 取自回應 usage。
 *  4. 回應無 usage 欄位 → 記 0/0（不炸）。
 *  5. 模型拋錯 → 先記一列 success=false 再原樣拋出。
 *  6. advisor.tips 配額用罄 → generateAdvisorTips 原樣拋 AiQuotaExceededError
 *     （不被轉成一般 502 訊息，路由才能回 503）。
 *  7. pruneAiUsageLogs 只刪保留期外舊列。
 */

const FEATURE = "npc_initiative.proposals" as const;

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

let restore: (() => void) | null = null;
afterEach(async () => {
  if (restore) {
    restore();
    restore = null;
  }
  await cleanFeature(FEATURE);
  await cleanFeature("advisor.tips");
});

async function cleanFeature(feature: string): Promise<void> {
  await db.execute(sql`DELETE FROM ai_usage_logs WHERE feature = ${feature}`);
  await db.execute(
    sql`DELETE FROM ai_feature_settings WHERE feature = ${feature}`,
  );
  invalidateAiFeatureSettingsCache();
}

function stubCapture(
  response: unknown,
): { calls: Array<Record<string, unknown>>; restore: () => void } {
  const calls: Array<Record<string, unknown>> = [];
  const fn = (async (params: Record<string, unknown>) => {
    calls.push(params);
    return response;
  }) as unknown as MessagesCreate;
  anthropic.messages.create = fn;
  return {
    calls,
    restore: () => {
      anthropic.messages.create = realMessagesCreate;
    },
  };
}

function okResponse(input = 111, output = 222): unknown {
  return {
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: input, output_tokens: output },
  };
}

async function setSettings(
  feature: string,
  maxTokensOverride: number | null,
  dailyTokenQuota: number | null,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO ai_feature_settings (feature, max_tokens_override, daily_token_quota)
    VALUES (${feature}, ${maxTokensOverride}, ${dailyTokenQuota})
    ON CONFLICT (feature) DO UPDATE SET
      max_tokens_override = EXCLUDED.max_tokens_override,
      daily_token_quota = EXCLUDED.daily_token_quota,
      updated_at = NOW()
  `);
  invalidateAiFeatureSettingsCache();
}

async function loadRows(feature: string): Promise<
  Array<{ input_tokens: number; output_tokens: number; success: boolean; tier: string }>
> {
  const res = await db.execute(sql`
    SELECT input_tokens, output_tokens, success, tier
    FROM ai_usage_logs WHERE feature = ${feature} ORDER BY id
  `);
  return res.rows as Array<{
    input_tokens: number;
    output_tokens: number;
    success: boolean;
    tier: string;
  }>;
}

before(async () => {
  await runAiUsageMigrations();
  await cleanFeature(FEATURE);
  await cleanFeature("advisor.tips");
});

after(async () => {
  invalidateAiFeatureSettingsCache();
});

test("功能註冊表：isAiFeatureKey 與預設值", () => {
  assert.equal(isAiFeatureKey(FEATURE), true);
  assert.equal(isAiFeatureKey("bogus.feature"), false);
  assert.ok(AI_FEATURES[FEATURE].defaultMaxTokens >= AI_MAX_TOKENS_FLOOR);
});

test("max_tokens：無覆寫用預設、有覆寫用覆寫、低於下限夾到 256", async () => {
  const stub = stubCapture(okResponse());
  restore = stub.restore;

  await callGameAi(FEATURE, "bulk", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(stub.calls[0]?.max_tokens, AI_FEATURES[FEATURE].defaultMaxTokens);

  await setSettings(FEATURE, 512, null);
  await callGameAi(FEATURE, "bulk", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(stub.calls[1]?.max_tokens, 512);

  // 覆寫值低於下限（admin API 會擋，這裡直寫 DB 模擬歷史髒資料）→ 夾到下限。
  await setSettings(FEATURE, 100, null);
  await callGameAi(FEATURE, "bulk", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(stub.calls[2]?.max_tokens, AI_MAX_TOKENS_FLOOR);
});

test("system 有帶才進參數；tier 與 model 一併傳遞", async () => {
  const stub = stubCapture(okResponse());
  restore = stub.restore;

  await callGameAi(FEATURE, "quality", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal("system" in (stub.calls[0] ?? {}), false);
  assert.equal(typeof stub.calls[0]?.model, "string");

  await callGameAi(FEATURE, "quality", {
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(stub.calls[1]?.system, "sys");
});

test("每日配額用罄 → 丟 AiQuotaExceededError 且不呼叫模型", async () => {
  await setSettings(FEATURE, null, 100);
  // 先寫一列今日用量 60+50=110 > 100。
  await db.execute(sql`
    INSERT INTO ai_usage_logs (feature, tier, model, input_tokens, output_tokens, success)
    VALUES (${FEATURE}, 'bulk', 'test-model', 60, 50, true)
  `);
  const stub = stubCapture(okResponse());
  restore = stub.restore;

  await assert.rejects(
    callGameAi(FEATURE, "bulk", {
      messages: [{ role: "user", content: "hi" }],
    }),
    (err: unknown) => {
      assert.ok(err instanceof AiQuotaExceededError);
      assert.equal(err.feature, FEATURE);
      assert.match(err.message, /token 用量上限/);
      return true;
    },
  );
  assert.equal(stub.calls.length, 0, "配額用罄時不得呼叫模型");
});

test("配額 0 = 完全停用該功能", async () => {
  await setSettings(FEATURE, null, 0);
  const stub = stubCapture(okResponse());
  restore = stub.restore;
  await assert.rejects(
    callGameAi(FEATURE, "bulk", {
      messages: [{ role: "user", content: "hi" }],
    }),
    AiQuotaExceededError,
  );
  assert.equal(stub.calls.length, 0);
});

test("成功呼叫 → 記一列 success=true、token 來自回應 usage", async () => {
  const stub = stubCapture(okResponse(123, 456));
  restore = stub.restore;
  await callGameAi(FEATURE, "bulk", {
    messages: [{ role: "user", content: "hi" }],
  });
  const rows = await loadRows(FEATURE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.success, true);
  assert.equal(rows[0]?.input_tokens, 123);
  assert.equal(rows[0]?.output_tokens, 456);
  assert.equal(rows[0]?.tier, "bulk");
  assert.equal(await getTodayTokenUsage(FEATURE), 123 + 456);
});

test("回應缺 usage 欄位 → 記 0/0，不影響回傳", async () => {
  const stub = stubCapture({ content: [{ type: "text", text: "ok" }] });
  restore = stub.restore;
  const message = await callGameAi(FEATURE, "bulk", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.ok(message);
  const rows = await loadRows(FEATURE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.input_tokens, 0);
  assert.equal(rows[0]?.output_tokens, 0);
});

test("模型拋錯 → 先記 success=false 再原樣拋出", async () => {
  const fn = (async () => {
    throw new Error("模擬 AI 失敗");
  }) as unknown as MessagesCreate;
  anthropic.messages.create = fn;
  restore = () => {
    anthropic.messages.create = realMessagesCreate;
  };

  await assert.rejects(
    callGameAi(FEATURE, "bulk", {
      messages: [{ role: "user", content: "hi" }],
    }),
    /模擬 AI 失敗/,
  );
  const rows = await loadRows(FEATURE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.success, false);
  assert.equal(rows[0]?.input_tokens, 0);
});

test("advisor.tips 配額用罄 → generateAdvisorTips 原樣拋 AiQuotaExceededError", async () => {
  await setSettings("advisor.tips", null, 0);
  const stub = stubCapture(okResponse());
  restore = stub.restore;
  await assert.rejects(generateAdvisorTips("正經"), AiQuotaExceededError);
  assert.equal(stub.calls.length, 0);
});

test("pruneAiUsageLogs 只刪保留期外舊列", async () => {
  await db.execute(sql`
    INSERT INTO ai_usage_logs (feature, tier, model, input_tokens, output_tokens, success, created_at)
    VALUES
      (${FEATURE}, 'bulk', 'test-model', 1, 1, true, NOW() - INTERVAL '31 days'),
      (${FEATURE}, 'bulk', 'test-model', 2, 2, true, NOW())
  `);
  const pruned = await pruneAiUsageLogs();
  assert.ok(pruned >= 1);
  const rows = await loadRows(FEATURE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.input_tokens, 2);
});
