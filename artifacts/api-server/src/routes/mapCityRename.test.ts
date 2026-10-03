/**
 * Task #317 — PATCH /api/map/cities/:id/name（玩家自訂城市名）的真實資料庫整合
 * 測試。此端點的權限與命名衝突規則過去只靠手動驗證，一旦被改壞就可能讓非主控
 * 玩家改別國城市名、或造出與地區／其他城市重複的混淆名稱。這裡鎖住：
 *
 *  1. 主控者（掌控該城所屬地區佔比最高的國家玩家）可成功更名。
 *  2. 非主控者（該地區沒有掌控或非最高佔比）回 403。
 *  3. name 為 null 或空字串 → 還原種子預設名（customName 歸 null）。
 *  4. 名稱超過 40 字 → 400。
 *  5. 與現有地區名稱衝突 → 409。
 *  6. 與其他城市（預設名）衝突 → 409。
 *  7. 更名為全域單一值：第二個 session 也能透過公開 /api/map/cities 看到新名。
 *
 * 走真正的 Express 端點（掛 session cookie），因此驗證的是線上守門本身。
 * 需要 DATABASE_URL 指向已由正常伺服器啟動遷移過的資料庫。所有資料以
 * `__cityrntest__` / `cityrntest-` 前綴標記，且測試用城市於跑前跑後還原成預設
 * 名，可重複執行：`pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the map-city-rename tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq, isNull, like, ne } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  mapCitiesTable,
  userSessionsTable,
} = await import("@workspace/db");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runMapCitySync } = await import("../lib/mapCities");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const mapRouter = (await import("./mapRegions")).default;

const NATION_MARKER = "__cityrntest__";
const USER_MARKER = "cityrntest-";
const runId = randomBytes(4).toString("hex");
const CUSTOM_NAME = `改名測試城${runId}`; // 全域唯一、遠短於 40 字

let server: http.Server;
let baseUrl: string;

let ownerNationId: string;
let otherNationId: string;
let ownerUserId: string;
let otherUserId: string;
let ownerToken: string;
let otherToken: string;

let cityId: number;
let cityDefaultName: string;
let cityRegionId: number;
let existingRegionName: string;
let otherCityName: string;

async function resetTestCity() {
  if (cityId) {
    await db
      .update(mapCitiesTable)
      .set({ customName: null, customNameNationId: null })
      .where(eq(mapCitiesTable.id, cityId));
  }
}

async function cleanup() {
  await resetTestCity();
  // 刪國家會 cascade 清掉 region_controls；customName_nation_id 為 SET NULL，
  // 故上面先把測試城市的 customName 一併歸零，避免殘留自訂名污染共用 DB。
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function patchName(
  id: number,
  body: unknown,
  token: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/map/cities/${id}/name`, {
    method: "PATCH",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function fetchCity(
  id: number,
  token?: string,
): Promise<{ id: number; name: string; defaultName: string } | undefined> {
  const res = await fetch(`${baseUrl}/api/map/cities`, {
    headers: token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {},
  });
  assert.equal(res.status, 200, "/api/map/cities 應回 200");
  const data = (await res.json()) as {
    cities: { id: number; name: string; defaultName: string }[];
  };
  return data.cities.find((c) => c.id === id);
}

before(async () => {
  await runMapRegionSync();
  await runMapCitySync();
  await cleanup();

  // 選一座「所屬地區目前無任何掌控列」的城市，確保我們插入的主控者為該地區
  // 唯一掌控者，不受共用 dev DB 既有資料影響（left join + isNull）。
  const [freeCity] = await db
    .select({
      id: mapCitiesTable.id,
      name: mapCitiesTable.name,
      regionId: mapCitiesTable.regionId,
    })
    .from(mapCitiesTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapCitiesTable.regionId),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapCitiesTable.id)
    .limit(1);
  assert.ok(freeCity, "測試需要至少一座所屬地區無人掌控的城市");
  cityId = freeCity.id;
  cityDefaultName = freeCity.name;
  cityRegionId = freeCity.regionId;

  // 任一現有地區名（用於「與地區名衝突」測試），排除本城市所屬地區。
  const [someRegion] = await db
    .select({ name: mapRegionsTable.name })
    .from(mapRegionsTable)
    .where(ne(mapRegionsTable.id, cityRegionId))
    .orderBy(mapRegionsTable.id)
    .limit(1);
  assert.ok(someRegion, "測試需要至少一個其他地區");
  existingRegionName = someRegion.name;

  // 另一座城市的預設名（用於「與其他城市名衝突」測試），排除本城市。
  const [anotherCity] = await db
    .select({ name: mapCitiesTable.name })
    .from(mapCitiesTable)
    .where(ne(mapCitiesTable.id, cityId))
    .orderBy(mapCitiesTable.id)
    .limit(1);
  assert.ok(anotherCity, "測試需要至少一座其他城市");
  otherCityName = anotherCity.name;

  ownerUserId = `${USER_MARKER}owner-${runId}`;
  otherUserId = `${USER_MARKER}other-${runId}`;

  const [owner] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}owner-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: ownerUserId,
    })
    .returning({ id: playerNationsTable.id });
  ownerNationId = owner!.id;

  const [other] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}other-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: otherUserId,
    })
    .returning({ id: playerNationsTable.id });
  otherNationId = other!.id;

  // 只有 owner 掌控該城所屬地區（100%）；other 建了國但不掌控此地區 → 非主控者。
  await db
    .insert(regionControlsTable)
    .values({ regionId: cityRegionId, nationId: ownerNationId, percent: 100 });

  ownerToken = await createSession({
    discordUserId: ownerUserId,
    username: ownerUserId,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });
  otherToken = await createSession({
    discordUserId: otherUserId,
    username: otherUserId,
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
  app.use("/api", mapRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanup();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("主控者可成功更名", async () => {
  await resetTestCity();
  const { status, json } = await patchName(
    cityId,
    { name: CUSTOM_NAME },
    ownerToken,
  );
  assert.equal(status, 200, "主控者更名應回 200");
  assert.equal(json.name, CUSTOM_NAME);
  assert.equal(json.customName, CUSTOM_NAME);
  assert.equal(json.defaultName, cityDefaultName);
});

test("非主控者更名回 403", async () => {
  await resetTestCity();
  const { status } = await patchName(cityId, { name: CUSTOM_NAME }, otherToken);
  assert.equal(status, 403, "非主控者不得更名");
  // 未變更：仍為預設名。
  const city = await fetchCity(cityId);
  assert.equal(city?.name, cityDefaultName);
});

test("name 為 null 還原預設名", async () => {
  // 先設自訂名，再以 null 還原。
  await patchName(cityId, { name: CUSTOM_NAME }, ownerToken);
  const { status, json } = await patchName(cityId, { name: null }, ownerToken);
  assert.equal(status, 200);
  assert.equal(json.customName, null);
  assert.equal(json.name, cityDefaultName);
});

test("name 為空字串還原預設名", async () => {
  await patchName(cityId, { name: CUSTOM_NAME }, ownerToken);
  const { status, json } = await patchName(cityId, { name: "   " }, ownerToken);
  assert.equal(status, 200);
  assert.equal(json.customName, null);
  assert.equal(json.name, cityDefaultName);
});

test("名稱超過 25 字回 400", async () => {
  await resetTestCity();
  const tooLong = "字".repeat(26);
  const { status } = await patchName(cityId, { name: tooLong }, ownerToken);
  assert.equal(status, 400, "超過 25 字應被拒");
  const city = await fetchCity(cityId);
  assert.equal(city?.name, cityDefaultName, "被拒後仍為預設名");
});

test("含空白或特殊符號的城市名回 400", async () => {
  await resetTestCity();
  const withSpace = await patchName(cityId, { name: "城 市" }, ownerToken);
  assert.equal(withSpace.status, 400, "含空白應被拒");
  const withPunct = await patchName(cityId, { name: "城市！" }, ownerToken);
  assert.equal(withPunct.status, 400, "含標點應被拒");
  const city = await fetchCity(cityId);
  assert.equal(city?.name, cityDefaultName, "被拒後仍為預設名");
});

test("與現有地區名稱衝突回 409", async () => {
  await resetTestCity();
  const { status } = await patchName(
    cityId,
    { name: existingRegionName },
    ownerToken,
  );
  assert.equal(status, 409, "與地區名衝突應被拒");
  const city = await fetchCity(cityId);
  assert.equal(city?.name, cityDefaultName, "被拒後仍為預設名");
});

test("與其他城市名稱衝突回 409", async () => {
  await resetTestCity();
  const { status } = await patchName(
    cityId,
    { name: otherCityName },
    ownerToken,
  );
  assert.equal(status, 409, "與其他城市名衝突應被拒");
  const city = await fetchCity(cityId);
  assert.equal(city?.name, cityDefaultName, "被拒後仍為預設名");
});

test("自訂名為全域單值：第二個 session 也看得到", async () => {
  await resetTestCity();
  const { status } = await patchName(cityId, { name: CUSTOM_NAME }, ownerToken);
  assert.equal(status, 200);
  // 以「非主控者」的 session 讀公開城市清單，仍看得到 owner 設定的全域自訂名。
  const city = await fetchCity(cityId, otherToken);
  assert.equal(city?.name, CUSTOM_NAME, "全域自訂名對其他 session 亦可見");
  assert.equal(city?.defaultName, cityDefaultName);
});
