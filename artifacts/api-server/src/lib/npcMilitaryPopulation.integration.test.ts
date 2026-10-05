/**
 * 方案 A:NPC 常備軍補兵改為扣人口(與玩家同口徑 popCostPerUnit × 數量)。
 *  - 補兵量不變,但人口同額減少(只扣 region_controls.population_bonus,不動時代人口)
 *  - 人口不足時整批按比例縮減;人口 0 → 補不出來(被戰爭打空的 NPC 不再 1.6 天回滿)
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { and, eq, like, inArray } from "drizzle-orm";
import {
  db, pool, playerNationsTable, npcArmiesTable, militaryUnitTemplatesTable,
  regionControlsTable, mapRegionsTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";

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

const MARKER = "__npcpop__";
const runId = randomBytes(3).toString("hex");
const POP_PER_UNIT = 10;
let nationId = "";
let templateId = 0;
let regionId = 0;
const realCreate = anthropic.messages.create.bind(anthropic.messages);

async function cleanup() {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARKER}%`));
  await db.delete(militaryUnitTemplatesTable).where(like(militaryUnitTemplatesTable.name, `${MARKER}%`));
}
async function state() {
  const [c] = await db.select({ bonus: regionControlsTable.populationBonus }).from(regionControlsTable)
    .where(and(eq(regionControlsTable.nationId, nationId), eq(regionControlsTable.regionId, regionId)));
  const rows = await db.select().from(npcArmiesTable).where(eq(npcArmiesTable.nationId, nationId));
  return { bonus: c!.bonus, army: rows.reduce((s, r) => s + r.quantity, 0) };
}

before(async () => {
  for (const [m, f] of MIGS) await (await import(`./${m}`) as any)[f]();
  // AI 兵種設計一律失敗 → 只用我們預先放的專屬模板。
  (anthropic.messages as any).create = async () => { throw new Error("ai disabled in test"); };
  await cleanup();
  const [n] = await db.insert(playerNationsTable).values({ name: `${MARKER}${runId}`, isNpc: true })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
  const { getEraSlugs } = await import("./nationStats");
  const { currentEra } = await getEraSlugs();
  const [tpl] = await db.insert(militaryUnitTemplatesTable).values({
    name: `${MARKER}步兵${runId}`, category: "infantry", eraSlug: currentEra, hp: 10, attack: 5, defense: 5,
    speed: 5, accuracy: 50, range: "melee", prodCostPer100: 1, popCostPerUnit: POP_PER_UNIT,
    moneyCostPerUnit: 1, upkeepPerUnit: 1, isDefault: false, ownerNationId: nationId,
  }).returning({ id: militaryUnitTemplatesTable.id });
  templateId = tpl!.id;
  const [r] = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable).orderBy(mapRegionsTable.id).offset(250).limit(1);
  regionId = r!.id;
  await db.insert(regionControlsTable).values({ regionId, nationId, percent: 100 });
});
after(async () => {
  (anthropic.messages as any).create = realCreate;
  await cleanup();
  await pool.end();
});

test("補兵同額扣人口:產出 N 兵 → population_bonus 減少 N × popCostPerUnit", async () => {
  const { runNpcMilitaryTurn } = await import("./npcMilitary");
  const before = await state();
  await runNpcMilitaryTurn();
  const after = await state();
  const produced = after.army - before.army;
  assert.ok(produced > 0, "應有補兵");
  assert.equal(before.bonus - after.bonus, produced * POP_PER_UNIT, "人口同額減少");
});

test("人口被打空(人口 ≤ 0)→ 補不出兵、人口不再下降", async () => {
  const { runNpcMilitaryTurn } = await import("./npcMilitary");
  const { getEraSlugs, computeNationStats } = await import("./nationStats");
  const { statsEra } = await getEraSlugs();
  const stats = await computeNationStats(nationId, statsEra);
  // 把人口壓到 0:累積量 = −基準人口。
  await db.update(regionControlsTable).set({ populationBonus: -stats.basePopulation })
    .where(and(eq(regionControlsTable.nationId, nationId), eq(regionControlsTable.regionId, regionId)));
  await db.delete(npcArmiesTable).where(eq(npcArmiesTable.nationId, nationId));
  const before = await state();
  await runNpcMilitaryTurn();
  const after = await state();
  assert.equal(after.army, 0, "沒有人口就補不出兵");
  assert.equal(after.bonus, before.bonus, "人口不變");
});

test("人口只夠一部分 → 按比例縮減,絕不把人口扣成負的", async () => {
  const { runNpcMilitaryTurn } = await import("./npcMilitary");
  const { getEraSlugs, computeNationStats } = await import("./nationStats");
  const { statsEra } = await getEraSlugs();
  const stats = await computeNationStats(nationId, statsEra);
  const left = 55; // 只剩 55 人口 → 最多補 5 兵(每兵 10)
  await db.update(regionControlsTable).set({ populationBonus: -(stats.basePopulation - left) })
    .where(and(eq(regionControlsTable.nationId, nationId), eq(regionControlsTable.regionId, regionId)));
  await db.delete(npcArmiesTable).where(eq(npcArmiesTable.nationId, nationId));
  await runNpcMilitaryTurn();
  const after = await state();
  assert.ok(after.army <= 5, `補兵不可超過人口能負擔 (got ${after.army})`);
  const now = await computeNationStats(nationId, statsEra);
  assert.ok(now.population >= 0, "人口不為負");
  assert.ok(left - now.population <= after.army * POP_PER_UNIT + 0, "扣的人口 ≤ 補的兵 × 單價");
});
