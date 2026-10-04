import { scalesFromPopulation } from "../lib/nationScale";
import { scaleByEra } from "../lib/eraCostScale";
import { Router, type IRouter } from "express";
import { z } from "zod";
import { schemas } from "@workspace/api-zod";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  playerNationsTable,
  gameNewsTable,
  gameAppearanceDefaultsTable,
  worldGameStateTable,
  regionControlsTable,
  mapRegionsTable,
  playerArmiesTable,
  militaryPurchaseQuotasTable,
  militaryUnitTemplatesTable,
  cityBuildingsTable,
  nationPopulationBuffsTable,
  playerWoundedUnitsTable,
  playerUnitCustomizationsTable,
  type PlayerNation,
} from "@workspace/db";
import { computeAvailableProduction } from "../lib/economy";
import { loadCurrentTurnRecruitSpend } from "../lib/recruitSpend";
import { getSession, readSessionToken } from "../lib/sessions";
import { endCampaignsForNation, getWoundedStatus } from "../lib/warEngine";
import { requireAdmin } from "../middlewares/requireAdmin";
import { ERAS, isEraSlug, DEFAULT_ERA_SLUG } from "../lib/mapRegionEras";
import {
  buildNationStatBreakdown,
  computeAdjustedNationStats,
  getEraSlugs,
  getStatsEraSlug,
} from "../lib/nationStats";
import { grantJoinEraKeyTechsToPlayer } from "../lib/keyTechAdmin";
import {
  FOUNDING_GOVERNMENT_SLUGS,
  GOVERNMENTS,
  governmentLabel,
  isFoundingGovernmentSlug,
  recommendedGovernmentsForEra,
} from "../lib/governments";

import {
  pgErrorCode,
  validateImageUrl,
  validateName,
  validateNationName,
} from "../lib/playerValidation";
import {
  listPlayerNotifications,
  markPlayerNotificationsRead,
} from "../lib/playerNotify";
import { REGION_CLAIM_LOCK_NS } from "../lib/locks";
import { recordTerritoryChanges } from "../lib/territoryHistory";
import { ADVISOR_STYLE_MAX, generateAdvisorTips } from "../lib/advisorAi";
import { AiQuotaExceededError } from "../lib/gameAi";
import { aiRateLimit } from "../middlewares/aiRateLimit";

const router: IRouter = Router();

const { GetNationStatBreakdownResponse } = schemas;

/** Admin read of the global game appearance defaults (single row id=1). */
router.get("/game/appearance-defaults", requireAdmin, async (_req, res) => {
  const [row] = await db
    .select()
    .from(gameAppearanceDefaultsTable)
    .where(eq(gameAppearanceDefaultsTable.id, 1))
    .limit(1);
  res.json({
    kanbanUrl: row?.kanbanUrl ?? null,
    backgroundUrl: row?.backgroundUrl ?? null,
    eraBackgrounds: row?.eraBackgrounds ?? {},
    eras: ERAS.map((e) => ({ slug: e.slug, label: e.label })),
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  });
});

/**
 * Admin update of the global game appearance defaults. Fields are optional —
 * omitted fields keep their previous value; empty string or null clears the
 * override (frontend then falls back to the shipped static asset).
 */
router.put("/game/appearance-defaults", requireAdmin, async (req, res) => {
  const body = req.body ?? {};

  const updates: {
    kanbanUrl?: string | null;
    backgroundUrl?: string | null;
    eraBackgrounds?: Record<string, string>;
  } = {};

  if ("kanbanUrl" in body) {
    const result = validateImageUrl(body.kanbanUrl, "kanbanUrl");
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    updates.kanbanUrl = result.value;
  }
  if ("backgroundUrl" in body) {
    const result = validateImageUrl(body.backgroundUrl, "backgroundUrl");
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    updates.backgroundUrl = result.value;
  }
  if ("eraBackgrounds" in body) {
    const raw = body.eraBackgrounds;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      res.status(400).json({ error: "eraBackgrounds 必須是物件（時代代號 → 圖片網址）" });
      return;
    }
    // Full-replace semantics: the map provided here becomes the stored map.
    // Entries with empty/null values are dropped (= 該時代改用全域預設).
    const cleaned: Record<string, string> = {};
    for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!isEraSlug(slug)) {
        res.status(400).json({ error: `未知的時代代號：${slug}` });
        return;
      }
      const result = validateImageUrl(value, `eraBackgrounds.${slug}`);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      if (result.value !== null) cleaned[slug] = result.value;
    }
    updates.eraBackgrounds = cleaned;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({
      error: "請至少提供 kanbanUrl、backgroundUrl 或 eraBackgrounds 其中一項",
    });
    return;
  }

  const [row] = await db
    .insert(gameAppearanceDefaultsTable)
    .values({ id: 1, ...updates })
    .onConflictDoUpdate({
      target: gameAppearanceDefaultsTable.id,
      set: { ...updates, updatedAt: new Date() },
    })
    .returning();

  req.log.info(
    {
      kanbanUrl: row.kanbanUrl,
      backgroundUrl: row.backgroundUrl,
      eraBackgroundCount: Object.keys(row.eraBackgrounds ?? {}).length,
    },
    "game appearance defaults updated",
  );

  res.json({
    kanbanUrl: row.kanbanUrl,
    backgroundUrl: row.backgroundUrl,
    eraBackgrounds: row.eraBackgrounds ?? {},
    eras: ERAS.map((e) => ({ slug: e.slug, label: e.label })),
    updatedAt: row.updatedAt.toISOString(),
  });
});

/**
 * 12 governments with the current-era recommendations first (Task #30).
 * Public read — the founding UI needs it before a nation exists.
 */
router.get("/game/governments", async (_req, res) => {
  const [gameState] = await db
    .select()
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  const currentEra = gameState?.currentEra ?? DEFAULT_ERA_SLUG;
  const currentEraLabel =
    ERAS.find((e) => e.slug === currentEra)?.label ?? currentEra;
  const recommended = recommendedGovernmentsForEra(currentEra);

  const list = [
    ...recommended
      .map((slug) => GOVERNMENTS.find((g) => g.slug === slug))
      .filter((g): g is (typeof GOVERNMENTS)[number] => g !== undefined)
      .map((g) => ({ ...g, recommended: true })),
    ...GOVERNMENTS.filter((g) => !recommended.includes(g.slug)).map((g) => ({
      ...g,
      recommended: false,
    })),
  ];

  res.json({ currentEra, currentEraLabel, governments: list });
});

/**
 * Region ids that already have at least one control row (= not available as
 * a founding start region). Public read — powers the founding map.
 */
router.get("/game/claimed-regions", async (_req, res) => {
  const rows = await db
    .selectDistinct({ regionId: regionControlsTable.regionId })
    .from(regionControlsTable);
  res.json({ regionIds: rows.map((r) => r.regionId) });
});

/**
 * Task #184 — 每回合 AI 整理的重大新聞（公開唯讀，新到舊）。
 */
router.get("/game/news", async (req, res) => {
  const parsed = z
    .object({ limit: z.coerce.number().int().min(1).max(100).default(30) })
    .safeParse(req.query);
  const limit = parsed.success ? parsed.data.limit : 30;

  const rows = await db
    .select()
    .from(gameNewsTable)
    .orderBy(desc(gameNewsTable.createdAt))
    .limit(limit);

  res.json({
    news: rows.map((r) => ({
      id: r.id,
      gameDate: r.gameDate,
      year: r.year,
      era: r.era,
      eraLabel: ERAS.find((e) => e.slug === r.era)?.label ?? r.era,
      category: r.category,
      title: r.title,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

/** Task #28 — 玩家可見的掌控地區清單（唯讀，依大區/種子順序排序）。 */
async function loadControlledRegions(
  nationId: string,
): Promise<{ regionId: number; name: string; macroRegion: string; percent: number }[]> {
  // 地區 id 為種子順序（serial），依 id 排序＝依大區/種子順序。
  return db
    .select({
      regionId: mapRegionsTable.id,
      name: mapRegionsTable.name,
      macroRegion: mapRegionsTable.macroRegion,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .innerJoin(mapRegionsTable, eq(mapRegionsTable.id, regionControlsTable.regionId))
    .where(eq(regionControlsTable.nationId, nationId))
    .orderBy(asc(mapRegionsTable.id));
}

function serializeNation(
  nation: PlayerNation,
  stats: Awaited<ReturnType<typeof computeAdjustedNationStats>>,
  regions: Awaited<ReturnType<typeof loadControlledRegions>>,
  defaults: {
    kanbanUrl: string | null;
    backgroundUrl: string | null;
    eraBackgroundUrl: string | null;
  },
  woundedTotal: number,
  currentTurnSpend: number,
) {
  return {
    id: nation.id,
    name: nation.name,
    leaderName: nation.leaderName,
    flagUrl: nation.flagUrl,
    emblemUrl: nation.emblemUrl,
    // 玩家自訂地圖顏色（#rrggbb）；null = 前端退回預設調色盤。
    mapColor: nation.mapColor,
    government: nation.government,
    techPoints: nation.techPoints,
    techPerTurn: stats.techPerTurn,
    // Task #27 — military recruiting consumes production/population; the
    // numbers surfaced to the player are the remaining (available) amounts.
    // Task #568 — 可用量 = 總量 − 已佔用 − 本回合招募花費（流量）。
    production: computeAvailableProduction({
      production: stats.production,
      productionSpent: nation.productionSpent,
      currentTurnSpend,
    }),
    // Task #179 — 生產力剩餘/總量顯示：一併回傳本回合總量與已佔用量。
    productionTotal: stats.production,
    productionSpent: nation.productionSpent,
    population: Math.max(0, stats.population - nation.populationSpent),
    // 人口增長率（%／回合；內政基礎值 + 政策/事件加減成，夾 ±上限）。
    populationGrowthPct: Math.round(stats.populationGrowthRatePct * 10) / 10,
    money: nation.money,
    // Task #43 — 內政有效數值（基底 + 政策/事件持續性加減成後）。
    // 顯示用：最多小數點第一位（內部計算保留完整精度供回合結算使用）。
    stability: Math.round(stats.politics.stability * 10) / 10,
    unrest: stats.politics.unrest,
    warWeariness: stats.politics.warWeariness,
    // Task #105 — 傷兵總數（全國傷兵池 + 前線傷兵；隨結算迴圈逐步歸隊）。
    woundedTotal,
    // Task #401 — 人口結構：農民比例（0–100，工人 = 100 − 農民；純顯示用）。
    farmerPopulationPct: nation.farmerPopulationPct,
    satisfactions: Object.fromEntries(
      Object.entries(stats.politics.satisfactions).map(([k, v]) => [
        k,
        Math.round((v as number) * 10) / 10,
      ]),
    ) as typeof stats.politics.satisfactions,
    // Player override → current-era background → global admin default → null
    // (frontend falls back to the static asset shipped with the dashboard).
    kanbanUrl: nation.kanbanUrl ?? defaults.kanbanUrl,
    backgroundUrl:
      nation.backgroundUrl ?? defaults.eraBackgroundUrl ?? defaults.backgroundUrl,
    // Task #303 — 看板顧問：自訂說話風格 + 已產生的隨機小tips。
    advisorStyle: nation.advisorStyle,
    advisorTips: nation.advisorTips ?? [],
    // Discord 私訊通知開關（外交／內政各自獨立，預設開啟）。
    dmDiplomacyEnabled: nation.dmDiplomacyEnabled,
    dmPoliticsEnabled: nation.dmPoliticsEnabled,
    // Task #584 — 政變後果倒數（政策封鎖／士氣懲罰剩餘回合數）。
    coupPolicyLockTurns: nation.coupPolicyLockTurns,
    coupMoralePenaltyTurns: nation.coupMoralePenaltyTurns,
    // Task #28 — 玩家可見的掌控地區清單（唯讀）。
    regions,
  };
}

/** Compute stats + appearance defaults and serialize one nation. */
async function buildNationView(nation: PlayerNation) {
  const [[defaults], [gameState], regions] = await Promise.all([
    db
      .select()
      .from(gameAppearanceDefaultsTable)
      .where(eq(gameAppearanceDefaultsTable.id, 1))
      .limit(1),
    db
      .select()
      .from(worldGameStateTable)
      .where(eq(worldGameStateTable.id, 1))
      .limit(1),
    loadControlledRegions(nation.id),
  ]);
  const currentEra = gameState?.currentEra ?? DEFAULT_ERA_SLUG;
  // 玩家數據用「數據時代」計算：管理員改時代未勾同步時，數據不會被重設。
  const statsEra = gameState?.statsEra ?? currentEra;
  const eraBackgrounds = defaults?.eraBackgrounds ?? {};
  const [stats, wounded, currentTurnSpend] = await Promise.all([
    computeAdjustedNationStats(nation, statsEra),
    getWoundedStatus(nation.discordUserId, nation.id),
    loadCurrentTurnRecruitSpend(nation.id),
  ]);
  return serializeNation(
    nation,
    stats,
    regions,
    {
      kanbanUrl: defaults?.kanbanUrl ?? null,
      backgroundUrl: defaults?.backgroundUrl ?? null,
      eraBackgroundUrl: eraBackgrounds[currentEra] ?? null,
    },
    wounded.woundedTotal,
    currentTurnSpend,
  );
}

async function requireSession(req: Parameters<Parameters<IRouter["get"]>[1]>[0]) {
  return getSession(readSessionToken(req));
}

async function loadOwnedNation(userId: string): Promise<PlayerNation | null> {
  const [nation] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  return nation ?? null;
}

/**
 * Current player's nation (Task #30: no auto-create — a player without a
 * nation gets hasNation=false and the frontend shows the founding flow).
 */
router.get("/player/nation", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }

  const nation = await loadOwnedNation(session.discordUserId);
  if (!nation) {
    res.json({ hasNation: false, nation: null });
    return;
  }
  res.json({ hasNation: true, nation: await buildNationView(nation) });
});

/**
 * Task #179 — 數值來源明細：把玩家國家數值（生產力/科技/人口/內政）的
 * 組成逐層攤開，供首頁彈窗按需載入。玩家數據一律以「數據時代」計算。
 */
router.get("/player/nation/stat-breakdown", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }
  const nation = await loadOwnedNation(session.discordUserId);
  if (!nation) {
    res.status(404).json({ error: "尚未建國" });
    return;
  }
  const statsEra = await getStatsEraSlug();
  const breakdown = await buildNationStatBreakdown(nation, statsEra);
  const eraLabel = ERAS.find((e) => e.slug === breakdown.era)?.label ?? breakdown.era;
  // Task #540 — 以生成的 zod schema 驗證回應形狀：欄位漂移在開發期顯性失敗，
  // 而不是默默少欄位讓前端渲染出 undefined%。
  const data = GetNationStatBreakdownResponse.parse({ ...breakdown, eraLabel });
  res.json(data);
});

/**
 * 建國生產力上限的年代縮放：基準為古典時代（prodAvg = 5）。
 * worldGameState.foundingProductionCap 是管理員設定的「古典基準值」；
 * 實際上限 = 基準 × 當前年代 prodAvg ÷ 5，讓所有年代保有同樣的選地寬度
 * （分子 productivity × population 隨年代暴漲，固定上限晚期會形同虛設）。
 * 未知時代 slug 回落古典（prodAvg 5 → 不縮放）。
 */
function eraScaledFoundingCap(baseCap: number, eraSlug: string | undefined): number {
  const era = ERAS.find((e) => e.slug === eraSlug);
  const prodAvg = era?.prodAvg ?? 5;
  return Math.round(baseCap * (prodAvg / 5));
}

/**
 * Task #433 — 建國可選政體清單（含決策難度等量化提示）。數值直接取自
 * governments.ts SSOT，前端不再自抄一份會漂移的數字。
 */
router.get("/player/founding-governments", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }
  const governments = FOUNDING_GOVERNMENT_SLUGS.map((slug) => {
    const def = GOVERNMENTS.find((g) => g.slug === slug);
    if (!def) return null;
    return {
      slug: def.slug,
      label: def.label,
      description: def.description,
      decisionDifficulty: def.decisionDifficulty,
    };
  }).filter((g) => g !== null);

  const [worldRow] = await db
    .select({
      foundingProductionCap: worldGameStateTable.foundingProductionCap,
      currentEra: worldGameStateTable.currentEra,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  // 生產力上限依當前年代縮放：分子（productivity × population）隨年代暴漲
  // （prodAvg 5 → 10000），固定上限會讓晚期年代幾乎選不了第二塊地。
  const foundingProductionCap = eraScaledFoundingCap(
    worldRow?.foundingProductionCap ?? 10000,
    worldRow?.currentEra,
  );

  res.json({ governments, foundingProductionCap });
});

/**
 * 建國（自創國家）：picks an unclaimed map region as the starting territory
 * (100% control). Race-safe via a per-region advisory lock inside the
 * transaction; one-nation-per-player is enforced by the unique owner column.
 */
router.post("/player/nation", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }
  const userId = session.discordUserId;
  const body = req.body ?? {};

  const name = validateNationName(body.name, "國名");
  if (!name.ok) {
    res.status(400).json({ error: name.error });
    return;
  }
  const leaderName = validateName(body.leaderName, "領導者名稱");
  if (!leaderName.ok) {
    res.status(400).json({ error: leaderName.error });
    return;
  }
  // Task #428：建國時三選一政體（君主專制／貴族制／議會共和制）；其餘政體須靠政治系統改制取得。
  const governmentSlug = typeof body.government === "string" ? body.government : "";
  if (!isFoundingGovernmentSlug(governmentSlug)) {
    res.status(400).json({
      error: "請選擇建國政體（君主專制、貴族制或議會共和制）",
    });
    return;
  }
  const government = governmentLabel(governmentSlug);

  // 接受 1–5 塊起始地區。
  const rawIds = body.regionIds;
  if (!Array.isArray(rawIds) || rawIds.length < 1 || rawIds.length > 5) {
    res.status(400).json({ error: "請選擇 1–5 塊起始地區" });
    return;
  }
  const regionIds: number[] = [];
  for (const v of rawIds) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(400).json({ error: "地區 ID 必須為正整數" });
      return;
    }
    if (regionIds.includes(n)) {
      res.status(400).json({ error: "起始地區不可重複" });
      return;
    }
    regionIds.push(n);
  }
  // 升冪排序，確保 advisory lock 順序一致，避免死鎖
  regionIds.sort((a, b) => a - b);

  const flag = validateImageUrl(body.flagUrl, "國旗圖片");
  if (!flag.ok) {
    res.status(400).json({ error: flag.error });
    return;
  }
  const emblem = validateImageUrl(body.emblemUrl, "國徽圖片");
  if (!emblem.ok) {
    res.status(400).json({ error: emblem.error });
    return;
  }

  // 驗證所有地區存在
  const regions = await db
    .select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
    .from(mapRegionsTable)
    .where(inArray(mapRegionsTable.id, regionIds));
  if (regions.length !== regionIds.length) {
    res.status(400).json({ error: "找不到指定的地區" });
    return;
  }

  // 依加入當下的世界時代自動補齊前代關鍵科技（見 grantJoinEraKeyTechsToPlayer）。
  const { currentEra: worldEra } = await getEraSlugs();

  // 選 2–3 塊時，驗證實際生產力（productivity × population / 1,000,000）加總 ≤ 可設定上限
  if (regionIds.length >= 2) {
    const [capRow] = await db
      .select({ foundingProductionCap: worldGameStateTable.foundingProductionCap })
      .from(worldGameStateTable)
      .where(eq(worldGameStateTable.id, 1))
      .limit(1);
    const productionCap = eraScaledFoundingCap(
      capRow?.foundingProductionCap ?? 10000,
      worldEra,
    );

    // 兩欄皆為 int4：大航海時代之後 productivity × population 會超過 2^31，
    // 必須在相乘前先轉 bigint，否則多地區建國會 500（numeric overflow）。
    const eraStats = await db.execute<{ production: string }>(sql`
      SELECT FLOOR(productivity::bigint * population::bigint / 10000)::bigint AS production
      FROM map_region_era_stats
      WHERE region_id = ANY(ARRAY[${sql.join(regionIds.map((id) => sql`${id}`), sql`, `)}]::int[]) AND era = ${worldEra}
    `);
    const totalProduction = eraStats.rows.reduce(
      (sum, r) => sum + Number(r.production),
      0,
    );
    if (totalProduction > productionCap) {
      res.status(422).json({
        error: `所選地區生產力合計（${totalProduction.toLocaleString("zh-TW")}）超過上限 ${productionCap.toLocaleString("zh-TW")}，請減少地區或改選生產力較低的地塊`,
      });
      return;
    }
  }

  // 開局資源也依所選地區人口縮放（與之後的動態價格同一把尺，避免開局錢與價格錯位）。
  const foundingPopRows = await db.execute<{ population: string }>(sql`
    SELECT COALESCE(SUM(population::bigint), 0)::bigint AS population
    FROM map_region_era_stats
    WHERE region_id = ANY(ARRAY[${sql.join(regionIds.map((id) => sql`${id}`), sql`, `)}]::int[]) AND era = ${worldEra}
  `);
  const foundingEraScale = scalesFromPopulation(
    Number(foundingPopRows.rows[0]?.population ?? 0),
    worldEra,
  ).price;
  try {
    const nation = await db.transaction(async (tx) => {
      // Serialize concurrent founding attempts — lock all regions in ascending
      // id order (sorted above) to prevent deadlocks.
      for (const rid of regionIds) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${REGION_CLAIM_LOCK_NS}, ${rid})`,
        );
      }
      // 批次查詢是否全部未被佔領
      const claimed = await tx
        .select({ id: regionControlsTable.id, regionId: regionControlsTable.regionId })
        .from(regionControlsTable)
        .where(inArray(regionControlsTable.regionId, regionIds));
      if (claimed.length > 0) {
        throw Object.assign(new Error("region taken"), { code: "REGION_TAKEN" });
      }
      // Task #504 — 同交易內讀取開局資源設定，套用到新國家（取代 schema
      // 預設值的效果）。接手無主國家路徑不經過這裡，沿用該國既有資源。
      const [startingRow] = await tx
        .select({
          startingTechPoints: worldGameStateTable.startingTechPoints,
          startingMoney: worldGameStateTable.startingMoney,
        })
        .from(worldGameStateTable)
        .where(eq(worldGameStateTable.id, 1))
        .limit(1);
      const [created] = await tx
        .insert(playerNationsTable)
        .values({
          discordUserId: userId,
          name: name.value,
          leaderName: leaderName.value,
          government,
          flagUrl: flag.value,
          emblemUrl: emblem.value,
          // 設定值視為「古典基準」，建國時乘時代係數（與稅收同一把尺），
          // 讓晚期開局的新國家起始資金與稅收成比例，不至於一回合就被維護費吃光。
          // techPoints 是 int4：夾在 2^31-1 以內避免管理員高基準 × 晚期係數溢位。
          techPoints: Math.min(
            2_147_483_647,
            scaleByEra(startingRow?.startingTechPoints ?? 200, foundingEraScale),
          ),
          money: Math.min(
            Number.MAX_SAFE_INTEGER,
            scaleByEra(startingRow?.startingMoney ?? 5000, foundingEraScale),
          ),
        })
        .returning();
      // 批次插入所有 region_controls
      await tx.insert(regionControlsTable).values(
        regionIds.map((rid) => ({
          regionId: rid,
          nationId: created!.id,
          percent: 100,
        })),
      );
      // Task #392 — 同交易內記錄建國佔領（0 → 100%）。
      const regionMap = new Map(regions.map((r) => [r.id, r.name]));
      await recordTerritoryChanges(
        tx,
        regionIds.map((rid) => ({
          nationId: created!.id,
          regionId: rid,
          percentBefore: 0,
          percentAfter: 100,
          changeType: "founding" as const,
          reason: `建國佔領：以「${regionMap.get(rid) ?? rid}」為起始地區（100% 掌控）`,
        })),
      );
      await grantJoinEraKeyTechsToPlayer(tx, created!.id, worldEra);
      return created!;
    });

    req.log.info(
      { userId, nationId: nation.id, regionIds, government },
      "nation founded",
    );
    res.status(201).json({ hasNation: true, nation: await buildNationView(nation) });
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code === "REGION_TAKEN") {
      res.status(409).json({ error: "這個地區已被其他國家掌控，請改選其他起始地區" });
      return;
    }
    if (pgErrorCode(err) === "23505") {
      res.status(409).json({ error: "你已經擁有國家，無法再建國" });
      return;
    }
    throw err;
  }
});

/**
 * 更新國家設定（名稱／領導者／各式圖片）。政體建國後鎖定，不可修改。
 * Omitted fields keep their value; null/empty string clears an image.
 */
router.patch("/player/nation", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }
  const body = req.body ?? {};
  if ("government" in body) {
    res.status(400).json({ error: "政體在建國後即固定，無法修改" });
    return;
  }

  const updates: Partial<
    Pick<
      PlayerNation,
      | "name"
      | "leaderName"
      | "flagUrl"
      | "emblemUrl"
      | "kanbanUrl"
      | "backgroundUrl"
      | "advisorStyle"
      | "dmDiplomacyEnabled"
      | "dmPoliticsEnabled"
      | "mapColor"
    >
  > = {};

  if ("name" in body) {
    const v = validateName(body.name, "國名");
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    updates.name = v.value;
  }
  if ("leaderName" in body) {
    const v = validateName(body.leaderName, "領導者名稱");
    if (!v.ok) {
      res.status(400).json({ error: v.error });
      return;
    }
    updates.leaderName = v.value;
  }
  for (const [field, label] of [
    ["flagUrl", "國旗圖片"],
    ["emblemUrl", "國徽圖片"],
    ["kanbanUrl", "看板顧問圖片"],
    ["backgroundUrl", "背景圖片"],
  ] as const) {
    if (field in body) {
      const v = validateImageUrl(body[field], label);
      if (!v.ok) {
        res.status(400).json({ error: v.error });
        return;
      }
      updates[field] = v.value;
    }
  }
  // 玩家自訂地圖顏色：omitted=保留、null/""=清除（地圖退回預設調色盤）。
  // 僅接受 #RRGGBB 十六進位色碼，統一存成小寫。
  if ("mapColor" in body) {
    const raw = body.mapColor;
    if (raw === null || raw === "") {
      updates.mapColor = null;
    } else if (typeof raw !== "string") {
      res.status(400).json({ error: "地圖顏色必須為文字（#RRGGBB 色碼）" });
      return;
    } else {
      const trimmed = raw.trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
        res
          .status(400)
          .json({ error: "地圖顏色格式錯誤，請使用 #RRGGBB 十六進位色碼" });
        return;
      }
      updates.mapColor = trimmed.toLowerCase();
    }
  }
  // Task #303 — 看板顧問說話風格：omitted=保留、null/""=清除。清除後首頁
  // 改用內建題庫；重新設定風格後由 advisor-tips 端點另外產生新tips。
  if ("advisorStyle" in body) {
    const raw = body.advisorStyle;
    if (raw === null || raw === "") {
      updates.advisorStyle = null;
    } else if (typeof raw !== "string") {
      res.status(400).json({ error: "說話風格必須為文字" });
      return;
    } else {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        updates.advisorStyle = null;
      } else if (trimmed.length > ADVISOR_STYLE_MAX) {
        res
          .status(400)
          .json({ error: `說話風格請控制在 ${ADVISOR_STYLE_MAX} 字以內` });
        return;
      } else {
        updates.advisorStyle = trimmed;
      }
    }
  }
  // Discord 私訊通知開關（外交／內政各自獨立）。
  if ("dmDiplomacyEnabled" in body) {
    if (typeof body.dmDiplomacyEnabled !== "boolean") {
      res.status(400).json({ error: "dmDiplomacyEnabled 必須為布林值" });
      return;
    }
    updates.dmDiplomacyEnabled = body.dmDiplomacyEnabled;
  }
  if ("dmPoliticsEnabled" in body) {
    if (typeof body.dmPoliticsEnabled !== "boolean") {
      res.status(400).json({ error: "dmPoliticsEnabled 必須為布林值" });
      return;
    }
    updates.dmPoliticsEnabled = body.dmPoliticsEnabled;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "請至少提供一個要更新的欄位" });
    return;
  }

  const [nation] = await db
    .update(playerNationsTable)
    .set(updates)
    .where(eq(playerNationsTable.discordUserId, session.discordUserId))
    .returning();
  if (!nation) {
    res.status(404).json({ error: "尚未建國" });
    return;
  }
  res.json({ hasNation: true, nation: await buildNationView(nation) });
});

/**
 * Task #303 — 產生看板顧問小tips。
 * 讀取玩家已存的 advisorStyle，用 bulk 模型一次產生 20–30 則符合風格的
 * 遊戲小tips，成功才覆寫 advisor_tips；AI/解析失敗回 502（zh-TW）且保留
 * 原本的tips。套用 aiRateLimit（5/min/IP）。
 */
router.post(
  "/player/nation/advisor-tips",
  aiRateLimit,
  async (req, res) => {
    const session = await requireSession(req);
    if (!session) {
      res.status(401).json({ error: "請先以 Discord 登入" });
      return;
    }
    const [current] = await db
      .select()
      .from(playerNationsTable)
      .where(eq(playerNationsTable.discordUserId, session.discordUserId))
      .limit(1);
    if (!current) {
      res.status(404).json({ error: "尚未建國" });
      return;
    }
    const style = (current.advisorStyle ?? "").trim();
    if (!style) {
      res
        .status(400)
        .json({ error: "請先設定看板顧問的說話風格，再產生小提示" });
      return;
    }

    let tips: string[];
    try {
      tips = await generateAdvisorTips(style);
    } catch (err) {
      if (err instanceof AiQuotaExceededError) {
        // Task #593 — 顧問功能今日 token 配額用罄 → 503。
        res.status(503).json({ error: err.message });
        return;
      }
      req.log.error({ err }, "generateAdvisorTips failed");
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : "顧問小提示產生失敗，請稍後再試（已保留原本的提示）",
      });
      return;
    }

    const [nation] = await db
      .update(playerNationsTable)
      .set({ advisorTips: tips })
      .where(eq(playerNationsTable.discordUserId, session.discordUserId))
      .returning();
    if (!nation) {
      res.status(404).json({ error: "尚未建國" });
      return;
    }
    res.json({ hasNation: true, nation: await buildNationView(nation) });
  },
);

/**
 * 退出國家：the nation becomes 無主 (claimable) and keeps its name, images,
 * government, region controls, region buildings, tech points and money. The
 * player's military (armies / researched techs / purchase quotas / custom
 * unit designs) is disbanded — military rows are keyed to the player and
 * cannot follow an ownerless nation. population_spent resets to 0, but
 * production_spent is set to Σ(surviving region_buildings.production_reserved)
 * so the invariant spent = Σ(army reserved) + Σ(building reserved) holds
 * (Task #565).
 */
router.post("/player/nation/quit", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }
  const userId = session.discordUserId;

  // 先查出國家，並在退出交易「之前」結束進行中的戰役（通知對手、傷兵入池、
  // 地區冷卻）。必須趁玩家仍持有 discord_user_id 時執行，否則稍後傷兵入池的
  // INSERT 會撞上已被 null 化的外鍵。與 DELETE /player/nation 的順序一致。
  const [owned] = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  if (!owned) {
    res.status(404).json({ error: "尚未建國" });
    return;
  }
  try {
    await endCampaignsForNation(owned.id);
  } catch (err) {
    req.log.error(
      { err, nationId: owned.id },
      "failed to end campaigns before quit",
    );
  }

  const nation = await db.transaction(async (tx) => {
    await tx
      .delete(playerArmiesTable)
      .where(eq(playerArmiesTable.discordUserId, userId));
    await tx
      .delete(militaryPurchaseQuotasTable)
      .where(eq(militaryPurchaseQuotasTable.discordUserId, userId));
    await tx
      .delete(militaryUnitTemplatesTable)
      .where(eq(militaryUnitTemplatesTable.ownerDiscordUserId, userId));
    // Task #481 — 科技樹兩表已改鍵到 nation_id（discord_user_id 全 NULL 化），
    // 科技進度跟著國家走：退出後國家成無主，樹狀態保留，不需刪除。
    // Task #149 — 城市建築與人口增長 buff 也以 discord_user_id 外鍵指向
    // player_nations；nulling 前必須先刪，否則外鍵約束會擋下退出（造成 500）。
    await tx
      .delete(cityBuildingsTable)
      .where(eq(cityBuildingsTable.discordUserId, userId));
    await tx
      .delete(nationPopulationBuffsTable)
      .where(eq(nationPopulationBuffsTable.discordUserId, userId));
    // 傷兵國家池與兵種改名（含改名的「預設」兵種——不隨自訂兵種範本刪除連動）
    // 同樣以 discord_user_id 外鍵指向 player_nations；null 化前必須先刪，
    // 否則外鍵約束會擋下退出（造成 500）。
    await tx
      .delete(playerWoundedUnitsTable)
      .where(eq(playerWoundedUnitsTable.discordUserId, userId));
    await tx
      .delete(playerUnitCustomizationsTable)
      .where(eq(playerUnitCustomizationsTable.discordUserId, userId));
    // Task #565 — 生產力佔用不變量：spent = Σ(軍隊 reserved) + Σ(建築 reserved)。
    // 軍隊列已在本交易內刪除（份額歸零），但地區資源建築跟著無主國家保留，
    // 其 production_reserved 份額必須留在 production_spent 裡——直接歸零會讓
    // spent < Σreserved（接手者平白多出可用生產力，直到下次開機 reconcile 才補回）。
    const [updated] = await tx
      .update(playerNationsTable)
      .set({
        discordUserId: null,
        productionSpent: sql`COALESCE((
          SELECT SUM(b.production_reserved) FROM region_buildings b
          WHERE b.nation_id = ${owned.id}
        ), 0)`,
        populationSpent: 0,
      })
      .where(eq(playerNationsTable.discordUserId, userId))
      .returning();
    return updated ?? null;
  });

  if (!nation) {
    res.status(404).json({ error: "尚未建國" });
    return;
  }
  req.log.info({ userId, nationId: nation.id }, "player quit nation");
  res.json({ ok: true });
});

/**
 * 刪除國家：removes the nation row entirely — region controls cascade via
 * nation_id and the player's military rows cascade via the owner FK.
 */
router.delete("/player/nation", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }
  const userId = session.discordUserId;
  const [existing] = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "尚未建國" });
    return;
  }
  // Task #105 — 刪除前先優雅終止進行中的戰役（通知對手、地區冷卻）；
  // 刪除後 war 資料列會隨 FK cascade 消失，屆時無法再處理。
  try {
    await endCampaignsForNation(existing.id);
  } catch (err) {
    req.log.error(
      { err, nationId: existing.id },
      "failed to end campaigns before delete",
    );
  }
  const [deleted] = await db
    .delete(playerNationsTable)
    .where(eq(playerNationsTable.discordUserId, userId))
    .returning({ id: playerNationsTable.id });
  if (!deleted) {
    res.status(404).json({ error: "尚未建國" });
    return;
  }
  req.log.info({ userId, nationId: deleted.id }, "nation deleted");
  res.json({ ok: true });
});

/** 無主國家清單（接手用）：name/images/government + controlled regions. */
router.get("/player/unowned-nations", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }
  const nations = await db
    .select()
    .from(playerNationsTable)
    .where(
      and(
        isNull(playerNationsTable.discordUserId),
        eq(playerNationsTable.isNpc, false),
      ),
    )
    .orderBy(asc(playerNationsTable.createdAt));

  const controls =
    nations.length === 0
      ? []
      : await db
          .select({
            nationId: regionControlsTable.nationId,
            percent: regionControlsTable.percent,
            regionId: mapRegionsTable.id,
            regionName: mapRegionsTable.name,
          })
          .from(regionControlsTable)
          .innerJoin(
            mapRegionsTable,
            eq(mapRegionsTable.id, regionControlsTable.regionId),
          )
          .innerJoin(
            playerNationsTable,
            eq(playerNationsTable.id, regionControlsTable.nationId),
          )
          .where(
            and(
              isNull(playerNationsTable.discordUserId),
              eq(playerNationsTable.isNpc, false),
            ),
          );

  const regionsByNation = new Map<
    string,
    { id: number; name: string; percent: number }[]
  >();
  for (const c of controls) {
    const list = regionsByNation.get(c.nationId) ?? [];
    list.push({ id: c.regionId, name: c.regionName, percent: c.percent });
    regionsByNation.set(c.nationId, list);
  }

  res.json({
    nations: nations.map((n) => ({
      id: n.id,
      name: n.name,
      leaderName: n.leaderName,
      government: n.government,
      flagUrl: n.flagUrl,
      emblemUrl: n.emblemUrl,
      regions: regionsByNation.get(n.id) ?? [],
    })),
  });
});

/**
 * 接手無主國家 — race-safe: a single conditional UPDATE claims the nation
 * only while it is still ownerless AND the player owns no other nation.
 */
router.post("/player/unowned-nations/:id/claim", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }
  const userId = session.discordUserId;
  const nationId = String(req.params.id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(nationId)) {
    res.status(400).json({ error: "無效的國家編號" });
    return;
  }

  // 依加入當下的世界時代自動補齊前代關鍵科技（見 grantJoinEraKeyTechsToPlayer）。
  const { currentEra: worldEra } = await getEraSlugs();

  try {
    const claimed = await db.transaction(async (tx) => {
      const [c] = await tx
        .update(playerNationsTable)
        .set({ discordUserId: userId })
        .where(
          and(
            eq(playerNationsTable.id, nationId),
            isNull(playerNationsTable.discordUserId),
            eq(playerNationsTable.isNpc, false),
            sql`NOT EXISTS (SELECT 1 FROM player_nations own WHERE own.discord_user_id = ${userId})`,
          ),
        )
        .returning();
      if (!c) return null;
      await grantJoinEraKeyTechsToPlayer(tx, c.id, worldEra);
      return c;
    });

    if (!claimed) {
      const existing = await loadOwnedNation(userId);
      if (existing) {
        res.status(409).json({ error: "你已經擁有國家，無法接手其他國家" });
        return;
      }
      const [target] = await db
        .select({ id: playerNationsTable.id })
        .from(playerNationsTable)
        .where(eq(playerNationsTable.id, nationId))
        .limit(1);
      if (!target) {
        res.status(404).json({ error: "找不到這個國家" });
        return;
      }
      res.status(409).json({ error: "這個國家剛被其他玩家接手了" });
      return;
    }

    req.log.info({ userId, nationId }, "nation claimed");
    res.json({ hasNation: true, nation: await buildNationView(claimed) });
  } catch (err) {
    if (pgErrorCode(err) === "23505") {
      res.status(409).json({ error: "你已經擁有國家，無法接手其他國家" });
      return;
    }
    throw err;
  }
});

/**
 * Task #79 — 站內通知（鈴鐺通知中心）。以 Discord user id 為鍵，
 * 不需要擁有國家也能讀（退出國家後歷史通知仍在）。
 */
router.get("/player/notifications", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }
  const rawLimit = Number(req.query["limit"] ?? 30);
  const limit =
    Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100
      ? rawLimit
      : 30;
  const { notifications, unreadCount } = await listPlayerNotifications(
    session.discordUserId,
    limit,
  );
  res.json({
    unreadCount,
    notifications: notifications.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      linkPath: n.linkPath,
      createdAt: n.createdAt.toISOString(),
      read: n.readAt !== null,
    })),
  });
});

/** 標為已讀：ids 省略或空陣列 = 全部；帶 ids = 只標指定通知。 */
router.post("/player/notifications/read", async (req, res) => {
  const session = await requireSession(req);
  if (!session) {
    res.status(401).json({ error: "請先以 Discord 登入" });
    return;
  }
  const body = req.body ?? {};
  let ids: string[] | undefined;
  if ("ids" in body && body.ids !== null && body.ids !== undefined) {
    if (
      !Array.isArray(body.ids) ||
      body.ids.some((v: unknown) => typeof v !== "string") ||
      body.ids.length > 200
    ) {
      res.status(400).json({ error: "ids 必須是字串陣列（最多 200 筆）" });
      return;
    }
    ids = body.ids as string[];
  }
  const { unreadCount } = await markPlayerNotificationsRead(
    session.discordUserId,
    ids,
  );
  res.json({ ok: true, unreadCount });
});

export default router;
