/**
 * 全民皆兵整合測試(真實資料庫 + HTTP):
 *  - 開啟條件:必須戰爭中、穩定度夠、無僱傭兵合約;重複開啟被拒
 *  - 開啟:10% 可徵召人口變民兵(player_armies 一列),population_spent 同額增加,總人口不變
 *  - 回合:開啟期間每回合固定 −1 穩定度(與國庫危機懲罰合併成一次寫入);未開啟不扣
 *  - 關閉:民兵解散、人口如數補回;前線派駐中的民兵不解散但狀態關閉
 *  - 互斥:開啟中不能簽僱傭兵;解除武裝會一併解散民兵並關閉
 *  - 併發連點:只會開啟一次
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
  db, pool, playerNationsTable, playerArmiesTable, regionControlsTable, mapRegionsTable,
  userSessionsTable, diplomacyWarsTable, totalMobilizationStatesTable, mercenaryStatesTable,
} = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { getEraSlugs, computeNationStats } = await import("../lib/nationStats");
const { levyAmount } = await import("../lib/totalMobilization");
const { tickMobilizationStability, startMobilization, stopMobilization } = await import("../lib/totalMobilizationService");
const { signContract, disarmNation } = await import("../lib/mercenaryService");
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
const router = (await import("./mobilization")).default;

const TAG = "__mobtest__";
const runId = randomBytes(4).toString("hex");
const userId = `${TAG}u_${runId}`;
const foeUser = `${TAG}f_${runId}`;
let server: http.Server;
let baseUrl: string;
let token: string;
let nationId: string;
let foeId: string;
let statsEra: string;

async function api(method: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  return { status: res.status, json: (await res.json()) as any };
}
const nation = async () => (await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId)))[0]!;
const armies = () => db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
const mobState = async () => (await db.select().from(totalMobilizationStatesTable).where(eq(totalMobilizationStatesTable.nationId, nationId)))[0];
async function cleanup() {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  await db.delete(userSessionsTable).where(like(userSessionsTable.discordUserId, `${TAG}%`));
}
async function reset(over: Record<string, unknown> = {}) {
  await db.delete(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  await db.delete(totalMobilizationStatesTable).where(eq(totalMobilizationStatesTable.nationId, nationId));
  await db.delete(mercenaryStatesTable).where(eq(mercenaryStatesTable.nationId, nationId));
  await db.update(playerNationsTable).set({ populationSpent: 0, productionSpent: 0, stability: 50, ...over }).where(eq(playerNationsTable.id, nationId));
}
const closeWar = () => db.delete(diplomacyWarsTable).where(eq(diplomacyWarsTable.declaredByNationId, nationId));
const openWar = async () => {
  await closeWar();
  const [a, b] = [nationId, foeId].sort();
  await db.insert(diplomacyWarsTable).values({ nationAId: a!, nationBId: b!, declaredByNationId: nationId });
};

before(async () => {
  for (const [mod, fn] of MIGS) await (await import(`../lib/${mod}`) as any)[fn]();
  await cleanup();
  const free = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable)
    .where(notExists(db.select({ one: sql`1` }).from(regionControlsTable).where(eq(regionControlsTable.regionId, mapRegionsTable.id))))
    .orderBy(mapRegionsTable.id).limit(2);
  assert.equal(free.length, 2, "需要 2 個無主地區");
  const mk = async (uid: string, name: string) =>
    (await db.insert(playerNationsTable).values({ discordUserId: uid, name: `${TAG}${name}${runId}`, leaderName: "全民皆兵測試", government: "君主制" })
      .returning({ id: playerNationsTable.id }))[0]!.id;
  nationId = await mk(userId, "me");
  foeId = await mk(foeUser, "foe");
  await db.insert(regionControlsTable).values([
    { regionId: free[0]!.id, nationId, percent: 100 },
    { regionId: free[1]!.id, nationId: foeId, percent: 100 },
  ]);
  ({ statsEra } = await getEraSlugs());
  token = await createSession({ discordUserId: userId, username: "mob", globalName: null, avatar: null, manageableGuildIds: [] });
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
  try { await cleanup(); } finally {
    if (server) await new Promise((r) => server.close(r));
    await pool.end();
  }
});

test("不在戰爭中 → 不能開;狀態 API 顯示 atWar=false", async () => {
  await reset(); await closeWar();
  const info = await api("GET", "/api/player/mobilization");
  assert.equal(info.status, 200);
  assert.equal(info.json.atWar, false);
  assert.ok(info.json.previewLevy > 0);
  const r = await api("POST", "/api/player/mobilization/start");
  assert.equal(r.status, 409);
  assert.match(r.json.error, /戰爭/);
  assert.equal((await armies()).length, 0);
  assert.equal((await nation()).populationSpent, 0);
});

test("開啟:10% 可徵召人口 → 民兵,人口占用同額增加,總人口不變", async () => {
  await reset(); await openWar();
  const before = await computeNationStats(nationId, statsEra);
  const expected = levyAmount(before.population, 0);
  assert.ok(expected > 0);
  const r = await api("POST", "/api/player/mobilization/start");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.levy, expected);
  const a = await armies();
  assert.equal(a.length, 1);
  assert.equal(a[0]!.quantity, expected);
  assert.equal(a[0]!.populationReserved, expected, "人口以 populationReserved 占用");
  assert.equal(a[0]!.productionReserved, 0, "民兵不占生產力");
  assert.equal((await nation()).populationSpent, expected);
  assert.equal((await computeNationStats(nationId, statsEra)).population, before.population, "總人口不變");
  assert.equal((await mobState())!.active, true);
  // 重複開啟被拒,且不會多徵
  const again = await api("POST", "/api/player/mobilization/start");
  assert.equal(again.status, 409);
  assert.equal((await armies())[0]!.quantity, expected);
  await closeWar();
});

test("併發連點開啟:不論回應幾次,資料上只徵召一次(不變量)", async () => {
  await reset(); await openWar();
  const before = await computeNationStats(nationId, statsEra);
  const expected = levyAmount(before.population, 0);
  const rs = await Promise.all([1, 2, 3, 4].map(() => api("POST", "/api/player/mobilization/start")));
  assert.ok(rs.some((r) => r.status === 200), "至少一次成功");
  assert.ok(rs.every((r) => r.status === 200 || r.status === 409), `只應是 200/409: ${rs.map((r) => r.status)}`);
  const a = await armies();
  assert.equal(a.length, 1);
  assert.equal(a[0]!.quantity, expected, "只徵召一次");
  assert.equal(a[0]!.populationReserved, expected);
  assert.equal((await nation()).populationSpent, expected, "人口只占用一次");
  await closeWar();
});

test("穩定度:開啟每回合 −1;未開啟不扣;穩定度不會低於 0", async () => {
  await reset(); await openWar();
  assert.equal(await tickMobilizationStability(nationId), 0, "未開啟不扣");
  await api("POST", "/api/player/mobilization/start");
  assert.equal(await tickMobilizationStability(nationId), -1);
  assert.equal(await tickMobilizationStability(nationId), -1);
  assert.equal(Number((await mobState())!.totalStabilityLost), 2, "累計統計");
  await closeWar();
});

test("穩定度太低不能開", async () => {
  await reset({ stability: 10 }); await openWar();
  const r = await api("POST", "/api/player/mobilization/start");
  assert.equal(r.status, 409);
  assert.match(r.json.error, /穩定度/);
  await closeWar();
});

test("關閉:民兵解散、人口如數補回、狀態關閉", async () => {
  await reset(); await openWar();
  const start = await api("POST", "/api/player/mobilization/start");
  const levy = start.json.levy as number;
  assert.equal((await nation()).populationSpent, levy);
  const stop = await api("POST", "/api/player/mobilization/stop");
  assert.equal(stop.status, 200, JSON.stringify(stop.json));
  assert.equal(stop.json.disbanded, levy);
  assert.equal(stop.json.releasedPopulation, levy);
  assert.equal((await armies()).length, 0);
  assert.equal((await nation()).populationSpent, 0, "占用人口補回");
  assert.equal((await mobState())!.active, false);
  assert.equal(await tickMobilizationStability(nationId), 0, "關閉後不再扣");
  const stop2 = await api("POST", "/api/player/mobilization/stop");
  assert.equal(stop2.status, 409, "沒開啟時不能關閉");
  await closeWar();
});

test("先用掉一部分人口再開:只徵召『剩餘可徵召人口』的 10%", async () => {
  await reset(); await openWar();
  const pop = (await computeNationStats(nationId, statsEra)).population;
  const used = Math.floor(pop / 2);
  await db.update(playerNationsTable).set({ populationSpent: used }).where(eq(playerNationsTable.id, nationId));
  const r = await api("POST", "/api/player/mobilization/start");
  assert.equal(r.status, 200);
  assert.equal(r.json.levy, levyAmount(pop, used));
  assert.equal((await nation()).populationSpent, used + r.json.levy);
  await closeWar();
});

test("互斥:有僱傭兵合約不能開;開著民兵不能簽約", async () => {
  await reset(); await openWar();
  await db.insert(mercenaryStatesTable).values({ nationId, disarmed: true, companyId: "grey_wolves", signedAt: new Date() });
  const r = await api("POST", "/api/player/mobilization/start");
  assert.equal(r.status, 409);
  assert.match(r.json.error, /僱傭兵合約/);
  assert.equal((await armies()).length, 0);

  await reset(); await openWar();
  await db.insert(mercenaryStatesTable).values({ nationId, disarmed: true });
  await db.insert(totalMobilizationStatesTable).values({ nationId, active: true });
  await assert.rejects(() => signContract(nationId, "grey_wolves"), /全民皆兵/);
  await closeWar();
});

test("解除武裝:民兵一併解散、人口退還、全民皆兵狀態關閉", async () => {
  await reset(); await closeWar(); await openWar();
  await api("POST", "/api/player/mobilization/start");
  assert.ok((await nation()).populationSpent > 0);
  await closeWar(); // 解除武裝需沒有進行中戰役;戰爭狀態與戰役無關,這裡順手結束
  await disarmNation(nationId);
  assert.equal((await armies()).length, 0);
  assert.equal((await nation()).populationSpent, 0);
  assert.equal((await mobState())!.active, false, "狀態同步關閉");
});

test("NPC 國家不能用全民皆兵(開啟/關閉都拒絕,不產生民兵與人口占用)", async () => {
  const [npc] = await db.insert(playerNationsTable)
    .values({ name: `${TAG}npc${runId}`, isNpc: true })
    .returning({ id: playerNationsTable.id });
  const [a, b] = [npc!.id, foeId].sort();
  await db.insert(diplomacyWarsTable).values({ nationAId: a!, nationBId: b!, declaredByNationId: npc!.id });
  await assert.rejects(() => startMobilization(npc!.id), /NPC/);
  await assert.rejects(() => stopMobilization(npc!.id), /NPC/);
  const [row] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, npc!.id));
  assert.equal(row!.populationSpent, 0);
  const st = await db.select().from(totalMobilizationStatesTable).where(eq(totalMobilizationStatesTable.nationId, npc!.id));
  assert.equal(st.length, 0);
  await db.delete(diplomacyWarsTable).where(eq(diplomacyWarsTable.declaredByNationId, npc!.id));
});
