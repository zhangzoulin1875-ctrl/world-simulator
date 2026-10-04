/**
 * 管理員開關 + 玩家流程的 HTTP 端到端（真實 DB）：
 *  - 未帶 token 的管理員請求被拒；帶 token 可讀寫開關。
 *  - 開關預設關閉 → 開啟後玩家佇列 API 回報 enabled。
 *  - 玩家流程：啟用 → 招募進佇列 → GET 看到訂單 → 回合推進 → 軍隊增加。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || "test-admin-token";

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq, like, notExists, sql } = await import("drizzle-orm");
const {
  db, pool, playerNationsTable, regionControlsTable, mapRegionsTable, userSessionsTable,
  militaryUnitTemplatesTable, playerArmiesTable, recruitQueueTable,
} = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("./sessions");
const { getStatsEraSlug } = await import("./nationStats");
const { setRecruitQueueEnabled, runRecruitQueueTurn } = await import("./recruitQueue");
const militaryRouter = (await import("../routes/military")).default;
const militaryAdminRouter = (await import("../routes/militaryAdmin")).default;

const MARK = "__rqadm__";
const runId = randomBytes(4).toString("hex");
const userId = `rqadm-${runId}-${process.pid}`;
let server: http.Server, base: string, token: string, nationId: string, tplId: number;

const admin = (method: string, body?: unknown, auth = true) =>
  fetch(`${base}/api/military-admin/recruit-queue`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: `Bearer ${process.env.ADMIN_TOKEN}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const player = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
};

before(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  const [region] = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable)
    .where(notExists(db.select({ one: sql`1` }).from(regionControlsTable).where(eq(regionControlsTable.regionId, mapRegionsTable.id))))
    .orderBy(mapRegionsTable.id).limit(1);
  const [n] = await db.insert(playerNationsTable)
    .values({ discordUserId: userId, name: `${MARK}${runId}`, leaderName: "t", government: "君主制", wood: 100000, ore: 100000, money: 1_000_000_000 })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
  await db.insert(regionControlsTable).values({ regionId: region!.id, nationId, percent: 100 });
  const [t] = await db.insert(militaryUnitTemplatesTable).values({
    ownerDiscordUserId: userId, isDefault: false, category: "infantry", name: `${MARK}t-${runId}`,
    eraSlug: await getStatsEraSlug(), hp: 100, attack: 100, defense: 10, speed: 1, accuracy: 80,
    range: "melee", prodCostPer100: 1, popCostPerUnit: 1, moneyCostPerUnit: 10, prodUpkeepPerUnit: 0.1, woodCostPerUnit: 1,
  }).returning({ id: militaryUnitTemplatesTable.id });
  tplId = t!.id;
  token = await createSession({ discordUserId: userId, username: userId, globalName: null, avatar: null, manageableGuildIds: [] });
  const app = express();
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", militaryRouter);
  app.use("/api", militaryAdminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await setRecruitQueueEnabled(false);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await db.delete(userSessionsTable).where(like(userSessionsTable.discordUserId, "rqadm-%"));
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await pool.end();
});

test("管理員開關：無 token 被拒；預設關閉；可開可關", async () => {
  await setRecruitQueueEnabled(false);
  assert.ok([401, 403].includes((await admin("GET", undefined, false)).status), "未授權必須被拒");
  assert.ok([401, 403].includes((await admin("PUT", { enabled: true }, false)).status));
  assert.deepEqual(await (await admin("GET")).json(), { enabled: false });
  assert.deepEqual(await (await admin("PUT", { enabled: true })).json(), { enabled: true });
  assert.deepEqual(await (await admin("GET")).json(), { enabled: true });
  assert.equal((await admin("PUT", { enabled: "yes" })).status, 400, "非布林值被拒");
  assert.deepEqual(await (await admin("PUT", { enabled: false })).json(), { enabled: false });
});

test("玩家完整流程：啟用 → 招募進佇列 → 看見訂單 → 回合推進 → 軍隊增加", async () => {
  await db.delete(recruitQueueTable).where(eq(recruitQueueTable.nationId, nationId));
  await db.delete(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));

  assert.equal((await player("GET", "/api/military/queue")).json.enabled, false, "關閉時玩家端 enabled=false");
  await admin("PUT", { enabled: true });
  assert.equal((await player("GET", "/api/military/queue")).json.enabled, true);

  const r = await player("POST", "/api/military/recruit", { templateId: tplId, quantity: 60 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.queued, true);
  assert.equal(r.json.quantity, null, "佇列模式不回傳軍隊數量");

  const q = await player("GET", "/api/military/queue");
  assert.equal(q.json.orders.length, 1);
  assert.equal(q.json.orders[0].remaining, 60);
  const perTurn = q.json.capacityPerTurn;
  assert.ok(perTurn >= 1);

  // 回合推進：用 API 顯示的同一個產能，完成量 = floor(產能 / tp)（至少 1）。
  const tp = q.json.orders[0].tpPerUnit;
  const expected = Math.min(60, Math.max(1, Math.floor(perTurn / tp)));
  await runRecruitQueueTurn("x", async () => Math.round(perTurn / 0.002));
  const [army] = await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  assert.equal(army?.quantity, expected, "完成量與 API 顯示的產能一致");

  const after1 = await player("GET", "/api/military/queue");
  assert.equal(after1.json.orders[0]?.remaining ?? 0, 60 - expected);

  // 取消剩餘：已完成的單位保留。
  if (after1.json.orders[0]) {
    const c = await player("POST", "/api/military/queue/cancel", { orderId: after1.json.orders[0].id });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal(c.json.refund.refundedUnits, 60 - expected);
  }
  const [armyAfter] = await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  assert.equal(armyAfter?.quantity, expected, "取消不影響已完成的軍隊");
});
