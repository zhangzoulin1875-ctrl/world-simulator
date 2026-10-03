/**
 * Task #437 — 地區列表與財政分頁人口在「真實資料庫」下完全對帳的整合測試。
 *
 * Task #430 已用最大餘數法（lib/regionTax.ts 純函式）讓
 * GET /api/economy/regions 的各地區顯示人口 Σ = computeNationStats 的全國
 * 人口、各地區稅收 Σ = 全國稅收，並有純函式單元測試。這裡補一條走真 DB、
 * 直接打路由的端到端驗證，防止日後有人在路由層改回各地區獨立 rounding：
 *
 *  情境：建國（真人玩家，Discord session 登入）＋ 多筆 region_controls 混合
 *   - 部分掌控（60% / 35% / 100%）
 *   - 一個地區缺「數據時代」的 era stats（left join 邊界；權重只剩累積成長量）
 *   - 一個地區帶負的累積人口成長量（population_bonus < 0）
 *
 *  斷言：
 *   1. /api/economy/regions 的 Σ 地區 population = economy.totalPopulation，
 *      且 Σ 地區 taxContribution = economy.taxIncomePerTurn（同回應內對帳）。
 *   2. /api/economy/overview 的 totalPopulation / taxIncomePerTurn 與
 *      /api/economy/regions 完全一致（兩頁跨端點對帳）。
 *
 * 測試資料自成一體：專屬測試國家（名稱前綴，cascade 清 controls）、只借用
 * 無人掌控的 map_regions（offset 210，避開其他整合測試 0/80/120/150/160/170/
 * 190/200）。「缺時代數據」用 snapshot → 刪除 → after 還原該 era stat 列模擬
 * （啟動種子亦會 idempotent 補回）。跑法：test-integration workflow。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the economy-regions reconcile tests",
  );
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, isNull, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  mapRegionEraStatsTable,
  userSessionsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runPoliticsMigrations } = await import("./politicsMigrations");
const { runEconomyMigrations } = await import("./economyMigrations");
const { runMilitaryMigrations } = await import("./militaryMigrations");
const { runSocialTechMigrations } = await import("./socialTechMigrations");
const { runProductionMigrations } = await import("./productionMigrations");
const { runWallMigrations } = await import("./wallMigrations");
const { createSession, SESSION_COOKIE_NAME } = await import("./sessions");
const { getEraSlugs } = await import("./nationStats");
const economyRouter = (await import("../routes/economy")).default;

const TEST_TAG = "__ecorec437__";
const runId = randomBytes(4).toString("hex");
const discordUserId = `${TEST_TAG}${runId}`;

let server: http.Server;
let baseUrl: string;
let sessionToken: string;
let nationId: string;
let regionIds: number[] = [];
/** 被暫時刪掉 era stat 的地區與其原始列（after 還原）。 */
let removedEraStat: {
  regionId: number;
  era: string;
  population: number;
  productivity: number;
  techPoints: number;
} | null = null;

async function cleanupTestRows() {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
  await db
    .delete(userSessionsTable)
    .where(sql`${userSessionsTable.discordUserId} LIKE ${TEST_TAG + "%"}`);
}

async function getJson(path: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await runEconomyMigrations();
  await runMilitaryMigrations();
  await runSocialTechMigrations();
  await runProductionMigrations();
  await runWallMigrations();

  await cleanupTestRows();

  // 借用無人掌控的地區；offset 210 避開其他整合測試。
  const rows = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(210)
    .limit(4);
  regionIds = rows.map((r) => r.id);
  assert.ok(regionIds.length >= 4, "測試需要至少 4 個無人掌控的地區");

  // 建國（真人玩家）＋ session。
  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}nation-${runId}`,
      leaderName: TEST_TAG,
      discordUserId,
      money: 0,
      techPoints: 0,
      taxRatePct: 7,
      isNpc: false,
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

  // 混合掌控情境：
  //  region[0] 60% 掌控 + 正累積成長量
  //  region[1] 35% 掌控 + 負累積成長量
  //  region[2] 100% 掌控、無累積量
  //  region[3] 100% 掌控，但「數據時代」era stat 被移除（缺時代數據）
  const controls = [
    { regionId: regionIds[0]!, percent: 60, populationBonus: 12_345 },
    { regionId: regionIds[1]!, percent: 35, populationBonus: -9_876 },
    { regionId: regionIds[2]!, percent: 100, populationBonus: 0 },
    { regionId: regionIds[3]!, percent: 100, populationBonus: 4_321 },
  ];
  await db.insert(regionControlsTable).values(
    controls.map((c) => ({ nationId, ...c })),
  );

  // 模擬缺時代數據：snapshot → 刪掉 region[3] 的 statsEra 列（after 還原）。
  const { statsEra } = await getEraSlugs();
  const [statRow] = await db
    .select({
      population: mapRegionEraStatsTable.population,
      productivity: mapRegionEraStatsTable.productivity,
      techPoints: mapRegionEraStatsTable.techPoints,
    })
    .from(mapRegionEraStatsTable)
    .where(
      and(
        eq(mapRegionEraStatsTable.regionId, regionIds[3]!),
        eq(mapRegionEraStatsTable.era, statsEra),
      ),
    )
    .limit(1);
  assert.ok(statRow, "expected era stat row to snapshot");
  removedEraStat = { regionId: regionIds[3]!, era: statsEra, ...statRow };
  await db
    .delete(mapRegionEraStatsTable)
    .where(
      and(
        eq(mapRegionEraStatsTable.regionId, regionIds[3]!),
        eq(mapRegionEraStatsTable.era, statsEra),
      ),
    );

  // 測試用 app：cookie-parser（readSessionToken 需 req.cookies）＋ req.log shim。
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
    // 還原被暫時刪掉的 era stat 列（idempotent；啟動種子也會補回）。
    if (removedEraStat) {
      await db
        .insert(mapRegionEraStatsTable)
        .values(removedEraStat)
        .onConflictDoNothing();
    }
    await cleanupTestRows();
  } finally {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
});

test("GET /api/economy/regions：Σ 地區人口 = 全國人口、Σ 地區稅收 = 全國稅收（含缺時代數據與負累積量）", async () => {
  const { status, body } = await getJson("/api/economy/regions");
  assert.equal(status, 200);

  const economy = body["economy"] as {
    totalPopulation: number;
    taxIncomePerTurn: number;
  };
  const regions = body["regions"] as {
    regionId: number;
    population: number;
    taxContribution: number;
  }[];
  assert.equal(regions.length, 4, "應回傳全部 4 筆掌控地區");

  // 缺時代數據的地區必須仍在列表中（left join 邊界不能整列消失）。
  const missing = regions.find((r) => r.regionId === regionIds[3]);
  assert.ok(missing, "缺 era stats 的地區不得從列表消失");

  const popSum = regions.reduce((s, r) => s + r.population, 0);
  const taxSum = regions.reduce((s, r) => s + r.taxContribution, 0);
  assert.equal(
    popSum,
    economy.totalPopulation,
    "Σ 地區顯示人口必須等於全國人口",
  );
  assert.equal(
    taxSum,
    economy.taxIncomePerTurn,
    "Σ 地區稅收貢獻必須等於全國稅收",
  );

  // 每筆地區數字都必須是非負整數（顯示層不可出現小數/負值）。
  for (const r of regions) {
    assert.ok(Number.isInteger(r.population) && r.population >= 0);
    assert.ok(Number.isInteger(r.taxContribution) && r.taxContribution >= 0);
  }

  // 全國人口 > 0（混合情境不是退化的全 0 分配）。
  assert.ok(economy.totalPopulation > 0, "測試情境的全國人口應為正");
});

test("GET /api/economy/overview 與 /api/economy/regions 的全國人口與稅收完全一致", async () => {
  const [{ status: sR, body: regionsBody }, { status: sO, body: overview }] =
    await Promise.all([
      getJson("/api/economy/regions"),
      getJson("/api/economy/overview"),
    ]);
  assert.equal(sR, 200);
  assert.equal(sO, 200);

  const economy = (regionsBody["economy"] ?? {}) as {
    totalPopulation: number;
    taxIncomePerTurn: number;
  };
  assert.equal(
    overview["totalPopulation"],
    economy.totalPopulation,
    "兩端點全國人口必須一致",
  );
  assert.equal(
    overview["taxIncomePerTurn"],
    economy.taxIncomePerTurn,
    "兩端點全國稅收必須一致",
  );

  // 再對帳一次：財政總覽的全國數字 = 地區列表逐列加總。
  const regions = regionsBody["regions"] as {
    population: number;
    taxContribution: number;
  }[];
  assert.equal(
    regions.reduce((s, r) => s + r.population, 0),
    overview["totalPopulation"],
  );
  assert.equal(
    regions.reduce((s, r) => s + r.taxContribution, 0),
    overview["taxIncomePerTurn"],
  );
});
