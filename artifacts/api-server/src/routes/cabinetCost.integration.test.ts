/**
 * AI 代理(內閣/託管)招募與購買必須和玩家手動同口徑扣木材、礦石;
 * 回報的漏洞:原本完全不扣,可設計重原料兵種後叫 AI 免費大量招募。
 */
import { strict as assert } from "node:assert";
import test, { after, before, beforeEach } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set to run cabinet cost tests");

const { eq, like, notExists, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, playerArmiesTable, militaryUnitTemplatesTable, regionControlsTable, mapRegionsTable, recruitQueueTable } =
  await import("@workspace/db");
const { executeRecruit, executePurchase } = await import("../lib/cabinet/domains/militaryExec");
const { setRecruitQueueEnabled } = await import("../lib/recruitQueue");
const { cancelQueueOrder } = await import("../lib/recruitQueue");
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

const TAG = "__cabcost__";
const runId = randomBytes(4).toString("hex");
const userId = `${TAG}u_${runId}`;
let nationId = "";
let tplId = 0;

const nation = async () => (await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId)))[0]!;
const units = async () =>
  (await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId))).reduce((s, a) => s + a.quantity, 0);

before(async () => {
  for (const [mod, fn] of MIGS) await ((await import(`../lib/${mod}`)) as Record<string, () => Promise<void>>)[fn]!();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  [{ id: nationId }] = await db
    .insert(playerNationsTable)
    .values({ discordUserId: userId, name: `${TAG}n${runId}`, leaderName: "x", government: "君主制", wood: 1000, ore: 1000, money: 1e12 })
    .returning({ id: playerNationsTable.id }) as [{ id: string }];
  const free = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .where(notExists(db.select({ one: sql`1` }).from(regionControlsTable).where(eq(regionControlsTable.regionId, mapRegionsTable.id))))
    .orderBy(mapRegionsTable.id)
    .limit(1);
  await db.insert(regionControlsTable).values({ regionId: free[0]!.id, nationId, percent: 100 });
  [{ id: tplId }] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ownerDiscordUserId: userId, category: "infantry", name: `${TAG}t`, hp: 10, attack: 10, defense: 5, speed: 4, accuracy: 50,
      range: "melee", prodCostPer100: 1, popCostPerUnit: 1, moneyCostPerUnit: 1, upkeepPerUnit: 0, prodUpkeepPerUnit: 0,
      woodCostPerUnit: 5, oreCostPerUnit: 3,
    })
    .returning({ id: militaryUnitTemplatesTable.id }) as [{ id: number }];
});

beforeEach(async () => {
  await setRecruitQueueEnabled(false);
  await db.delete(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  await db.delete(recruitQueueTable).where(eq(recruitQueueTable.nationId, nationId));
  await db.update(playerNationsTable).set({ wood: 1000, ore: 1000, money: 1e12, productionSpent: 0, populationSpent: 0 }).where(eq(playerNationsTable.id, nationId));
});

after(async () => {
  await setRecruitQueueEnabled(false);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  await db.delete(militaryUnitTemplatesTable).where(eq(militaryUnitTemplatesTable.ownerDiscordUserId, userId));
  await pool.end();
});

test("AI 招募:扣木材與礦石(100 單位 = 木 500 / 礦 300)", async () => {
  await executeRecruit(userId, tplId, 100);
  const n = await nation();
  assert.equal(n.wood, 500);
  assert.equal(n.ore, 700);
  assert.equal(await units(), 100);
});

test("AI 購買:扣木材與礦石", async () => {
  await executePurchase(userId, tplId, 100);
  const n = await nation();
  assert.equal(n.wood, 500);
  assert.equal(n.ore, 700);
  assert.equal(await units(), 100);
});

test("AI 招募:木材不足被擋,且不產生兵力、不改任何資源", async () => {
  await db.update(playerNationsTable).set({ wood: 100 }).where(eq(playerNationsTable.id, nationId));
  await assert.rejects(() => executeRecruit(userId, tplId, 100), /木材不足/);
  const n = await nation();
  assert.equal(n.wood, 100);
  assert.equal(n.ore, 1000);
  assert.equal(n.productionSpent, 0);
  assert.equal(await units(), 0);
});

test("AI 招募:礦石不足被擋", async () => {
  await db.update(playerNationsTable).set({ ore: 10 }).where(eq(playerNationsTable.id, nationId));
  await assert.rejects(() => executeRecruit(userId, tplId, 100), /礦石不足/);
  assert.equal((await nation()).wood, 1000);
  assert.equal(await units(), 0);
});

test("AI 購買:木材不足被擋,金錢與額度都不動", async () => {
  await db.update(playerNationsTable).set({ wood: 100 }).where(eq(playerNationsTable.id, nationId));
  await assert.rejects(() => executePurchase(userId, tplId, 100), /木材不足/);
  const n = await nation();
  assert.equal(n.wood, 100);
  assert.equal(n.money, 1e12);
  assert.equal(await units(), 0);
});

test("訓練佇列開啟:AI 招募/購買的木礦記入佇列,取消按比例退還", async () => {
  await setRecruitQueueEnabled(true);
  await executeRecruit(userId, tplId, 100);
  let n = await nation();
  assert.equal(n.wood, 500);
  const [q] = await db.select().from(recruitQueueTable).where(eq(recruitQueueTable.nationId, nationId));
  assert.equal(q!.woodPaid, 500);
  assert.equal(q!.orePaid, 300);
  await cancelQueueOrder(nationId, q!.id);
  n = await nation();
  assert.equal(n.wood, 1000, "取消後木材全退");
  assert.equal(n.ore, 1000, "取消後礦石全退");
});
