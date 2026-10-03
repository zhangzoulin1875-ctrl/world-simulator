import { Router, type IRouter } from "express";
import { asc, eq } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import {
  diffRegionControls,
  recordTerritoryChanges,
} from "../lib/territoryHistory";

/**
 * Task #24 — 地區歸屬管理 admin API (ADMIN_TOKEN raw-fetch pattern, not part
 * of the public OpenAPI spec). Region control assignments drive the computed
 * player nation stats in GET /api/player/nation.
 */
const router: IRouter = Router();

/**
 * All region control assignments plus the list of known nations (Task #30:
 * keyed by nation uuid; discordUserId only shown as owner info, null = 無主).
 * Response shape:
 * {
 *   nations: [{ id, name, discordUserId }],
 *   controls: [{ regionId, nationId, percent }]
 * }
 */
router.get("/region-controls", requireAdmin, async (_req, res) => {
  const [nations, controls] = await Promise.all([
    db
      .select({
        id: playerNationsTable.id,
        name: playerNationsTable.name,
        discordUserId: playerNationsTable.discordUserId,
        isNpc: playerNationsTable.isNpc,
        // 玩家自訂地圖顏色（#rrggbb）；null = 前端退回預設調色盤。
        mapColor: playerNationsTable.mapColor,
      })
      .from(playerNationsTable)
      .orderBy(asc(playerNationsTable.createdAt)),
    db
      .select({
        regionId: regionControlsTable.regionId,
        nationId: regionControlsTable.nationId,
        percent: regionControlsTable.percent,
      })
      .from(regionControlsTable)
      .orderBy(asc(regionControlsTable.regionId), asc(regionControlsTable.id)),
  ]);
  res.json({ nations, controls });
});

/**
 * Full-replace the control assignments of one region.
 * Body: { controls: [{ nationId, percent }] } — an empty array clears
 * the region back to 無人掌控. Validation (explicit 400s, never silent):
 * - percent must be an integer 1–100 per entry
 * - the same nation may appear only once
 * - per-region total must not exceed 100
 * - every nationId must be an existing nation
 */
router.put("/region-controls/:regionId", requireAdmin, async (req, res) => {
  const regionId = Number(req.params.regionId);
  if (!Number.isInteger(regionId) || regionId <= 0) {
    res.status(400).json({ error: "regionId 不正確" });
    return;
  }

  const [region] = await db
    .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
    .from(mapRegionsTable)
    .where(eq(mapRegionsTable.id, regionId))
    .limit(1);
  if (!region) {
    res.status(404).json({ error: "找不到這個地區" });
    return;
  }

  const rawControls = (req.body ?? {}).controls;
  if (!Array.isArray(rawControls)) {
    res.status(400).json({ error: "controls 必須是陣列" });
    return;
  }
  if (rawControls.length > 50) {
    res.status(400).json({ error: "單一地區最多 50 筆掌控紀錄" });
    return;
  }

  const seen = new Set<string>();
  const cleaned: { nationId: string; percent: number }[] = [];
  let total = 0;
  for (const entry of rawControls) {
    if (entry === null || typeof entry !== "object") {
      res.status(400).json({ error: "controls 每一項必須是物件" });
      return;
    }
    const { nationId, percent } = entry as {
      nationId?: unknown;
      percent?: unknown;
    };
    if (typeof nationId !== "string" || nationId.trim() === "") {
      res.status(400).json({ error: "nationId 必須是非空字串" });
      return;
    }
    const id = nationId.trim();
    if (seen.has(id)) {
      res.status(400).json({ error: "同一個國家在一個地區只能出現一次" });
      return;
    }
    seen.add(id);
    if (typeof percent !== "number" || !Number.isInteger(percent)) {
      res.status(400).json({ error: "percent 必須是整數" });
      return;
    }
    if (percent < 1 || percent > 100) {
      res.status(400).json({ error: "percent 必須介於 1 到 100" });
      return;
    }
    total += percent;
    cleaned.push({ nationId: id, percent });
  }
  if (total > 100) {
    res.status(400).json({
      error: `掌控比例總和不可超過 100%（目前為 ${total}%）`,
    });
    return;
  }

  // Task #392 — 管理員可附上自訂變更理由（選填，zh-TW）。
  const rawReason = (req.body ?? {}).reason;
  if (rawReason !== undefined && typeof rawReason !== "string") {
    res.status(400).json({ error: "reason 必須是文字" });
    return;
  }
  const customReason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (customReason.length > 500) {
    res.status(400).json({ error: "reason 最多 500 字" });
    return;
  }

  if (cleaned.length > 0) {
    const ids = cleaned.map((c) => c.nationId);
    const existing = await db
      .select({ id: playerNationsTable.id })
      .from(playerNationsTable);
    const known = new Set(existing.map((n) => n.id));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) {
      res.status(400).json({
        error: `找不到國家：${missing.join("、")}`,
      });
      return;
    }
  }

  await db.transaction(async (tx) => {
    // Task #322 — 全量替換此地區掌控時，保留各國既有的人口成長累積量
    // （依 nationId 對應）；被移除的國家其累積量隨之消失，新增者從 0 起算。
    const existing = await tx
      .select({
        nationId: regionControlsTable.nationId,
        percent: regionControlsTable.percent,
        populationBonus: regionControlsTable.populationBonus,
      })
      .from(regionControlsTable)
      .where(eq(regionControlsTable.regionId, regionId));
    const accruedByNation = new Map(
      existing.map((r) => [r.nationId, r.populationBonus]),
    );
    await tx
      .delete(regionControlsTable)
      .where(eq(regionControlsTable.regionId, regionId));
    if (cleaned.length > 0) {
      await tx.insert(regionControlsTable).values(
        cleaned.map((c) => ({
          regionId,
          nationId: c.nationId,
          percent: c.percent,
          populationBonus: accruedByNation.get(c.nationId) ?? 0,
        })),
      );
    }
    // Task #392 — 同交易內記錄管理員手動編輯（僅記實際變更；支援自訂理由）。
    await recordTerritoryChanges(
      tx,
      diffRegionControls(regionId, existing, cleaned, {
        changeType: "admin_edit",
        reason:
          customReason !== ""
            ? `管理員手動編輯：${customReason}`
            : `管理員手動編輯「${region.name}」的地區掌控`,
      }),
    );
  });

  req.log.info(
    { regionId, regionName: region.name, count: cleaned.length, total },
    "region controls replaced",
  );

  res.json({
    regionId,
    controls: cleaned,
  });
});

export default router;
