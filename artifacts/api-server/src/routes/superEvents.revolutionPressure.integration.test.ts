/**
 * GET /api/super-events/:id 的 revolutionPressure 欄位(真 DB + 真 Express):
 *  - 未登入 401;
 *  - 革命浪潮:只回「登入玩家自己掌控」的受波及地區壓力,他國的看不到;
 *  - 非革命浪潮事件:revolutionPressure = null。
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
const { like, sql } = await import("drizzle-orm");
const {
  db, pool, playerNationsTable, regionControlsTable,
  superEventsTable, superEventRegionsTable, superEventRegionPressureTable,
} = await import("@workspace/db");
const { runGameMigrations, runRegionControlMigrations } = await import("../lib/gameMigrations");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runSuperEventMigrations } = await import("../lib/superEventMigrations");
const { createSession } = await import("../lib/sessions");
const { REVOLUTION_CATEGORY } = await import("../lib/revolutionWave");
const { default: app } = await import("../app");

const TAG = "__sevp_test__";
const run = randomBytes(3).toString("hex");
let server: import("node:http").Server; let base = "";
let waveId = ""; let plainId = "";
let myCookie = ""; let otherCookie = "";
let myRegions: number[] = []; let otherRegion = 0;

async function cleanup() {
  await db.delete(superEventsTable).where(like(superEventsTable.title, `${TAG}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
}
async function mk(suffix: string) {
  const uid = `sevp-${run}-${suffix}`;
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: uid, name: `${TAG}${suffix}${run}`, government: "議會共和", isNpc: false,
  } as any).returning();
  const tok = await createSession({ discordUserId: uid, username: "t", avatar: null } as any);
  return { id: n!.id, cookie: `dn_session=${tok}` };
}
const getEvent = (id: string, cookie?: string) =>
  fetch(`${base}/api/super-events/${id}`, { headers: cookie ? { cookie } : {} });

before(async () => {
  await runGameMigrations(); await runMapRegionSync(); await runRegionControlMigrations(); await runSuperEventMigrations();
  await cleanup();
  const free = await db.execute(sql`select id from map_regions where id not in (select region_id from region_controls) order by id limit 3`);
  const ids = (free.rows as { id: number }[]).map((r) => r.id);
  assert.equal(ids.length, 3);
  myRegions = [ids[0]!, ids[1]!]; otherRegion = ids[2]!;
  const me = await mk("me"); const other = await mk("ot");
  myCookie = me.cookie; otherCookie = other.cookie;
  for (const r of myRegions) await db.insert(regionControlsTable).values({ regionId: r, nationId: me.id, percent: 100 });
  await db.insert(regionControlsTable).values({ regionId: otherRegion, nationId: other.id, percent: 100 });

  const [w] = await db.insert(superEventsTable).values({
    title: `${TAG}wave${run}`, category: REVOLUTION_CATEGORY, scope: "regional", kind: "disaster",
    stage: "spreading", severity: 50, status: "active", cause: "ai",
  }).returning();
  waveId = w!.id;
  await db.insert(superEventRegionsTable).values(ids.map((regionId) => ({ eventId: waveId, regionId })));
  await db.insert(superEventRegionPressureTable).values([
    { eventId: waveId, regionId: myRegions[0]!, pressure: 82 },
    { eventId: waveId, regionId: myRegions[1]!, pressure: 25 },
    { eventId: waveId, regionId: otherRegion, pressure: 97 },
  ]);
  const [p] = await db.insert(superEventsTable).values({
    title: `${TAG}plain${run}`, category: "疾病", scope: "global", kind: "disaster",
    stage: "outbreak", severity: 40, status: "active", cause: "ai",
  }).returning();
  plainId = p!.id;

  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await cleanup(); server.close(); await pool.end(); });

test("未登入 → 401", async () => {
  assert.equal((await getEvent(waveId)).status, 401);
});

test("革命浪潮:登入玩家只看到自己的地區壓力(高到低),看不到他國", async () => {
  const res = await getEvent(waveId, myCookie);
  assert.equal(res.status, 200);
  const j = (await res.json()) as any;
  assert.equal(j.category, REVOLUTION_CATEGORY);
  assert.deepEqual(j.revolutionPressure.map((r: any) => r.pressure), [82, 25]);
  assert.deepEqual(j.revolutionPressure.map((r: any) => r.level), ["critical", "calm"]);
  assert.ok(!j.revolutionPressure.some((r: any) => r.regionId === otherRegion));
  assert.ok(j.revolutionPressure.every((r: any) => r.revoltAt === 100 && typeof r.regionName === "string"));
});

test("他國玩家看同一事件:只看到他自己的那一區(97)", async () => {
  const j = (await (await getEvent(waveId, otherCookie)).json()) as any;
  assert.equal(j.revolutionPressure.length, 1);
  assert.equal(j.revolutionPressure[0].regionId, otherRegion);
  assert.equal(j.revolutionPressure[0].pressure, 97);
});

test("非革命浪潮事件:revolutionPressure 為 null", async () => {
  const j = (await (await getEvent(plainId, myCookie)).json()) as any;
  assert.equal(j.revolutionPressure, null);
});
