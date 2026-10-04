import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, playerNationsTable } from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { logger } from "../lib/logger";
import { getPendingDemand, respondToDemand } from "../lib/militaryDemand/service";
import { REFUSE_PENALTY, AUTO_WAR_BELOW, COUP_BELOW } from "../lib/militaryDemand/core";

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

/** 目前待回應的軍方要求(沒有則 pending=null)+ 規則常數供前端顯示 */
router.get("/military-demand", async (req, res) => {
  const auth = await requirePlayer(req, res); if (!auth) return;
  try {
    const d = await getPendingDemand(auth.nation.id);
    res.json({
      pending: d ? { id: d.id, regionName: d.regionName, targetNationName: d.targetNationName, createdAt: d.createdAt.toISOString() } : null,
      refusePenalty: REFUSE_PENALTY, autoWarBelow: AUTO_WAR_BELOW, coupBelow: COUP_BELOW,
      satisfaction: Math.round(auth.nation.satisfactionMilitary),
    });
  } catch (err) {
    logger.error({ err }, "military demand view failed");
    res.status(500).json({ error: "讀取軍方要求失敗" });
  }
});

router.post("/military-demand/:id/respond", async (req, res) => {
  const auth = await requirePlayer(req, res); if (!auth) return;
  const id = Number(req.params.id);
  const accept = req.body?.accept;
  if (!Number.isInteger(id) || id <= 0 || typeof accept !== "boolean") {
    res.status(400).json({ error: "參數錯誤" }); return;
  }
  try {
    const r = await respondToDemand(auth.nation, id, accept);
    if (!r.ok) { res.status(409).json({ error: r.error ?? "無法處理" }); return; }
    res.json(r);
  } catch (err) {
    logger.error({ err }, "military demand respond failed");
    res.status(500).json({ error: "處理軍方要求失敗" });
  }
});

export default router;
