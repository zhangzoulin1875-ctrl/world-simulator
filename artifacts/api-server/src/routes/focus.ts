import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, playerNationsTable } from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { logger } from "../lib/logger";
import { cancelFocus, startFocus } from "../lib/focus/service";
import { getFocusView } from "../lib/focus/view";

const router: IRouter = Router();

async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
) {
  const session = await getSession(readSessionToken(req));
  if (!session) { res.status(401).json({ error: "尚未登入 Discord" }); return null; }
  const [nation] = await db.select().from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, session.discordUserId)).limit(1);
  if (!nation) { res.status(400).json({ error: "尚未建國,請先在首頁建立你的國家" }); return null; }
  return { nation };
}

const bodySchema = z.object({ focusId: z.string().min(1).max(100) });

/** 國策樹畫面所需的全部資料(唯讀)。 */
router.get("/focus", async (req, res) => {
  const auth = await requirePlayer(req, res); if (!auth) return;
  try {
    res.json(await getFocusView(auth.nation));
  } catch (err) {
    logger.error({ err }, "focus view failed");
    res.status(500).json({ error: "讀取國策樹失敗" });
  }
});

router.post("/focus/start", async (req, res) => {
  const auth = await requirePlayer(req, res); if (!auth) return;
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "缺少國策 id" }); return; }
  try {
    const r = await startFocus(auth.nation, parsed.data.focusId);
    if (!r.ok) {
      // 業務拒絕(點數不足/條件未達/互斥…)不是伺服器錯誤:404 找不到、其餘 409
      res.status(r.reason === "unknown_focus" ? 404 : 409).json({ error: r.message, reason: r.reason });
      return;
    }
    req.log.info({ nationId: auth.nation.id, focusId: r.focusId }, "focus started");
    res.json({ ...r, view: await getFocusView(auth.nation) });
  } catch (err) {
    logger.error({ err }, "focus start failed");
    res.status(500).json({ error: "啟動國策失敗" });
  }
});

router.post("/focus/cancel", async (req, res) => {
  const auth = await requirePlayer(req, res); if (!auth) return;
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "缺少國策 id" }); return; }
  try {
    const r = await cancelFocus(auth.nation, parsed.data.focusId);
    if (!r.ok) { res.status(409).json({ error: "此國策不在進行中" }); return; }
    req.log.info({ nationId: auth.nation.id, focusId: parsed.data.focusId }, "focus cancelled");
    res.json({ ok: true, refunded: r.refunded, view: await getFocusView(auth.nation) });
  } catch (err) {
    logger.error({ err }, "focus cancel failed");
    res.status(500).json({ error: "取消國策失敗" });
  }
});

export default router;
