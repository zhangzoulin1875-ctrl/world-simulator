/**
 * Task #406 — 整合測試（真實資料庫）：地區資源建築與資源轉移的併發保護。
 *
 *  1. 同地區同型建築併發建造 → 恰好一個 201、另一個 409（unique 約束）；
 *     金錢/生產力只扣一次。
 *  2. 金錢只夠一次建造時，兩個不同地區併發建造 → 一個 201、一個 400
 *     金錢不足；金錢不會為負（conditional-UPDATE spend guard）。
 *  3. 工人上限：人口不足以容納新等級 → 400 建築工人不足，不扣款。
 *  4. 升級：成功升級扣升級成本（level 2 = 6000 金錢）；等級與扣款一致。
 *  5. 條約一次性資源轉移原子性：提供方木材不足 → activateTreaty 擲
 *     HttpError，雙方金錢/木材/礦石完全不變（全回滾）。
 *
 * 需要 DATABASE_URL 指向已由正常啟動遷移過的資料庫。所有列以識別前綴標記，
 * 執行前後皆清理：`pnpm --filter @workspace/api-server run test:integration`
 */
import { strict as assert } from "node:assert";
import test, { after, before, beforeEach } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the region building race tests",
  );
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, like, notExists, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  regionBuildingsTable,
  mapRegionsTable,
  userSessionsTable,
  diplomacyTreatiesTable,
} = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { computeNationStats, getStatsEraSlug } = await import(
  "../lib/nationStats"
);
const { buildingCost: baseBuildingCost } = await import("../lib/regionBuildings");
const { eraCostScale } = await import("../lib/eraCostScale");
const { getEraSlugs } = await import("../lib/nationStats");
// 金錢軌隨世界時代膨脹（與正式路由同款係數）；生產力軌不縮放。
const ERA_SCALE = eraCostScale((await getEraSlugs()).statsEra);
const buildingCost = (level: number) => baseBuildingCost(level, ERA_SCALE);
const { activateTreaty, HttpError } = await import(
  "../lib/treatyActivation"
);
const { runResourceMigrations, runResourceMigrationsInner } = await import(
  "../lib/resourceMigrations"
);
const buildingsRouter = (await import("./regionBuildings")).default;

const NATION_MARKER = "__bldgtest__";
const USER_MARKER = "bldgtest-";

const runId = randomBytes(4).toString("hex");
const userId = `${USER_MARKER}${runId}`;
const nationName = `${NATION_MARKER}${runId}`;

let server: http.Server;
let baseUrl: string;
let sessionToken: string;

let nationId: string;
let regionA: number;
let regionB: number;
let stats: { population: number; production: number };

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function cleanup(): Promise<void> {
  // 刪國家會 cascade 掉 region_controls / region_buildings / 條約。
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function nationRow(id: string = nationId) {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, id));
  assert.ok(row, "test nation must exist");
  return row!;
}

async function setNation(values: Record<string, unknown>): Promise<void> {
  await db
    .update(playerNationsTable)
    .set(values)
    .where(eq(playerNationsTable.id, nationId));
}

async function resetBuildings(): Promise<void> {
  await db
    .delete(regionBuildingsTable)
    .where(eq(regionBuildingsTable.nationId, nationId));
}

before(async () => {
  await cleanup();

  // 兩個無主地區，各 50% 掌控（建造只需 percent ≥ 1）。
  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(regionControlsTable)
          .where(eq(regionControlsTable.regionId, mapRegionsTable.id)),
      ),
    )
    .orderBy(mapRegionsTable.id)
    .limit(2);
  assert.equal(regions.length, 2, "need two unclaimed regions for the tests");
  regionA = regions[0]!.id;
  regionB = regions[1]!.id;

  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      discordUserId: userId,
      name: nationName,
      leaderName: "建築競態測試",
      government: "君主制",
      // 兩個無主邊陲地區的時代生產力可能極低；用固定生產力加成
      // 確保可負擔建造/升級成本（工人上限測試只看人口，不受影響）。
      productionBonus: 100_000,
    })
    .returning({ id: playerNationsTable.id });
  nationId = nation!.id;
  await db.insert(regionControlsTable).values([
    { regionId: regionA, nationId, percent: 50 },
    { regionId: regionB, nationId, percent: 50 },
  ]);

  const eraSlug = await getStatsEraSlug();
  stats = await computeNationStats(nationId, eraSlug);
  assert.ok(
    stats.production > 0 && stats.population > 0,
    `controlled regions must yield stats (got ${JSON.stringify(stats)})`,
  );

  sessionToken = await createSession({
    discordUserId: userId,
    username: `bldg-${runId}`,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    (req as any).log = {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
    next();
  });
  app.use("/api", buildingsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await cleanup();
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

beforeEach(async () => {
  await resetBuildings();
  await setNation({ money: 1_000_000 * ERA_SCALE, productionSpent: 0, wood: 0, ore: 0 });
});

test("併發建造同地區同型建築 → 一個 201、一個 409，只扣一次款", async () => {
  const before = await nationRow();
  const body = { regionId: regionA, buildingType: "lumber_mill" };
  const [r1, r2] = await Promise.all([
    api("POST", "/api/player/buildings", body),
    api("POST", "/api/player/buildings", body),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409], JSON.stringify([r1.json, r2.json]));

  const rows = await db
    .select()
    .from(regionBuildingsTable)
    .where(
      and(
        eq(regionBuildingsTable.nationId, nationId),
        eq(regionBuildingsTable.regionId, regionA),
      ),
    );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.level, 1);

  const cost = buildingCost(1);
  const afterRow = await nationRow();
  assert.equal(afterRow.money, before.money - cost.money);
  assert.equal(afterRow.productionSpent, cost.production);
});

test("金錢只夠一次 → 兩地區併發建造，一個 201、一個 400 金錢不足", async () => {
  const cost = buildingCost(1);
  await setNation({ money: cost.money, productionSpent: 0 });
  const [r1, r2] = await Promise.all([
    api("POST", "/api/player/buildings", {
      regionId: regionA,
      buildingType: "mine",
    }),
    api("POST", "/api/player/buildings", {
      regionId: regionB,
      buildingType: "mine",
    }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 400], JSON.stringify([r1.json, r2.json]));
  const failed = r1.status === 400 ? r1 : r2;
  assert.match(String(failed.json.error), /不足/);

  const afterRow = await nationRow();
  assert.equal(afterRow.money, 0);
  assert.ok(afterRow.money >= 0, "money must never go negative");
  const rows = await db
    .select()
    .from(regionBuildingsTable)
    .where(eq(regionBuildingsTable.nationId, nationId));
  assert.equal(rows.length, 1);
});

test("工人上限：既有等級已占滿人口 → 400 建築工人不足，不扣款", async () => {
  // 用一座超高等級建築占滿工人（1000 × level > population）。
  const levelsToFill = Math.floor(stats.population / 1000);
  assert.ok(levelsToFill >= 1, "population must fit at least one level");
  await db.insert(regionBuildingsTable).values({
    nationId,
    regionId: regionA,
    buildingType: "lumber_mill",
    level: levelsToFill,
  });
  const before = await nationRow();
  const res = await api("POST", "/api/player/buildings", {
    regionId: regionB,
    buildingType: "lumber_mill",
  });
  assert.equal(res.status, 400, JSON.stringify(res.json));
  assert.match(String(res.json.error), /建築工人不足/);
  const afterRow = await nationRow();
  assert.equal(afterRow.money, before.money);
  assert.equal(afterRow.productionSpent, before.productionSpent);
});

test("升級：扣 level 2 成本（6000×時代係數 金錢／240 生產力）且等級 +1", async () => {
  const created = await api("POST", "/api/player/buildings", {
    regionId: regionA,
    buildingType: "mine",
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const buildingId = created.json.building.id;
  const before = await nationRow();
  const res = await api(
    "POST",
    `/api/player/buildings/${buildingId}/upgrade`,
  );
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.building.level, 2);
  const cost2 = buildingCost(2);
  assert.equal(cost2.money, 6000 * ERA_SCALE);
  assert.equal(cost2.production, 240);
  const afterRow = await nationRow();
  assert.equal(afterRow.money, before.money - cost2.money);
  assert.equal(
    afterRow.productionSpent,
    before.productionSpent + cost2.production,
  );
});

test("拆除：釋放累計占用生產力（建造＋升級）、金錢不退還", async () => {
  const created = await api("POST", "/api/player/buildings", {
    regionId: regionA,
    buildingType: "lumber_mill",
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const buildingId = created.json.building.id;
  const upgraded = await api(
    "POST",
    `/api/player/buildings/${buildingId}/upgrade`,
  );
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json));

  const before = await nationRow();
  const expectedReserved =
    (await db
      .select({ reserved: regionBuildingsTable.productionReserved })
      .from(regionBuildingsTable)
      .where(eq(regionBuildingsTable.id, buildingId)))[0]!.reserved;
  assert.ok(expectedReserved > 0, "reserved must be tracked");
  assert.equal(before.productionSpent, expectedReserved);

  const res = await api("DELETE", `/api/player/buildings/${buildingId}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.ok, true);
  assert.equal(res.json.releasedProduction, expectedReserved);

  const afterRow = await nationRow();
  // 生產力占用完全釋放、金錢不變（不退款）。
  assert.equal(afterRow.productionSpent, 0);
  assert.equal(afterRow.money, before.money);
  const rows = await db
    .select()
    .from(regionBuildingsTable)
    .where(eq(regionBuildingsTable.id, buildingId));
  assert.equal(rows.length, 0, "building row must be deleted");
});

test("拆除：非本國建築 → 404；重複拆除 → 404；釋放量夾底不為負", async () => {
  // 別國的建築拆不掉。
  const [other] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}demolish-${runId}`,
      leaderName: "拆除權限測試",
      government: "君主制",
    })
    .returning({ id: playerNationsTable.id });
  const [foreign] = await db
    .insert(regionBuildingsTable)
    .values({
      nationId: other!.id,
      regionId: regionB,
      buildingType: "mine",
      level: 1,
      productionReserved: 200,
    })
    .returning({ id: regionBuildingsTable.id });
  const forbidden = await api(
    "DELETE",
    `/api/player/buildings/${foreign!.id}`,
  );
  assert.equal(forbidden.status, 404, JSON.stringify(forbidden.json));

  // 自己的建築：即使 spent 已被外力歸零，釋放也以 GREATEST(0, …) 夾底。
  const created = await api("POST", "/api/player/buildings", {
    regionId: regionA,
    buildingType: "mine",
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const buildingId = created.json.building.id;
  await setNation({ productionSpent: 0 });
  const res = await api("DELETE", `/api/player/buildings/${buildingId}`);
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const afterRow = await nationRow();
  assert.equal(afterRow.productionSpent, 0, "spent must clamp at zero");

  // 已拆除 → 再拆 404。
  const again = await api("DELETE", `/api/player/buildings/${buildingId}`);
  assert.equal(again.status, 404, JSON.stringify(again.json));

  await db
    .delete(playerNationsTable)
    .where(eq(playerNationsTable.id, other!.id));
});

test("開機修復：spent 被歷史 bug 歸零 → 資源遷移補回 Σ(建築 reserved)", async () => {
  // 建造＋升級，取得實際累計占用。
  const created = await api("POST", "/api/player/buildings", {
    regionId: regionA,
    buildingType: "lumber_mill",
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const buildingId = created.json.building.id;
  const upgraded = await api(
    "POST",
    `/api/player/buildings/${buildingId}/upgrade`,
  );
  assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json));
  const reserved = (await db
    .select({ reserved: regionBuildingsTable.productionReserved })
    .from(regionBuildingsTable)
    .where(eq(regionBuildingsTable.id, buildingId)))[0]!.reserved;
  assert.ok(reserved > 0);

  // 模擬舊版 backfillArmyReservations 在建築占用可見前把 spent 歸零。
  await setNation({ productionSpent: 0 });

  // 開機遷移（idempotent）→ 不變量修復把 spent 拉回 Σreserved。
  // Task #569 — 直呼 Inner 版繞過測試回合的遷移戳記快速路徑（戳記會讓
  // 重跑被跳過，修復不會執行）。
  await runResourceMigrationsInner();
  const afterRow = await nationRow();
  assert.equal(afterRow.productionSpent, reserved);

  // 再跑一次不會重覆加（idempotent、只補到 Σreserved）。
  await runResourceMigrationsInner();
  const again = await nationRow();
  assert.equal(again.productionSpent, reserved);
});

test("條約一次性資源轉移原子性：木材不足 → 全回滾", async () => {
  // 第二個國家作為對象。
  const [other] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}other-${runId}`,
      leaderName: "資源條約測試",
      government: "君主制",
      money: 500,
      wood: 10,
      ore: 10,
    })
    .returning({ id: playerNationsTable.id });
  const otherId = other!.id;
  await setNation({ money: 500, wood: 10, ore: 10 });

  // 提案方（我方）提供 100 木材（庫存只有 10）＋要求對方 5 礦石。
  const [treaty] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: nationId,
      targetNationId: otherId,
      type: "trade",
      status: "proposed",
      offerMoney: 0,
      offerTechPoints: 0,
      offerWood: 100,
      offerOre: 0,
      requestMoney: 0,
      requestTechPoints: 0,
      requestWood: 0,
      requestOre: 5,
      proposerIsPayer: true,
    })
    .returning();
  assert.ok(treaty);

  await assert.rejects(
    db.transaction(async (tx) => {
      await activateTreaty(tx, treaty!);
    }),
    (err: unknown) => err instanceof HttpError,
  );

  // 雙方資源完全不變。
  const mine = await nationRow();
  const theirs = await nationRow(otherId);
  assert.equal(mine.wood, 10);
  assert.equal(mine.ore, 10);
  assert.equal(mine.money, 500);
  assert.equal(theirs.wood, 10);
  assert.equal(theirs.ore, 10);
  assert.equal(theirs.money, 500);
});
