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
import { logger } from "../lib/logger";
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

router.post("/bot/token", async (req, res) => {
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

export default router;
