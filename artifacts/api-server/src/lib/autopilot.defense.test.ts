import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  playerArmiesTable,
  militaryUnitTemplatesTable,
  mapRegionsTable,
  regionControlsTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  type PlayerNation,
} from "@workspace/db";
import { runGameMigrations } from "./gameMigrations";
import { runMapRegionSync } from "./mapRegions";
import { runMilitaryMigrations } from "./militaryMigrations";
import { runDiplomacyMigrations } from "./diplomacyMigrations";
import { runWarMigrations } from "./warMigrations";
import { autoFormLegions } from "./cabinet/domains/militaryBattlefield";

/**
 * AI 託管「被攻擊時軍事指揮接手防守」測試（真實 DB）。
 *
 * 託管的軍事大臣靠 autoFormLegions 為進行中戰役編制軍團。守方（被攻擊方）要：
 *   1. 自動把 60% 兵力編成「駐守城市」的軍團 A、40% 編成機動軍團 B；
 *   2. 進攻方的同函式呼叫不駐守（A 不駐城）；
 *   3. 已有部署時絕不覆蓋（玩家或先前回合的配置原封不動）；
 *   4. 沒有任何兵力時不建立空軍團。
 */

const MARKER = "autopilot-defense-test-";
const PID = process.pid;
let attacker!: PlayerNation;
let defender!: PlayerNation;
let templateId = 0;
let attackerRegionId = 0;
let defenderRegionId = 0;
let warId = 0;
let campaignId = 0;

async function cleanup(): Promise<void> {
  const nations = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.name, `${MARKER}%`));
  const ids = nations.map((n) => n.id);
  if (ids.length > 0) {
    // 戰爭刪除會 cascade 戰役／軍團／單位。
    await db.delete(diplomacyWarsTable).where(inArray(diplomacyWarsTable.nationAId, ids));
    await db.delete(diplomacyWarsTable).where(inArray(diplomacyWarsTable.nationBId, ids));
    await db.delete(regionControlsTable).where(inArray(regionControlsTable.nationId, ids));
  }
  await db.delete(playerArmiesTable).where(like(playerArmiesTable.discordUserId, `${MARKER}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARKER}%`));
  await db.delete(militaryUnitTemplatesTable).where(like(militaryUnitTemplatesTable.name, `${MARKER}%`));
}

async function legionsOf(nationId: string) {
  const legions = await db
    .select()
    .from(warCampaignLegionsTable)
    .where(and(eq(warCampaignLegionsTable.campaignId, campaignId), eq(warCampaignLegionsTable.nationId, nationId)))
    .orderBy(asc(warCampaignLegionsTable.slot));
  const out = [];
  for (const l of legions) {
    const units = await db.select().from(warCampaignLegionUnitsTable).where(eq(warCampaignLegionUnitsTable.legionId, l.id));
    out.push({ ...l, total: units.reduce((s, u) => s + u.quantity, 0) });
  }
  return out;
}

async function clearLegions(): Promise<void> {
  await db.delete(warCampaignLegionsTable).where(eq(warCampaignLegionsTable.campaignId, campaignId));
}

async function fresh(id: string): Promise<PlayerNation> {
  const [n] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id));
  return n!;
}

before(async () => {
  await runGameMigrations();
  await runMapRegionSync();
  await runMilitaryMigrations();
  await runDiplomacyMigrations();
  await runWarMigrations();
  await cleanup();

  const mk = async (label: string) => {
    const [n] = await db
      .insert(playerNationsTable)
      .values({ name: `${MARKER}${label}`, leaderName: MARKER, discordUserId: `${MARKER}${label}-${PID}` })
      .returning();
    return n!;
  };
  attacker = await mk("攻方");
  defender = await mk("守方");

  const regions = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable).orderBy(asc(mapRegionsTable.id)).limit(2);
  assert.equal(regions.length, 2);
  attackerRegionId = regions[0]!.id;
  defenderRegionId = regions[1]!.id;

  const [tpl] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      name: `${MARKER}步兵`, category: "infantry", eraSlug: "classical",
      hp: 50, attack: 50, defense: 50, speed: 5, accuracy: 50, range: "melee",
      prodCostPer100: 1, popCostPerUnit: 1, moneyCostPerUnit: 1, upkeepPerUnit: 1,
      isDefault: false, ownerNationId: defender.id,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  templateId = tpl!.id;

  await db.insert(regionControlsTable).values([
    { regionId: attackerRegionId, nationId: attacker.id, percent: 100 },
    { regionId: defenderRegionId, nationId: defender.id, percent: 100 },
  ]);
  for (const n of [attacker, defender]) {
    await db.insert(playerArmiesTable).values({ discordUserId: n.discordUserId!, templateId, quantity: 1000 });
  }

  const [aId, bId] = attacker.id < defender.id ? [attacker.id, defender.id] : [defender.id, attacker.id];
  const [war] = await db
    .insert(diplomacyWarsTable)
    .values({ nationAId: aId, nationBId: bId, declaredByNationId: attacker.id })
    .returning({ id: diplomacyWarsTable.id });
  warId = war!.id;
  const [campaign] = await db
    .insert(warCampaignsTable)
    .values({
      warId, attackerNationId: attacker.id, defenderNationId: defender.id,
      attackerRegionId, defenderRegionId, status: "active", cycleHours: 4, nextResolveAt: new Date(),
    })
    .returning({ id: warCampaignsTable.id });
  campaignId = campaign!.id;
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("被攻擊（守方）：60% 兵力駐守城市的軍團 A、40% 機動軍團 B", async () => {
  await clearLegions();
  await autoFormLegions(await fresh(defender.id), "classical");
  const legions = await legionsOf(defender.id);
  assert.deepEqual(legions.map((l) => l.slot), ["A", "B"]);
  assert.equal(legions[0]!.garrisoningCity, true, "守方軍團 A 必須駐守城市");
  assert.equal(legions[1]!.garrisoningCity, false);
  assert.equal(legions[0]!.total, 600);
  assert.equal(legions[1]!.total, 400);
});

test("進攻方：同樣編制兩個軍團，但 A 不駐守城市", async () => {
  await clearLegions();
  await autoFormLegions(await fresh(attacker.id), "classical");
  const legions = await legionsOf(attacker.id);
  assert.equal(legions.length, 2);
  assert.equal(legions[0]!.garrisoningCity, false, "進攻方不駐城");
  assert.equal(legions[0]!.total + legions[1]!.total, 1000);
});

test("已有部署時絕不覆蓋：既有軍團與單位數量原封不動", async () => {
  await clearLegions();
  const [existing] = await db
    .insert(warCampaignLegionsTable)
    .values({ campaignId, nationId: defender.id, slot: "A", garrisoningCity: false })
    .returning({ id: warCampaignLegionsTable.id });
  await db.insert(warCampaignLegionUnitsTable).values({ legionId: existing!.id, templateId, quantity: 123, wounded: 0 });
  await autoFormLegions(await fresh(defender.id), "classical");
  const legions = await legionsOf(defender.id);
  assert.equal(legions.length, 1, "不得再新增軍團");
  assert.equal(legions[0]!.id, existing!.id);
  assert.equal(legions[0]!.total, 123, "玩家原有配置不被改動");
  assert.equal(legions[0]!.garrisoningCity, false);
});

test("沒有任何兵力時不建立空軍團", async () => {
  await clearLegions();
  await db.delete(playerArmiesTable).where(eq(playerArmiesTable.discordUserId, defender.discordUserId!));
  await autoFormLegions(await fresh(defender.id), "classical");
  assert.equal((await legionsOf(defender.id)).length, 0);
});
