import { Router, type IRouter } from "express";
import {
  getBotState,
  validateToken,
  saveToken,
  restartDiscordBot,
  getStoredToken,
} from "../lib/discordBot";
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

export default router;
