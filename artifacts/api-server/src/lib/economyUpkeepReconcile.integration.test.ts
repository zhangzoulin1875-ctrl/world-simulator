/**
 * Task #446 — 財政分頁維護費明細與回合實際扣款「在真實資料庫」下對帳的
 * 整合測試。
 *
 * /api/economy/overview 顯示 upkeepPerTurn（無條件進位後的實際扣款）與
 * netSurplusPerTurn；回合引擎則用 computeTurnFinance 扣款。若日後兩邊的
 * 維護費組成（軍隊 ＋ 建築 ＋ 地區資源建築）或 rounding 規則分岔，玩家看到
 * 的預估就會與實際扣款不符。本測試建立含「小數維護費軍隊 × 2 兵種 ＋ 地區
 * 資源建築」的國家，然後：
 *
 *  1. 用「回合引擎同款查詢」組出該國 upkeep（軍隊 SUM(數量×每單位) ＋
 *     loadBuildingUpkeepByUser ＋ 地區資源建築 buildingUpkeep(Σ level)），
 *     丟進 computeTurnFinance 取得引擎會實際扣的 upkeepCharged。
 *  2. 斷言 overview.upkeepPerTurn === upkeepCharged、
 *     overview.netSurplusPerTurn === overview.taxIncomePerTurn − upkeepCharged
 *     === computeTurnFinance(...).surplus（同輸入）。
 *  3. 明細各組成（military/building/regionBuilding round1）與合計進位關係。
 *
 * 資料以名稱前綴標記、self-cleaning；只借用無人掌控的 map_regions
 * （offset 230，避開其他整合測試）。跑法：test-integration workflow。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the economy-upkeep reconcile tests",
  );
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq, isNull, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  militaryUnitTemplatesTable,
  playerArmiesTable,
  regionBuildingsTable,
  userSessionsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runPoliticsMigrations } = await import("./politicsMigrations");
const { runEconomyMigrations } = await import("./economyMigrations");
const { runMilitaryMigrations } = await import("./militaryMigrations");
const { runSocialTechMigrations } = await import("./socialTechMigrations");
const { runProductionMigrations } = await import("./productionMigrations");
const { runResourceMigrations } = await import("./resourceMigrations");
const { runWallMigrations } = await import("./wallMigrations");
const { createSession, SESSION_COOKIE_NAME } = await import("./sessions");
const {
  computeTurnFinance,
  effectiveTaxEfficiencyPct,
} = await import("./economy");
const { aggregateSocialEffectsForUser } = await import("./socialTechData");
const { loadBuildingUpkeepByUser } = await import("./productionTechData");
const { buildingUpkeep } = await import("./regionBuildings");
const { getEraSlugs } = await import("./nationStats");
const { eraCostScale } = await import("./eraCostScale");
const economyRouter = (await import("../routes/economy")).default;

const TEST_TAG = "__upkrec446__";
const runId = randomBytes(4).toString("hex");
const discordUserId = `${TEST_TAG}${runId}`;

let server: http.Server;
let baseUrl: string;
let sessionToken: string;
let nationId: string;
let templateIds: number[] = [];

async function cleanupTestRows() {
  // player_nations cascade 清 region_controls / region_buildings /
  // player_armies（經 discord_user_id FK）；模板另清（owner cascade 亦可，
  // 但明確刪除保險）。
  if (templateIds.length > 0) {
    for (const id of templateIds) {
      await db
        .delete(militaryUnitTemplatesTable)
        .where(eq(militaryUnitTemplatesTable.id, id));
    }
  }
  await db
    .delete(militaryUnitTemplatesTable)
    .where(
      sql`${militaryUnitTemplatesTable.name} LIKE ${TEST_TAG + "%"}`,
    );
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
  await db
    .delete(userSessionsTable)
    .where(sql`${userSessionsTable.discordUserId} LIKE ${TEST_TAG + "%"}`);
}

async function getOverview(): Promise<{
  status: number;
  body: Record<string, number>;
}> {
  const res = await fetch(`${baseUrl}/api/economy/overview`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  });
  const body = (await res.json()) as Record<string, number>;
  return { status: res.status, body };
}

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await runEconomyMigrations();
  await runMilitaryMigrations();
  await runSocialTechMigrations();
  await runProductionMigrations();
  await runResourceMigrations();
  await runWallMigrations();

  await cleanupTestRows();

  // 借用無人掌控的地區；offset 230 避開其他整合測試。
  const rows = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(230)
    .limit(2);
  const regionIds = rows.map((r) => r.id);
  assert.ok(regionIds.length >= 2, "測試需要至少 2 個無人掌控的地區");

  // 建國（真人玩家）＋ session。
  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}nation-${runId}`,
      leaderName: TEST_TAG,
      discordUserId,
      money: 100_000,
      techPoints: 0,
      taxRatePct: 7,
      isNpc: false,
      // 生產力維護費對帳需要可用生產力 > 想扣量（未封頂路徑）；無人邊陲
      // 地區計算生產力趨近 0，故直接種 production_bonus。
      productionBonus: 100_000,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(nation, "test nation insert failed");
  nationId = nation.id;

  sessionToken = await createSession({
    discordUserId,
    username: TEST_TAG,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });

  await db.insert(regionControlsTable).values([
    { nationId, regionId: regionIds[0]!, percent: 80, populationBonus: 0 },
    { nationId, regionId: regionIds[1]!, percent: 100, populationBonus: 0 },
  ]);

  // 兩個小數維護費兵種（基準合計 0.37×37 + 1.73×13 = 13.69 + 22.49 = 36.18，
  // 再乘時代係數 → 進位邊界）。
  const inserted = await db
    .insert(militaryUnitTemplatesTable)
    .values([
      {
        ownerDiscordUserId: discordUserId,
        category: "infantry",
        name: `${TEST_TAG}inf-${runId}`,
        hp: 10,
        attack: 5,
        defense: 5,
        speed: 1,
        accuracy: 50,
        range: "melee",
        prodCostPer100: 1,
        popCostPerUnit: 1,
        moneyCostPerUnit: 10,
        upkeepPerUnit: 0.37,
        prodUpkeepPerUnit: 0.25,
      },
      {
        ownerDiscordUserId: discordUserId,
        category: "ranged",
        name: `${TEST_TAG}rng-${runId}`,
        hp: 8,
        attack: 6,
        defense: 3,
        speed: 1,
        accuracy: 60,
        range: "ranged",
        prodCostPer100: 1,
        popCostPerUnit: 1,
        moneyCostPerUnit: 12,
        upkeepPerUnit: 1.73,
        prodUpkeepPerUnit: 0.9,
      },
    ])
    .returning({ id: militaryUnitTemplatesTable.id });
  templateIds = inserted.map((r) => r.id);
  assert.equal(templateIds.length, 2);

  await db.insert(playerArmiesTable).values([
    { discordUserId, templateId: templateIds[0]!, quantity: 37 },
    { discordUserId, templateId: templateIds[1]!, quantity: 13 },
  ]);

  // 地區資源建築：木材廠 lv3 ＋ 礦場 lv2（維護 100×5 = 500）。
  await db.insert(regionBuildingsTable).values([
    {
      nationId,
      regionId: regionIds[0]!,
      buildingType: "lumber_mill",
      level: 3,
    },
    { nationId, regionId: regionIds[1]!, buildingType: "mine", level: 2 },
  ]);

  // 測試用 app：cookie-parser ＋ req.log shim。
  const app = express();
  app.use(cookieParser());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
    next();
  });
  app.use(express.json());
  app.use("/api", economyRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  try {
    await cleanupTestRows();
  } finally {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});

/**
 * 用「回合引擎同款查詢」組出該國本回合會被扣的維護費（見 turnEngine：
 * 軍隊 Σ(數量×每單位) ＋ loadBuildingUpkeepByUser ＋ 地區資源建築
 * buildingUpkeep(Σ level)），未進位的原始合計。
 */
async function composeTurnEngineUpkeep(): Promise<number> {
  // 時代開銷縮放：回合引擎與財政頁都用 statsEra 的係數（與稅收同一把尺）。
  const costScale = eraCostScale((await getEraSlugs()).statsEra);
  const [armyRow] = await db
    .select({
      upkeep: sql<string>`COALESCE(SUM(${playerArmiesTable.quantity} * ${militaryUnitTemplatesTable.upkeepPerUnit}), 0)`,
    })
    .from(playerArmiesTable)
    .innerJoin(
      militaryUnitTemplatesTable,
      eq(militaryUnitTemplatesTable.id, playerArmiesTable.templateId),
    )
    .where(eq(playerArmiesTable.discordUserId, discordUserId));
  const militaryUpkeep = Number(armyRow?.upkeep ?? 0) * costScale;

  const buildingUpkeepByUser = await loadBuildingUpkeepByUser(costScale);
  const cityBuildingUpkeep = buildingUpkeepByUser.get(discordUserId) ?? 0;

  // 回合引擎按 buildingType 分組 SUM(level) 再 buildingUpkeep；維護費線性，
  // 等同 buildingUpkeep(Σ level)，但這裡照引擎逐 type 組合以鎖住組成。
  const rbRows = await db
    .select({
      buildingType: regionBuildingsTable.buildingType,
      totalLevel: sql<string>`COALESCE(SUM(${regionBuildingsTable.level}), 0)`,
    })
    .from(regionBuildingsTable)
    .where(eq(regionBuildingsTable.nationId, nationId))
    .groupBy(regionBuildingsTable.buildingType);
  const regionBuildingUpkeep = rbRows.reduce(
    (s, r) => s + buildingUpkeep(Number(r.totalLevel), costScale),
    0,
  );

  return militaryUpkeep + cityBuildingUpkeep + regionBuildingUpkeep;
}

test("overview.upkeepPerTurn = 回合引擎 computeTurnFinance 同輸入的 upkeepCharged", async () => {
  // 共用開發 DB：其他整合測試（如 famineTurn）可能在本測試取 overview 與
  // 重算之間強制跑回合、暫時推進世界時代（world_game_state），使兩邊讀到
  // 不同 stats_era → taxEfficiencyPct 假性不一致。偵測到時代中途變動時
  // 重取一次（上限 3 次）；真正的組成分岔不受時代影響，仍會穩定失敗。
  let status = 0;
  let body: Record<string, number> = {};
  let upkeep = 0;
  let taxEfficiencyPct = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const eraBefore = (await getEraSlugs()).statsEra;
    ({ status, body } = await getOverview());
    assert.equal(status, 200);

    upkeep = await composeTurnEngineUpkeep();

    // 回合引擎的稅收效率組成（時代基礎 + 國家加成 + 社會科技加成）。
    const { statsEra } = await getEraSlugs();
    const social = await aggregateSocialEffectsForUser(discordUserId);
    taxEfficiencyPct = effectiveTaxEfficiencyPct(
      statsEra,
      0 + social.taxEfficiencyBonusPct,
    );
    if (body["taxEfficiencyPct"] === taxEfficiencyPct) break;
    // 時代整段沒變仍不一致 → 真的組成分岔，直接讓下方斷言失敗。
    if (eraBefore === statsEra) break;
  }

  // 測試情境確為小數合計（0.37×37 + 1.73×13 = 36.18 再乘時代係數 + 建築），確保
  // 進位規則真的被驗到。
  assert.ok(!Number.isInteger(upkeep), "測試維護費合計應為小數（驗進位）");

  assert.equal(
    body["taxEfficiencyPct"],
    taxEfficiencyPct,
    "overview 稅收效率必須與回合引擎同組成",
  );

  const finance = computeTurnFinance({
    money: 100_000,
    population: body["totalPopulation"]!,
    taxRatePct: 7,
    taxEfficiencyPct,
    upkeep,
  });

  assert.equal(
    body["upkeepPerTurn"],
    finance.upkeepCharged,
    "財政分頁顯示的 upkeepPerTurn 必須等於回合引擎實際扣款",
  );
  assert.equal(
    body["taxIncomePerTurn"],
    finance.taxIncome,
    "財政分頁預估稅收必須等於回合引擎稅收",
  );
  assert.equal(
    body["netSurplusPerTurn"],
    finance.surplus,
    "財政分頁淨結餘必須等於回合引擎盈餘（稅收 − 進位後維護費）",
  );
});

// Task #568 — 生產力維護費機制已移除：overview 不再有 prodUpkeep* 欄位，
// availableProduction = 總生產力 − 已佔用 − 本回合招募花費（本測試無花費）。
test("overview 已無 prodUpkeep 欄位且 availableProduction 走新口徑", async () => {
  const { status, body } = await getOverview();
  assert.equal(status, 200);

  assert.equal(body["prodUpkeepPerTurn"], undefined);
  assert.equal(body["prodUpkeepChargedPerTurn"], undefined);
  assert.equal(body["prodUpkeepLines"], undefined);

  // 本測試 productionSpent = 0、無招募花費 → availableProduction = 總生產力。
  const available = body["availableProduction"]!;
  assert.ok(available > 0, "availableProduction 應為正");
});

test("overview 維護費明細組成完整且與合計進位一致", async () => {
  const { status, body } = await getOverview();
  assert.equal(status, 200);

  const military = body["militaryUpkeepPerTurn"]!;
  const building = body["buildingUpkeepPerTurn"]!;
  const regionBuilding = body["regionBuildingUpkeepPerTurn"]!;

  // 明細數值（round1 顯示）：基準值 × 當前 statsEra 的時代係數。
  //   軍隊 36.18 × 係數、建築 0、地區資源建築 100/級 × 5 級 × 係數。
  // 這同時驗證縮放「真的生效」（晚期時代 ≫ 古典基準），而不只是兩邊互相一致。
  const scale = eraCostScale((await getEraSlugs()).statsEra);
  assert.equal(military, Math.round(36.18 * scale * 10) / 10);
  assert.equal(building, 0);
  assert.equal(regionBuilding, Math.round(500 * scale * 10) / 10);

  // 實扣 = ⌈Σ 組成⌉；netSurplus = 稅收 − 實扣。
  assert.equal(
    body["upkeepPerTurn"],
    Math.ceil(military + building + regionBuilding),
  );
  assert.equal(
    body["netSurplusPerTurn"],
    body["taxIncomePerTurn"]! - body["upkeepPerTurn"]!,
  );
});
