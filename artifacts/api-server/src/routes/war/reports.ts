import { type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import {
  db,
  warCampaignReportsTable,
  type WarReportSideSummary,
} from "@workspace/db";
import { fuzzValue } from "../../lib/war";
import { requireCampaignParticipant, serializeReportCities } from "./shared";

/** 帶符號模糊化：對絕對值模糊後套回原符號。 */
function fuzzSigned(value: number, level: number, seed: string): number {
  if (value === 0) return 0;
  const magnitude = fuzzValue(Math.abs(value), level, seed);
  return value < 0 ? -magnitude : magnitude;
}

export function registerWarReportRoutes(router: IRouter): void {
  // ── 戰報列表 ───────────────────────────────────────────────────

  router.get("/war/campaigns/:id/reports", async (req, res) => {
    const ctx = await requireCampaignParticipant(req, res);
    if (!ctx) return;
    const { campaign } = ctx;
    // Task #453 — 陣營以參戰列為準（晚加入者亦取其所屬方的戰報視角）。
    const myRole = ctx.mySide;
    const enemyRole = myRole === "attacker" ? "defender" : "attacker";
    const rows = await db
      .select()
      .from(warCampaignReportsTable)
      .where(eq(warCampaignReportsTable.campaignId, campaign.id))
      .orderBy(desc(warCampaignReportsTable.cycleNumber));
    res.json({
      reports: rows.map((r) => {
        const summary = r.summary;
        const mine: WarReportSideSummary = summary[myRole];
        const theirs: WarReportSideSummary = summary[enemyRole];
        const level = mine.reconLevel;
        const seed = `${campaign.id}:${r.cycleNumber}:report`;
        return {
          id: r.id,
          cycleNumber: r.cycleNumber,
          report: myRole === "attacker" ? r.attackerReport : r.defenderReport,
          mySide: {
            moraleDelta: mine.moraleDelta,
            woundedTotal: mine.woundedTotal,
            deadTotal: mine.deadTotal,
            territoryPctDelta: mine.territoryPctDelta,
            warWearinessDelta: mine.warWearinessDelta,
          },
          enemySide: {
            moraleDelta: fuzzSigned(theirs.moraleDelta, level, `${seed}:morale`),
            woundedTotal: fuzzValue(theirs.woundedTotal, level, `${seed}:wounded`),
            deadTotal: fuzzValue(theirs.deadTotal, level, `${seed}:dead`),
            territoryPctDelta: fuzzSigned(
              theirs.territoryPctDelta,
              level,
              `${seed}:territory`,
            ),
            warWearinessDelta: fuzzSigned(
              theirs.warWearinessDelta,
              level,
              `${seed}:weariness`,
            ),
          },
          attackerCityHoldoutPct: summary.attackerCityHoldoutPct,
          defenderCityHoldoutPct: summary.defenderCityHoldoutPct,
          attackerCities: serializeReportCities(summary.attackerCities),
          defenderCities: serializeReportCities(summary.defenderCities),
          localPopulationLoss: summary.localPopulationLoss,
          stalemate: summary.stalemate ?? false,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    });
  });
}
