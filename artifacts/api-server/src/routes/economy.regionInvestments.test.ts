/**
 * 地區生產力投資端點（POST /api/economy/region-investments）整合測試（Task #405）。
 *
 * 純函式費用計算已有單元測試（lib/regionInvestment.test.ts）；本測試鎖住線上
 * 端點不變量：
 *  1. 掌控地區才能投資；未掌控 → 400（zh-TW）。
 *  2. 投資成功：金錢扣除伺服器端重算的費用、map_regions.productivity_investment_bonus +1，
 *     且 map_region_era_stats 不被改動（鐵則）。
 *  3. 金錢不足 → 400、不扣款、加成不動。
 *  4. 併發保護：兩個併發投資（同地區）在 advisory lock 下序列化，加成 +2、
 *     總扣款 = 兩次伺服器端重算的費用和（第二次以更新後的加成計價）。
 *  5. GET /api/economy/regions 回傳 investment 欄位且 nextInvestCost 一致。
 *
 * 資料以 `__ecoinvtest__` / `ecoinvtest-` 前綴標記、self-cleaning：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the region investment tests",
  );
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  mapRegionEraStatsTable,
} = await import("@workspace/db");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runEconomyMigrations } = await import("../lib/economyMigrations");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { getEraSlugs } = await import("../lib/nationStats");
const economyRouter = (await import("./economy")).default;

const NATION_MARKER = "__ecoinvtest__";
const USER_MARKER = "ecoinvtest-";
const runId = randomBytes(4).toString("hex");
const START_MONEY = 2_000_000_000;

let server: http.Server;
let baseUrl: string;
let ownerUserId: string;
let nationId: string;
let sessionToken: string;
let ownedRegionId = 0;
let unownedRegionId = 0;
/** 測試開始時該地區的加成基準（測試自行歸零，after 恢復 0）。 */
const touchedRegionIds = new Set<number>();

async function cleanup() {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${NATION_MARKER + "%"}`);
  // 測試投資產生的加成要歸零，避免污染共用開發 DB 的地圖顯示。
  for (const regionId of touchedRegionIds) {
    await db
      .update(mapRegionsTable)
      .set({ productivityInvestmentBonus: 0 })
      .where(eq(mapRegionsTable.id, regionId));
  }
}

async function invest(regionId: number): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/economy/region-investments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
    body: JSON.stringify({ regionId }),
  });
  return { status: res.status, json: await res.json() };
}

async function getMoney(): Promise<number> {
  const [row] = await db
    .select({ money: playerNationsTable.money })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row);
  return row.money;
}

async function getBonus(regionId: number): Promise<number> {
  const [row] = await db
    .select({ bonus: mapRegionsTable.productivityInvestmentBonus })
    .from(mapRegionsTable)
    .where(eq(mapRegionsTable.id, regionId));
  assert.ok(row);
  return row.bonus;
}

async function setMoney(money: number) {
  await db
    .update(playerNationsTable)
    .set({ money })
    .where(eq(playerNationsTable.id, nationId));
}

before(async () => {
  await runMapRegionSync();
  await runEconomyMigrations();
  await cleanup();

  ownerUserId = `${USER_MARKER}owner-${runId}`;
  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}A-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: ownerUserId,
      money: START_MONEY,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(nation, "nation insert failed");
  nationId = nation.id;

  // 找兩個地區：一個給玩家掌控、一個不掌控（拒絕測試）。
  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .orderBy(mapRegionsTable.id)
    .limit(2);
  assert.ok(regions.length >= 2, "需要至少兩個地區");
  ownedRegionId = regions[0]!.id;
  unownedRegionId = regions[1]!.id;
  touchedRegionIds.add(ownedRegionId);

  // 基準：加成歸零，讓費用可預測。
  await db
    .update(mapRegionsTable)
    .set({ productivityInvestmentBonus: 0 })
    .where(eq(mapRegionsTable.id, ownedRegionId));

  await db.insert(regionControlsTable).values({
    regionId: ownedRegionId,
    nationId,
    percent: 60,
  });

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

test("未掌控地區 → 400 且不扣款", async () => {
  const moneyBefore = await getMoney();
  const { status, json } = await invest(unownedRegionId);
  assert.equal(status, 400, `應拒絕：${JSON.stringify(json)}`);
  assert.ok(
    String(json.error).includes("未掌控"),
    `錯誤訊息應為 zh-TW 未掌控：${json.error}`,
  );
  assert.equal(await getMoney(), moneyBefore, "不應扣款");
});

test("無效 regionId → 400", async () => {
  const { status } = await invest(-1);
  assert.equal(status, 400);
});

test("投資成功：扣伺服器重算費用、加成 +1、era stats 不變", async () => {
  await setMoney(START_MONEY);
  const bonusBefore = await getBonus(ownedRegionId);
  const { statsEra } = await getEraSlugs();
  const [statBefore] = await db
    .select({ productivity: mapRegionEraStatsTable.productivity })
    .from(mapRegionEraStatsTable)
    .where(
      and(
        eq(mapRegionEraStatsTable.regionId, ownedRegionId),
        eq(mapRegionEraStatsTable.era, statsEra),
      ),
    );
  assert.ok(statBefore, "數據時代 era stats 應存在");

  const { status, json } = await invest(ownedRegionId);
  assert.equal(status, 200, `應成功：${JSON.stringify(json)}`);
  assert.ok(Number.isInteger(json.cost) && json.cost >= 1, "費用應為 ≥1 的整數");
  assert.equal(json.investmentBonus, bonusBefore + 1, "回應加成應 +1");
  assert.equal(await getBonus(ownedRegionId), bonusBefore + 1, "DB 加成應 +1");
  assert.equal(
    await getMoney(),
    START_MONEY - json.cost,
    "應剛好扣除伺服器重算費用",
  );

  // 鐵則：不得動 map_region_era_stats。
  const [statAfter] = await db
    .select({ productivity: mapRegionEraStatsTable.productivity })
    .from(mapRegionEraStatsTable)
    .where(
      and(
        eq(mapRegionEraStatsTable.regionId, ownedRegionId),
        eq(mapRegionEraStatsTable.era, statsEra),
      ),
    );
  assert.equal(
    statAfter!.productivity,
    statBefore.productivity,
    "era stats 生產素質不得被改動",
  );
});

test("金錢不足 → 400、不扣款、加成不動", async () => {
  await setMoney(0);
  const bonusBefore = await getBonus(ownedRegionId);
  const { status, json } = await invest(ownedRegionId);
  assert.equal(status, 400, `應拒絕：${JSON.stringify(json)}`);
  assert.ok(
    String(json.error).includes("金錢不足"),
    `錯誤訊息應為 zh-TW 金錢不足：${json.error}`,
  );
  assert.equal(await getMoney(), 0, "不應扣款");
  assert.equal(await getBonus(ownedRegionId), bonusBefore, "加成不應變動");
});

test("併發投資同一地區：加成 +2、扣款守恆", async () => {
  await setMoney(START_MONEY);
  const bonusBefore = await getBonus(ownedRegionId);

  const [a, b] = await Promise.all([
    invest(ownedRegionId),
    invest(ownedRegionId),
  ]);
  assert.equal(a.status, 200, `A 應成功：${JSON.stringify(a.json)}`);
  assert.equal(b.status, 200, `B 應成功：${JSON.stringify(b.json)}`);

  assert.equal(
    await getBonus(ownedRegionId),
    bonusBefore + 2,
    "兩次投資後加成應 +2",
  );
  assert.equal(
    await getMoney(),
    START_MONEY - a.json.cost - b.json.cost,
    "總扣款應等於兩次回報費用之和（無重複或漏扣）",
  );
});

test("GET /economy/regions 回傳 investment 欄位且與投資費用一致", async () => {
  await setMoney(START_MONEY);
  const res = await fetch(`${baseUrl}/api/economy/regions`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  });
  const json = (await res.json()) as any;
  assert.equal(res.status, 200, `應成功：${JSON.stringify(json)}`);
  const region = json.regions.find((r: any) => r.regionId === ownedRegionId);
  assert.ok(region, "應包含掌控地區");
  const inv = region.investment;
  assert.ok(inv, "應含 investment 資訊");
  assert.equal(
    inv.effectiveProductivity,
    inv.baseProductivity + inv.investmentBonus,
    "有效生產素質 = 基礎 + 加成",
  );
  assert.ok(inv.costMultiplier >= 1, "倍率下限 1");
  assert.ok(
    Number.isInteger(inv.nextInvestCost) && inv.nextInvestCost >= 1,
    "下一次費用為 ≥1 整數",
  );

  // 實際投資 → 扣款金額應等於 GET 顯示的 nextInvestCost。
  const { status, json: investJson } = await invest(ownedRegionId);
  assert.equal(status, 200, `應成功：${JSON.stringify(investJson)}`);
  assert.equal(
    investJson.cost,
    inv.nextInvestCost,
    "實際費用應與 GET 顯示的下一次費用一致",
  );
});
