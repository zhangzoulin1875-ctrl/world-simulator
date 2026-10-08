import { type IRouter } from "express";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  militaryUnitTemplatesTable,
  playerNationsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignsTable,
} from "@workspace/db";
import { getEraSlugs } from "../../lib/nationStats";
import { loadMercenaryUnitsForCampaign } from "../../lib/mercenaryService";
import {
  forecastCampaignSupply,
  maxResupplyAmount,
  resupplyUnitPrice,
  RESUPPLY_HORIZON_CYCLES,
  validateResupply,
  type ForecastLegionInput,
} from "../../lib/supplyForecast";
import { HttpError, requireCampaignParticipant } from "./shared";

/**
 * 載入某國在「所有進行中戰役」的軍團。
 * 結算時同一國家的所有軍團共用同一個彈藥庫存（見 warEngine/supplyPhase.ts），
 * 所以預估必須涵蓋全國，否則面板會在國家同時打多場仗時謊報「夠用」。
 */
async function loadNationActiveLegions(
  nationId: string,
  currentCampaignId: number,
): Promise<{ legions: ForecastLegionInput[]; campaignCount: number }> {
  const rows = await db
    .select({ legion: warCampaignLegionsTable })
    .from(warCampaignLegionsTable)
    .innerJoin(
      warCampaignsTable,
      eq(warCampaignsTable.id, warCampaignLegionsTable.campaignId),
    )
    .where(
      and(
        eq(warCampaignLegionsTable.nationId, nationId),
        eq(warCampaignsTable.status, "active"),
      ),
    )
    .orderBy(asc(warCampaignLegionsTable.campaignId), asc(warCampaignLegionsTable.slot));
  if (rows.length === 0) return { legions: [], campaignCount: 0 };

  const legionIds = rows.map((r) => r.legion.id);
  const unitRows = await db
    .select({
      legionId: warCampaignLegionUnitsTable.legionId,
      quantity: warCampaignLegionUnitsTable.quantity,
      category: militaryUnitTemplatesTable.category,
    })
    .from(warCampaignLegionUnitsTable)
    .leftJoin(
      militaryUnitTemplatesTable,
      eq(militaryUnitTemplatesTable.id, warCampaignLegionUnitsTable.templateId),
    )
    .where(inArray(warCampaignLegionUnitsTable.legionId, legionIds));
  const unitsByLegion = new Map<number, { quantity: number; category: string }[]>();
  for (const u of unitRows) {
    const list = unitsByLegion.get(u.legionId) ?? [];
    // 與結算（settle.ts）同口徑：沒有分類的兵種視為步兵。
    list.push({ quantity: u.quantity, category: u.category ?? "infantry" });
    unitsByLegion.set(u.legionId, list);
  }

  // 僱傭兵軍團（資料庫沒有單位列）：每場戰役各載一次，標記為不吃本國補給。
  const campaignIds = [...new Set(rows.map((r) => r.legion.campaignId))];
  const mercKeys = new Set<string>();
  for (const cid of campaignIds) {
    const m = await loadMercenaryUnitsForCampaign(cid);
    for (const key of m.keys()) mercKeys.add(`${cid}:${key}`);
  }

  const legions: ForecastLegionInput[] = rows.map(({ legion }) => ({
    slot:
      campaignIds.length > 1
        ? `#${legion.campaignId}-${legion.slot}`
        : String(legion.slot),
    mercenary: mercKeys.has(`${legion.campaignId}:${nationId}:${legion.slot}`),
    supply: legion.supply,
    units: unitsByLegion.get(legion.id) ?? [],
  }));
  void currentCampaignId;
  return { legions, campaignCount: campaignIds.length };
}

export function registerWarSupplyRoutes(router: IRouter): void {
  // ── 後勤補給預估 ──────────────────────────────────────────────

  router.get("/war/campaigns/:id/supply", async (req, res) => {
    const ctx = await requireCampaignParticipant(req, res);
    if (!ctx) return;
    const { campaign, nation } = ctx;
    try {
      const { statsEra } = await getEraSlugs();
      const [fresh] = await db
        .select({
          ammo: playerNationsTable.ammo,
          money: playerNationsTable.money,
          famine: playerNationsTable.consecutiveFamineTurns,
        })
        .from(playerNationsTable)
        .where(eq(playerNationsTable.id, nation.id))
        .limit(1);
      const { legions, campaignCount } = await loadNationActiveLegions(
        nation.id,
        campaign.id,
      );
      const forecast = forecastCampaignSupply(legions, Number(fresh?.ammo ?? 0), statsEra);
      res.json({
        ...forecast,
        money: Number(fresh?.money ?? 0),
        famineTurns: Number(fresh?.famine ?? 0),
        unitPrice: resupplyUnitPrice(statsEra),
        maxResupply: maxResupplyAmount(forecast.totalAmmoDemand, forecast.ammoStock),
        horizonCycles: RESUPPLY_HORIZON_CYCLES,
        /** 國家同時進行的戰役數；> 1 時需求與庫存是跨戰役共用的。 */
        activeCampaignCount: campaignCount,
        campaignActive: campaign.status === "active",
      });
    } catch (err) {
      req.log.error({ err }, "war supply forecast failed");
      res.status(500).json({ error: "讀取補給資訊失敗，請稍後再試" });
    }
  });

  // ── 緊急運補（花錢買彈藥）──────────────────────────────────────

  router.post("/war/campaigns/:id/supply/resupply", async (req, res) => {
    const ctx = await requireCampaignParticipant(req, res);
    if (!ctx) return;
    const { campaign, nation } = ctx;
    if (campaign.status !== "active") {
      res.status(409).json({ error: "戰役已結束，無法運補" });
      return;
    }
    const amount = (req.body as Record<string, unknown> | undefined)?.amount;
    try {
      const { statsEra } = await getEraSlugs();
      const { legions } = await loadNationActiveLegions(nation.id, campaign.id);

      const result = await db.transaction(async (tx) => {
        // 鎖國家列：與結算（supplyPhase 的 FOR UPDATE）及連點的第二次請求串行，
        // 後到的會看到扣完/加完後的庫存，不會重複扣款或超過上限。
        const [locked] = await tx
          .select({ ammo: playerNationsTable.ammo, money: playerNationsTable.money })
          .from(playerNationsTable)
          .where(eq(playerNationsTable.id, nation.id))
          .for("update")
          .limit(1);
        if (!locked) throw new HttpError(404, "找不到你的國家");

        const forecast = forecastCampaignSupply(legions, Number(locked.ammo), statsEra);
        const check = validateResupply(amount, forecast, statsEra, Number(locked.money));
        if (!check.ok) throw new HttpError(400, check.error);
        // 庫存硬上限 = 目前需求 × N 個週期（與 validateResupply 的單次上限同一口徑）。
        const stockLimit = forecast.totalAmmoDemand * RESUPPLY_HORIZON_CYCLES;

        // 條件式原子更新：即使鎖之外的程式動過餘額，也不會把金錢扣成負數。
        const updated = await tx
          .update(playerNationsTable)
          .set({
            money: sql`${playerNationsTable.money} - ${check.cost}`,
            ammo: sql`${playerNationsTable.ammo} + ${check.amount}`,
          })
          .where(
            and(
              eq(playerNationsTable.id, nation.id),
              sql`${playerNationsTable.money} >= ${check.cost}`,
              // 上限也放進條件式更新（不單靠 FOR UPDATE）：即使兩個請求都在鎖之前
              // 讀到同一個舊庫存，後寫入的那個也會因 ammo + amount 超過上限而落空。
              sql`${playerNationsTable.ammo} + ${check.amount} <= ${stockLimit}`,
            ),
          )
          .returning({ ammo: playerNationsTable.ammo, money: playerNationsTable.money });
        const row = updated[0];
        if (!row) {
          throw new HttpError(
            400,
            "運補未成功：金錢不足，或庫存已因其他操作達到上限，請重新整理後再試",
          );
        }
        return { check, ammo: Number(row.ammo), money: Number(row.money) };
      });

      res.json({
        ok: true,
        amount: result.check.amount,
        cost: result.check.cost,
        unitPrice: result.check.unitPrice,
        ammo: result.ammo,
        money: result.money,
      });
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      req.log.error({ err }, "war resupply failed");
      res.status(500).json({ error: "運補失敗，請稍後再試" });
    }
  });
}
