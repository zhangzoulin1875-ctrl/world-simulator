import { Router, type IRouter } from "express";
import { and, count, eq, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  militaryUnitTemplatesTable,
  playerArmiesTable,
  npcArmiesTable,
  warCampaignLegionUnitsTable,
  warCampaignLegionsTable,
  warCampaignsTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import { z } from "zod/v4";
import {
  isRecruitQueueEnabled,
  setRecruitQueueEnabled,
} from "../lib/recruitQueue";
import { uuidParam } from "../lib/uuidParam";

/**
 * Task #651 — 後台軍事管理 API（ADMIN_TOKEN raw-fetch，不進 OpenAPI spec）。
 * 管理員可查看/編輯任一國家的兵種模板戰鬥數值與成本，並覆蓋寫入軍隊數量。
 */
const router: IRouter = Router();

/** 兵種類別清單 */
const UNIT_CATEGORIES = [
  "infantry",
  "ranged",
  "armor",
  "artillery",
  "ship",
  "air",
  "siege",
] as const;

/** PATCH 模板的合法欄位（Zod schema） */
const templatePatchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  eraSlug: z.string().max(40).nullable().optional(),
  category: z.enum(UNIT_CATEGORIES).optional(),
  hp: z.number().int().min(1).max(100_000).optional(),
  attack: z.number().int().min(0).max(100_000).optional(),
  defense: z.number().int().min(0).max(100_000).optional(),
  speed: z.number().min(0).max(10_000).optional(),
  accuracy: z.number().int().min(0).max(100).optional(),
  range: z.enum(["melee", "ranged"]).optional(),
  antiCavalryPct: z.number().int().min(0).max(100).optional(),
  antiRangedPct: z.number().int().min(0).max(100).optional(),
  antiArtilleryPct: z.number().int().min(0).max(100).optional(),
  siegePct: z.number().int().min(0).max(100).optional(),
  prodCostPer100: z.number().int().min(0).max(1_000_000).optional(),
  popCostPerUnit: z.number().int().min(0).max(1_000_000).optional(),
  moneyCostPerUnit: z
    .number()
    .int()
    .min(0)
    .max(1_000_000_000_000_000)
    .optional(),
  upkeepPerUnit: z.number().min(0).max(1_000_000).optional(),
  prodUpkeepPerUnit: z.number().min(0).max(1_000_000).optional(),
  woodCostPerUnit: z.number().int().min(0).max(1_000_000).optional(),
  oreCostPerUnit: z.number().int().min(0).max(1_000_000).optional(),
});

/** PUT armies body schema */
const armiesUpsertSchema = z.object({
  nationId: z.string().uuid(),
  templateId: z.number().int().positive(),
  quantity: z.number().int().min(0).max(1_000_000_000_000_000),
});

/** 查詢指定國家，若不存在回 null */
async function findNation(id: string) {
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, id))
    .limit(1);
  return nation ?? null;
}

/**
 * GET /api/military-admin/nations
 * 回傳所有國家（id / name / isNpc），供前端國家選擇下拉。
 */
/**
 * 招募訓練佇列功能開關（預設關閉）。開啟後新的招募／購買／NPC 生產改進佇列；
 * 已在佇列中的訂單在關閉期間保留，重新開啟後繼續推進。
 */
router.get("/military-admin/recruit-queue", requireAdmin, async (_req, res) => {
  res.json({ enabled: await isRecruitQueueEnabled() });
});

router.put("/military-admin/recruit-queue", requireAdmin, async (req, res) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "enabled 必須是布林值" });
    return;
  }
  await setRecruitQueueEnabled(parsed.data.enabled);
  req.log.info({ enabled: parsed.data.enabled }, "recruit queue flag changed");
  res.json({ enabled: parsed.data.enabled });
});

router.get("/military-admin/nations", requireAdmin, async (_req, res) => {
  const nations = await db
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
      isNpc: playerNationsTable.isNpc,
      discordUserId: playerNationsTable.discordUserId,
    })
    .from(playerNationsTable)
    .orderBy(playerNationsTable.isNpc, playerNationsTable.name);

  res.json(
    nations.map((n) => ({
      id: n.id,
      name: n.name,
      isNpc: n.isNpc,
      isOwned: n.discordUserId !== null,
    })),
  );
});

/**
 * GET /api/military-admin/nations/:id
 * 回傳指定國家的所有兵種模板（含 army 數量）。
 * NPC 查 npc_armies；玩家查 player_armies。
 */
router.get(
  "/military-admin/nations/:id",
  requireAdmin,
  (req, res, next) => uuidParam(req, res, next, req.params.id, "id"),
  async (req, res) => {
    const nationId = String(req.params.id);
    const nation = await findNation(nationId);
    if (!nation) {
      res.status(404).json({ error: "找不到這個國家" });
      return;
    }

    if (nation.isNpc) {
      // NPC 模板：ownerNationId = nationId
      const rows = await db
        .select({
          id: militaryUnitTemplatesTable.id,
          name: militaryUnitTemplatesTable.name,
          category: militaryUnitTemplatesTable.category,
          eraSlug: militaryUnitTemplatesTable.eraSlug,
          hp: militaryUnitTemplatesTable.hp,
          attack: militaryUnitTemplatesTable.attack,
          defense: militaryUnitTemplatesTable.defense,
          speed: militaryUnitTemplatesTable.speed,
          accuracy: militaryUnitTemplatesTable.accuracy,
          range: militaryUnitTemplatesTable.range,
          antiCavalryPct: militaryUnitTemplatesTable.antiCavalryPct,
          antiRangedPct: militaryUnitTemplatesTable.antiRangedPct,
          antiArtilleryPct: militaryUnitTemplatesTable.antiArtilleryPct,
          siegePct: militaryUnitTemplatesTable.siegePct,
          prodCostPer100: militaryUnitTemplatesTable.prodCostPer100,
          popCostPerUnit: militaryUnitTemplatesTable.popCostPerUnit,
          moneyCostPerUnit: militaryUnitTemplatesTable.moneyCostPerUnit,
          upkeepPerUnit: militaryUnitTemplatesTable.upkeepPerUnit,
          prodUpkeepPerUnit: militaryUnitTemplatesTable.prodUpkeepPerUnit,
          woodCostPerUnit: militaryUnitTemplatesTable.woodCostPerUnit,
          oreCostPerUnit: militaryUnitTemplatesTable.oreCostPerUnit,
          quantity: sql<number>`COALESCE(${npcArmiesTable.quantity}, 0)`,
          committed: sql<number>`COALESCE(${npcArmiesTable.committed}, 0)`,
          wounded: sql<number>`COALESCE(${npcArmiesTable.wounded}, 0)`,
        })
        .from(militaryUnitTemplatesTable)
        .leftJoin(
          npcArmiesTable,
          and(
            eq(npcArmiesTable.templateId, militaryUnitTemplatesTable.id),
            eq(npcArmiesTable.nationId, nationId),
          ),
        )
        .where(eq(militaryUnitTemplatesTable.ownerNationId, nationId))
        .orderBy(
          militaryUnitTemplatesTable.category,
          militaryUnitTemplatesTable.name,
        );

      res.json({ nation: { id: nation.id, name: nation.name, isNpc: true }, templates: rows });
    } else {
      // 玩家模板：ownerDiscordUserId = discordUserId
      if (!nation.discordUserId) {
        // 無主玩家國家（無擁有者）→ 無模板
        res.json({ nation: { id: nation.id, name: nation.name, isNpc: false }, templates: [] });
        return;
      }

      const rows = await db
        .select({
          id: militaryUnitTemplatesTable.id,
          name: militaryUnitTemplatesTable.name,
          category: militaryUnitTemplatesTable.category,
          eraSlug: militaryUnitTemplatesTable.eraSlug,
          hp: militaryUnitTemplatesTable.hp,
          attack: militaryUnitTemplatesTable.attack,
          defense: militaryUnitTemplatesTable.defense,
          speed: militaryUnitTemplatesTable.speed,
          accuracy: militaryUnitTemplatesTable.accuracy,
          range: militaryUnitTemplatesTable.range,
          antiCavalryPct: militaryUnitTemplatesTable.antiCavalryPct,
          antiRangedPct: militaryUnitTemplatesTable.antiRangedPct,
          antiArtilleryPct: militaryUnitTemplatesTable.antiArtilleryPct,
          siegePct: militaryUnitTemplatesTable.siegePct,
          prodCostPer100: militaryUnitTemplatesTable.prodCostPer100,
          popCostPerUnit: militaryUnitTemplatesTable.popCostPerUnit,
          moneyCostPerUnit: militaryUnitTemplatesTable.moneyCostPerUnit,
          upkeepPerUnit: militaryUnitTemplatesTable.upkeepPerUnit,
          prodUpkeepPerUnit: militaryUnitTemplatesTable.prodUpkeepPerUnit,
          woodCostPerUnit: militaryUnitTemplatesTable.woodCostPerUnit,
          oreCostPerUnit: militaryUnitTemplatesTable.oreCostPerUnit,
          quantity: sql<number>`COALESCE(${playerArmiesTable.quantity}, 0)`,
        })
        .from(militaryUnitTemplatesTable)
        .leftJoin(
          playerArmiesTable,
          and(
            eq(playerArmiesTable.templateId, militaryUnitTemplatesTable.id),
            eq(playerArmiesTable.discordUserId, nation.discordUserId),
          ),
        )
        .where(
          eq(
            militaryUnitTemplatesTable.ownerDiscordUserId,
            nation.discordUserId,
          ),
        )
        .orderBy(
          militaryUnitTemplatesTable.category,
          militaryUnitTemplatesTable.name,
        );

      res.json({ nation: { id: nation.id, name: nation.name, isNpc: false }, templates: rows });
    }
  },
);

/**
 * PATCH /api/military-admin/templates/:id
 * 部分更新兵種模板的戰鬥數值與成本欄位。
 */
router.patch(
  "/military-admin/templates/:id",
  requireAdmin,
  async (req, res) => {
    const templateId = Number(req.params.id);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      res.status(400).json({ error: "無效的模板 id" });
      return;
    }

    const parsed = templatePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => i.message).join("；"),
      });
      return;
    }

    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "沒有可更新的欄位" });
      return;
    }

    const [existing] = await db
      .select({ id: militaryUnitTemplatesTable.id })
      .from(militaryUnitTemplatesTable)
      .where(eq(militaryUnitTemplatesTable.id, templateId))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "找不到這個兵種模板" });
      return;
    }

    await db
      .update(militaryUnitTemplatesTable)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(militaryUnitTemplatesTable.id, templateId));

    req.log.info({ templateId, updates }, "military template patched by admin");
    res.json({ ok: true });
  },
);

/**
 * PUT /api/military-admin/armies
 * body: { nationId, templateId, quantity }
 * Upsert 指定國家的指定兵種數量（quantity=0 時刪除該列）。
 * 自動判斷 NPC 或玩家，寫對應資料表。
 * 注意：productionReserved / populationReserved 保持原值（下次招募/解散自行修正）。
 */
router.put("/military-admin/armies", requireAdmin, async (req, res) => {
  const parsed = armiesUpsertSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues.map((i) => i.message).join("；"),
    });
    return;
  }
  const { nationId, templateId, quantity } = parsed.data;

  const nation = await findNation(nationId);
  if (!nation) {
    res.status(404).json({ error: "找不到這個國家" });
    return;
  }

  // 確認模板存在
  const [tmpl] = await db
    .select({ id: militaryUnitTemplatesTable.id })
    .from(militaryUnitTemplatesTable)
    .where(eq(militaryUnitTemplatesTable.id, templateId))
    .limit(1);
  if (!tmpl) {
    res.status(404).json({ error: "找不到這個兵種模板" });
    return;
  }

  if (nation.isNpc) {
    if (quantity === 0) {
      await db
        .delete(npcArmiesTable)
        .where(
          and(
            eq(npcArmiesTable.nationId, nationId),
            eq(npcArmiesTable.templateId, templateId),
          ),
        );
    } else {
      await db
        .insert(npcArmiesTable)
        .values({
          nationId,
          templateId,
          quantity,
          committed: 0,
          wounded: 0,
        })
        .onConflictDoUpdate({
          target: [npcArmiesTable.nationId, npcArmiesTable.templateId],
          set: { quantity, updatedAt: new Date() },
        });
    }
  } else {
    // 玩家國家
    if (!nation.discordUserId) {
      res.status(409).json({ error: "此玩家國家目前無擁有者，無法寫入軍隊" });
      return;
    }
    if (quantity === 0) {
      await db
        .delete(playerArmiesTable)
        .where(
          and(
            eq(playerArmiesTable.discordUserId, nation.discordUserId),
            eq(playerArmiesTable.templateId, templateId),
          ),
        );
    } else {
      await db
        .insert(playerArmiesTable)
        .values({
          discordUserId: nation.discordUserId,
          templateId,
          quantity,
          productionReserved: 0,
          populationReserved: 0,
        })
        .onConflictDoUpdate({
          target: [
            playerArmiesTable.discordUserId,
            playerArmiesTable.templateId,
          ],
          set: { quantity, updatedAt: new Date() },
        });
    }
  }

  req.log.info(
    { nationId, templateId, quantity, isNpc: nation.isNpc },
    "army quantity overridden by admin",
  );
  res.json({ ok: true });
});

/**
 * DELETE /api/military-admin/templates/:id
 * 刪除兵種模板（cascade 刪 armies）。
 * 回傳受影響的 legion_units 數量（作為前端警告依據）。
 * 管理員可於確認後強制刪除。
 */
router.delete(
  "/military-admin/templates/:id",
  requireAdmin,
  async (req, res) => {
    const templateId = Number(req.params.id);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      res.status(400).json({ error: "無效的模板 id" });
      return;
    }

    const force = req.query["force"] === "1";

    // 只計算「進行中戰役（endedAt IS NULL）」使用此模板的 legion_units 數量
    const [legionCount] = await db
      .select({ n: count() })
      .from(warCampaignLegionUnitsTable)
      .innerJoin(
        warCampaignLegionsTable,
        eq(warCampaignLegionUnitsTable.legionId, warCampaignLegionsTable.id),
      )
      .innerJoin(
        warCampaignsTable,
        eq(warCampaignLegionsTable.campaignId, warCampaignsTable.id),
      )
      .where(
        and(
          eq(warCampaignLegionUnitsTable.templateId, templateId),
          sql`${warCampaignsTable.endedAt} IS NULL`,
        ),
      );
    const activeCount = legionCount?.n ?? 0;

    if (activeCount > 0 && !force) {
      res.status(409).json({
        error: `此兵種模板目前有 ${activeCount} 筆進行中戰役列，刪除將影響戰鬥結算。加上 ?force=1 可強制刪除。`,
        activeCount,
      });
      return;
    }

    const [existing] = await db
      .select({ id: militaryUnitTemplatesTable.id })
      .from(militaryUnitTemplatesTable)
      .where(eq(militaryUnitTemplatesTable.id, templateId))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "找不到這個兵種模板" });
      return;
    }

    await db
      .delete(militaryUnitTemplatesTable)
      .where(eq(militaryUnitTemplatesTable.id, templateId));

    req.log.info({ templateId, activeCount }, "military template deleted by admin");
    res.json({ ok: true, activeCount });
  },
);

export default router;
