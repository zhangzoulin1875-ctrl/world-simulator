import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, playerNationsTable } from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import { logger } from "../lib/logger";
import { DOMESTIC_EVENTS, EVENT_CHANCE, EVENT_DEADLINE_TURNS, EVENT_EVERY_TURNS } from "../lib/domesticEvents/core";
import { adminOverview, cancelPendingEvent, sendEventToNations } from "../lib/domesticEvents/service";

/**
 * 國內事件後台(管理員專用,Bearer ADMIN_TOKEN;raw fetch,不進 OpenAPI spec)。
 * 管理員看得到效果數字(玩家看不到),可以把任一事件投放給單一玩家國或所有玩家國。
 */
const router: IRouter = Router();

const sendSchema = z.object({
  kind: z.string().min(1).max(50),
  target: z.union([
    z.object({ type: z.literal("allPlayers") }),
    z.object({ type: z.literal("nation"), nationId: z.string().uuid() }),
  ]),
  rewrite: z.boolean().optional(),
});

router.get("/admin/domestic-events", requireAdmin, async (_req, res) => {
  try {
    res.json({
      settings: { everyTurns: EVENT_EVERY_TURNS, chance: EVENT_CHANCE, deadlineTurns: EVENT_DEADLINE_TURNS },
      catalog: DOMESTIC_EVENTS.map((d) => ({
        kind: d.kind,
        title: d.title,
        body: d.body,
        weight: d.weight,
        defaultChoiceId: d.defaultChoiceId,
        choices: d.choices.map((c) => ({ id: c.id, style: c.style, label: c.label, hint: c.hint, effects: c.effects })),
      })),
      recent: await adminOverview(40),
    });
  } catch (err) {
    logger.error({ err }, "admin domestic events overview failed");
    res.status(500).json({ error: "讀取失敗" });
  }
});

router.post("/admin/domestic-events/send", requireAdmin, async (req, res) => {
  const parsed = sendSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "參數不正確" }); return; }
  const { kind, target, rewrite } = parsed.data;
  if (!DOMESTIC_EVENTS.some((d) => d.kind === kind)) { res.status(400).json({ error: "沒有這種事件" }); return; }
  try {
    let ids: string[];
    if (target.type === "nation") {
      ids = [target.nationId];
    } else {
      const players = await db.select({ id: playerNationsTable.id }).from(playerNationsTable).where(eq(playerNationsTable.isNpc, false));
      ids = players.map((p) => p.id);
    }
    const result = await sendEventToNations(kind, ids, { rewrite });
    logger.info({ kind, target: target.type, sent: result.sent.length, skipped: result.skipped.length }, "admin sent domestic event");
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err }, "admin send domestic event failed");
    res.status(500).json({ error: "投放失敗" });
  }
});

router.post("/admin/domestic-events/:id/cancel", requireAdmin, async (req, res) => {
  const id = String(req.params["id"] ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.status(400).json({ error: "事件編號不正確" }); return; }
  try {
    const ok = await cancelPendingEvent(id);
    if (!ok) { res.status(409).json({ error: "這個事件已經處理過或不存在" }); return; }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "admin cancel domestic event failed");
    res.status(500).json({ error: "撤回失敗" });
  }
});

export default router;
