/**
 * 導彈系統整合測試(真實資料庫 + HTTP):
 *  - 1960 年前鎖住、之後開放
 *  - 只能打「交戰中」國家控制的地區;未開戰 / 自己的地 / 無主地 → 拒絕
 *  - 國庫門檻、費用 = 國庫 × 10/33/50%、目標國庫不動
 *  - 目標地區人口與地區建築各扣 3/12/20%(其他地區不受影響);炸毀時釋放生產力占用
 *  - 每國每回合限射一發(含併發連點只有一發成功)
 * world_game_state 是共用單例:以 advisory lock 序列化,結束後還原。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, like, notExists, sql } = await import("drizzle-orm");
const {
  db, pool, playerNationsTable, regionControlsTable, regionBuildingsTable, mapRegionsTable,
  userSessionsTable, diplomacyWarsTable, missileStrikesTable, worldGameStateTable, playerNotificationsTable,
} = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const MIGS = [
  ["gameMigrations", "runGameMigrations"], ["mapRegions", "runMapRegionSync"],
  ["gameMigrations", "runRegionControlMigrations"], ["mapRegionEraStats", "runMapRegionEraStatsSync"],
  ["mapCities", "runMapCitySync"], ["mapV2Reset", "runMapV2RegionReset"],
  ["militaryMigrations", "runMilitaryMigrations"], ["weaponMigrations", "runWeaponMigrations"],
  ["diplomacyMigrations", "runDiplomacyMigrations"], ["resourceMigrations", "runResourceMigrations"],
  ["politicsMigrations", "runPoliticsMigrations"], ["cabinetMigrations", "runCabinetMigrations"],
  ["autopilotMigrations", "runAutopilotMigrations"], ["warMigrations", "runWarMigrations"],
  ["mercenaryMigrations", "runMercenaryMigrations"], ["economyMigrations", "runEconomyMigrations"],
  ["socialTechMigrations", "runSocialTechMigrations"], ["productionMigrations", "runProductionMigrations"],
  ["techTreeMigrations", "runTechTreeMigrations"], ["wallMigrations", "runWallMigrations"],
  ["worldSimMigrations", "runWorldSimMigrations"], ["gameNewsMigrations", "runGameNewsMigrations"],
  ["accountBanMigrations", "runAccountBanMigrations"], ["superEventMigrations", "runSuperEventMigrations"],
  ["gameBalanceMigrations", "runGameBalanceMigrations"], ["aiUsageMigrations", "runAiUsageMigrations"],
  ["aiPregenMigrations", "runAiPregenMigrations"], ["generalsMigrations", "runGeneralsMigrations"],
  ["parliamentMigrations", "runParliamentMigrations"], ["nationNameSanitizeMigration", "runNationNameSanitizeMigration"],
] as const;
const { getEraSlugs } = await import("../lib/nationStats");
const { eraCostScale } = await import("../lib/eraCostScale");
const { missileMinTreasury } = await import("../lib/missile");
const { mapRegionPopulation } = await import("../lib/missileRegion");
const router = (await import("./missile")).default;

const TAG = "__missiletest__";
const runId = randomBytes(4).toString("hex");
const atkUser = `${TAG}atk_${runId}`;
const defUser = `${TAG}def_${runId}`;
const peaceUser = `${TAG}peace_${runId}`;
const LOCK_KEY = 9_999_999_901;

let server: http.Server;
let baseUrl: string;
let token: string;
let atkId: string;
let defId: string;
let peaceId: string;
let defRegionA: number;
let defRegionB: number;
let peaceRegion: number;
let minTreasury: number;
let statsEra: string;
let lockClient: any;
let worldBefore: { gameDate: string; lastTurnAt: Date | null };

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}
async function setWorld(gameDate: string, turnMs: number) {
  await db.update(worldGameStateTable).set({ gameDate, lastTurnAt: new Date(turnMs) }).where(eq(worldGameStateTable.id, 1));
}
async function nation(id: string) {
  const [r] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id));
  return r!;
}
async function cleanup() {
  await db.delete(playerNotificationsTable).where(like(playerNotificationsTable.discordUserId, `${TAG}%`));
  await db.delete(missileStrikesTable).where(like(missileStrikesTable.attackerName, `${TAG}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  await db.delete(userSessionsTable).where(like(userSessionsTable.discordUserId, `${TAG}%`));
}
async function resetState(money = 10_000_000_000) {
  await db.delete(missileStrikesTable).where(like(missileStrikesTable.attackerName, `${TAG}%`));
  await db.update(playerNationsTable).set({ money }).where(eq(playerNationsTable.id, atkId));
  await db.update(playerNationsTable).set({ money: 5_000_000_000, productionSpent: 0 }).where(eq(playerNationsTable.id, defId));
  await db.update(regionControlsTable).set({ populationBonus: 0 }).where(eq(regionControlsTable.nationId, defId));
  await db.delete(regionBuildingsTable).where(eq(regionBuildingsTable.nationId, defId));
}
async function openWar() {
  const [low, high] = [atkId, defId].sort();
  await db.insert(diplomacyWarsTable).values({ nationAId: low!, nationBId: high!, declaredByNationId: atkId });
}
async function closeWar() {
  await db.delete(diplomacyWarsTable).where(eq(diplomacyWarsTable.declaredByNationId, atkId));
}
let turnSeq = 0;
const nextTurn = async (date = "1965-06-01") => setWorld(date, Date.UTC(2030, 0, 1) + ++turnSeq * 3_600_000);

before(async () => {
  for (const [mod, fn] of MIGS) await (await import(`../lib/${mod}`) as any)[fn]();
  lockClient = await (pool as any).connect();
  await lockClient.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  const [w] = await db.select({ gameDate: worldGameStateTable.gameDate, lastTurnAt: worldGameStateTable.lastTurnAt })
    .from(worldGameStateTable).where(eq(worldGameStateTable.id, 1));
  worldBefore = { gameDate: w!.gameDate, lastTurnAt: w!.lastTurnAt };
  await cleanup();

  const free = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable)
    .where(notExists(db.select({ one: sql`1` }).from(regionControlsTable).where(eq(regionControlsTable.regionId, mapRegionsTable.id))))
    .orderBy(mapRegionsTable.id).limit(4);
  assert.equal(free.length, 4, "需要 4 個無主地區");
  [defRegionA, defRegionB, peaceRegion] = [free[0]!.id, free[1]!.id, free[2]!.id];
  const atkRegion = free[3]!.id;

  const mk = async (uid: string, name: string) =>
    (await db.insert(playerNationsTable).values({ discordUserId: uid, name: `${TAG}${name}${runId}`, leaderName: "導彈測試", government: "君主制" })
      .returning({ id: playerNationsTable.id }))[0]!.id;
  atkId = await mk(atkUser, "atk");
  defId = await mk(defUser, "def");
  peaceId = await mk(peaceUser, "peace");
  await db.insert(regionControlsTable).values([
    { regionId: defRegionA, nationId: defId, percent: 100 },
    { regionId: defRegionB, nationId: defId, percent: 100 },
    { regionId: peaceRegion, nationId: peaceId, percent: 100 },
    { regionId: atkRegion, nationId: atkId, percent: 100 },
  ]);

  ({ statsEra } = await getEraSlugs());
  const { currentEra } = await getEraSlugs();
  minTreasury = missileMinTreasury(eraCostScale(currentEra));

  token = await createSession({ discordUserId: atkUser, username: "atk", globalName: null, avatar: null, manageableGuildIds: [] });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
  app.use("/api", router);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  try {
    await cleanup();
    await db.update(worldGameStateTable).set({ gameDate: worldBefore.gameDate, lastTurnAt: worldBefore.lastTurnAt }).where(eq(worldGameStateTable.id, 1));
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    lockClient.release();
    await pool.end();
  }
});

test("1960 年前:導彈鎖住", async () => {
  await resetState(); await openWar(); await nextTurn("1959-12-31");
  const info = await api("GET", "/api/player/missiles");
  assert.equal(info.json.unlocked, false);
  const r = await api("POST", "/api/player/missiles/launch", { missileType: "medium", targetRegionId: defRegionA });
  assert.equal(r.status, 403);
  assert.equal((await nation(atkId)).money, 10_000_000_000, "不應扣款");
  await closeWar();
});

test("未開戰 / 無主地 / 自己的地 / 和平國家的地 → 全部拒絕且不扣款", async () => {
  await resetState(); await nextTurn();
  const noWar = await api("POST", "/api/player/missiles/launch", { missileType: "medium", targetRegionId: defRegionA });
  assert.equal(noWar.status, 400);
  await openWar();
  const peace = await api("POST", "/api/player/missiles/launch", { missileType: "medium", targetRegionId: peaceRegion });
  assert.equal(peace.status, 400, "沒有交戰的國家不能打");
  const bad = await api("POST", "/api/player/missiles/launch", { missileType: "nuke", targetRegionId: defRegionA });
  assert.equal(bad.status, 400);
  assert.equal((await nation(atkId)).money, 10_000_000_000);
  assert.equal((await db.select().from(missileStrikesTable).where(eq(missileStrikesTable.targetNationId, defId))).length, 0);
  await closeWar();
});

test("國庫低於門檻 → 拒絕", async () => {
  await resetState(minTreasury - 1); await openWar(); await nextTurn();
  const r = await api("POST", "/api/player/missiles/launch", { missileType: "strategic_nuke", targetRegionId: defRegionA });
  assert.equal(r.status, 400);
  assert.equal(Number((await nation(atkId)).money), minTreasury - 1);
  await closeWar();
});

for (const [type, costPct, dmgPct] of [["medium", 10, 3], ["tactical_nuke", 33, 12], ["strategic_nuke", 50, 20]] as const) {
  test(`${type}:扣發射國國庫 ${costPct}%、目標地區人口與建築各扣 ${dmgPct}%、其他地區與目標國庫不動`, async () => {
    const money = 10_000_000_000;
    await resetState(money); await openWar(); await nextTurn();
    // 目標地區 A:lv10 建築(占用 1000);地區 B:lv10 建築(不應受影響)
    await db.insert(regionBuildingsTable).values([
      { nationId: defId, regionId: defRegionA, buildingType: "mine", level: 10, productionReserved: 1000 },
      { nationId: defId, regionId: defRegionB, buildingType: "mine", level: 10, productionReserved: 1000 },
      { nationId: defId, regionId: defRegionA, buildingType: "lumber_mill", level: 1, productionReserved: 200 },
    ]);
    await db.update(playerNationsTable).set({ productionSpent: 2200 }).where(eq(playerNationsTable.id, defId));
    const popA0 = await db.transaction((tx) => mapRegionPopulation(tx, defId, defRegionA, statsEra));
    const popB0 = await db.transaction((tx) => mapRegionPopulation(tx, defId, defRegionB, statsEra));
    assert.ok(popA0 > 0, "測試地區需有人口");

    const r = await api("POST", "/api/player/missiles/launch", { missileType: type, targetRegionId: defRegionA });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const expectCost = Math.floor((money * costPct) / 100);
    assert.equal(Number((await nation(atkId)).money), money - expectCost, "發射國扣國庫 %");
    assert.equal(r.json.cost, expectCost);
    assert.equal(Number((await nation(defId)).money), 5_000_000_000, "目標國國庫不動");

    const popA1 = await db.transaction((tx) => mapRegionPopulation(tx, defId, defRegionA, statsEra));
    const popB1 = await db.transaction((tx) => mapRegionPopulation(tx, defId, defRegionB, statsEra));
    const expectLoss = Math.floor((popA0 * dmgPct) / 100);
    assert.equal(popA0 - popA1, expectLoss, "目標地區人口扣 %");
    assert.equal(popB1, popB0, "其他地區人口不動");
    assert.equal(r.json.populationLost, expectLoss);

    const bA = await db.select().from(regionBuildingsTable).where(and(eq(regionBuildingsTable.nationId, defId), eq(regionBuildingsTable.regionId, defRegionA)));
    const mineA = bA.find((b) => b.buildingType === "mine")!;
    const lumberA = bA.find((b) => b.buildingType === "lumber_mill");
    const keptLv = Math.min(Math.floor((10 * (100 - dmgPct)) / 100), 9);
    assert.equal(mineA.level, keptLv, "礦場降級");
    assert.equal(lumberA, undefined, "1 級伐木場被炸毀");
    const bB = await db.select().from(regionBuildingsTable).where(and(eq(regionBuildingsTable.nationId, defId), eq(regionBuildingsTable.regionId, defRegionB)));
    assert.equal(bB[0]!.level, 10, "其他地區建築不動");

    // 生產力占用不變量:production_spent = Σ 建築 production_reserved
    const all = await db.select().from(regionBuildingsTable).where(eq(regionBuildingsTable.nationId, defId));
    const sumReserved = all.reduce((s, b) => s + b.productionReserved, 0);
    assert.equal((await nation(defId)).productionSpent, sumReserved, "占用不變量維持");
    assert.equal(r.json.buildingsDestroyed, 1);
    assert.equal(r.json.buildingsDowngraded, 1);
    await closeWar();
  });
}

test("每國每回合限射一發;下一回合可再射", async () => {
  await resetState(); await openWar(); await nextTurn();
  const a = await api("POST", "/api/player/missiles/launch", { missileType: "medium", targetRegionId: defRegionA });
  assert.equal(a.status, 200);
  const moneyAfterFirst = Number((await nation(atkId)).money);
  const b = await api("POST", "/api/player/missiles/launch", { missileType: "medium", targetRegionId: defRegionB });
  assert.equal(b.status, 409);
  assert.equal(Number((await nation(atkId)).money), moneyAfterFirst, "第二發不扣款");
  const info = await api("GET", "/api/player/missiles");
  assert.equal(info.json.firedThisTurn, true);
  await nextTurn();
  const c = await api("POST", "/api/player/missiles/launch", { missileType: "medium", targetRegionId: defRegionB });
  assert.equal(c.status, 200, "新回合可再射");
  await closeWar();
});

test("連點 / 併發:同一回合只有一發成功,只扣一次款", async () => {
  await resetState(); await openWar(); await nextTurn();
  const money = 10_000_000_000;
  const rs = await Promise.all([1, 2, 3, 4].map(() => api("POST", "/api/player/missiles/launch", { missileType: "medium", targetRegionId: defRegionA })));
  const ok = rs.filter((r) => r.status === 200).length;
  assert.equal(ok, 1, `應只有 1 發成功: ${rs.map((r) => r.status)}`);
  assert.equal(Number((await nation(atkId)).money), money - Math.floor(money / 10), "只扣一次");
  assert.equal((await db.select().from(missileStrikesTable).where(eq(missileStrikesTable.attackerNationId, atkId))).length, 1);
  await closeWar();
});

test("被炸的玩家收到站內通知;戰爭結束後不能再打", async () => {
  await resetState(); await openWar(); await nextTurn();
  const r = await api("POST", "/api/player/missiles/launch", { missileType: "medium", targetRegionId: defRegionA });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 200));
  const notes = await db.select().from(playerNotificationsTable).where(eq(playerNotificationsTable.discordUserId, defUser));
  assert.ok(notes.some((n) => n.type === "missile_strike"), "目標玩家應收到通知");
  await closeWar(); await nextTurn();
  const after = await api("POST", "/api/player/missiles/launch", { missileType: "medium", targetRegionId: defRegionA });
  assert.equal(after.status, 400, "停戰後不能再打");
});
