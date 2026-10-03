import { Router, type IRouter } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  npcArmiesTable,
  militaryUnitTemplatesTable,
} from "@workspace/db";
import { requireAdmin } from "../middlewares/requireAdmin";
import { recordTerritoryChanges } from "../lib/territoryHistory";
import { aiRateLimit } from "../middlewares/aiRateLimit";
import { validateImageUrl, validateNationName } from "../lib/playerValidation";
import { TAX_RATE_MAX } from "../lib/economy";
import {
  generateDiplomaticAttitude,
  generatePoliticalNote,
} from "../lib/politicsAi";
import { getEraSlugs } from "../lib/nationStats";
import { buildNationGeoCultureContext } from "../lib/nationGeoCulture";
import { ERAS, getEraIndex } from "../lib/mapRegionEras";
import {
  applyKeyTechToNullOwnerNations,
  getKeyTechId,
  grantKeyTechToAllPlayers,
  isKeyTechDomain,
  keyTechCatalogEntry,
  loadKeyTechStatus,
  revokeKeyTechFromAllPlayers,
} from "../lib/keyTechAdmin";
import { EXPECTED_REGION_COUNT } from "../lib/mapConstants.generated";

/**
 * Task #34 / #121 — 國家管理 admin API（ADMIN_TOKEN raw-fetch pattern，不在
 * 公開 OpenAPI spec）。管理員可建立/刪除 NPC 國家，並編輯「所有國家」（NPC 與
 * 玩家）的全部數據（資源／內政／經濟數值＋外觀＋掌控地區）。
 * NPC 國家共用 player_nations（is_npc = true、無擁有者），掌控地區走
 * region_controls，與玩家共用外交系統。
 *
 * 安全界線：本 API 永不更動 discord_user_id 或 is_npc；刪除只限 NPC（玩家國家
 * 由玩家自己的退出／刪除流程處理，避免管理員誤刪玩家資料）。
 */
const router: IRouter = Router();

type NationRow = typeof playerNationsTable.$inferSelect;
type RegionAssignment = { regionId: number; percent: number };

/** 整數數值欄位（min/max 皆含）。 */
const INT_STAT_FIELDS = {
  techPoints: { label: "科技點數", min: 0, max: 2_000_000_000 },
  stability: { label: "安定度", min: 0, max: 100 },
  unrest: { label: "動亂度", min: 0, max: 100 },
  warWeariness: { label: "厭戰度", min: 0, max: 100 },
  satisfactionFarmers: { label: "農民滿意度", min: 0, max: 100 },
  satisfactionWorkers: { label: "工人滿意度", min: 0, max: 100 },
  satisfactionNobles: { label: "貴族(資本家)滿意度", min: 0, max: 100 },
  satisfactionClergy: { label: "教士滿意度", min: 0, max: 100 },
  farmerPopulationPct: { label: "農民人口比例", min: 0, max: 100 },
  taxRatePct: { label: "稅率", min: 0, max: TAX_RATE_MAX },
  taxEfficiencyBonus: { label: "稅收效率加成", min: -1000, max: 1000 },
} as const;

/**
 * bigint（mode: number）數值欄位。Task #322 起，人口增長累積量已移到
 * region_controls（per-region），不再是 nation 層級欄位，故此處移除「人口增減」。
 */
const BIGINT_STAT_FIELDS = {
  money: { label: "金錢", min: 0, max: 1_000_000_000_000_000 },
} as const;

/** 圖片網址欄位 → 錯誤訊息用的中文名稱。 */
const IMAGE_FIELDS: Record<string, string> = {
  flagUrl: "國旗圖片",
  emblemUrl: "國徽圖片",
  kanbanUrl: "看板顧問圖片",
  backgroundUrl: "背景圖片",
};

type NumericUpdates = Record<string, number>;
type ImageUpdates = Record<string, string | null>;

/** 解析數值欄位（省略 = 不含）；回傳 updates 或錯誤訊息。 */
function parseStatUpdates(
  body: Record<string, unknown>,
): { updates: NumericUpdates } | { error: string } {
  const updates: NumericUpdates = {};
  for (const [field, spec] of Object.entries(INT_STAT_FIELDS)) {
    if (body[field] === undefined) continue;
    const v = body[field];
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < spec.min ||
      v > spec.max
    ) {
      return { error: `${spec.label}必須是 ${spec.min} 到 ${spec.max} 的整數` };
    }
    updates[field] = v;
  }
  for (const [field, spec] of Object.entries(BIGINT_STAT_FIELDS)) {
    if (body[field] === undefined) continue;
    const v = body[field];
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < spec.min ||
      v > spec.max
    ) {
      return {
        error: `${spec.label}必須是整數（範圍 ${spec.min} 到 ${spec.max}）`,
      };
    }
    updates[field] = v;
  }
  return { updates };
}

/** 解析圖片網址欄位（省略 = 不含；null/"" = 清除）。 */
function parseImageUpdates(
  body: Record<string, unknown>,
): { updates: ImageUpdates } | { error: string } {
  const updates: ImageUpdates = {};
  for (const [field, label] of Object.entries(IMAGE_FIELDS)) {
    if (body[field] === undefined) continue;
    const result = validateImageUrl(body[field], label);
    if (!result.ok) return { error: result.error };
    updates[field] = result.value;
  }
  return { updates };
}

/** 文字欄位：trim 後空字串 → null，並截斷長度。 */
function textOrNull(v: unknown, max = 40): string | null {
  return typeof v === "string" && v.trim() !== ""
    ? v.trim().slice(0, max)
    : null;
}

/**
 * 驗證地區指派：每項 percent 1–100 整數、地區不可重複、地區必須存在，
 * 且每個地區「其他國家已占比例 + 本次指派」不可超過 100%。
 * 回傳錯誤訊息字串（null = 通過）。
 */
async function validateAssignments(
  assignments: RegionAssignment[],
  excludeNationId: string | null,
): Promise<string | null> {
  if (assignments.length === 0) return null;
  // 全世界共 373 個地區；單一國家最多可掌控全部（罕見，但戰爭領土轉移可達成）。
  if (assignments.length > EXPECTED_REGION_COUNT)
    return `最多指派 ${EXPECTED_REGION_COUNT} 個地區`;

  const seen = new Set<number>();
  for (const a of assignments) {
    if (!Number.isInteger(a.regionId) || a.regionId <= 0)
      return "regionId 不正確";
    if (seen.has(a.regionId)) return "同一個地區只能指派一次";
    seen.add(a.regionId);
    if (!Number.isInteger(a.percent) || a.percent < 1 || a.percent > 100)
      return "percent 必須是 1 到 100 的整數";
  }

  const regionIds = assignments.map((a) => a.regionId);
  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .where(inArray(mapRegionsTable.id, regionIds));
  if (regions.length !== regionIds.length) return "有地區不存在";

  const existing = await db
    .select({
      regionId: regionControlsTable.regionId,
      nationId: regionControlsTable.nationId,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .where(inArray(regionControlsTable.regionId, regionIds));
  const usedByOthers = new Map<number, number>();
  for (const row of existing) {
    if (excludeNationId !== null && row.nationId === excludeNationId) continue;
    usedByOthers.set(
      row.regionId,
      (usedByOthers.get(row.regionId) ?? 0) + row.percent,
    );
  }
  for (const a of assignments) {
    const used = usedByOthers.get(a.regionId) ?? 0;
    if (used + a.percent > 100) {
      return `地區 #${a.regionId} 的掌控比例總和會超過 100%（其他國家已占 ${used}%）`;
    }
  }
  return null;
}

function parseAssignments(raw: unknown): RegionAssignment[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: RegionAssignment[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return null;
    const { regionId, percent } = entry as {
      regionId?: unknown;
      percent?: unknown;
    };
    if (typeof regionId !== "number" || typeof percent !== "number")
      return null;
    out.push({ regionId, percent });
  }
  return out;
}

function serializeNation(
  n: NationRow,
  regions: { regionId: number; regionName: string; percent: number }[],
) {
  return {
    id: n.id,
    name: n.name,
    leaderName: n.leaderName,
    government: n.government,
    flagUrl: n.flagUrl,
    emblemUrl: n.emblemUrl,
    kanbanUrl: n.kanbanUrl,
    backgroundUrl: n.backgroundUrl,
    isNpc: n.isNpc,
    isOwned: n.discordUserId !== null,
    techPoints: n.techPoints,
    money: n.money,
    stability: n.stability,
    unrest: n.unrest,
    warWeariness: n.warWeariness,
    satisfactionFarmers: n.satisfactionFarmers,
    satisfactionWorkers: n.satisfactionWorkers,
    satisfactionNobles: n.satisfactionNobles,
    satisfactionClergy: n.satisfactionClergy,
    farmerPopulationPct: n.farmerPopulationPct,
    taxRatePct: n.taxRatePct,
    taxEfficiencyBonus: n.taxEfficiencyBonus,
    politicalNote: n.politicalNote,
    diplomaticAttitude: n.diplomaticAttitude,
    regions,
    createdAt: n.createdAt.toISOString(),
  };
}

/** 國家清單（NPC 與玩家分組，皆含全部可編輯欄位與掌控地區）。 */
router.get("/npc-nations", requireAdmin, async (_req, res) => {
  const allNations = await db
    .select()
    .from(playerNationsTable)
    .orderBy(asc(playerNationsTable.createdAt));

  const nationIds = allNations.map((n) => n.id);
  const controls =
    nationIds.length === 0
      ? []
      : await db
          .select({
            regionId: regionControlsTable.regionId,
            nationId: regionControlsTable.nationId,
            percent: regionControlsTable.percent,
            regionName: mapRegionsTable.name,
          })
          .from(regionControlsTable)
          .innerJoin(
            mapRegionsTable,
            eq(mapRegionsTable.id, regionControlsTable.regionId),
          )
          .where(inArray(regionControlsTable.nationId, nationIds));

  const regionsByNation = new Map<
    string,
    { regionId: number; regionName: string; percent: number }[]
  >();
  for (const c of controls) {
    const list = regionsByNation.get(c.nationId) ?? [];
    list.push({
      regionId: c.regionId,
      regionName: c.regionName,
      percent: c.percent,
    });
    regionsByNation.set(c.nationId, list);
  }

  // Task #389 — NPC 常備軍摘要（唯讀顯示，不提供編輯）。
  const npcArmyRows =
    nationIds.length === 0
      ? []
      : await db
          .select({
            nationId: npcArmiesTable.nationId,
            quantity: npcArmiesTable.quantity,
            committed: npcArmiesTable.committed,
            wounded: npcArmiesTable.wounded,
            unitName: militaryUnitTemplatesTable.name,
            category: militaryUnitTemplatesTable.category,
          })
          .from(npcArmiesTable)
          .innerJoin(
            militaryUnitTemplatesTable,
            eq(militaryUnitTemplatesTable.id, npcArmiesTable.templateId),
          )
          .where(inArray(npcArmiesTable.nationId, nationIds))
          .orderBy(asc(npcArmiesTable.id));
  const militaryByNation = new Map<
    string,
    {
      standing: number;
      committed: number;
      wounded: number;
      units: {
        name: string;
        category: string;
        quantity: number;
        committed: number;
        wounded: number;
      }[];
    }
  >();
  for (const a of npcArmyRows) {
    const entry = militaryByNation.get(a.nationId) ?? {
      standing: 0,
      committed: 0,
      wounded: 0,
      units: [],
    };
    entry.standing += a.quantity;
    entry.committed += a.committed;
    entry.wounded += a.wounded;
    entry.units.push({
      name: a.unitName,
      category: a.category,
      quantity: a.quantity,
      committed: a.committed,
      wounded: a.wounded,
    });
    militaryByNation.set(a.nationId, entry);
  }

  const npcs: (ReturnType<typeof serializeNation> & {
    military: ReturnType<typeof militaryByNation.get> | null;
  })[] = [];
  const players: ReturnType<typeof serializeNation>[] = [];
  for (const n of allNations) {
    const s = serializeNation(n, regionsByNation.get(n.id) ?? []);
    if (n.isNpc)
      npcs.push({ ...s, military: militaryByNation.get(n.id) ?? null });
    else players.push(s);
  }

  res.json({ npcs, players });
});

/** 建立 NPC：name 必填；leaderName/government/圖片/數值/regions 皆可選。 */
router.post("/npc-nations", requireAdmin, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const nameResult = validateNationName(body.name, "國名");
  if (!nameResult.ok) {
    res.status(400).json({ error: nameResult.error });
    return;
  }
  const name = nameResult.value;

  const imageResult = parseImageUpdates(body);
  if ("error" in imageResult) {
    res.status(400).json({ error: imageResult.error });
    return;
  }
  const statResult = parseStatUpdates(body);
  if ("error" in statResult) {
    res.status(400).json({ error: statResult.error });
    return;
  }

  const assignments = parseAssignments(body.regions);
  if (assignments === null) {
    res.status(400).json({ error: "regions 格式不正確" });
    return;
  }
  const validationError = await validateAssignments(assignments, null);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const created = await db.transaction(async (tx) => {
    const [npc] = await tx
      .insert(playerNationsTable)
      .values({
        name,
        leaderName: textOrNull(body.leaderName),
        government: textOrNull(body.government),
        isNpc: true,
        ...imageResult.updates,
        ...statResult.updates,
      })
      .returning();
    if (!npc) throw new Error("NPC 建立失敗");
    if (assignments.length > 0) {
      await tx.insert(regionControlsTable).values(
        assignments.map((a) => ({
          regionId: a.regionId,
          nationId: npc.id,
          percent: a.percent,
        })),
      );
      // Task #392 — 同交易內記錄 NPC 建立時的初始領土指派。
      await recordTerritoryChanges(
        tx,
        assignments.map((a) => ({
          nationId: npc.id,
          regionId: a.regionId,
          percentBefore: 0,
          percentAfter: a.percent,
          changeType: "admin_nation_replace" as const,
          reason: `國家管理：建立 NPC「${name}」並指派初始領土`,
        })),
      );
    }
    return npc;
  });

  req.log.info({ npcId: created.id, name }, "NPC nation created");
  res.json({ id: created.id, name: created.name });
});

/**
 * 更新任一國家（NPC 或玩家）：所有欄位省略 = 不變；regions = 全量替換。
 * 永不更動 discord_user_id / is_npc。
 */
router.patch("/npc-nations/:id", requireAdmin, async (req, res) => {
  const nationId = String(req.params.id);
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId))
    .limit(1);
  if (!nation) {
    res.status(404).json({ error: "找不到這個國家" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Record<string, unknown> = {};

  if (body.name !== undefined) {
    const nameResult = validateNationName(body.name, "國名");
    if (!nameResult.ok) {
      res.status(400).json({ error: nameResult.error });
      return;
    }
    updates.name = nameResult.value;
  }
  if (body.leaderName !== undefined) {
    updates.leaderName = textOrNull(body.leaderName);
  }
  if (body.government !== undefined) {
    updates.government = textOrNull(body.government);
  }
  if (body.diplomaticAttitude !== undefined) {
    updates.diplomaticAttitude = textOrNull(body.diplomaticAttitude, 300);
  }
  if (body.politicalNote !== undefined) {
    // Task #330 — 管理員手動改寫政治註記（含清空）；null／空字串 → 清空。
    updates.politicalNote = textOrNull(body.politicalNote, 1000);
  }

  const imageResult = parseImageUpdates(body);
  if ("error" in imageResult) {
    res.status(400).json({ error: imageResult.error });
    return;
  }
  Object.assign(updates, imageResult.updates);

  const statResult = parseStatUpdates(body);
  if ("error" in statResult) {
    res.status(400).json({ error: statResult.error });
    return;
  }
  Object.assign(updates, statResult.updates);

  // Task #392 — 管理員可附上自訂變更理由（選填，僅用於 regions 替換的歷史）。
  if (body.reason !== undefined && typeof body.reason !== "string") {
    res.status(400).json({ error: "reason 必須是文字" });
    return;
  }
  const customReason =
    typeof body.reason === "string" ? body.reason.trim() : "";
  if (customReason.length > 500) {
    res.status(400).json({ error: "reason 最多 500 字" });
    return;
  }

  let assignments: RegionAssignment[] | null = null;
  if (body.regions !== undefined) {
    assignments = parseAssignments(body.regions);
    if (assignments === null) {
      res.status(400).json({ error: "regions 格式不正確" });
      return;
    }
    const validationError = await validateAssignments(assignments, nationId);
    if (validationError) {
      res.status(400).json({ error: validationError });
      return;
    }
  }

  await db.transaction(async (tx) => {
    if (Object.keys(updates).length > 0) {
      await tx
        .update(playerNationsTable)
        .set(updates)
        .where(eq(playerNationsTable.id, nationId));
    }
    if (assignments !== null) {
      // Task #322 — 全量替換掌控地區時，保留各地區既有的人口成長累積量
      // （依 regionId 對應）；被移除的地區其累積量隨之消失，新增地區從 0 起算。
      const existing = await tx
        .select({
          regionId: regionControlsTable.regionId,
          percent: regionControlsTable.percent,
          populationBonus: regionControlsTable.populationBonus,
        })
        .from(regionControlsTable)
        .where(eq(regionControlsTable.nationId, nationId));
      const accruedByRegion = new Map(
        existing.map((r) => [r.regionId, r.populationBonus]),
      );
      await tx
        .delete(regionControlsTable)
        .where(eq(regionControlsTable.nationId, nationId));
      if (assignments.length > 0) {
        await tx.insert(regionControlsTable).values(
          assignments.map((a) => ({
            regionId: a.regionId,
            nationId: nationId,
            percent: a.percent,
            populationBonus: accruedByRegion.get(a.regionId) ?? 0,
          })),
        );
      }
      // Task #392 — 同交易內記錄國家管理的領土全量替換（僅記實際變更；
      // 支援管理員自訂理由）。
      const beforeByRegion = new Map(
        existing.map((r) => [r.regionId, r.percent]),
      );
      const afterByRegion = new Map(
        assignments.map((a) => [a.regionId, a.percent]),
      );
      const touched = new Set([
        ...beforeByRegion.keys(),
        ...afterByRegion.keys(),
      ]);
      const entries = [...touched]
        .map((regionId) => ({
          nationId,
          regionId,
          percentBefore: beforeByRegion.get(regionId) ?? 0,
          percentAfter: afterByRegion.get(regionId) ?? 0,
          changeType: "admin_nation_replace" as const,
          reason:
            customReason !== ""
              ? `國家管理領土替換：${customReason}`
              : `國家管理：替換「${nation.name}」的掌控地區`,
        }))
        .filter((e) => e.percentBefore !== e.percentAfter);
      await recordTerritoryChanges(tx, entries);
    }
  });

  req.log.info({ nationId }, "nation updated (admin)");
  res.json({ ok: true });
});

/**
 * Task #233 — 所有國家的政治註記與外交態度總覽（唯讀）。放在 :id 參數路由之前，
 * 避免被參數路由攔截（雖目前無 GET :id，仍保守）。
 */
router.get("/npc-nations/political-notes", requireAdmin, async (_req, res) => {
  const rows = await db
    .select({
      id: playerNationsTable.id,
      name: playerNationsTable.name,
      government: playerNationsTable.government,
      isNpc: playerNationsTable.isNpc,
      discordUserId: playerNationsTable.discordUserId,
      politicalNote: playerNationsTable.politicalNote,
      diplomaticAttitude: playerNationsTable.diplomaticAttitude,
    })
    .from(playerNationsTable)
    .orderBy(asc(playerNationsTable.createdAt));
  const nations = rows.map((n) => ({
    id: n.id,
    name: n.name,
    government: n.government,
    isNpc: n.isNpc,
    isOwned: n.discordUserId !== null,
    politicalNote: n.politicalNote,
    diplomaticAttitude: n.diplomaticAttitude,
  }));
  res.json({ nations });
});

/**
 * 全國家三領域關鍵科技狀況總覽（唯讀）＋批次工具用的科技目錄與時代清單。
 * 放在 :id 參數路由之前保守處理。不外洩 discord_user_id。
 */
router.get("/npc-nations/tech-status", requireAdmin, async (_req, res) => {
  const { worldEra, catalog, nations } = await loadKeyTechStatus();
  res.json({
    worldEra,
    catalog,
    eras: ERAS.map((e) => ({ slug: e.slug, label: e.label })),
    nations,
  });
});

/**
 * 批次對「所有國家」授予／移除單一關鍵科技（單一交易）。玩家走 player_researched_*
 * （實際增刪對應列），NPC／無主走 player_nations 的科技時代指標近似。
 * body: { domain: 'military'|'social'|'production', keySlug, action: 'grant'|'revoke' }
 */
router.post("/npc-nations/key-techs", requireAdmin, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { domain, keySlug, action } = body;
  if (!isKeyTechDomain(domain)) {
    res.status(400).json({ error: "科技領域不正確（軍事／社會／生產）" });
    return;
  }
  if (typeof keySlug !== "string") {
    res.status(400).json({ error: "找不到這個關鍵科技" });
    return;
  }
  const entry = await keyTechCatalogEntry(domain, keySlug);
  if (entry === null) {
    res.status(400).json({ error: "找不到這個關鍵科技" });
    return;
  }
  if (action !== "grant" && action !== "revoke") {
    res.status(400).json({ error: "動作必須是 grant 或 revoke" });
    return;
  }

  const techId = await getKeyTechId(domain, keySlug);
  if (techId === null) {
    res.status(500).json({ error: "關鍵科技尚未初始化，請稍後再試" });
    return;
  }

  const { currentEra } = await getEraSlugs();
  const keyAboveWorld = getEraIndex(entry.eraSlug) > getEraIndex(currentEra);

  const result = await db.transaction(async (tx) => {
    const playerCount =
      action === "grant"
        ? await grantKeyTechToAllPlayers(tx, domain, techId)
        : await revokeKeyTechFromAllPlayers(tx, domain, techId);
    const npc = await applyKeyTechToNullOwnerNations(
      tx,
      domain,
      entry.eraSlug,
      currentEra,
      action,
      techId,
    );
    return { playerCount, ...npc };
  });

  req.log.info(
    {
      domain,
      keySlug,
      action,
      playerCount: result.playerCount,
      npcUpdated: result.npcUpdated,
      npcCapped: result.npcCapped,
      npcSkipped: result.npcSkipped.length,
    },
    "bulk key tech applied (admin)",
  );
  res.json({
    domain,
    keySlug,
    name: entry.name,
    action,
    worldEra: currentEra,
    keyAboveWorld,
    ...result,
  });
});

/**
 * Task #233 — 產生某國「外交態度」（AI，bulk 模型）並寫回其 diplomatic_attitude。
 * 加 aiRateLimit（5/min/IP）；AI 失敗回 502，不寫入。
 */
router.post(
  "/npc-nations/:id/diplomatic-attitude",
  requireAdmin,
  aiRateLimit,
  async (req, res) => {
    const nationId = String(req.params.id);
    const [nation] = await db
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .limit(1);
    if (!nation) {
      res.status(404).json({ error: "找不到這個國家" });
      return;
    }
    try {
      const { currentEra } = await getEraSlugs();
      const geoContext = await buildNationGeoCultureContext(nation.id);
      const attitude = await generateDiplomaticAttitude({
        government: nation.government,
        eraSlug: currentEra,
        nationName: nation.name,
        leaderName: nation.leaderName,
        politicalNote: nation.politicalNote,
        geoContext,
      });
      await db
        .update(playerNationsTable)
        .set({ diplomaticAttitude: attitude })
        .where(eq(playerNationsTable.id, nationId));
      req.log.info({ nationId }, "diplomatic attitude generated (admin)");
      res.json({ diplomaticAttitude: attitude });
    } catch (err) {
      req.log.error(
        { err, nationId },
        "failed to generate diplomatic attitude",
      );
      res.status(502).json({ error: "外交態度生成失敗，請稍後再試" });
    }
  },
);

/**
 * Task #330 — 管理員一鍵以 AI 重新生成某國政治註記（可選填提示詞引導方向）。
 * 套用既有 AI 速率限制；AI 失敗回 zh-TW 錯誤且不覆寫原值。比照
 * /diplomatic-attitude 的 raw-fetch、不進 OpenAPI spec 慣例。
 */
router.post(
  "/npc-nations/:id/political-note",
  requireAdmin,
  aiRateLimit,
  async (req, res) => {
    const nationId = String(req.params.id);
    const [nation] = await db
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, nationId))
      .limit(1);
    if (!nation) {
      res.status(404).json({ error: "找不到這個國家" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const customPrompt = textOrNull(body.prompt, 500);
    try {
      const { currentEra } = await getEraSlugs();
      const note = await generatePoliticalNote({
        government: nation.government,
        eraSlug: currentEra,
        nationName: nation.name,
        leaderName: nation.leaderName,
        customPrompt,
      });
      await db
        .update(playerNationsTable)
        .set({ politicalNote: note })
        .where(eq(playerNationsTable.id, nationId));
      req.log.info({ nationId }, "political note regenerated (admin)");
      res.json({ politicalNote: note });
    } catch (err) {
      req.log.error({ err, nationId }, "failed to regenerate political note");
      res.status(502).json({ error: "政治註記生成失敗，請稍後再試" });
    }
  },
);

/** 刪除 NPC（region_controls／外交資料由 FK cascade 一併清除）。僅限 NPC。 */
router.delete("/npc-nations/:id", requireAdmin, async (req, res) => {
  const npcId = String(req.params.id);
  const deleted = await db
    .delete(playerNationsTable)
    .where(
      and(
        eq(playerNationsTable.id, npcId),
        eq(playerNationsTable.isNpc, true),
      ),
    )
    .returning({ id: playerNationsTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "找不到這個 NPC 國家" });
    return;
  }
  req.log.info({ npcId }, "NPC nation deleted");
  res.json({ ok: true });
});

export default router;
