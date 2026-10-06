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

test("回歸:解除武裝取消佇列只扣一次 productionSpent/populationSpent(不吃掉其他佔用)", async () => {
  await reset(nB, userB);
  await db.insert(recruitQueueTable).values({
    nationId: nB, templateId, totalQuantity: 100, remaining: 100,
    productionReserved: 25, populationReserved: 100, woodPaid: 0, orePaid: 0, moneyPaid: 0,
  } as never);
  // 已用 = 佇列預留(25/100) + 其他合法佔用(60/500)。雙扣會把其他佔用也吃掉。
  await db.update(playerNationsTable).set({ productionSpent: 85, populationSpent: 600 }).where(eq(playerNationsTable.id, nB));
  const r = await svc.disarmNation(nB);
  const after = await nationRow(nB);
  assert.equal(after.productionSpent, 60, "只退佇列那 25,其他佔用 60 要保留");
  assert.equal(after.populationSpent, 500, "只退佇列那 100,其他佔用 500 要保留");
  // 回報給前端的仍是總退還量
  assert.equal(r.refundedProduction, 25);
  assert.equal(r.refundedPopulation, 100);
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
  assert.equal(s.campaignId, cid);
  const legs = await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, cid));
  assert.equal(legs.filter((l) => l.nationId === nB && l.slot === "A").length, 1);
  await assert.rejects(() => svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "B", mode: "defend" }), /已派進這場戰役/);
  await svc.recallMercenaries(nB);
  assert.equal((await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, cid))).filter((l) => l.nationId === nB).length, 0);
  assert.equal((await svc.listDeployments(nB)).length, 0);
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
  assert.equal((await svc.listDeployments(nB)).length, 0);
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

test("回合租金:付得起就收並累計 total_rent_paid", async () => {
  await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "grey_wolves");
  const q = await svc.quoteCompany(nB, "grey_wolves");
  const r = await svc.settleMercenaryRent({ nationId: nB, availableFunds: q!.rent + 1000, otherUpkeep: 1000 });
  assert.equal(r.terminated, false);
  assert.equal(r.rentCharged, q!.rent);
  assert.equal((await svc.getMercenaryState(nB))?.totalRentPaid, q!.rent);
  const r2 = await svc.settleMercenaryRent({ nationId: nB, availableFunds: q!.rent + 1000, otherUpkeep: 1000 });
  assert.equal((await svc.getMercenaryState(nB))?.totalRentPaid, q!.rent * 2);
  assert.equal(r2.rentCharged, q!.rent);
});

test("回合租金:付不起 → 自動解約、留下備註、不收租、召回派遣", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const cid = await mkCampaign(nA, nB);
  await svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "A", mode: "defend" });
  const r = await svc.settleMercenaryRent({ nationId: nB, availableFunds: 0, otherUpkeep: 0 });
  assert.equal(r.terminated, true);
  assert.equal(r.rentCharged, 0);
  const st = await svc.getMercenaryState(nB);
  assert.equal(st?.companyId, null);
  assert.equal((await svc.listDeployments(nB)).length, 0);
  assert.match(st?.lastTerminationNote ?? "", /資金不足/);
  assert.equal((await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, cid))).filter((l) => l.nationId === nB).length, 0);
});

test("回合租金:派遣中額外收戰役出動費,分開累計", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "iron_shield");
  const q = (await svc.quoteCompany(nB, "iron_shield"))!;
  const idle = await svc.settleMercenaryRent({ nationId: nB, availableFunds: 1e9, otherUpkeep: 0 });
  assert.equal(idle.rentCharged, q.rent, "未派遣只收租金");
  const cid = await mkCampaign(nA, nB);
  await svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "A", mode: "defend" });
  const busy = await svc.settleMercenaryRent({ nationId: nB, availableFunds: 1e9, otherUpkeep: 0 });
  assert.equal(busy.rentCharged, q.rent + q.deployFee, "派遣中租金 + 出動費");
  const st = await svc.getMercenaryState(nB);
  assert.equal(st?.totalRentPaid, q.rent * 2);
  assert.equal(st?.totalDeployPaid, q.deployFee);
});

test("多戰線:同一傭兵團可同時派進兩場不同戰役,各自佔欄位", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const c1 = await mkCampaign(nA, nB);
  const c2 = await mkExtraCampaign(nNpc, nB);
  await svc.deployMercenaries({ nationId: nB, campaignId: c1, slot: "A", mode: "defend" });
  await svc.deployMercenaries({ nationId: nB, campaignId: c2, slot: "A", mode: "defend" });
  const ds = await svc.listDeployments(nB);
  assert.equal(ds.length, 2);
  assert.deepEqual(ds.map((d) => d.campaignId).sort(), [c1, c2].sort());
  // 同一場戰役不能重複派
  await assert.rejects(() => svc.deployMercenaries({ nationId: nB, campaignId: c1, slot: "B", mode: "defend" }), /已派進這場戰役/);
  // 兩場戰役各自載得到完整兵力的虛擬單位
  const m1 = await svc.loadMercenaryUnitsForCampaign(c1);
  const m2 = await svc.loadMercenaryUnitsForCampaign(c2);
  assert.equal(m1.size, 1);
  assert.equal(m2.size, 1);
  assert.equal(m1.get(nB + ":A")!.quantity, m2.get(nB + ":A")!.quantity);
});

test("多戰線:出動費按參戰場次累加,租金只收一次", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "iron_shield");
  const q = (await svc.quoteCompany(nB, "iron_shield"))!;
  const c1 = await mkCampaign(nA, nB);
  const c2 = await mkExtraCampaign(nNpc, nB);
  const r0 = await svc.settleMercenaryRent({ nationId: nB, availableFunds: 1e12, otherUpkeep: 0 });
  assert.equal(r0.rentCharged, q.rent, "0 場:只收租金");
  await svc.deployMercenaries({ nationId: nB, campaignId: c1, slot: "A", mode: "defend" });
  const r1 = await svc.settleMercenaryRent({ nationId: nB, availableFunds: 1e12, otherUpkeep: 0 });
  assert.equal(r1.rentCharged, q.rent + q.deployFee, "1 場:租金 + 1 份出動費");
  await svc.deployMercenaries({ nationId: nB, campaignId: c2, slot: "A", mode: "defend" });
  const r2 = await svc.settleMercenaryRent({ nationId: nB, availableFunds: 1e12, otherUpkeep: 0 });
  assert.equal(r2.rentCharged, q.rent + q.deployFee * 2, "2 場:租金 + 2 份出動費");
  const st = await svc.getMercenaryState(nB);
  assert.equal(st?.totalRentPaid, q.rent * 3);
  assert.equal(st?.totalDeployPaid, q.deployFee * 3, "0+1+2 = 3 份出動費");
});

test("多戰線:可只召回其中一場,其餘繼續派遣", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const c1 = await mkCampaign(nA, nB);
  const c2 = await mkExtraCampaign(nNpc, nB);
  await svc.deployMercenaries({ nationId: nB, campaignId: c1, slot: "A", mode: "defend" });
  await svc.deployMercenaries({ nationId: nB, campaignId: c2, slot: "C", mode: "defend" });
  assert.equal(await svc.recallMercenaries(nB, c1), 1);
  const left = await svc.listDeployments(nB);
  assert.deepEqual(left.map((d) => d.campaignId), [c2]);
  const legs1 = await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, c1));
  const legs2 = await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, c2));
  assert.equal(legs1.filter((l) => l.nationId === nB).length, 0);
  assert.equal(legs2.filter((l) => l.nationId === nB && l.slot === "C").length, 1);
  await assert.rejects(() => svc.recallMercenaries(nB, c1), /沒有派遣中/);
});

test("多戰線:不指定場次 = 全部召回;解約也會撤出所有戰場", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const c1 = await mkCampaign(nA, nB);
  const c2 = await mkExtraCampaign(nNpc, nB);
  await svc.deployMercenaries({ nationId: nB, campaignId: c1, slot: "A", mode: "defend" });
  await svc.deployMercenaries({ nationId: nB, campaignId: c2, slot: "A", mode: "defend" });
  assert.equal(await svc.recallMercenaries(nB), 2);
  assert.equal((await svc.listDeployments(nB)).length, 0);
  await svc.deployMercenaries({ nationId: nB, campaignId: c1, slot: "A", mode: "defend" });
  await svc.deployMercenaries({ nationId: nB, campaignId: c2, slot: "B", mode: "defend" });
  await svc.terminateContract(nB);
  assert.equal((await svc.listDeployments(nB)).length, 0);
  for (const cid of [c1, c2]) {
    const legs = await db.select().from(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, cid));
    assert.equal(legs.filter((l) => l.nationId === nB).length, 0);
  }
});

test("多戰線:付不起時自動解約,所有場次一併撤出", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const c1 = await mkCampaign(nA, nB);
  const c2 = await mkExtraCampaign(nNpc, nB);
  await svc.deployMercenaries({ nationId: nB, campaignId: c1, slot: "A", mode: "defend" });
  await svc.deployMercenaries({ nationId: nB, campaignId: c2, slot: "A", mode: "defend" });
  const q = (await svc.quoteCompany(nB, "obsidian"))!;
  // 只夠付 1 場的費用,2 場就付不起
  const r = await svc.settleMercenaryRent({ nationId: nB, availableFunds: q.rent + q.deployFee, otherUpkeep: 0 });
  assert.equal(r.terminated, true);
  assert.equal((await svc.listDeployments(nB)).length, 0);
});

test("多戰線:戰役被刪除時,派遣紀錄跟著刪除,不會卡住", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const c1 = await mkCampaign(nA, nB);
  await svc.deployMercenaries({ nationId: nB, campaignId: c1, slot: "A", mode: "defend" });
  await db.delete(warCampaignsTable).where(eq(warCampaignsTable.id, c1));
  assert.equal((await svc.listDeployments(nB)).length, 0);
});

test("軍團視圖:傭兵欄位標 mercenary(公司名/兵力/攻防),一般軍團為 null", async () => {
  const { buildMyLegionsView } = await import("../routes/war/shared");
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "obsidian");
  const cid = await mkCampaign(nA, nB);
  await svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "B", mode: "defend" });
  const view = await buildMyLegionsView(cid, nB, userB);
  assert.equal(view.length, 1);
  assert.equal(view[0]!.slot, "B");
  assert.ok(view[0]!.mercenary, "傭兵欄位應帶 mercenary 資訊");
  assert.ok(view[0]!.mercenary!.troops > 0);
  assert.ok(view[0]!.mercenary!.companyName.length > 0);
  assert.equal(view[0]!.units.length, 0, "傭兵軍團沒有自己的兵種列");
  assert.equal(await svc.hasActiveMercenaryContract(nB), true);
  await svc.terminateContract(nB);
  assert.equal(await svc.hasActiveMercenaryContract(nB), false);
});

test("回合租金:沒有合約的國家回 0、不報錯", async () => {
  await reset(nB, userB);
  const r = await svc.settleMercenaryRent({ nationId: nB, availableFunds: 0, otherUpkeep: 0 });
  assert.deepEqual(r, { rentCharged: 0, terminated: false, companyName: null });
});

test("戰役載入:已派遣的僱傭兵得到虛擬單位(負數 unitRowId),未派遣的沒有", async () => {
  await reset(nA, userA); await reset(nB, userB);
  await svc.disarmNation(nB);
  await svc.signContract(nB, "white_raven");
  const cid = await mkCampaign(nA, nB);
  assert.equal((await svc.loadMercenaryUnitsForCampaign(cid)).size, 0);
  await svc.deployMercenaries({ nationId: nB, campaignId: cid, slot: "B", mode: "defend" });
  const m = await svc.loadMercenaryUnitsForCampaign(cid);
  assert.equal(m.size, 1);
  const u = m.get(`${nB}:B`)!;
  assert.ok(u, "key 應為 nationId:slot");
  assert.ok(u.unitRowId < 0, "虛擬單位不可對應真實資料列");
  assert.ok(u.quantity >= 1 && u.attack > 0 && u.defense > 0 && u.hp > 0);
  assert.equal(u.wounded, 0);
});

test("報價:五間公司兵力隨公司遞增、租金低於常備軍", async () => {
  const q = await svc.quoteCompanies(nB);
  assert.equal(q.length, 5);
  for (let i = 1; i < q.length; i++) {
    assert.ok(q[i]!.rent >= q[i - 1]!.rent || q[i]!.force.troops >= q[i - 1]!.force.troops);
  }
  for (const x of q) assert.ok(x.rent >= 1 && x.force.troops >= 1);
});
