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

const TAG = "__merc__";
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

test("解除武裝:全軍解散並 100% 退還生產力與人口,標記 disarmed", async () => {
  await reset(nA, userA);
  await giveArmy(userA, 500, 40, 500);
  const before = await nationRow(nA);
  assert.equal(before.productionSpent, 40);
  const r = await svc.disarmNation(nA);
  assert.equal(r.disbandedUnits, 500);
  assert.equal(r.refundedProduction, 40);
  assert.equal(r.refundedPopulation, 500);
  const after = await nationRow(nA);
  assert.equal(after.productionSpent, 0);
  assert.equal(after.populationSpent, 0);
  const left = await db.select().from(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, userA));
  assert.equal(left.length, 0);
  assert.equal((await svc.getMercenaryState(nA))?.disarmed, true);
});

test("解除武裝:重複解除被拒", async () => {
  await assert.rejects(() => svc.disarmNation(nA), (e: Error) => e instanceof svc.MercenaryError && (e as never as { status: number }).status === 409);
});

test("解除武裝:同時取消訓練佇列並退還", async () => {
  await reset(nB, userB);
  await db.insert(recruitQueueTable).values({
    nationId: nB, templateId, totalQuantity: 100, remaining: 100,
    productionReserved: 25, populationReserved: 100, woodPaid: 0, orePaid: 0, moneyPaid: 300,
  } as never);
  await db.update(playerNationsTable).set({ productionSpent: 25, populationSpent: 100 }).where(eq(playerNationsTable.id, nB));
  const m0 = (await nationRow(nB)).money;
  const r = await svc.disarmNation(nB);
  assert.equal(r.refundedProduction, 25);
  assert.equal(r.refundedPopulation, 100);
  assert.equal(r.refundedMoney, 300);
  assert.equal((await nationRow(nB)).money, m0 + 300);
  assert.equal((await nationRow(nB)).productionSpent, 0);
  assert.equal((await db.select().from(recruitQueueTable).where(eq(recruitQueueTable.nationId, nB))).length, 0);
});

test("有進行中戰役時不可解除武裝", async () => {
  await reset(nB, userB);
  const cid = await mkCampaign(nA, nB);
  await assert.rejects(() => svc.disarmNation(nB), /戰役/);
  await db.update(warCampaignsTable).set({ status: "ended" }).where(eq(warCampaignsTable.id, cid));
});

test("NPC 國家不可解除武裝、不可簽約", async () => {
  await assert.rejects(() => svc.disarmNation(nNpc), /NPC/);
});

test("簽約:必須已解除武裝", async () => {
  await reset(nB, userB);
  await assert.rejects(() => svc.signContract(nB, "obsidian"), /解除武裝/);
});

test("簽約:不存在的公司被拒;解除武裝後可簽", async () => {
  await reset(nB, userB);
  await svc.disarmNation(nB);
  await assert.rejects(() => svc.signContract(nB, "nope"), /找不到/);
  const s = await svc.signContract(nB, "obsidian");
  assert.equal(s.companyId, "obsidian");
  assert.ok(s.signedAt);
});

test("一次只能一間:已有合約再簽被拒;解約後可立刻換家", async () => {
  await assert.rejects(() => svc.signContract(nB, "white_raven"), /已有生效中的合約/);
  await svc.terminateContract(nB);
  assert.equal((await svc.getMercenaryState(nB))?.companyId, null);
  const s = await svc.signContract(nB, "white_raven");
  assert.equal(s.companyId, "white_raven");
});

test("建軍閘門:有合約時 assertCanRecruit 拒絕;解約後放行", async () => {
  await assert.rejects(() => svc.assertCanRecruit(nB), /先解約/);
  await svc.terminateContract(nB);
  await svc.assertCanRecruit(nB);
});

test("有合約不可恢復建軍;解約後可以", async () => {
  await svc.signContract(nB, "grey_wolves");
  await assert.rejects(() => svc.restoreArmy(nB), /先解約/);
  await svc.terminateContract(nB);
  await svc.restoreArmy(nB);
  assert.equal((await svc.getMercenaryState(nB))?.disarmed, false);
});

test("解除武裝後若又建軍(有常備軍),不可簽約", async () => {
  await reset(nB, userB);
  await svc.disarmNation(nB);
  await giveArmy(userB, 10, 1, 10);
  await assert.rejects(() => svc.signContract(nB, "obsidian"), /常備軍/);
});

test("解約沒有合約時回 409", async () => {
  await reset(nB, userB);
  await assert.rejects(() => svc.terminateContract(nB), /沒有生效中的合約/);
});

test("派遣:需合約;防守方只能 defend、進攻方只能 attack;欄位不可重複;可召回", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  const cid = await mkCampaign(nA, nB); // A 進攻 B;B 防守
  await assert.rejects(() => svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "A", mode: "defend" }), /尚未簽訂/);
  // 戰役已開始後 B 不能再解除武裝,所以這裡先簽約(B 已解除武裝)
  await svc.signContract(nB, "iron_shield");
  await assert.rejects(() => svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "A", mode: "attack" }), /只有進攻方/);
  await assert.rejects(() => svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "Z", mode: "defend" }), /A、B 或 C/);
  const s = await svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "A", mode: "defend" });
  assert.equal(s.deployedCampaignId, cid);
  const legs = await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, cid));
  assert.equal(legs.filter((l) => l.nationId === nB && l.slot === "A").length, 1);
  await assert.rejects(() => svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "B", mode: "defend" }), /已派遣中/);
  await svc.recallMercenaries(nB);
  assert.equal((await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, cid))).filter((l) => l.nationId === nB).length, 0);
  assert.equal((await svc.getMercenaryState(nB))?.deployedCampaignId, null);
  await assert.rejects(() => svc.recallMercenaries(nB), /沒有派遣中/);
});

test("解約會一併召回派遣中的僱傭兵", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const cid = await mkCampaign(nA, nB);
  await svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "C", mode: "defend" });
  assert.equal((await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, cid))).filter((l) => l.nationId === nB).length, 1);
  await svc.terminateContract(nB);
  assert.equal((await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, cid))).filter((l) => l.nationId === nB).length, 0);
  assert.equal((await svc.getMercenaryState(nB))?.deployedCampaignId, null);
  assert.equal((await svc.getMercenaryState(nB))?.companyId, null);
});

test("非參與者不可派遣", async () => {
  await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const cid = await mkCampaign(nA, nNpc); // nB 不在這場戰役裡
  await assert.rejects(() => svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "A", mode: "defend" }), /不是這場戰役的參與者/);
});

test("已結束的戰役不可派遣", async () => {
  await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const cid = await mkCampaign(nA, nB);
  await db.update(warCampaignsTable).set({ status: "ended" }).where(eq(warCampaignsTable.id, cid));
  await assert.rejects(() => svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "A", mode: "defend" }), /已經結束/);
});

test("報價:五間公司兵力隨公司遞增、租金低於常備軍", async () => {
  const q = await svc.quoteCompanies(nB);
  assert.equal(q.length, 5);
  for (let i = 1; i < q.length; i++) {
    assert.ok(q[i]!.rent >= q[i - 1]!.rent || q[i]!.force.troops >= q[i - 1]!.force.troops);
  }
  for (const x of q) assert.ok(x.rent >= 1 && x.force.troops >= 1);
});
