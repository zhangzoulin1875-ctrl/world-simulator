/**
 * 戰役補給預估與緊急運補整合測試（真 DB、真 HTTP、AI 樁）。
 *
 *  1. GET /supply：需求/庫存/缺口/可撐週期正確，且 = 結算用的同一套公式。
 *  2. POST /supply/resupply：金錢扣、彈藥加，與報價一致。
 *  3. 併發連點：N 個請求同時送，總扣款不超過金錢（金錢絕不為負）、彈藥不超過上限。
 *  4. 驗證：金錢不足 / 超過上限 / 非整數 / 冷兵器時代 / 非參戰方 / 戰役已結束。
 *  5. 跨戰役：同國兩場進行中戰役，需求相加（庫存是全國共用的）。
 *
 * 仿 war.supplySettle.test.ts 的建戰役方式 + regionBuildings.race.test.ts 的 HTTP 方式。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the supply resupply tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, gt, inArray, like, notExists, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerArmiesTable,
  playerNotificationsTable,
  regionControlsTable,
  mapCitiesTable,
  mapRegionAdjacenciesTable,
  militaryUnitTemplatesTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warRegionCooldownsTable,
  userSessionsTable,
  worldGameStateTable,
} = await import("@workspace/db");
const { initiateCampaign, flushWarBackgroundWork } = await import("../lib/warEngine");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runWallMigrations } = await import("../lib/wallMigrations");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { legionSupplyDemand } = await import("../lib/supply");
const warRouter = (await import("./war")).default;

const runId = randomBytes(4).toString("hex");
const NATION_MARKER = "__resuptest__";
const USER_MARKER = "resuptest-";
const atkUser = `${USER_MARKER}${runId}-atk`;
const outsiderUser = `${USER_MARKER}${runId}-out`;

let server: http.Server;
let baseUrl: string;
let atkToken = "";
let outsiderToken = "";
let attackerId = "";
let defenderId = "";
let outsiderId = "";
let templateId = 0;
let artilleryTemplateId = 0;
const usedRegions: number[] = [];

// AI 樁：開戰的背景地形簡報不打真 API。
const STUB = "測試樁地形簡報：兩地區以丘陵與河谷相接，攻守要點在渡口與城郊高地，補給線沿河而行。".repeat(3);
anthropic.messages.create = (async (params: { system?: unknown }) => {
  const system = typeof params?.system === "string" ? params.system : "";
  if (system.includes("兵種分析 AI")) {
    return { content: [{ type: "text", text: JSON.stringify({ counterSummary: "無", anachronisticUnits: [] }) }] };
  }
  return { content: [{ type: "text", text: STUB }] };
}) as unknown as typeof anthropic.messages.create;

async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function setEra(era: string): Promise<() => Promise<void>> {
  const [prev] = await db
    .select({ cur: worldGameStateTable.currentEra, st: worldGameStateTable.statsEra })
    .from(worldGameStateTable).where(eq(worldGameStateTable.id, 1)).limit(1);
  if (prev) {
    await db.update(worldGameStateTable).set({ currentEra: era, statsEra: era }).where(eq(worldGameStateTable.id, 1));
    return async () => {
      await db.update(worldGameStateTable).set({ currentEra: prev.cur, statsEra: prev.st }).where(eq(worldGameStateTable.id, 1));
    };
  }
  await db.insert(worldGameStateTable).values({ id: 1, currentEra: era, statsEra: era });
  return async () => { await db.delete(worldGameStateTable).where(eq(worldGameStateTable.id, 1)); };
}

async function cleanup(): Promise<void> {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db.delete(militaryUnitTemplatesTable).where(like(militaryUnitTemplatesTable.name, `${NATION_MARKER}%`));
  await db.delete(playerArmiesTable).where(like(playerArmiesTable.discordUserId, `${USER_MARKER}%`));
  await db.delete(playerNotificationsTable).where(like(playerNotificationsTable.discordUserId, `${USER_MARKER}%`));
  await db.delete(userSessionsTable).where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function findSparePair(): Promise<{ a: number; b: number }> {
  type AdjCol = typeof mapRegionAdjacenciesTable.regionId | typeof mapRegionAdjacenciesTable.adjacentRegionId;
  const uncontrolled = (c: AdjCol) => notExists(db.select({ one: sql`1` }).from(regionControlsTable).where(eq(regionControlsTable.regionId, c)));
  const notCooling = (c: AdjCol) => notExists(db.select({ one: sql`1` }).from(warRegionCooldownsTable).where(and(eq(warRegionCooldownsTable.regionId, c), gt(warRegionCooldownsTable.expiresAt, new Date()))));
  const noCities = (c: AdjCol) => notExists(db.select({ one: sql`1` }).from(mapCitiesTable).where(eq(mapCitiesTable.regionId, c)));
  const pairs = await db
    .select({ a: mapRegionAdjacenciesTable.regionId, b: mapRegionAdjacenciesTable.adjacentRegionId })
    .from(mapRegionAdjacenciesTable)
    .where(and(
      sql`${mapRegionAdjacenciesTable.regionId} < ${mapRegionAdjacenciesTable.adjacentRegionId}`,
      uncontrolled(mapRegionAdjacenciesTable.regionId), uncontrolled(mapRegionAdjacenciesTable.adjacentRegionId),
      notCooling(mapRegionAdjacenciesTable.regionId), notCooling(mapRegionAdjacenciesTable.adjacentRegionId),
      noCities(mapRegionAdjacenciesTable.regionId), noCities(mapRegionAdjacenciesTable.adjacentRegionId),
    ))
    .orderBy(mapRegionAdjacenciesTable.regionId, mapRegionAdjacenciesTable.adjacentRegionId)
    .limit(200);
  const pair = pairs.find((p) => !usedRegions.includes(p.a) && !usedRegions.includes(p.b));
  assert.ok(pair, "need an unclaimed, city-free adjacent region pair");
  usedRegions.push(pair.a, pair.b);
  return pair;
}

/**
 * 建一場進行中戰役，攻方軍團 = 8000 步兵 + 400 火砲（工業時代 3600 彈藥/週期）。
 * 預設先收掉先前測試遺留的進行中戰役：需求是跨戰役加總的（功能本身如此），
 * 不收的話每個測試會看到累積的需求。keepOthers 供「跨戰役」測試使用。
 */
async function newCampaign(keepOthers = false): Promise<number> {
  if (!keepOthers) {
    await db.update(warCampaignsTable).set({ status: "ended" }).where(eq(warCampaignsTable.attackerNationId, attackerId));
  }
  const { a: rA, b: rB } = await findSparePair();
  await db.insert(regionControlsTable).values([
    { regionId: rA, nationId: attackerId, percent: 80 },
    { regionId: rB, nationId: defenderId, percent: 70 },
  ]);
  const campaign = await initiateCampaign({ attackerNationId: attackerId, attackerRegionId: rA, defenderRegionId: rB });
  await db.delete(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, campaign.id));
  const [legion] = await db
    .insert(warCampaignLegionsTable)
    .values({ campaignId: campaign.id, nationId: attackerId, slot: "A", morale: 80, supply: 100, garrisoningCity: false })
    .returning({ id: warCampaignLegionsTable.id });
  await db.insert(warCampaignLegionUnitsTable).values([
    { legionId: legion!.id, templateId, quantity: 8000, wounded: 0 },
    { legionId: legion!.id, templateId: artilleryTemplateId, quantity: 400, wounded: 0 },
  ]);
  await flushWarBackgroundWork();
  return campaign.id;
}

async function nation() {
  const [r] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, attackerId));
  return r!;
}
async function setNation(values: Record<string, unknown>) {
  await db.update(playerNationsTable).set(values).where(eq(playerNationsTable.id, attackerId));
}

let restoreEra: () => Promise<void> = async () => {};

before(async () => {
  await runWallMigrations();
  await cleanup();
  const mk = async (suffix: string, opts: { npc?: boolean; user?: string }) => {
    const [row] = await db.insert(playerNationsTable).values({
      name: `${NATION_MARKER}${runId}-${suffix}`, leaderName: "運補測試", government: "君主制",
      isNpc: opts.npc ?? false, discordUserId: opts.user ?? null,
    }).returning({ id: playerNationsTable.id });
    return row!.id;
  };
  attackerId = await mk("atk", { user: atkUser });
  defenderId = await mk("def", { npc: true });
  outsiderId = await mk("out", { user: outsiderUser });
  const [aId, bId] = [attackerId, defenderId].sort();
  await db.insert(diplomacyWarsTable).values({ nationAId: aId!, nationBId: bId!, declaredByNationId: attackerId });

  const base = { hp: 100, attack: 100, defense: 10, speed: 1, accuracy: 80, range: "melee", prodCostPer100: 1, popCostPerUnit: 1, moneyCostPerUnit: 10 } as const;
  const [inf] = await db.insert(militaryUnitTemplatesTable).values({ ...base, category: "infantry", ownerDiscordUserId: atkUser, name: `${NATION_MARKER}${runId}-步兵` }).returning({ id: militaryUnitTemplatesTable.id });
  const [art] = await db.insert(militaryUnitTemplatesTable).values({ ...base, category: "artillery", ownerDiscordUserId: atkUser, name: `${NATION_MARKER}${runId}-火砲` }).returning({ id: militaryUnitTemplatesTable.id });
  templateId = inf!.id;
  artilleryTemplateId = art!.id;
  await db.insert(militaryUnitTemplatesTable).values({ ...base, category: "infantry", ownerNationId: defenderId, name: `${NATION_MARKER}${runId}-NPC步兵` });
  await db.insert(playerArmiesTable).values([
    { discordUserId: atkUser, templateId, quantity: 50_000 },
    { discordUserId: atkUser, templateId: artilleryTemplateId, quantity: 5_000 },
  ]);

  restoreEra = await setEra("industrial");

  const mkSession = (u: string) => createSession({ discordUserId: u, username: u, globalName: null, avatar: null, manageableGuildIds: [] });
  atkToken = await mkSession(atkUser);
  outsiderToken = await mkSession(outsiderUser);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
  app.use("/api", warRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await restoreEra();
  await cleanup();
  if (usedRegions.length > 0) {
    await db.delete(warRegionCooldownsTable).where(inArray(warRegionCooldownsTable.regionId, usedRegions));
  }
  await flushWarBackgroundWork();
  if (server) await new Promise((r) => server.close(r));
  await pool.end();
});

const EXPECTED_DEMAND = legionSupplyDemand(
  [{ quantity: 8000, category: "infantry" }, { quantity: 400, category: "artillery" }],
  "industrial",
).ammo; // 3600

test("GET /supply：需求、缺口、可撐週期與結算同一套公式", async () => {
  const cid = await newCampaign();
  await setNation({ ammo: 1800, money: 100_000 });
  const r = await api(atkToken, "GET", `/war/campaigns/${cid}/supply`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(EXPECTED_DEMAND, 3600);
  assert.equal(r.json.totalAmmoDemand, EXPECTED_DEMAND);
  assert.equal(r.json.ammoStock, 1800);
  assert.equal(r.json.ammoShortfall, 1800);
  assert.equal(r.json.cyclesOfAmmo, 0.5);
  assert.equal(r.json.legionsShort, 1);
  assert.equal(r.json.ammoRelevant, true);
  assert.equal(r.json.unitPrice, 2.3);
  assert.equal(r.json.maxResupply, EXPECTED_DEMAND * 5 - 1800);
  assert.equal(r.json.money, 100_000);
  assert.equal(r.json.legions.length, 1);
  assert.equal(r.json.legions[0].ammoDemand, EXPECTED_DEMAND);
});

test("GET /supply：庫存足夠時無缺口", async () => {
  const cid = await newCampaign();
  await setNation({ ammo: 10_800 });
  const r = await api(atkToken, "GET", `/war/campaigns/${cid}/supply`);
  assert.equal(r.json.ammoShortfall, 0);
  assert.equal(r.json.cyclesOfAmmo, 3);
  assert.equal(r.json.legionsShort, 0);
});

test("POST resupply：扣金錢、加彈藥，數字與報價一致", async () => {
  const cid = await newCampaign();
  await setNation({ ammo: 0, money: 100_000 });
  const r = await api(atkToken, "POST", `/war/campaigns/${cid}/supply/resupply`, { amount: 1000 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.cost, 2300);
  assert.equal(r.json.amount, 1000);
  const n = await nation();
  assert.equal(Number(n.ammo), 1000);
  assert.equal(Number(n.money), 100_000 - 2300);
  assert.equal(r.json.ammo, 1000);
  assert.equal(r.json.money, 100_000 - 2300);
});

test("併發連點：總扣款不超過金錢、金錢絕不為負", async () => {
  const cid = await newCampaign();
  // 只夠買 2 次 1000（每次 2300），其餘必須被擋。
  await setNation({ ammo: 0, money: 5000 });
  const results = await Promise.all(
    Array.from({ length: 8 }, () => api(atkToken, "POST", `/war/campaigns/${cid}/supply/resupply`, { amount: 1000 })),
  );
  const ok = results.filter((r) => r.status === 200).length;
  const rejected = results.filter((r) => r.status === 400).length;
  assert.equal(ok, 2, `應恰好 2 次成功,實際 ${ok}: ${JSON.stringify(results.map((r) => r.status))}`);
  assert.equal(ok + rejected, 8, "其餘都應是 400(金錢不足),不能有 500");
  const n = await nation();
  assert.equal(Number(n.ammo), 2000);
  assert.equal(Number(n.money), 5000 - 2 * 2300);
  assert.ok(Number(n.money) >= 0);
});

test("併發連點：彈藥不超過上限(N 週期需求)", async () => {
  const cid = await newCampaign();
  const cap = EXPECTED_DEMAND * 5; // 18000
  await setNation({ ammo: 0, money: 10_000_000 });
  // 每次 6000,一共 8 次 = 48000,但上限只有 18000 → 恰好 3 次成功。
  const results = await Promise.all(
    Array.from({ length: 8 }, () => api(atkToken, "POST", `/war/campaigns/${cid}/supply/resupply`, { amount: 6000 })),
  );
  const ok = results.filter((r) => r.status === 200).length;
  assert.equal(ok, 3, JSON.stringify(results.map((r) => r.status)));
  assert.equal(results.filter((r) => r.status === 500).length, 0);
  assert.equal(Number((await nation()).ammo), cap);
});

test("驗證:金錢不足、超過上限、非整數、<1 都被擋且不扣款", async () => {
  const cid = await newCampaign();
  await setNation({ ammo: 0, money: 100 });
  const post = (amount: unknown) => api(atkToken, "POST", `/war/campaigns/${cid}/supply/resupply`, { amount });

  const poor = await post(1000);
  assert.equal(poor.status, 400);
  assert.match(poor.json.error, /金錢不足/);

  await setNation({ money: 10_000_000 });
  assert.equal((await post(18_001)).status, 400);
  assert.equal((await post(1.5)).status, 400);
  assert.equal((await post(0)).status, 400);
  assert.equal((await post(-5)).status, 400);
  assert.equal((await post("100")).status, 400);
  assert.equal((await post(undefined)).status, 400);

  const n = await nation();
  assert.equal(Number(n.ammo), 0, "被擋的請求不能增加彈藥");
  assert.equal(Number(n.money), 10_000_000, "被擋的請求不能扣款");
});

test("驗證:庫存已足夠撐過 5 週期則拒絕", async () => {
  const cid = await newCampaign();
  await setNation({ ammo: EXPECTED_DEMAND * 5, money: 10_000_000 });
  const r = await api(atkToken, "POST", `/war/campaigns/${cid}/supply/resupply`, { amount: 1 });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /已足夠/);
});

test("權限:非參戰方 403(GET 與 POST 都擋)", async () => {
  const cid = await newCampaign();
  await setNation({ ammo: 0, money: 100_000 });
  assert.equal((await api(outsiderToken, "GET", `/war/campaigns/${cid}/supply`)).status, 403);
  const p = await api(outsiderToken, "POST", `/war/campaigns/${cid}/supply/resupply`, { amount: 100 });
  assert.equal(p.status, 403);
  assert.equal(Number((await nation()).ammo), 0);
});

test("戰役已結束:不可運補(409),不扣款", async () => {
  const cid = await newCampaign();
  await setNation({ ammo: 0, money: 100_000 });
  await db.update(warCampaignsTable).set({ status: "ended" }).where(eq(warCampaignsTable.id, cid));
  const r = await api(atkToken, "POST", `/war/campaigns/${cid}/supply/resupply`, { amount: 100 });
  assert.equal(r.status, 409);
  const n = await nation();
  assert.equal(Number(n.money), 100_000);
  assert.equal(Number(n.ammo), 0);
});

test("冷兵器時代:不需彈藥,運補被擋", async () => {
  const cid = await newCampaign();
  const back = await setEra("roman");
  try {
    await setNation({ ammo: 0, money: 100_000 });
    const g = await api(atkToken, "GET", `/war/campaigns/${cid}/supply`);
    assert.equal(g.json.ammoRelevant, false);
    assert.equal(g.json.totalAmmoDemand, 0);
    const p = await api(atkToken, "POST", `/war/campaigns/${cid}/supply/resupply`, { amount: 10 });
    assert.equal(p.status, 400);
    assert.equal(Number((await nation()).money), 100_000);
  } finally {
    await back();
  }
});

test("跨戰役:同國兩場進行中戰役,需求相加(庫存全國共用)", async () => {
  // 先把先前測試遺留的進行中戰役收掉,確保只剩這兩場。
  const c1 = await newCampaign();
  const c2 = await newCampaign(true);
  await setNation({ ammo: 0, money: 100_000 });
  const r = await api(atkToken, "GET", `/war/campaigns/${c1}/supply`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.activeCampaignCount, 2);
  assert.equal(r.json.totalAmmoDemand, EXPECTED_DEMAND * 2);
  assert.equal(r.json.legions.length, 2);
  // 從另一場戰役看,數字相同(同一個全國庫存池)
  const r2 = await api(atkToken, "GET", `/war/campaigns/${c2}/supply`);
  assert.equal(r2.json.totalAmmoDemand, EXPECTED_DEMAND * 2);
  // 上限也是以兩場合計需求計
  assert.equal(r.json.maxResupply, EXPECTED_DEMAND * 2 * 5);
});
