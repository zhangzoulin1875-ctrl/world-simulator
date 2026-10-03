import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { z } from "zod";
import { requireAdmin } from "../middlewares/requireAdmin";
import {
  AI_FEATURES,
  AI_MAX_TOKENS_FLOOR,
  callGameAi,
  invalidateAiFeatureSettingsCache,
  isAiFeatureKey,
  todayStartInstant,
} from "../lib/gameAi";
import { getAiModel } from "../lib/aiModels";
import { NEWS_SCHEDULE_TZ, localDateString } from "../lib/time";

/**
 * Task #593 — AI 用量統計＋各功能 token 上限 admin API（requireAdmin
 * raw-fetch，**不在**公開 OpenAPI spec，比照 game-balance／world-sim 模式）。
 *
 *  - GET   /api/ai-usage/summary：全部功能的今日／7 日／30 日用量統計
 *    （呼叫數、輸入/輸出 token、失敗數）＋目前設定（覆寫值與程式碼預設）。
 *  - PATCH /api/ai-usage/settings/:feature：讀-併-寫該功能設定
 *    （maxTokensOverride／dailyTokenQuota，null=清除），成功後立即失效快取。
 */
const router: IRouter = Router();

interface UsageWindow {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  failures: number;
}

const EMPTY_WINDOW: UsageWindow = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  failures: 0,
};

router.get("/ai-usage/summary", requireAdmin, async (_req, res) => {
  const todayStart = todayStartInstant();

  // 單一 GROUP BY 掃 30 天窗，FILTER 切出三個時間窗（today 以當地日期起點計）。
  const usageRes = await db.execute(sql`
    SELECT
      feature,
      COUNT(*) FILTER (WHERE created_at >= ${todayStart})::int AS today_calls,
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= ${todayStart}), 0)::bigint AS today_input,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= ${todayStart}), 0)::bigint AS today_output,
      COUNT(*) FILTER (WHERE created_at >= ${todayStart} AND NOT success)::int AS today_failures,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS d7_calls,
      COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)::bigint AS d7_input,
      COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)::bigint AS d7_output,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days' AND NOT success)::int AS d7_failures,
      COUNT(*)::int AS d30_calls,
      COALESCE(SUM(input_tokens), 0)::bigint AS d30_input,
      COALESCE(SUM(output_tokens), 0)::bigint AS d30_output,
      COUNT(*) FILTER (WHERE NOT success)::int AS d30_failures
    FROM ai_usage_logs
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY feature
  `);

  const usageByFeature = new Map<
    string,
    { today: UsageWindow; last7d: UsageWindow; last30d: UsageWindow }
  >();
  for (const r of usageRes.rows as Array<Record<string, unknown>>) {
    const win = (calls: unknown, input: unknown, output: unknown, failures: unknown): UsageWindow => ({
      calls: Number(calls ?? 0),
      inputTokens: Number(input ?? 0),
      outputTokens: Number(output ?? 0),
      totalTokens: Number(input ?? 0) + Number(output ?? 0),
      failures: Number(failures ?? 0),
    });
    usageByFeature.set(String(r.feature), {
      today: win(r.today_calls, r.today_input, r.today_output, r.today_failures),
      last7d: win(r.d7_calls, r.d7_input, r.d7_output, r.d7_failures),
      last30d: win(r.d30_calls, r.d30_input, r.d30_output, r.d30_failures),
    });
  }

  const settingsRes = await db.execute(sql`
    SELECT feature, max_tokens_override, daily_token_quota
    FROM ai_feature_settings
  `);
  const settingsByFeature = new Map<
    string,
    { maxTokensOverride: number | null; dailyTokenQuota: number | null }
  >();
  for (const r of settingsRes.rows as Array<{
    feature: string;
    max_tokens_override: number | null;
    daily_token_quota: number | null;
  }>) {
    settingsByFeature.set(r.feature, {
      maxTokensOverride: r.max_tokens_override,
      dailyTokenQuota: r.daily_token_quota,
    });
  }

  // Task #596 — 最近 30 天每日 × 功能 token 用量（按 NEWS_SCHEDULE_TZ 當地日期分組），
  // 供 /ai-usage 頁面畫每日趨勢折線圖，提早發現 token 花費暴增。
  const dailyRes = await db.execute(sql`
    SELECT
      to_char(created_at AT TIME ZONE ${NEWS_SCHEDULE_TZ}, 'YYYY-MM-DD') AS day,
      feature,
      COUNT(*)::int AS calls,
      COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total_tokens,
      COUNT(*) FILTER (WHERE NOT success)::int AS failures
    FROM ai_usage_logs
    WHERE created_at >= NOW() - INTERVAL '30 days'
    GROUP BY 1, 2
    ORDER BY 1
  `);
  const daily = (dailyRes.rows as Array<Record<string, unknown>>).map((r) => ({
    date: String(r.day),
    feature: String(r.feature),
    calls: Number(r.calls ?? 0),
    totalTokens: Number(r.total_tokens ?? 0),
    failures: Number(r.failures ?? 0),
  }));

  // 完整 30 天日期軸由伺服器產生（與分組同一時區），前端補零即可，
  // 避免瀏覽器時區與 NEWS_SCHEDULE_TZ 不一致造成日期錯位。
  const now = new Date();
  const days: string[] = [];
  for (let i = 29; i >= 0; i--) {
    days.push(localDateString(new Date(now.getTime() - i * 86_400_000)));
  }

  const features = Object.entries(AI_FEATURES).map(([key, def]) => {
    const usage = usageByFeature.get(key);
    const settings = settingsByFeature.get(key);
    return {
      feature: key,
      label: def.label,
      defaultMaxTokens: def.defaultMaxTokens,
      maxTokensOverride: settings?.maxTokensOverride ?? null,
      dailyTokenQuota: settings?.dailyTokenQuota ?? null,
      today: usage?.today ?? EMPTY_WINDOW,
      last7d: usage?.last7d ?? EMPTY_WINDOW,
      last30d: usage?.last30d ?? EMPTY_WINDOW,
    };
  });

  res.json({ features, maxTokensFloor: AI_MAX_TOKENS_FLOOR, daily, days });
});

const settingsPatchSchema = z
  .object({
    maxTokensOverride: z
      .number()
      .int()
      .min(AI_MAX_TOKENS_FLOOR, `max_tokens 覆寫值不可低於 ${AI_MAX_TOKENS_FLOOR}`)
      .max(64000, "max_tokens 覆寫值過大")
      .nullable()
      .optional(),
    dailyTokenQuota: z
      .number()
      .int()
      .min(0, "每日 token 配額不可為負數")
      .max(2_000_000_000, "每日 token 配額過大")
      .nullable()
      .optional(),
  })
  .strict();

router.patch("/ai-usage/settings/:feature", requireAdmin, async (req, res) => {
  const rawFeature = req.params.feature;
  const feature = Array.isArray(rawFeature) ? rawFeature[0] : rawFeature;
  if (!isAiFeatureKey(feature)) {
    res.status(404).json({ error: "找不到該 AI 功能" });
    return;
  }
  const parsed = settingsPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "設定格式不正確",
      issues: parsed.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    });
    return;
  }
  const patch = parsed.data;
  if (patch.maxTokensOverride === undefined && patch.dailyTokenQuota === undefined) {
    res.status(400).json({ error: "至少需提供一個要更新的欄位" });
    return;
  }

  // 讀-併-寫 upsert：未帶的欄位保留既有值（COALESCE 於 SQL 端合併）。
  await db.execute(sql`
    INSERT INTO ai_feature_settings (feature, max_tokens_override, daily_token_quota, updated_at)
    VALUES (
      ${feature},
      ${patch.maxTokensOverride === undefined ? null : patch.maxTokensOverride},
      ${patch.dailyTokenQuota === undefined ? null : patch.dailyTokenQuota},
      NOW()
    )
    ON CONFLICT (feature) DO UPDATE SET
      max_tokens_override = ${
        patch.maxTokensOverride === undefined
          ? sql`ai_feature_settings.max_tokens_override`
          : sql`EXCLUDED.max_tokens_override`
      },
      daily_token_quota = ${
        patch.dailyTokenQuota === undefined
          ? sql`ai_feature_settings.daily_token_quota`
          : sql`EXCLUDED.daily_token_quota`
      },
      updated_at = NOW()
  `);
  invalidateAiFeatureSettingsCache();

  const row = (
    await db.execute(sql`
      SELECT feature, max_tokens_override, daily_token_quota
      FROM ai_feature_settings WHERE feature = ${feature}
    `)
  ).rows[0] as {
    feature: string;
    max_tokens_override: number | null;
    daily_token_quota: number | null;
  };
  req.log.info({ feature, patch }, "ai feature settings updated");
  res.json({
    ok: true,
    feature,
    maxTokensOverride: row?.max_tokens_override ?? null,
    dailyTokenQuota: row?.daily_token_quota ?? null,
  });
});

/**
 * 使用者回報「AI 調用好像失敗」卻查不出原因：既有失敗紀錄只記 success=false，
 * 不存錯誤訊息本體。這個端點讓管理員直接觸發一次真實呼叫並把底層錯誤（NIM
 * 回傳的 HTTP 狀態碼＋錯誤內容，或逾時/網路錯誤訊息）整段回傳到後台頁面，
 * 不像一般遊戲呼叫路徑那樣把錯誤吞掉只留一筆失敗列。
 */
const testBodySchema = z.object({ tier: z.enum(["quality", "bulk"]) }).strict();

/** 連線測試逾時（毫秒）：測試只要 20 個輸出 token，30 秒拿不到回應
 *  幾乎可斷定上游卡住（模型佇列過長／端點錯誤），不必等滿 120 秒的
 *  一般請求逾時，讓後台按鈕快速得到結論。 */
const AI_TEST_TIMEOUT_MS = 30_000;

function testTimeoutError(): Error {
  return new Error(
    `測試逾時：${AI_TEST_TIMEOUT_MS / 1000} 秒內沒有收到 AI 回應。` +
      "可能原因：模型佇列過長、模型 ID 不存在或已下架、或 AI 端點網址設定錯誤。",
  );
}

router.post("/ai-usage/test", requireAdmin, async (req, res) => {
  const parsed = testBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "tier 必須是 quality 或 bulk" });
    return;
  }
  const { tier } = parsed.data;
  const model = await getAiModel(tier);
  const startedAt = Date.now();
  try {
    const message = (await Promise.race([
      callGameAi("diagnostics.ping", tier, {
        system: "你是系統連線測試工具，只需照指示簡短回覆，不要輸出其他內容。",
        messages: [
          { role: "user", content: "請只回覆「ok」兩個字，不要加任何其他文字或標點。" },
        ],
      }),
      new Promise<never>((_resolve, reject) => {
        const t = setTimeout(() => reject(testTimeoutError()), AI_TEST_TIMEOUT_MS);
        if (typeof t === "object" && t && "unref" in t) t.unref();
      }),
    ])) as Awaited<ReturnType<typeof callGameAi>>;
    const latencyMs = Date.now() - startedAt;
    const content = (message as { content?: Array<{ type?: string; text?: string }> })
      .content;
    const reply = Array.isArray(content)
      ? content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("").slice(0, 200)
      : "";
    res.json({ ok: true, tier, model, latencyMs, reply });
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const error = err instanceof Error ? err.message : String(err);
    req.log.warn({ err, tier, model }, "ai connectivity test failed");
    res.json({ ok: false, tier, model, latencyMs, error });
  }
});

export default router;
