/**
 * 招募訓練佇列：HTTP 端到端（真實 DB）。
 *  1. 開關關閉：招募立刻生效、不進佇列（行為與舊版完全相同）。
 *  2. 開關開啟：招募進佇列、資源與佔用當下已扣、軍隊不增加。
 *  3. 滿 3 種：第 4 種 400，整筆交易回滾（資源、人口、國家 spent 不變）。
 *  4. 同兵種追加不受 3 種限制。
 *  5. 取消：100% 退還，國家 spent/木礦回到下單前。
 *  6. GET /military/queue 顯示訂單、產能、預估回合。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq, like, notExists, sql } = await import("drizzle-orm");
const {
  db, pool, playerNationsTable, regionControlsTable, mapRegionsTable, userSessionsTable,
  militaryUnitTemplatesTable, playerArmiesTable, recruitQueueTable, recruitProductionSpendsTable,
} = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("./sessions");
const { getStatsEraSlug } = await import("./nationStats");
const { setRecruitQueueEnabled, listNationQueue } = await import("./recruitQueue");
const militaryRouter = (await import("../routes/military")).default;

const MARK = "__rqhttp__";
const runId = randomBytes(4).toString("hex");
const userId = `rqhttp-${runId}-${process.pid}`;
let server: http.Server, baseUrl: string, token: string, nationId: string;
const tpl: number[] = [];

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
async function nation() {
  const [r] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  return r!;
}
async function armyQty() {
  const r = await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  return r.reduce((a, x) => a + x.quantity, 0);
}
async function reset() {
  await db.delete(recruitQueueTable).where(eq(recruitQueueTable.nationId, nationId));
  await db.delete(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  await db.delete(recruitProductionSpendsTable).where(eq(recruitProductionSpendsTable.nationId, nationId));
  await db.update(playerNationsTable)
    .set({ productionSpent: 0, populationSpent: 0, wood: 100000, ore: 100000, money: 1_000_000_000 })
    .where(eq(playerNationsTable.id, nationId));
}

before(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  const [region] = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable)
    .where(notExists(db.select({ one: sql`1` }).from(regionControlsTable).where(eq(regionControlsTable.regionId, mapRegionsTable.id))))
    .orderBy(mapRegionsTable.id).limit(1);
  assert.ok(region, "need an unclaimed region");
  const [n] = await db.insert(playerNationsTable)
    .values({ discordUserId: userId, name: `${MARK}${runId}`, leaderName: "t", government: "君主制" })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
  await db.insert(regionControlsTable).values({ regionId: region!.id, nationId, percent: 100 });
  const era = await getStatsEraSlug();
  for (const nm of ["A", "B", "C", "D"]) {
    const [t] = await db.insert(militaryUnitTemplatesTable).values({
      ownerDiscordUserId: userId, isDefault: false, category: "infantry", name: `${MARK}${nm}-${runId}`,
      eraSlug: era, hp: 100, attack: 100, defense: 10, speed: 1, accuracy: 80, range: "melee",
      prodCostPer100: 1, popCostPerUnit: 1, moneyCostPerUnit: 10, prodUpkeepPerUnit: 0.1,
      woodCostPerUnit: 1,
    }).returning({ id: militaryUnitTemplatesTable.id });
    tpl.push(t!.id);
  }
  token = await createSession({ discordUserId: userId, username: userId, globalName: null, avatar: null, manageableGuildIds: [] });
  const app = express();
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", militaryRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await setRecruitQueueEnabled(false);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await db.delete(userSessionsTable).where(like(userSessionsTable.discordUserId, "rqhttp-%"));
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  await pool.end();
});

test("開關關閉：招募立刻生效、不進佇列（與舊版相同）", async () => {
  await setRecruitQueueEnabled(false);
  await reset();
  const r = await api("POST", "/api/military/recruit", { templateId: tpl[0], quantity: 50 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.queued, false);
  assert.equal(r.json.quantity, 50);
  assert.equal(await armyQty(), 50);
  assert.equal((await listNationQueue(nationId)).length, 0);
});

test("開關開啟：進佇列、資源當下已扣、軍隊不增加", async () => {
  await setRecruitQueueEnabled(true);
  await reset();
  const before = await nation();
  const r = await api("POST", "/api/military/recruit", { templateId: tpl[0], quantity: 50 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.queued, true);
  assert.equal(await armyQty(), 0, "佇列中的單位尚不是軍隊");
  const after = await nation();
  assert.equal(after.populationSpent - before.populationSpent, 50, "人口下單當下已佔用");
  assert.equal(before.wood - after.wood, 50, "木材下單當下已扣");
  const q = await listNationQueue(nationId);
  assert.equal(q.length, 1);
  assert.equal(q[0]!.remaining, 50);
  assert.equal(q[0]!.populationReserved, 50);
  assert.equal(q[0]!.woodPaid, 50);
});

test("滿 3 種：第 4 種 400 且整筆回滾；同兵種追加仍可", async () => {
  await setRecruitQueueEnabled(true);
  await reset();
  for (const i of [0, 1, 2]) {
    const r = await api("POST", "/api/military/recruit", { templateId: tpl[i], quantity: 10 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const snap = await nation();
  const rej = await api("POST", "/api/military/recruit", { templateId: tpl[3], quantity: 10 });
  assert.equal(rej.status, 400);
  assert.match(String(rej.json.error), /訓練佇列已滿/);
  const now = await nation();
  assert.equal(now.populationSpent, snap.populationSpent, "被拒時人口佔用必須回滾");
  assert.equal(now.productionSpent, snap.productionSpent, "被拒時生產力佔用必須回滾");
  assert.equal(now.wood, snap.wood, "被拒時木材必須回滾");
  assert.equal((await listNationQueue(nationId)).length, 3, "D 不得留下訂單");

  const again = await api("POST", "/api/military/recruit", { templateId: tpl[0], quantity: 5 });
  assert.equal(again.status, 200, "同兵種追加不受限");
  assert.equal((await listNationQueue(nationId)).length, 4);
});

test("取消：100% 退還，國家回到下單前", async () => {
  await setRecruitQueueEnabled(true);
  await reset();
  const start = await nation();
  const r = await api("POST", "/api/military/recruit", { templateId: tpl[0], quantity: 80 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const [order] = await listNationQueue(nationId);
  const c = await api("POST", "/api/military/queue/cancel", { orderId: order!.id });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const end = await nation();
  assert.equal(end.populationSpent, start.populationSpent);
  assert.equal(end.productionSpent, start.productionSpent);
  assert.equal(end.wood, start.wood);
  assert.equal(end.ore, start.ore);
  assert.equal((await listNationQueue(nationId)).length, 0);
  const again = await api("POST", "/api/military/queue/cancel", { orderId: order!.id });
  assert.equal(again.status, 404, "重複取消不得再次退款");
});

test("GET /military/queue：訂單、產能、預估回合", async () => {
  await setRecruitQueueEnabled(true);
  await reset();
  await api("POST", "/api/military/recruit", { templateId: tpl[0], quantity: 30 });
  const g = await api("GET", "/api/military/queue");
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(g.json.enabled, true);
  assert.equal(g.json.maxTemplates, 3);
  assert.ok(g.json.capacityPerTurn >= 1);
  assert.equal(g.json.orders.length, 1);
  assert.equal(g.json.orders[0].remaining, 30);
  assert.ok(g.json.orders[0].turnsToFinish >= 1);
});
