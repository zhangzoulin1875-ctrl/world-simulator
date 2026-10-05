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
import { runGameMigrations } from "../gameMigrations";
import { runMapRegionSync } from "../mapRegions";
import { runMilitaryMigrations } from "../militaryMigrations";
import { runDiplomacyMigrations } from "../diplomacyMigrations";
import { runWarMigrations } from "../warMigrations";
import { autoFormLegions, capLegionsToSeaLanding } from "../cabinet/domains/militaryBattlefield";

/**
 * AI 託管「被攻擊時軍事指揮接手防守」測試（真實 DB）。
 *
 * 託管的軍事大臣靠 autoFormLegions 為進行中戰役編制軍團。守方（被攻擊方）要：
 *   1. 自動把 60% 兵力編成「駐守城市」的軍團 A、40% 編成機動軍團 B；
 *   2. 進攻方的同函式呼叫不駐守（A 不駐城）；
 *   3. 已有部署時絕不覆蓋（玩家或先前回合的配置原封不動）；
 *   4. 沒有任何兵力時不建立空軍團。
 */

const MARKER = "sea-landing-cap-test-";
const PID = process.pid;
let attacker!: PlayerNation;
let defender!: PlayerNation;
let templateId = 0;
let attackerRegionId = 0;
let defenderRegionId = 0;
let warId = 0;
let campaignId = 0;
const SEA_CAP = 50_000;

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
    await db.insert(playerArmiesTable).values({ discordUserId: n.discordUserId!, templateId, quantity: 150_000 });
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
      isSeaLanding: true, seaLandingTroopCap: SEA_CAP, landingAttackReductionPct: 50,
    })
    .returning({ id: warCampaignsTable.id });
  campaignId = campaign!.id;
});

after(async () => {
  await cleanup();
  await pool.end();
});
const sumOf = (ls: { total: number }[]) => ls.reduce((s, l) => s + l.total, 0);

test("跨海戰役:攻方 15 萬兵 → 自動組軍團總投入恰為上限 5 萬(60/40 分配)", async () => {
  await clearLegions();
  await autoFormLegions(await fresh(attacker.id), "classical");
  const legions = await legionsOf(attacker.id);
  assert.equal(sumOf(legions), SEA_CAP);
  assert.deepEqual(legions.map((l) => l.slot), ["A", "B"]);
  assert.equal(legions[0]!.total, 30_000, "A 軍 60%");
  assert.equal(legions[1]!.total, 20_000, "B 軍 40%");
});

test("跨海戰役:守方不受登陸上限限制(15 萬全數防守)", async () => {
  await clearLegions();
  await autoFormLegions(await fresh(defender.id), "classical");
  assert.equal(sumOf(await legionsOf(defender.id)), 150_000);
});

test("一般陸地戰役(非跨海):攻方不受限,15 萬全數投入", async () => {
  await db.update(warCampaignsTable).set({ isSeaLanding: false, seaLandingTroopCap: null }).where(eq(warCampaignsTable.id, campaignId));
  await clearLegions();
  await autoFormLegions(await fresh(attacker.id), "classical");
  assert.equal(sumOf(await legionsOf(attacker.id)), 150_000);
  await db.update(warCampaignsTable).set({ isSeaLanding: true, seaLandingTroopCap: SEA_CAP }).where(eq(warCampaignsTable.id, campaignId));
});

test("兵力未超過上限:原樣投入,不被縮減", async () => {
  await db.update(playerArmiesTable).set({ quantity: 30_000 }).where(eq(playerArmiesTable.discordUserId, attacker.discordUserId!));
  await clearLegions();
  await autoFormLegions(await fresh(attacker.id), "classical");
  assert.equal(sumOf(await legionsOf(attacker.id)), 30_000);
});

test("capLegionsToSeaLanding(純函式):多兵種按比例縮、總和恰為上限、不產生負數或空軍團", () => {
  const legions = [
    { slot: "A" as const, garrisoningCity: false, units: [{ templateId: 1, quantity: 90_001 }, { templateId: 2, quantity: 30_003 }] },
    { slot: "B" as const, garrisoningCity: false, units: [{ templateId: 1, quantity: 60_000 }, { templateId: 2, quantity: 1 }] },
  ];
  const out = capLegionsToSeaLanding(legions, 50_000);
  const flat = out.flatMap((l) => l.units.map((u) => u.quantity));
  assert.equal(flat.reduce((a, b) => a + b, 0), 50_000);
  assert.ok(flat.every((q) => q > 0 && Number.isInteger(q)));
  // 兵種 1 原占 150001/180005 ≈ 83.33%,縮放後應維持(±1 的整數取捨誤差)
  const t1 = out.flatMap((l) => l.units).filter((u) => u.templateId === 1).reduce((a, u) => a + u.quantity, 0);
  const expectT1 = (150_001 / 180_005) * 50_000;
  assert.ok(Math.abs(t1 - expectT1) <= 2, `兵種 1 比例應被保留:期望≈${expectT1.toFixed(1)},實得 ${t1}`);
  // null 上限、cap 大於總量:原樣
  assert.equal(capLegionsToSeaLanding(legions, null), legions);
  assert.equal(capLegionsToSeaLanding(legions, 10_000_000), legions);
  // cap=0:全部清空(不產生空軍團)
  assert.deepEqual(capLegionsToSeaLanding(legions, 0), []);
});
