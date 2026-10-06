import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  getBotState,
  validateToken,
  saveToken,
  restartDiscordBot,
  getStoredToken,
} from "../lib/discordBot";
import { getAiModelInfo, setAiModelOverride, type AiModelTier } from "../lib/aiModels";
import {
  getAiFallbackInfo,
  setAiFallbackOverrides,
} from "../lib/aiFallback";
import { getAiFallbackStats } from "@workspace/integrations-anthropic-ai";
import { logger } from "../lib/logger";
import { describeRoutePool, loadStoredRoutes, sanitizeRoutes, saveRoutes } from "../lib/aiRoutePool";
import { postChatCompletion, getRoutePoolLaneStats, setRoutePoolConcurrency } from "@workspace/integrations-anthropic-ai";
import { requireAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();

router.get("/bot/status", async (_req, res) => {
  const s = getBotState();
  const token = await getStoredToken();
  res.json({
    connected: s.ready,
    username: s.username,
    guildCount: s.guildCount,
    hasToken: Boolean(token),
  });
});

router.post("/bot/token", requireAdmin, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token) {
    res.status(400).json({ ok: false, error: "Token 不可為空" });
    return;
  }
  const result = await validateToken(token);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.error });
    return;
  }
  try {
    await saveToken(token);
    await restartDiscordBot(token);
    res.json({ ok: true, username: result.username });
  } catch (err) {
    logger.error({ err }, "Failed to apply new token");
    res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/bot/restart", requireAdmin, async (_req, res) => {
  const token = await getStoredToken();
  if (!token) {
    res.status(400).json({ ok: false, error: "尚未設定 bot token" });
    return;
  }
  try {
    await restartDiscordBot(token);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to restart Discord bot");
    res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * 後台可切換 AI 模型（NIM 上游模型眾多；換模型不該要求改環境變數＋重新部署）。
 * quality／bulk 兩層，覆寫值存在 bot_settings，寫入後 30 秒內（短 TTL 快取，
 * PATCH 後立即失效）全站 AI 呼叫就會改用新模型，不需要重啟服務。
 */
router.get("/bot/ai-models", requireAdmin, async (_req, res) => {
  const info = await getAiModelInfo();
  res.json(info);
});

const aiModelPatchSchema = z
  .object({
    tier: z.enum(["quality", "bulk"]),
    model: z.string().trim().min(1).max(200).nullable(),
  })
  .strict();

router.patch("/bot/ai-models", requireAdmin, async (req, res) => {
  const parsed = aiModelPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: "格式不正確",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }
  const { tier, model } = parsed.data;
  try {
    await setAiModelOverride(tier as AiModelTier, model);
    const info = await getAiModelInfo();
    req.log.info({ tier, model }, "ai model override updated");
    res.json({ ok: true, ...info });
  } catch (err) {
    logger.error({ err }, "Failed to update ai model override");
    res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── 通用 AI 線路池：任何 OpenAI v1 相容端點（公益站等），輪詢＋斷路器 ──
router.get("/bot/ai-routes", requireAdmin, async (_req, res) => {
  res.json({ routes: await describeRoutePool(), lane: getRoutePoolLaneStats() });
});

/** 池線道併發上限（1~16）。池健康時所有排隊任務都由池處理，不受 NIM 的 35 RPM 限制。 */
router.put("/bot/ai-routes/concurrency", requireAdmin, (req, res) => {
  const n = Number((req.body ?? {}).concurrency);
  if (!Number.isFinite(n) || n < 1 || n > 16) { res.status(400).json({ ok: false, error: "concurrency 需為 1~16" }); return; }
  setRoutePoolConcurrency(n);
  res.json({ ok: true, lane: getRoutePoolLaneStats() });
});

/** 整份覆蓋。apiKey 留空或回傳遮罩值＝沿用該 id 原本的 key。 */
router.put("/bot/ai-routes", requireAdmin, async (req, res) => {
  try {
    const existing = await loadStoredRoutes();
    const routes = sanitizeRoutes((req.body ?? {}).routes, existing);
    await saveRoutes(routes);
    res.json({ ok: true, routes: await describeRoutePool() });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/** 測試單一線路（用已存的 key）：送一個極短請求，回延遲與結果。 */
router.post("/bot/ai-routes/:id/test", requireAdmin, async (req, res) => {
  const route = (await loadStoredRoutes()).find((r) => r.id === req.params.id);
  if (!route) { res.status(404).json({ ok: false, error: "找不到這條線路" }); return; }
  const t0 = Date.now();
  try {
    const m = await postChatCompletion(
      `${route.baseUrl}/chat/completions`, route.apiKey,
      { model: route.qualityModel, max_tokens: 32, messages: [{ role: "user", content: "回覆「OK」兩個字即可。" }] },
      route.qualityModel,
    );
    const text = m.content.map((b) => b.text).join("").trim();
    res.json({ ok: text !== "", ms: Date.now() - t0, model: m.model, reply: text.slice(0, 80), error: text === "" ? "HTTP 200 但回應內容為空" : null });
  } catch (err) {
    res.json({ ok: false, ms: Date.now() - t0, error: String((err as Error).message).slice(0, 300) });
  }
});

/**
 * AI 備援（fallback）供應商
設定：主供應商（NIM）單次呼叫失敗時，adapter
 * 會自動改用這裡設定的備援 API（預設 Gemini 的 OpenAI 相容端點）重試一次。
 * key／baseUrl／模型皆後台可調，存 bot_settings（30 秒 TTL 快取，
 * PATCH 後立即失效），不需重啟服務。GET 永遠不回傳 API key 本體。
 */
router.get("/bot/ai-fallback", requireAdmin, async (_req, res) => {
  const info = await getAiFallbackInfo();
  res.json({ ...info, stats: getAiFallbackStats() });
});

const aiFallbackPatchSchema = z
  .object({
    baseUrl: z.string().trim().max(500).nullable().optional(),
    apiKey: z.string().trim().min(1).max(500).nullable().optional(),
    qualityModel: z.string().trim().max(200).nullable().optional(),
    bulkModel: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

router.patch("/bot/ai-fallback", requireAdmin, async (req, res) => {
  const parsed = aiFallbackPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: "格式不正確",
      issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    return;
  }
  try {
    await setAiFallbackOverrides(parsed.data);
    const info = await getAiFallbackInfo();
    // 不把 key 寫進請求紀錄（只記哪個欄位有變動）。
    req.log.info(
      { fields: Object.keys(parsed.data) },
      "ai fallback settings updated",
    );
    res.json({ ok: true, ...info, stats: getAiFallbackStats() });
  } catch (err) {
    logger.error({ err }, "Failed to update ai fallback settings");
    res
      .status(500)
      .json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
