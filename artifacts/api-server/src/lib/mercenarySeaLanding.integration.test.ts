/**
 * 僱傭兵服務層整合測試(需要 DATABASE_URL)。
 * 涵蓋:解除武裝 100% 退還、戰役中不可解除、簽約條件、一次一間、換家、
 * 建軍閘門、派遣/召回、NPC 不開放。資料用唯一標籤前綴,測完自行清理。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the mercenary tests");
}

const { eq, sql, inArray } = await import("drizzle-orm");
const {
  db, pool, playerNationsTable, playerArmiesTable, recruitQueueTable,
  militaryUnitTemplatesTable, mapRegionsTable, diplomacyWarsTable,
  warCampaignsTable, warCampaignParticipantsTable, warCampaignLegionsTable,
  mercenaryStatesTable,
  mercenaryDeploymentsTable,
} = await import("@workspace/db");
const migs = [
  ["gameMigrations", "runGameMigrations"],
  ["mapRegions", "runMapRegionSync"],
  ["gameMigrations", "runRegionControlMigrations"],
  ["mapRegionEraStats", "runMapRegionEraStatsSync"],
  ["mapCities", "runMapCitySync"],
  ["mapV2Reset", "runMapV2RegionReset"],
  ["militaryMigrations", "runMilitaryMigrations"],
  ["weaponMigrations", "runWeaponMigrations"],
  ["diplomacyMigrations", "runDiplomacyMigrations"],
  ["resourceMigrations", "runResourceMigrations"],
  ["politicsMigrations", "runPoliticsMigrations"],
  ["cabinetMigrations", "runCabinetMigrations"],
  ["autopilotMigrations", "runAutopilotMigrations"],
  ["warMigrations", "runWarMigrations"],
  ["mercenaryMigrations", "runMercenaryMigrations"],
  ["economyMigrations", "runEconomyMigrations"],
  ["socialTechMigrations", "runSocialTechMigrations"],
  ["productionMigrations", "runProductionMigrations"],
  ["techTreeMigrations", "runTechTreeMigrations"],
  ["wallMigrations", "runWallMigrations"],
  ["worldSimMigrations", "runWorldSimMigrations"],
  ["gameNewsMigrations", "runGameNewsMigrations"],
  ["accountBanMigrations", "runAccountBanMigrations"],
  ["superEventMigrations", "runSuperEventMigrations"],
  ["gameBalanceMigrations", "runGameBalanceMigrations"],
  ["aiUsageMigrations", "runAiUsageMigrations"],
  ["aiPregenMigrations", "runAiPregenMigrations"],
  ["generalsMigrations", "runGeneralsMigrations"],
  ["parliamentMigrations", "runParliamentMigrations"],
  ["nationNameSanitizeMigration", "runNationNameSanitizeMigration"],
] as const;
const svc = await import("./mercenaryService");

const TAG = "__mercsea__";
const runId = randomBytes(4).toString("hex");
const userA = `${TAG}a${runId}`;
const userB = `${TAG}b${runId}`;
const userNpc = `${TAG}n${runId}`;
let nA = "", nB = "", nNpc = "";
let templateId = 0;
let regionIds: number[] = [];
const campaignIds: number[] = [];
const warIds: number[] = [];

async function mkNation(discordUserId: string, isNpc = false): Promise<string> {
  const [n] = await db.insert(playerNationsTable)
    .values({ name: `${TAG}${discordUserId}`, leaderName: TAG, discordUserId, isNpc, money: 100_000 })
    .returning({ id: playerNationsTable.id });
  return n!.id;
}
async function giveArmy(userId: string, qty: number, prod: number, pop: number) {
  await db.insert(playerArmiesTable).values({
    discordUserId: userId, templateId, quantity: qty,
    productionReserved: prod, populationReserved: pop,
  } as never);
  await db.update(playerNationsTable)
    .set({ productionSpent: sql`${playerNationsTable.productionSpent} + ${prod}`,
           populationSpent: sql`${playerNationsTable.populationSpent} + ${pop}` })
    .where(eq(playerNationsTable.discordUserId, userId));
}
async function mkCampaign(attacker: string, defender: string): Promise<number> {
  // diplomacy_wars_pair_active_uidx:同一對國家同時只能有一場進行中的戰爭
  await db.update(diplomacyWarsTable).set({ endedAt: new Date() }).where(inArray(diplomacyWarsTable.id, warIds.length ? warIds : [-1]));
  if (campaignIds.length) await db.update(warCampaignsTable).set({ status: "ended" }).where(inArray(warCampaignsTable.id, campaignIds));
  const [w] = await db.insert(diplomacyWarsTable)
    .values({
      // diplomacy_wars_order_check 要求 nation_a_id < nation_b_id
      nationAId: attacker < defender ? attacker : defender,
      nationBId: attacker < defender ? defender : attacker,
      declaredByNationId: attacker,
    })
    .returning({ id: diplomacyWarsTable.id });
  warIds.push(w!.id);
  const [c] = await db.insert(warCampaignsTable).values({
    warId: w!.id, attackerNationId: attacker, defenderNationId: defender,
    attackerRegionId: regionIds[0]!, defenderRegionId: regionIds[1]!,
    nextResolveAt: new Date(Date.now() + 3_600_000),
  } as never).returning({ id: warCampaignsTable.id });
  campaignIds.push(c!.id);
  return c!.id;
}

/** 再開一場「不結束舊戰役」的戰役:attacker 對 defender,用於多戰線測試。 */
async function mkExtraCampaign(attacker: string, defender: string): Promise<number> {
  const [w] = await db.insert(diplomacyWarsTable)
    .values({
      nationAId: attacker < defender ? attacker : defender,
      nationBId: attacker < defender ? defender : attacker,
      declaredByNationId: attacker,
    })
    .returning({ id: diplomacyWarsTable.id });
  warIds.push(w!.id);
  const [c] = await db.insert(warCampaignsTable).values({
    warId: w!.id, attackerNationId: attacker, defenderNationId: defender,
    attackerRegionId: regionIds[0]!, defenderRegionId: regionIds[1]!,
    nextResolveAt: new Date(Date.now() + 3_600_000),
  } as never).returning({ id: warCampaignsTable.id });
  campaignIds.push(c!.id);
  return c!.id;
}
async function nationRow(id: string) {
  const [r] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id));
  return r!;
}
async function reset(nationId: string, userId: string) {
  // 清掉這個國家牽涉的所有進行中戰役,避免前一個測試汙染「有戰役不可解除武裝」
  await db.update(warCampaignsTable).set({ status: "ended" }).where(
    sql`${warCampaignsTable.attackerNationId} = ${nationId} OR ${warCampaignsTable.defenderNationId} = ${nationId}`,
  );
  await db.delete(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.nationId, nationId));
  await db.delete(mercenaryDeploymentsTable).where(eq(mercenaryDeploymentsTable.nationId, nationId));
  await db.delete(mercenaryStatesTable).where(eq(mercenaryStatesTable.nationId, nationId));
  await db.delete(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userId));
  await db.delete(recruitQueueTable).where(eq(recruitQueueTable.nationId, nationId));
  await db.update(playerNationsTable).set({ productionSpent: 0, populationSpent: 0 }).where(eq(playerNationsTable.id, nationId));
}

async function cleanup() {
  if (campaignIds.length) {
    await db.delete(warCampaignLegionsTable).where(inArray(warCampaignLegionsTable.campaignId, campaignIds));
    await db.delete(warCampaignParticipantsTable).where(inArray(warCampaignParticipantsTable.campaignId, campaignIds));
    await db.delete(warCampaignsTable).where(inArray(warCampaignsTable.id, campaignIds));
  }
  if (warIds.length) await db.delete(diplomacyWarsTable).where(inArray(diplomacyWarsTable.id, warIds));
  await db.delete(playerArmiesTable).where(sql`${playerArmiesTable.discordUserId} LIKE ${TAG + "%"}`);
  await db.delete(playerNationsTable).where(sql`${playerNationsTable.name} LIKE ${TAG + "%"}`);
  if (templateId) await db.delete(militaryUnitTemplatesTable).where(eq(militaryUnitTemplatesTable.id, templateId));
}

before(async () => {
  for (const [f, fn] of migs) await ((await import(`./${f}`)) as Record<string, () => Promise<void>>)[fn]!();
  await cleanup();
  regionIds = (await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable).limit(3)).map((r) => r.id);
  assert.ok(regionIds.length >= 2);
  nA = await mkNation(userA); nB = await mkNation(userB); nNpc = await mkNation(userNpc, true);
  const [t] = await db.insert(militaryUnitTemplatesTable).values({
    category: "infantry", name: `${TAG}inf${runId}`, hp: 100, attack: 10, defense: 10, speed: 1,
    accuracy: 50, range: "melee", prodCostPer100: 10, popCostPerUnit: 1, moneyCostPerUnit: 1,
    ownerDiscordUserId: userA,
  } as never).returning({ id: militaryUnitTemplatesTable.id });
  templateId = t!.id;
});
after(async () => { await cleanup(); await pool.end(); });
const { loadMercenaryUnitsForCampaign } = svc as unknown as { loadMercenaryUnitsForCampaign: (id: number) => Promise<Map<string, { quantity: number }>> };

async function markSea(cid: number, cap: number) {
  await db.update(warCampaignsTable).set({ isSeaLanding: true, seaLandingTroopCap: cap }).where(eq(warCampaignsTable.id, cid));
}

const sumQ = (m: Map<string, { quantity: number }>, nation: string) =>
  [...m.entries()].filter(([k]) => k.startsWith(`${nation}:`)).reduce((s, [, u]) => s + u.quantity, 0);

test("跨海戰役:進攻方僱傭兵(白鴉)單欄位 → 兵力被壓到登陸上限 5000", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nA);
  await svc.signContract(nA, "white_raven");
  const cid = await mkCampaign(nA, nB);
  await markSea(cid, 5000);
  await svc.deployMercenaries({ nationId: nA, campaignId: cid, slot: "A", mode: "attack" });
  assert.equal(sumQ(await loadMercenaryUnitsForCampaign(cid), nA), 5000);
});

test("同一場戰役同一國只能派一個欄位(不能用多欄位疊加繞過上限)", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nA);
  await svc.signContract(nA, "white_raven");
  const cid = await mkCampaign(nA, nB);
  await markSea(cid, 50_000);
  await svc.deployMercenaries({ nationId: nA, campaignId: cid, slot: "A", mode: "attack" });
  for (const slot of ["B", "C"] as const) {
    await assert.rejects(() => svc.deployMercenaries({ nationId: nA, campaignId: cid, slot, mode: "attack" }), /已派進這場戰役/);
  }
  const units = await loadMercenaryUnitsForCampaign(cid);
  assert.equal(units.size, 1);
  assert.equal(sumQ(units, nA), 50_000);
});

test("跨海戰役:防守方僱傭兵不受登陸上限限制(本土作戰)", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "white_raven");
  const cid = await mkCampaign(nA, nB); // B 防守
  await markSea(cid, 5000);
  await svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "A", mode: "defend" });
  assert.ok(sumQ(await loadMercenaryUnitsForCampaign(cid), nB) > 5000, "防守方不應被縮減");
});

test("一般戰役(非跨海):進攻方僱傭兵不受限", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nA);
  await svc.signContract(nA, "white_raven");
  const cid = await mkCampaign(nA, nB);
  await svc.deployMercenaries({ nationId: nA, campaignId: cid, slot: "A", mode: "attack" });
  assert.ok(sumQ(await loadMercenaryUnitsForCampaign(cid), nA) > 5000);
});

test("capMercenaryTroopsToSeaLanding(純函式):邊界", () => {
  const { capMercenaryTroopsToSeaLanding: cap } = svc as unknown as { capMercenaryTroopsToSeaLanding: (t: number[], c: number | null) => number[] };
  assert.deepEqual(cap([100, 200], null), [100, 200], "無上限原樣");
  assert.deepEqual(cap([100, 200], 300), [100, 200], "恰等於上限原樣");
  assert.deepEqual(cap([100, 200], 1000), [100, 200], "低於上限原樣");
  const out = cap([70_000, 70_000, 70_000], 50_000);
  assert.equal(out.reduce((a, b) => a + b, 0), 50_000);
  assert.ok(Math.max(...out) - Math.min(...out) <= 1, "等量欄位應均分");
  assert.deepEqual(cap([100, 200], 0), [0, 0], "上限 0 → 全 0");
  assert.equal(cap([3, 1], 2).reduce((a, b) => a + b, 0), 2);
});
