import { Router, type IRouter, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requirePlayer, buildAvailableUnits } from "./war/shared";
import { canContestRig, OIL_INELIGIBLE_MESSAGE } from "../lib/oilRigCore";
import { loadResearchedKeySlugs } from "../lib/militaryTechData";
import {
  OilCampaignError, launchOilCampaign, reinforceOilCampaign, controlledRegionNames, describeOilCampaign,
} from "../lib/oilCampaignService";
import { OIL_CAMPAIGN_DELAY_HOURS } from "../lib/oilCombat";

/**
 * 油井戰役(玩家端)。凍結由全域 seasonFreeze 中介層擋(寫入一律 423),這裡不重複。
 * 不在 OpenAPI spec(與 oilRigs 同慣例)。
 */
const router: IRouter = Router();

function handle(fn: (req: Request, auth: { nationId: string; userId: string }) => Promise<unknown>) {
  return async (req: Request, res: Response): Promise<void> => {
    const auth = await requirePlayer(req, res);
    if (!auth) return;
    try {
      res.json(await fn(req, { nationId: auth.nation.id, userId: auth.userId }));
    } catch (err) {
      if (err instanceof OilCampaignError) {
        res.status(err.status).json({ error: err.message, code: err.code });
        return;
      }
      req.log.error({ err, nationId: auth.nation.id }, "oil campaign route failed");
      res.status(500).json({ error: "伺服器錯誤" });
    }
  };
}

/** 我的艦船可派量(只含 ship 類別),供派艦介面使用。 */
router.get("/oil-campaigns/my-fleet", handle(async (_req, { nationId, userId }) => {
  const views = await buildAvailableUnits(userId, nationId);
  if (views.length === 0) return { ships: [] };
  const ids = views.map((v) => v.templateId);
  const r = await db.execute(sql`SELECT id FROM military_unit_templates WHERE category = 'ship' AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  const shipIds = new Set((r.rows as { id: number }[]).map((x) => Number(x.id)));
  return { ships: views.filter((v) => shipIds.has(v.templateId) && (v.owned > 0 || v.available > 0)) };
}));

/** 進行中與近期戰役(公開資訊,任何登入玩家可看)。 */
router.get("/oil-campaigns", handle(async () => {
  const r = await db.execute(sql`
    SELECT c.id FROM oil_campaigns c
    WHERE c.status = 'active' OR c.settled_at > now() - interval '48 hours'
    ORDER BY c.started_at DESC LIMIT 50
  `);
  const out = [];
  for (const row of r.rows as { id: number }[]) { const d = await describeOilCampaign(row.id); if (d) out.push(d); }
  return { delayHours: OIL_CAMPAIGN_DELAY_HOURS, campaigns: out };
}));

/** 我能不能打某座油井(UI 用來顯示按鈕狀態與原因)。 */
router.get("/oil-campaigns/eligibility/:slug", handle(async (req, { nationId, userId }) => {
  const regions = await controlledRegionNames(nationId);
  const techs = await loadResearchedKeySlugs(userId);
  const e = canContestRig(regions, techs, String(req.params["slug"]));
  return e.ok ? { eligible: true } : { eligible: false, reason: e.reason, message: OIL_INELIGIBLE_MESSAGE[e.reason] };
}));

/** 發起戰役:{ rigSlug, fleet: [{ templateId, quantity }] } */
router.post("/oil-campaigns", handle(async (req, { nationId, userId }) => {
  const body = (req.body ?? {}) as { rigSlug?: unknown; fleet?: unknown };
  if (typeof body.rigSlug !== "string" || body.rigSlug.length === 0 || body.rigSlug.length > 64) throw new OilCampaignError(400, "請指定油井", "BAD_REQUEST");
  if (!Array.isArray(body.fleet)) throw new OilCampaignError(400, "請指定要投入的艦隊", "BAD_REQUEST");
  const regions = await controlledRegionNames(nationId);
  const techs = await loadResearchedKeySlugs(userId);
  const e = canContestRig(regions, techs, body.rigSlug);
  if (!e.ok) throw new OilCampaignError(e.reason === "unknown_rig" ? 404 : 403, OIL_INELIGIBLE_MESSAGE[e.reason], e.reason.toUpperCase());
  const r = await launchOilCampaign({ rigSlug: body.rigSlug, attacker: { nationId, discordUserId: userId }, fleet: body.fleet as never });
  return { ok: true, campaignId: r.campaignId, settleAt: r.settleAt };
}));

/** 追加艦隊(攻方加攻方、現任守方加守方)。 */
router.post("/oil-campaigns/:id/reinforce", handle(async (req, { nationId, userId }) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) throw new OilCampaignError(404, "找不到這場戰役", "UNKNOWN_CAMPAIGN");
  const body = (req.body ?? {}) as { fleet?: unknown };
  if (!Array.isArray(body.fleet)) throw new OilCampaignError(400, "請指定要投入的艦隊", "BAD_REQUEST");
  const r = await reinforceOilCampaign({ campaignId: id, who: { nationId, discordUserId: userId }, fleet: body.fleet as never });
  return { ok: true, side: r.side };
}));

export default router;
