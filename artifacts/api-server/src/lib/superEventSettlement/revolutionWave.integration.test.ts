import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import {
  db, pool, diplomacyWarsTable, playerNationsTable, regionControlsTable, mapRegionsTable,
  superEventsTable, superEventRegionsTable, superEventRegionPressureTable,
} from "@workspace/db";
import { runGameMigrations, runRegionControlMigrations } from "../gameMigrations";
import { runMapRegionSync } from "../mapRegions";
import { runSuperEventMigrations } from "../superEventMigrations";
import { stepRevolutionPressure, markRegionsRevolted, isRevolutionWave, triggerWaveRevolts } from "./revolutionWave";
import { REVOLUTION_CATEGORY, PRESSURE_START, REVOLT_AT } from "../revolutionWave";

const TAG = "__revwave_test__";
const runId = randomBytes(3).toString("hex");
let nationId = "";
let regionIds: number[] = [];
let eventId = "";

async function cleanup() {
  await db.delete(superEventsTable).where(like(superEventsTable.title, `${TAG}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
}

before(async () => {
  await runGameMigrations();
  await runMapRegionSync();
  await runRegionControlMigrations();
  await runSuperEventMigrations();
  await cleanup();
  const free = await db.execute(sql`select id from map_regions where id not in (select region_id from region_controls) order by id limit 2`);
  regionIds = (free.rows as { id: number }[]).map((r) => r.id);
  assert.equal(regionIds.length, 2, "dev DB 需有 2 個無主地區");
  const [n] = await db.insert(playerNationsTable).values({
    name: `${TAG}${runId}`, government: "議會共和", isNpc: false, stability: 20, unrest: 50,
  }).returning();
  nationId = n!.id;
  for (const regionId of regionIds) {
    await db.insert(regionControlsTable).values({ regionId, nationId, percent: 100 });
  }
  const [e] = await db.insert(superEventsTable).values({
    title: `${TAG}${runId}`, category: REVOLUTION_CATEGORY, scope: "regional", kind: "disaster",
    stage: "peak", severity: 50, status: "active", cause: "ai",
  }).returning();
  eventId = e!.id;
  await db.insert(superEventRegionsTable).values(regionIds.map((regionId) => ({ eventId, regionId })));
});
after(async () => { await cleanup(); await pool.end(); });

const event = async () => (await db.select().from(superEventsTable).where(eq(superEventsTable.id, eventId)))[0]!;
const pressures = async () =>
  new Map((await db.select().from(superEventRegionPressureTable).where(eq(superEventRegionPressureTable.eventId, eventId))).map((r) => [r.regionId, r]));

test("isRevolutionWave 只認「革命浪潮」類別", () => {
  assert.equal(isRevolutionWave({ category: REVOLUTION_CATEGORY }), true);
  assert.equal(isRevolutionWave({ category: "疾病" }), false);
});

test("第一回合:補齊壓力列並從起始壓力往上推(不滿國家漲更快)", async () => {
  const r = await stepRevolutionPressure({ event: await event(), newStage: "peak", impactMult: 1, affected: [], fitByNation: new Map() });
  const p = await pressures();
  assert.equal(p.size, 2);
  for (const rid of regionIds) assert.ok(p.get(rid)!.pressure > PRESSURE_START, `region ${rid}`);
  assert.deepEqual(r.readyRegionIds, []);
});

test("不處理:連續回合後地區到線;已脫離的地區不再累積", async () => {
  let ready: number[] = [];
  for (let i = 0; i < 12 && ready.length === 0; i++) {
    ready = (await stepRevolutionPressure({ event: await event(), newStage: "peak", impactMult: 1, affected: [], fitByNation: new Map() })).readyRegionIds;
  }
  assert.equal(ready.length, 2);
  await markRegionsRevolted(eventId, [regionIds[0]!]);
  const before = (await pressures()).get(regionIds[0]!)!.pressure;
  assert.equal(before, REVOLT_AT);
  await stepRevolutionPressure({ event: await event(), newStage: "peak", impactMult: 1, affected: [], fitByNation: new Map() });
  const p = await pressures();
  assert.ok(p.get(regionIds[0]!)!.revoltedAt, "已標記脫離");
  assert.equal(p.get(regionIds[0]!)!.pressure, before, "脫離後壓力不變");
});

test("極度動盪的國家,連滿分應對也壓不住高峰期(壓力停在線上)", async () => {
  const before = (await pressures()).get(regionIds[1]!)!.pressure;
  await stepRevolutionPressure({ event: await event(), newStage: "peak", impactMult: 1, affected: [], fitByNation: new Map([[nationId, 100]]) });
  const after_ = (await pressures()).get(regionIds[1]!)!.pressure;
  assert.ok(after_ >= before, `before=${before} after=${after_}`);
});

test("國內回穩後(穩定 55、暴動 0),高契合應對能把壓力壓下來", async () => {
  await db.update(playerNationsTable).set({ stability: 55, unrest: 0 }).where(eq(playerNationsTable.id, nationId));
  const before = (await pressures()).get(regionIds[1]!)!.pressure;
  await stepRevolutionPressure({ event: await event(), newStage: "peak", impactMult: 1, affected: [], fitByNation: new Map([[nationId, 100]]) });
  const after_ = (await pressures()).get(regionIds[1]!)!.pressure;
  assert.ok(after_ < before, `before=${before} after=${after_}`);
});

test("消退期壓力自然回落", async () => {
  const before = (await pressures()).get(regionIds[1]!)!.pressure;
  await stepRevolutionPressure({ event: await event(), newStage: "receding", impactMult: 1, affected: [], fitByNation: new Map() });
  const after_ = (await pressures()).get(regionIds[1]!)!.pressure;
  assert.equal(after_, before - 6);
});

test("爆發:到線地區合併切給一個 NPC 叛軍國並開內戰;原政權至少留一塊地", async () => {
  // 第三個地區當作「留給原政權」的地,確保不會被一次滅掉。
  const extra = await db.execute(sql`select id from map_regions where id not in (select region_id from region_controls) order by id limit 1`);
  const keepRegion = (extra.rows as { id: number }[])[0]!.id;
  await db.insert(regionControlsTable).values({ regionId: keepRegion, nationId, percent: 100 });
  const ev = await event();
  const out = await triggerWaveRevolts({ event: ev, readyRegionIds: [regionIds[1]!], tick: 1 });
  assert.equal(out.civilWars, 1);
  assert.deepEqual(out.revoltedRegionIds, [regionIds[1]]);
  const rebelOwner = await db.select().from(regionControlsTable).where(eq(regionControlsTable.regionId, regionIds[1]!));
  assert.equal(rebelOwner.length, 1);
  assert.notEqual(rebelOwner[0]!.nationId, nationId);
  assert.equal(rebelOwner[0]!.percent, 100);
  const [rebel] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, rebelOwner[0]!.nationId));
  assert.equal(rebel!.isNpc, true);
  const wars = await db.select().from(diplomacyWarsTable).where(eq(diplomacyWarsTable.rebelNationId, rebel!.id));
  assert.equal(wars.length, 1);
  assert.equal(wars[0]!.isCivilWar, true);
  assert.ok((await pressures()).get(regionIds[1]!)!.revoltedAt, "地區已標記脫離");
  // 原政權仍握有其他地區
  const left = await db.select().from(regionControlsTable).where(eq(regionControlsTable.nationId, nationId));
  assert.ok(left.length >= 1);
  await db.delete(playerNationsTable).where(eq(playerNationsTable.id, rebel!.id));
});

test("爆發保護:若會拿走原政權全部土地,這一波暫緩不爆發", async () => {
  const [n2] = await db.insert(playerNationsTable).values({ name: `${TAG}${runId}b`, government: "議會共和", isNpc: false }).returning();
  const lone = await db.execute(sql`select id from map_regions where id not in (select region_id from region_controls) order by id limit 1`);
  const loneRegion = (lone.rows as { id: number }[])[0]!.id;
  await db.insert(regionControlsTable).values({ regionId: loneRegion, nationId: n2!.id, percent: 100 });
  const out = await triggerWaveRevolts({ event: await event(), readyRegionIds: [loneRegion], tick: 1 });
  assert.equal(out.civilWars, 0);
  assert.deepEqual(out.revoltedRegionIds, []);
  const still = await db.select().from(regionControlsTable).where(eq(regionControlsTable.regionId, loneRegion));
  assert.equal(still[0]!.nationId, n2!.id);
});
