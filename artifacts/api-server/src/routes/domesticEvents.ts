import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, playerNationsTable } from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { logger } from "../lib/logger";
import { getNationTick, getPendingEvent, listRecentEvents, resolveEvent } from "../lib/domesticEvents/service";

const router: IRouter = Router();

async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
) {
  const session = await getSession(readSessionToken(req));
  if (!session) { res.status(401).json({ error: "請先登入 Discord" }); return null; }
  const [nation] = await db.select().from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, session.discordUserId)).limit(1);
  if (!nation) { res.status(400).json({ error: "你還沒有國家" }); return null; }
  return { nation };
}

const resolveSchema = z.object({ choiceId: z.string().min(1).max(50) });

/** 目前待處理的國內事件 + 最近的歷史 */
router.get("/domestic-events", async (req, res) => {
  const auth = await requirePlayer(req, res); if (!auth) return;
  try {
    const [pending, recent, tick] = await Promise.all([getPendingEvent(auth.nation.id), listRecentEvents(auth.nation.id, 8), getNationTick(auth.nation.id)]);
    res.json({
      pending: pending
        ? { id: pending.id, kind: pending.kind, title: pending.title, body: pending.body, choices: pending.choices, turnsLeft: Math.max(0, pending.dueTick - tick) }
        : null,
      history: recent
        .filter((e) => e.status !== "pending")
        .map((e) => ({ id: e.id, kind: e.kind, title: e.title, status: e.status, chosenId: e.chosenId, outcome: e.outcome, resolvedAt: e.resolvedAt })),
    });
  } catch (err) {
    logger.error({ err }, "domestic events view failed");
    res.status(500).json({ error: "讀取事件失敗" });
  }
});

/** 玩家選擇一個選項 */
router.post("/domestic-events/:id/resolve", async (req, res) => {
  const auth = await requirePlayer(req, res); if (!auth) return;
  const parsed = resolveSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "缺少選項" }); return; }
  const id = String(req.params["id"] ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "事件編號不正確" }); return; }
  try {
    const r = await resolveEvent(auth.nation, id, parsed.data.choiceId);
    if (!r.ok) {
      res.status(r.reason === "no_event" ? 404 : 409).json({ error: r.message, reason: r.reason });
      return;
    }
    res.json({ ok: true, outcome: r.outcome, civilWar: r.civilWar });
  } catch (err) {
    logger.error({ err }, "domestic event resolve failed");
    res.status(500).json({ error: "處理事件失敗" });
  }
});

export default router;
