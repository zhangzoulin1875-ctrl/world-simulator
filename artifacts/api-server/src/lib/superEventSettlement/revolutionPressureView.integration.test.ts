import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { like, sql } from "drizzle-orm";
import {
  db, pool, playerNationsTable, regionControlsTable,
  superEventsTable, superEventRegionsTable, superEventRegionPressureTable,
} from "@workspace/db";
import { runGameMigrations, runRegionControlMigrations } from "../gameMigrations";
import { runMapRegionSync } from "../mapRegions";
import { runSuperEventMigrations } from "../superEventMigrations";
import { loadMyRegionPressures, pressureLevel } from "./revolutionPressureView";
import { REVOLUTION_CATEGORY, REVOLT_AT } from "../revolutionWave";

const TAG = "__revview_test__";
const runId = randomBytes(3).toString("hex");
let mine = "";
let other = "";
let eventId = "";
let myRegions: number[] = [];
let otherRegion = 0;

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
  const free = await db.execute(
    sql`select id from map_regions where id not in (select region_id from region_controls) order by id limit 3`,
  );
  const ids = (free.rows as { id: number }[]).map((r) => r.id);
  assert.equal(ids.length, 3, "dev DB 需有 3 個無主地區");
  const [a] = await db.insert(playerNationsTable).values({ name: `${TAG}A${runId}`, government: "議會共和", isNpc: false }).returning();
  const [b] = await db.insert(playerNationsTable).values({ name: `${TAG}B${runId}`, government: "議會共和", isNpc: false }).returning();
  mine = a!.id; other = b!.id;
  myRegions = [ids[0]!, ids[1]!]; otherRegion = ids[2]!;
  for (const r of myRegions) await db.insert(regionControlsTable).values({ regionId: r, nationId: mine, percent: 100 });
  await db.insert(regionControlsTable).values({ regionId: otherRegion, nationId: other, percent: 100 });
  const [e] = await db.insert(superEventsTable).values({
    title: `${TAG}${runId}`, category: REVOLUTION_CATEGORY, scope: "regional", kind: "disaster",
    stage: "spreading", severity: 50, status: "active", cause: "ai",
  }).returning();
  eventId = e!.id;
  await db.insert(superEventRegionsTable).values(ids.map((regionId) => ({ eventId, regionId })));
  await db.insert(superEventRegionPressureTable).values([
    { eventId, regionId: myRegions[0]!, pressure: 80 },
    { eventId, regionId: myRegions[1]!, pressure: 30, revoltedAt: null },
    { eventId, regionId: otherRegion, pressure: 95 },
  ]);
});
after(async () => { await cleanup(); await pool.end(); });

test("pressureLevel 分級邊界:39 平穩 / 40 緊張 / 74 緊張 / 75 危急", () => {
  assert.equal(pressureLevel(0), "calm");
  assert.equal(pressureLevel(39), "calm");
  assert.equal(pressureLevel(40), "tense");
  assert.equal(pressureLevel(74), "tense");
  assert.equal(pressureLevel(75), "critical");
  assert.equal(pressureLevel(100), "critical");
});

test("只回傳我自己掌控的地區,絕不含他國地區的壓力", async () => {
  const rows = await loadMyRegionPressures(eventId, mine);
  assert.equal(rows.length, 2);
  assert.ok(!rows.some((r) => r.regionId === otherRegion), "不得洩漏他國地區");
  const theirs = await loadMyRegionPressures(eventId, other);
  assert.deepEqual(theirs.map((r) => r.regionId), [otherRegion]);
  assert.equal(theirs[0]!.pressure, 95);
});

test("依壓力由高到低排序,並帶地區名稱、爆發線與分級", async () => {
  const rows = await loadMyRegionPressures(eventId, mine);
  assert.deepEqual(rows.map((r) => r.pressure), [80, 30]);
  assert.equal(rows[0]!.level, "critical");
  assert.equal(rows[1]!.level, "calm");
  assert.equal(rows[0]!.revoltAt, REVOLT_AT);
  assert.ok(rows[0]!.regionName.length > 0);
  assert.equal(rows[0]!.revolted, false);
});

test("已脫離的地區 revolted=true", async () => {
  await db.execute(sql`update super_event_region_pressure set revolted_at = now() where event_id = ${eventId} and region_id = ${myRegions[0]}`);
  const rows = await loadMyRegionPressures(eventId, mine);
  assert.equal(rows.find((r) => r.regionId === myRegions[0])!.revolted, true);
  assert.equal(rows.find((r) => r.regionId === myRegions[1])!.revolted, false);
});

test("沒有任何地區的國家 / 不存在的事件 → 空陣列", async () => {
  const [c] = await db.insert(playerNationsTable).values({ name: `${TAG}C${runId}`, government: "議會共和", isNpc: false }).returning();
  assert.deepEqual(await loadMyRegionPressures(eventId, c!.id), []);
  assert.deepEqual(await loadMyRegionPressures("00000000-0000-4000-8000-000000000000", mine), []);
});
