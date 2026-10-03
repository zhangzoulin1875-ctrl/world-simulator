import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  regionBuildingsTable,
  regionControlsTable,
  mapRegionsTable,
  type PlayerNation,
  type RegionBuilding,
} from "@workspace/db";
import { getSession, readSessionToken } from "../lib/sessions";
import { getEraSlugs, computeAdjustedNationStats } from "../lib/nationStats";
import { computeAvailableProduction } from "../lib/economy";
import { loadCurrentTurnRecruitSpend } from "../lib/recruitSpend";
import { pgErrorCode } from "../lib/playerValidation";
import {
  BUILDING_LABEL,
  BUILDING_RESOURCE,
  MAX_BUILDING_LEVEL,
  buildingCost,
  buildingOutput,
  buildingUpkeep,
  buildingWorkers,
  isBuildingType,
  type BuildingType,
} from "../lib/regionBuildings";
import {
  getGameBalanceSettings,
  scaleConstructionCost,
} from "../lib/gameBalance";

/**
 * Task #523 — 資源建築成本 × 管理員倍率（金錢與生產力兩軌皆縮放；
 * 顯示端點與扣款端點共用，維護費不縮放）。
 */
function scaledBuildingCost(
  level: number,
  multiplier: number,
): { money: number; production: number } {
  const base = buildingCost(level);
  return {
    money: scaleConstructionCost(base.money, multiplier),
    production: scaleConstructionCost(base.production, multiplier),
  };
}

const router: IRouter = Router();

/** Task #406 — 建築工人上限檢查的 advisory lock namespace（per-nation）。 */
const BUILDING_LOCK_NS = 406_001;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function requirePlayer(
  req: Parameters<Parameters<IRouter["get"]>[1]>[0],
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<{ nation: PlayerNation; userId: string } | null> {
  const session = await getSession(readSessionToken(req));
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return null;
  }
  const userId = session.discordUserId;
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  if (!nation) {
    res.status(400).json({ error: "尚未建國，請先在玩家首頁建立或接手國家" });
    return null;
  }
  return { nation, userId };
}

function serializeBuilding(
  b: RegionBuilding,
  regionName: string | null,
  costMultiplier: number,
) {
  const type = b.buildingType as BuildingType;
  const nextLevel = b.level + 1;
  return {
    id: b.id,
    regionId: b.regionId,
    regionName: regionName ?? "",
    buildingType: b.buildingType,
    buildingLabel: BUILDING_LABEL[type] ?? b.buildingType,
    resource: BUILDING_RESOURCE[type] ?? "wood",
    level: b.level,
    outputPerTurn: buildingOutput(b.level),
    workers: buildingWorkers(b.level),
    upkeepPerTurn: buildingUpkeep(b.level),
    upgradeCost:
      b.level >= MAX_BUILDING_LEVEL
        ? null
        : scaledBuildingCost(nextLevel, costMultiplier),
  };
}

/** 全國建築工人總數（Σ 1000 × level）。 */
async function totalWorkers(
  executor: Pick<typeof db, "select">,
  nationId: string,
): Promise<number> {
  const [row] = await executor
    .select({
      levels: sql<string>`COALESCE(SUM(${regionBuildingsTable.level}), 0)`,
    })
    .from(regionBuildingsTable)
    .where(eq(regionBuildingsTable.nationId, nationId));
  return buildingWorkers(Number(row?.levels ?? 0));
}

/** 玩家建築清單＋建造成本／庫存摘要。 */
router.get("/player/buildings", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation } = auth;
  try {
    const { statsEra } = await getEraSlugs();
    const stats = await computeAdjustedNationStats(nation, statsEra);
    // Task #523 — 資源建築成本倍率（顯示與扣款一致）。
    const costMult = (await getGameBalanceSettings()).constructionCosts
      .resourceBuilding;
    const rows = await db
      .select({
        building: regionBuildingsTable,
        regionName: mapRegionsTable.name,
      })
      .from(regionBuildingsTable)
      .innerJoin(
        mapRegionsTable,
        eq(mapRegionsTable.id, regionBuildingsTable.regionId),
      )
      .where(eq(regionBuildingsTable.nationId, nation.id))
      .orderBy(regionBuildingsTable.regionId, regionBuildingsTable.buildingType);
    const workers = rows.reduce(
      (acc, r) => acc + buildingWorkers(r.building.level),
      0,
    );
    // 可建造的地區 = 有掌控（percent ≥ 1）的地區。
    const regions = await db
      .select({
        regionId: regionControlsTable.regionId,
        regionName: mapRegionsTable.name,
        percent: regionControlsTable.percent,
      })
      .from(regionControlsTable)
      .innerJoin(
        mapRegionsTable,
        eq(mapRegionsTable.id, regionControlsTable.regionId),
      )
      .where(eq(regionControlsTable.nationId, nation.id))
      .orderBy(regionControlsTable.regionId);
    res.json({
      buildings: rows.map((r) =>
        serializeBuilding(r.building, r.regionName, costMult),
      ),
      buildCost: scaledBuildingCost(1, costMult),
      maxLevel: MAX_BUILDING_LEVEL,
      workers,
      workerCap: stats.population,
      wood: nation.wood,
      ore: nation.ore,
      money: nation.money,
      // Task #568 — 可用量 = 總量 − 已佔用 − 本回合招募花費（流量）。
      production: computeAvailableProduction({
        production: stats.production,
        productionSpent: nation.productionSpent,
        currentTurnSpend: await loadCurrentTurnRecruitSpend(nation.id),
      }),
      regions,
    });
  } catch (err) {
    req.log.error({ err }, "list region buildings failed");
    res.status(500).json({ error: "讀取建築清單失敗，請稍後再試" });
  }
});

function parseBuildBody(body: unknown): {
  regionId: number;
  buildingType: BuildingType;
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const regionId = Number(b["regionId"]);
  const buildingType = String(b["buildingType"] ?? "");
  if (!Number.isInteger(regionId) || regionId <= 0) {
    throw new HttpError(400, "地區編號不正確");
  }
  if (!isBuildingType(buildingType)) {
    throw new HttpError(400, "建築類型不正確（lumber_mill 或 mine）");
  }
  return { regionId, buildingType };
}

/** 新建建築（level 1）。 */
router.post("/player/buildings", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;
  try {
    const { regionId, buildingType } = parseBuildBody(req.body);
    const { statsEra } = await getEraSlugs();
    const stats = await computeAdjustedNationStats(nation, statsEra);
    // Task #568 — 可用生產力守衛需扣除本回合招募花費（流量）。
    const productionCap = Math.max(
      0,
      stats.production - (await loadCurrentTurnRecruitSpend(nation.id)),
    );
    // Task #523 — 資源建築成本倍率（與 GET /player/buildings 顯示一致）。
    const costMult = (await getGameBalanceSettings()).constructionCosts
      .resourceBuilding;
    const cost = scaledBuildingCost(1, costMult);

    // 需掌控該地區（percent ≥ 1）。
    const [control] = await db
      .select({ percent: regionControlsTable.percent })
      .from(regionControlsTable)
      .where(
        and(
          eq(regionControlsTable.regionId, regionId),
          eq(regionControlsTable.nationId, nation.id),
        ),
      )
      .limit(1);
    if (!control) {
      throw new HttpError(400, "只能在自己掌控的地區建造建築");
    }

    const created = await db.transaction(async (tx) => {
      // per-nation advisory lock：序列化工人上限檢查（跨建造/升級路徑共用）。
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${BUILDING_LOCK_NS}, hashtext(${nation.id}))`,
      );
      const workers = await totalWorkers(tx, nation.id);
      if (workers + buildingWorkers(1) > stats.population) {
        throw new HttpError(
          400,
          `建築工人不足：全國建築工人（${(workers + buildingWorkers(1)).toLocaleString("en-US")}）將超過人口上限（${stats.population.toLocaleString("en-US")}）`,
        );
      }
      const updated = await tx
        .update(playerNationsTable)
        .set({
          money: sql`${playerNationsTable.money} - ${cost.money}`,
          productionSpent: sql`${playerNationsTable.productionSpent} + ${cost.production}`,
        })
        .where(
          and(
            eq(playerNationsTable.id, nation.id),
            sql`${playerNationsTable.money} >= ${cost.money}`,
            sql`${playerNationsTable.productionSpent} + ${cost.production} <= ${productionCap}`,
          ),
        )
        .returning();
      if (!updated[0]) {
        const moneyShort = nation.money < cost.money;
        throw new HttpError(
          400,
          moneyShort
            ? `金錢不足（需要 ${cost.money.toLocaleString("en-US")}）`
            : `生產力不足（需要 ${cost.production.toLocaleString("en-US")}）`,
        );
      }
      const [row] = await tx
        .insert(regionBuildingsTable)
        .values({
          nationId: nation.id,
          regionId,
          buildingType,
          level: 1,
          // 拆除釋放生產力用：記錄本建築實際占用的生產力（含成本倍率）。
          productionReserved: cost.production,
        })
        .returning();
      if (!row) throw new HttpError(500, "建築寫入失敗");
      return row;
    });

    const [region] = await db
      .select({ name: mapRegionsTable.name })
      .from(mapRegionsTable)
      .where(eq(mapRegionsTable.id, regionId))
      .limit(1);
    req.log.info(
      { userId, regionId, buildingType },
      "region building constructed",
    );
    res.status(201).json({
      building: serializeBuilding(created, region?.name ?? null, costMult),
    });
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      res.status(409).json({ error: "這個地區已經有同類型的建築了" });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "region building construct failed");
    res.status(500).json({ error: "建造失敗，請稍後再試" });
  }
});

/** 升級建築（level +1）。 */
router.post("/player/buildings/:id/upgrade", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;
  try {
    const buildingId = Number(req.params.id);
    if (!Number.isInteger(buildingId) || buildingId <= 0) {
      throw new HttpError(400, "建築編號不正確");
    }
    const { statsEra } = await getEraSlugs();
    const stats = await computeAdjustedNationStats(nation, statsEra);
    // Task #568 — 可用生產力守衛需扣除本回合招募花費（流量）。
    const productionCap = Math.max(
      0,
      stats.production - (await loadCurrentTurnRecruitSpend(nation.id)),
    );
    // Task #523 — 資源建築成本倍率（升級成本同軌縮放）。
    const costMult = (await getGameBalanceSettings()).constructionCosts
      .resourceBuilding;

    const upgraded = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${BUILDING_LOCK_NS}, hashtext(${nation.id}))`,
      );
      const [building] = await tx
        .select()
        .from(regionBuildingsTable)
        .where(
          and(
            eq(regionBuildingsTable.id, buildingId),
            eq(regionBuildingsTable.nationId, nation.id),
          ),
        )
        .limit(1);
      if (!building) throw new HttpError(404, "找不到這座建築");
      if (building.level >= MAX_BUILDING_LEVEL) {
        throw new HttpError(400, `已達等級上限（${MAX_BUILDING_LEVEL} 級）`);
      }
      const nextLevel = building.level + 1;
      const cost = scaledBuildingCost(nextLevel, costMult);
      const workers = await totalWorkers(tx, nation.id);
      if (workers + buildingWorkers(1) > stats.population) {
        throw new HttpError(
          400,
          `建築工人不足：升級後全國建築工人將超過人口上限（${stats.population.toLocaleString("en-US")}）`,
        );
      }
      const updated = await tx
        .update(playerNationsTable)
        .set({
          money: sql`${playerNationsTable.money} - ${cost.money}`,
          productionSpent: sql`${playerNationsTable.productionSpent} + ${cost.production}`,
        })
        .where(
          and(
            eq(playerNationsTable.id, nation.id),
            sql`${playerNationsTable.money} >= ${cost.money}`,
            sql`${playerNationsTable.productionSpent} + ${cost.production} <= ${productionCap}`,
          ),
        )
        .returning();
      if (!updated[0]) {
        const moneyShort = nation.money < cost.money;
        throw new HttpError(
          400,
          moneyShort
            ? `金錢不足（需要 ${cost.money.toLocaleString("en-US")}）`
            : `生產力不足（需要 ${cost.production.toLocaleString("en-US")}）`,
        );
      }
      const [row] = await tx
        .update(regionBuildingsTable)
        .set({
          level: nextLevel,
          // 累計本次升級實際占用的生產力（拆除時整筆釋放）。
          productionReserved: sql`${regionBuildingsTable.productionReserved} + ${cost.production}`,
          updatedAt: new Date(),
        })
        .where(eq(regionBuildingsTable.id, buildingId))
        .returning();
      if (!row) throw new HttpError(500, "建築升級寫入失敗");
      return row;
    });

    const [region] = await db
      .select({ name: mapRegionsTable.name })
      .from(mapRegionsTable)
      .where(eq(mapRegionsTable.id, upgraded.regionId))
      .limit(1);
    req.log.info(
      { userId, buildingId, level: upgraded.level },
      "region building upgraded",
    );
    res.json({
      building: serializeBuilding(upgraded, region?.name ?? null, costMult),
    });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "region building upgrade failed");
    res.status(500).json({ error: "升級失敗，請稍後再試" });
  }
});

/**
 * 拆除建築：金錢不退款；釋放本建築占用的生產力（production_reserved →
 * 自 production_spent 扣回，GREATEST(0, …) 夾底）；工人與維護費隨列刪除自然歸還。
 */
router.delete("/player/buildings/:id", async (req, res) => {
  const auth = await requirePlayer(req, res);
  if (!auth) return;
  const { nation, userId } = auth;
  try {
    const buildingId = Number(req.params.id);
    if (!Number.isInteger(buildingId) || buildingId <= 0) {
      throw new HttpError(400, "建築編號不正確");
    }
    const result = await db.transaction(async (tx) => {
      // 與建造／升級共用 per-nation advisory lock，序列化占用量的增減。
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${BUILDING_LOCK_NS}, hashtext(${nation.id}))`,
      );
      const deleted = await tx
        .delete(regionBuildingsTable)
        .where(
          and(
            eq(regionBuildingsTable.id, buildingId),
            eq(regionBuildingsTable.nationId, nation.id),
          ),
        )
        .returning();
      const row = deleted[0];
      if (!row) throw new HttpError(404, "找不到這座建築");
      const released = Math.max(0, row.productionReserved);
      if (released > 0) {
        await tx
          .update(playerNationsTable)
          .set({
            productionSpent: sql`GREATEST(0, ${playerNationsTable.productionSpent} - ${released})`,
          })
          .where(eq(playerNationsTable.id, nation.id));
      }
      return { row, released };
    });

    req.log.info(
      {
        userId,
        buildingId,
        buildingType: result.row.buildingType,
        level: result.row.level,
        releasedProduction: result.released,
      },
      "region building demolished",
    );
    res.json({ ok: true, releasedProduction: result.released });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "region building demolish failed");
    res.status(500).json({ error: "拆除失敗，請稍後再試" });
  }
});

export default router;
