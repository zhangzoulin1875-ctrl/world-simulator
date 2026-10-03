import { Router, type IRouter } from "express";
import { and, desc, eq, lt } from "drizzle-orm";
import {
  db,
  territoryChangeHistoryTable,
  mapRegionsTable,
  playerNationsTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import {
  TERRITORY_CHANGE_TYPE_LABELS,
  type TerritoryChangeType,
} from "../lib/territoryHistory";

/**
 * Task #392 — 領土變化歷史查詢 admin API（ADMIN_TOKEN raw-fetch pattern，
 * 不進 OpenAPI spec）。以國家為單位查詢時間軸（新→舊），cursor 分頁。
 */
const router: IRouter = Router();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * GET /territory-history?nationId=&limit=&beforeId=
 * - nationId 選填：不帶 = 全部國家的最新變更。
 * - beforeId 選填：cursor（回傳 id < beforeId 的較舊紀錄）。
 * 回應：{ items: [...], nextBeforeId: number | null }
 */
router.get("/territory-history", requireAdmin, async (req, res) => {
  const rawNationId = req.query.nationId;
  const nationId =
    typeof rawNationId === "string" && rawNationId.trim() !== ""
      ? rawNationId.trim()
      : null;

  const rawLimit = Number(req.query.limit);
  const limit =
    Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_LIMIT
      ? rawLimit
      : DEFAULT_LIMIT;

  const rawBefore = Number(req.query.beforeId);
  const beforeId =
    Number.isInteger(rawBefore) && rawBefore > 0 ? rawBefore : null;

  const conditions = [];
  if (nationId !== null)
    conditions.push(eq(territoryChangeHistoryTable.nationId, nationId));
  if (beforeId !== null)
    conditions.push(lt(territoryChangeHistoryTable.id, beforeId));

  const rows = await db
    .select({
      id: territoryChangeHistoryTable.id,
      nationId: territoryChangeHistoryTable.nationId,
      nationName: playerNationsTable.name,
      regionId: territoryChangeHistoryTable.regionId,
      regionName: mapRegionsTable.name,
      percentBefore: territoryChangeHistoryTable.percentBefore,
      percentAfter: territoryChangeHistoryTable.percentAfter,
      changeType: territoryChangeHistoryTable.changeType,
      reason: territoryChangeHistoryTable.reason,
      warId: territoryChangeHistoryTable.warId,
      treatyId: territoryChangeHistoryTable.treatyId,
      createdAt: territoryChangeHistoryTable.createdAt,
    })
    .from(territoryChangeHistoryTable)
    .leftJoin(
      mapRegionsTable,
      eq(mapRegionsTable.id, territoryChangeHistoryTable.regionId),
    )
    .leftJoin(
      playerNationsTable,
      eq(playerNationsTable.id, territoryChangeHistoryTable.nationId),
    )
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(territoryChangeHistoryTable.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  res.json({
    items: page.map((r) => ({
      id: r.id,
      nationId: r.nationId,
      nationName: r.nationName,
      regionId: r.regionId,
      regionName: r.regionName,
      percentBefore: r.percentBefore,
      percentAfter: r.percentAfter,
      changeType: r.changeType,
      changeTypeLabel:
        TERRITORY_CHANGE_TYPE_LABELS[r.changeType as TerritoryChangeType] ??
        r.changeType,
      reason: r.reason,
      warId: r.warId,
      treatyId: r.treatyId,
      createdAt: r.createdAt.toISOString(),
    })),
    nextBeforeId: hasMore ? page[page.length - 1]!.id : null,
  });
});

export default router;
