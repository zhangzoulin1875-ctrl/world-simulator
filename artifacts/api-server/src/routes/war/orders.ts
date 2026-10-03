import { type IRouter } from "express";
import { db, warCampaignOrdersTable } from "@workspace/db";
import { isWarOrderType, normalizeOrderBody } from "../../lib/war";
import { requireCampaignParticipant } from "./shared";

export function registerWarOrderRoutes(router: IRouter): void {
  // ── 指令提交（本週期，upsert 覆寫） ────────────────────────────

  router.post("/war/campaigns/:id/orders", async (req, res) => {
    const ctx = await requireCampaignParticipant(req, res);
    if (!ctx) return;
    const { campaign, nation } = ctx;
    if (campaign.status !== "active") {
      res.status(409).json({ error: "戰役已結束，無法下達指令" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const orderType = body.orderType;
    if (typeof orderType !== "string" || !isWarOrderType(orderType)) {
      res.status(400).json({ error: "指令類型必須是 command" });
      return;
    }
    const normalized = normalizeOrderBody(body.body);
    if (!normalized.ok) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    await db
      .insert(warCampaignOrdersTable)
      .values({
        campaignId: campaign.id,
        nationId: nation.id,
        cycleNumber: campaign.cycleNumber,
        orderType,
        body: normalized.body,
      })
      .onConflictDoUpdate({
        target: [
          warCampaignOrdersTable.campaignId,
          warCampaignOrdersTable.nationId,
          warCampaignOrdersTable.cycleNumber,
          warCampaignOrdersTable.orderType,
        ],
        set: { body: normalized.body, updatedAt: new Date() },
      });
    res.json({ ok: true });
  });
}
