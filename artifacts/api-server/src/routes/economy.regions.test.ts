/**
 * 地區建築槽端點（GET /api/economy/regions）整合測試。
 *
 * 純函式 cityBuildingSlots / BUILDING_SLOTS_MAX 已有單元測試；本測試補上線上
 * 端點的整合覆蓋，鎖住兩類不變量：
 *
 *  1. 每城建築槽數：把玩家已解鎖的社會關鍵技術（aggregateSocialEffectsForUser）
 *     換算成每城槽數，覆蓋各種組合——
 *       - 未解鎖「部落革新」（僅研發帶 buildingSlots 效果但不啟用系統的科技）→ 0 槽、停用
 *       - 僅部落革新 → 5 槽、啟用
 *       - 疊加大學制度 → 10、再疊行會革新 → 20、再疊三權分立 → 30
 *       - 超過硬上限（部落革新 + 一張 +50 槽的科技）→ 夾在 BUILDING_SLOTS_MAX（30）
 *  2. 只回傳玩家實際掌控的地區與其城市清單，不外洩他人的地區、城市或私有欄位。
 *
 * 走真正的 Express 端點（掛 session cookie）。需要 DATABASE_URL 指向已由正常
 * 伺服器啟動遷移過的資料庫。所有資料以 `__ecoregtest__` / `ecoregtest-` 前綴
 * 標記，跑前跑後自清，可重複執行：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the economy regions tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, inArray, like, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerResearchedTreeNodesTable,
  techTreeNodesTable,
  regionControlsTable,
  mapCitiesTable,
} = await import("@workspace/db");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runMapCitySync } = await import("../lib/mapCities");
const { runSocialTechMigrations } = await import("../lib/socialTechMigrations");
const { runProductionMigrations } = await import("../lib/productionMigrations");
const { runTechTreeMigrations } = await import("../lib/techTreeMigrations");
const { runWallMigrations } = await import("../lib/wallMigrations");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { BUILDING_SLOTS_MAX } = await import("../lib/socialTech");
const economyRouter = (await import("./economy")).default;

const NATION_MARKER = "__ecoregtest__";
const USER_MARKER = "ecoregtest-";
const TECH_MARKER = "__ecoregtest__slot-";
const START_POINTS = 500_000_000;

const runId = randomBytes(4).toString("hex");

let server: http.Server;
let baseUrl: string;
let ownerUserId: string;
let otherUserId: string;
let ownerNationId: string;
let sessionToken: string;

/** 玩家掌控地區（regionId → percent）。 */
let ownedRegions: { regionId: number; percent: number }[] = [];
/** 他人掌控且玩家未掌控的地區 id（洩漏測試用）。 */
let otherRegionId = 0;
/** 各關鍵技術與自種超額科技的 tech id。 */
let keyTechIds: Record<string, number> = {};
let overCapTechId = 0;

async function cleanup() {
  // region_controls／researched（Task #481 改鍵 nation_id）皆 CASCADE 於
  // nation.id；city_buildings CASCADE 於 nation.discord_user_id。
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${NATION_MARKER + "%"}`);
  await db
    .delete(techTreeNodesTable)
    .where(like(techTreeNodesTable.name, `${TECH_MARKER}%`));
}

async function clearResearched(nationId: string) {
  await db
    .delete(playerResearchedTreeNodesTable)
    .where(eq(playerResearchedTreeNodesTable.nationId, nationId));
}

/** 直接把某社會科技樹節點記為該國已研發（繞過研發端點）。 */
async function research(nationId: string, techId: number) {
  await db
    .insert(playerResearchedTreeNodesTable)
    .values({ nationId, nodeId: techId })
    .onConflictDoNothing();
}

async function fetchRegions(): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/economy/regions`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  });
  return { status: res.status, json: await res.json() };
}

async function keyTechId(keySlug: string): Promise<number> {
  const [row] = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.keySlug, keySlug))
    .limit(1);
  assert.ok(row, `seeded key tech ${keySlug} not found`);
  return row.id;
}

before(async () => {
  await runMapRegionSync();
  await runMapCitySync();
  await runSocialTechMigrations();
  await runProductionMigrations();
  await runTechTreeMigrations();
  await runWallMigrations();
  await cleanup();

  ownerUserId = `${USER_MARKER}owner-${runId}`;
  otherUserId = `${USER_MARKER}other-${runId}`;

  const [ownerNation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}A-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: ownerUserId,
      techPoints: START_POINTS,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(ownerNation, "owner nation insert failed");
  ownerNationId = ownerNation.id;

  const [otherNation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}B-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: otherUserId,
      techPoints: START_POINTS,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(otherNation, "other nation insert failed");

  // 取三個「有城市」的地區：兩個給玩家、一個給他人（洩漏測試）。
  const cityRegions = await db
    .select({ regionId: mapCitiesTable.regionId })
    .from(mapCitiesTable)
    .groupBy(mapCitiesTable.regionId)
    .orderBy(mapCitiesTable.regionId)
    .limit(3);
  assert.ok(cityRegions.length >= 3, "需要至少三個含城市的地區來跑此測試");
  ownedRegions = [
    { regionId: cityRegions[0]!.regionId, percent: 100 },
    { regionId: cityRegions[1]!.regionId, percent: 40 },
  ];
  otherRegionId = cityRegions[2]!.regionId;

  await db.insert(regionControlsTable).values([
    { regionId: ownedRegions[0]!.regionId, nationId: ownerNationId, percent: ownedRegions[0]!.percent },
    { regionId: ownedRegions[1]!.regionId, nationId: ownerNationId, percent: ownedRegions[1]!.percent },
    { regionId: otherRegionId, nationId: otherNation.id, percent: 100 },
  ]);

  keyTechIds = {
    tribal: await keyTechId("tribal_innovation"),
    university: await keyTechId("university_system"),
    guild: await keyTechId("guild_innovation"),
    separation: await keyTechId("separation_of_powers"),
  };

  // 自種一個「+50 建築槽」的測試專用支線節點，用來製造超過硬上限的情境。
  const [overCap] = await db
    .insert(techTreeNodesTable)
    .values({
      domain: "social",
      eraSlug: "roman",
      lineKey: `${TECH_MARKER}line-${runId}`,
      lineLabel: `${TECH_MARKER}測試線`,
      lineKind: "branch",
      sortOrder: 1,
      keySlug: null,
      name: `${TECH_MARKER}${runId}`,
      description: "測試用：超額建築槽",
      baseCost: 100,
      effects: [{ target: "buildingSlots", value: 50 }],
    })
    .returning({ id: techTreeNodesTable.id });
  assert.ok(overCap, "over-cap tech seed failed");
  overCapTechId = overCap.id;

  sessionToken = await createSession({
    discordUserId: ownerUserId,
    username: ownerUserId,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info() {},
      warn() {},
      error() {},
    };
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", economyRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

test("未解鎖部落革新：即使有 buildingSlots 效果，仍為 0 槽且停用", async () => {
  await clearResearched(ownerNationId);
  // 大學制度帶 +5 buildingSlots，但不啟用系統（無 enableBuildingSlots）。
  await research(ownerNationId, keyTechIds["university"]!);

  const { status, json } = await fetchRegions();
  assert.equal(status, 200, `應成功：${JSON.stringify(json)}`);
  assert.equal(json.buildingSlotsEnabled, false, "未研發部落革新應停用建築槽");
  assert.equal(json.buildingSlotsPerCity, 0, "停用時每城槽數應為 0");
  assert.equal(json.buildingSlotsMax, BUILDING_SLOTS_MAX, "硬上限應回報常數值");
});

test("僅部落革新：啟用且每城 5 槽", async () => {
  await clearResearched(ownerNationId);
  await research(ownerNationId, keyTechIds["tribal"]!);

  const { status, json } = await fetchRegions();
  assert.equal(status, 200, `應成功：${JSON.stringify(json)}`);
  assert.equal(json.buildingSlotsEnabled, true, "研發部落革新應啟用建築槽");
  assert.equal(json.buildingSlotsPerCity, 5, "僅部落革新應為 5 槽");
});

test("疊加大學制度／行會革新／三權分立：對應槽數 10 / 20 / 30", async () => {
  await clearResearched(ownerNationId);
  await research(ownerNationId, keyTechIds["tribal"]!);
  await research(ownerNationId, keyTechIds["university"]!);
  {
    const { json } = await fetchRegions();
    assert.equal(json.buildingSlotsPerCity, 10, "部落＋大學應為 10 槽");
  }

  await research(ownerNationId, keyTechIds["guild"]!);
  {
    const { json } = await fetchRegions();
    assert.equal(json.buildingSlotsPerCity, 20, "再疊行會革新應為 20 槽");
  }

  await research(ownerNationId, keyTechIds["separation"]!);
  {
    const { json } = await fetchRegions();
    assert.equal(json.buildingSlotsPerCity, 30, "四項全研發應為 30 槽");
    assert.equal(json.buildingSlotsEnabled, true, "應維持啟用");
  }
});

test("超過硬上限：夾在 BUILDING_SLOTS_MAX（30）", async () => {
  await clearResearched(ownerNationId);
  await research(ownerNationId, keyTechIds["tribal"]!); // 啟用 + 5
  await research(ownerNationId, overCapTechId); // +50 → 合計 55

  const { status, json } = await fetchRegions();
  assert.equal(status, 200, `應成功：${JSON.stringify(json)}`);
  assert.equal(json.buildingSlotsEnabled, true, "應啟用");
  assert.equal(
    json.buildingSlotsPerCity,
    BUILDING_SLOTS_MAX,
    "超過硬上限應夾在 30",
  );
});

test("只回傳玩家掌控地區與其城市，不外洩他人地區或私有欄位", async () => {
  await clearResearched(ownerNationId);
  await research(ownerNationId, keyTechIds["tribal"]!);

  const { status, json } = await fetchRegions();
  assert.equal(status, 200, `應成功：${JSON.stringify(json)}`);
  assert.ok(Array.isArray(json.regions), "應回傳 regions 陣列");

  const returnedIds = json.regions.map((r: any) => r.regionId).sort((a: number, b: number) => a - b);
  const expectedIds = ownedRegions.map((r) => r.regionId).sort((a, b) => a - b);
  assert.deepEqual(returnedIds, expectedIds, "應只含玩家掌控地區");
  assert.ok(
    !returnedIds.includes(otherRegionId),
    "不應含他人掌控的地區",
  );

  // 每個地區的百分比與城市清單須與 DB 一致，且不含私有欄位。
  for (const region of json.regions) {
    const expected = ownedRegions.find((r) => r.regionId === region.regionId);
    assert.ok(expected, `未預期的地區 ${region.regionId}`);
    assert.equal(region.percent, expected.percent, "掌控百分比應一致");
    assert.ok(typeof region.name === "string", "地區應含名稱");
    assert.ok(Array.isArray(region.cities), "地區應含城市陣列");

    const dbCities = await db
      .select({ id: mapCitiesTable.id })
      .from(mapCitiesTable)
      .where(eq(mapCitiesTable.regionId, region.regionId));
    const dbCityIds = dbCities.map((c) => c.id).sort((a, b) => a - b);
    const returnedCityIds = region.cities
      .map((c: any) => c.id)
      .sort((a: number, b: number) => a - b);
    assert.deepEqual(returnedCityIds, dbCityIds, "城市清單應與 DB 一致");

    for (const city of region.cities) {
      assert.ok(typeof city.name === "string", "城市應含名稱");
      assert.equal(city.slotsUsed, 0, "尚未興建，已用槽位應為 0");
      assert.ok(Array.isArray(city.buildings), "城市應含建築陣列");
    }
  }

  // 私有欄位不外洩：整份回應不得出現任何 discord_user_id。
  const raw = JSON.stringify(json);
  assert.ok(!raw.includes(ownerUserId), "回應不應洩漏擁有者 discord id");
  assert.ok(!raw.includes(otherUserId), "回應不應洩漏他人 discord id");
  assert.ok(
    !/discord/i.test(raw),
    "回應不應含任何 discord 相關欄位",
  );
});
