/**
 * 補給系統 — 軍工廠建造路由整合測試（真 DB、真 express、真 session、真 zod）。
 *  1. 火藥時代：軍工廠可建造，回應帶 resource=ammo；GET 列表含 ammo 庫存。
 *  2. 冷兵器時代：建軍工廠 → 400，且不扣款、不產生建築列。
 *  3. 不明建築類型 → 400，錯誤訊息列出三種合法類型。
 * 骨架同 regionBuildings.race.test.ts，但不依賴其過期的金錢斷言。
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
const { loadNationScales } = await import("../lib/nationScale");
const { getEraSlugs } = await import("../lib/nationStats");
// 金錢軌隨國家動態價格尺度（與正式路由同款，依該國人口）；生產力軌不縮放。
// 國家與地區控制建立後才算得出來，故為 let，於 before() 內重算。
let ERA_SCALE = 1;
const buildingCost = (level: number) => baseBuildingCost(level, ERA_SCALE);
const { activateTreaty, HttpError } = await import(
  "../lib/treatyActivation"
);
const { runResourceMigrations, runResourceMigrationsInner } = await import(
  "../lib/resourceMigrations"
);
const buildingsRouter = (await import("./regionBuildings")).default;

const NATION_MARKER = "__plantroute__";
const USER_MARKER = "plantroute-";

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
  ERA_SCALE = (await loadNationScales(nationId, eraSlug)).price;
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

const { worldGameStateTable } = await import("@workspace/db");

/** 設定世界時代（currentEra 與 statsEra 一起），回傳還原函式。 */
async function setEra(era: string): Promise<() => Promise<void>> {
  const [prev] = await db
    .select({ cur: worldGameStateTable.currentEra, st: worldGameStateTable.statsEra })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  assert.ok(prev, "world_game_state 應存在");
  await db
    .update(worldGameStateTable)
    .set({ currentEra: era, statsEra: era })
    .where(eq(worldGameStateTable.id, 1));
  return async () => {
    await db
      .update(worldGameStateTable)
      .set({ currentEra: prev!.cur, statsEra: prev!.st })
      .where(eq(worldGameStateTable.id, 1));
  };
}

async function plantRows() {
  return db
    .select()
    .from(regionBuildingsTable)
    .where(
      and(
        eq(regionBuildingsTable.nationId, nationId),
        eq(regionBuildingsTable.buildingType, "munitions_plant"),
      ),
    );
}

test("火藥時代：軍工廠可建造（201、resource=ammo），列表含 ammo 庫存", async () => {
  const restore = await setEra("ww1");
  try {
    await resetBuildings();
    await setNation({ money: 100_000_000, productionSpent: 0 });
    const r = await api("POST", "/api/player/buildings", {
      regionId: regionA,
      buildingType: "munitions_plant",
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.building.buildingType, "munitions_plant");
    assert.equal(r.json.building.resource, "ammo");
    assert.equal(r.json.building.buildingLabel, "軍工廠");
    assert.equal(r.json.building.level, 1);
    assert.equal((await plantRows()).length, 1);

    const list = await api("GET", "/api/player/buildings");
    assert.equal(list.status, 200);
    assert.equal(typeof list.json.ammo, "number", "列表應含彈藥庫存");
  } finally {
    await resetBuildings();
    await restore();
  }
});

test("冷兵器時代：建軍工廠 → 400，不扣款、不產生建築", async () => {
  const restore = await setEra("roman");
  try {
    await resetBuildings();
    await setNation({ money: 100_000_000, productionSpent: 0 });
    const before = await nationRow();
    const r = await api("POST", "/api/player/buildings", {
      regionId: regionA,
      buildingType: "munitions_plant",
    });
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.match(String(r.json.error), /軍工廠/);
    assert.equal((await plantRows()).length, 0, "不應產生建築列");
    const after = await nationRow();
    assert.equal(after.money, before.money, "不應扣款");
    assert.equal(after.productionSpent, before.productionSpent, "不應占用生產力");
  } finally {
    await restore();
  }
});

test("不明建築類型 → 400，訊息列出三種合法類型", async () => {
  const r = await api("POST", "/api/player/buildings", {
    regionId: regionA,
    buildingType: "farm",
  });
  assert.equal(r.status, 400);
  assert.match(String(r.json.error), /munitions_plant/);
});
