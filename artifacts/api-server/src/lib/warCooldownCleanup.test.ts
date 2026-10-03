/**
 * Task #375 — real-DB tests for capStaleRegionCooldowns():
 *  1. A far-future (24h-style legacy) cooldown row is capped to at most
 *     NOW() + REGION_COOLDOWN_MINUTES.
 *  2. A short, still-valid cooldown row is left untouched (LEAST never
 *     extends).
 * Existing rows for the two probe regions are snapshotted and restored, so
 * the suite is safe on a shared dev DB.
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the cooldown cleanup test");
}

const { db, warRegionCooldownsTable, mapRegionsTable } =
  await import("@workspace/db");
const { asc, inArray } = await import("drizzle-orm");
const { capStaleRegionCooldowns } = await import("./warMigrations");
const { REGION_COOLDOWN_MINUTES } = await import("./war");

// FK 需要真實 map_regions.id；動態取兩個實際存在的地區。
let STALE_REGION_ID = 0;
let FRESH_REGION_ID = 0;
let PROBE_IDS: number[] = [];

let savedRows: (typeof warRegionCooldownsTable.$inferSelect)[] = [];

before(async () => {
  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .orderBy(asc(mapRegionsTable.id))
    .limit(2);
  assert.equal(regions.length, 2, "需要至少兩個 map_regions 列");
  STALE_REGION_ID = regions[0]!.id;
  FRESH_REGION_ID = regions[1]!.id;
  PROBE_IDS = [STALE_REGION_ID, FRESH_REGION_ID];

  savedRows = await db
    .select()
    .from(warRegionCooldownsTable)
    .where(inArray(warRegionCooldownsTable.regionId, PROBE_IDS));
  await db
    .delete(warRegionCooldownsTable)
    .where(inArray(warRegionCooldownsTable.regionId, PROBE_IDS));
});

after(async () => {
  await db
    .delete(warRegionCooldownsTable)
    .where(inArray(warRegionCooldownsTable.regionId, PROBE_IDS));
  if (savedRows.length > 0) {
    await db.insert(warRegionCooldownsTable).values(savedRows);
  }
  const { pool } = await import("@workspace/db");
  await pool.end();
});

test("capStaleRegionCooldowns caps legacy long cooldowns, keeps short ones", async () => {
  const now = Date.now();
  const staleExpiry = new Date(now + 20 * 60 * 60 * 1000); // legacy 24h-style
  const freshExpiry = new Date(now + 10 * 60 * 1000); // valid 10-minute

  await db.insert(warRegionCooldownsTable).values([
    { regionId: STALE_REGION_ID, expiresAt: staleExpiry },
    { regionId: FRESH_REGION_ID, expiresAt: freshExpiry },
  ]);

  await capStaleRegionCooldowns();

  const rows = await db
    .select()
    .from(warRegionCooldownsTable)
    .where(inArray(warRegionCooldownsTable.regionId, PROBE_IDS));
  const byId = new Map(rows.map((r) => [r.regionId, r]));

  const capMs = Date.now() + REGION_COOLDOWN_MINUTES * 60_000 + 5_000; // clock slack
  const stale = byId.get(STALE_REGION_ID);
  assert.ok(stale, "stale row should still exist");
  assert.ok(
    stale.expiresAt.getTime() <= capMs,
    `stale cooldown should be capped to ≤ now + ${REGION_COOLDOWN_MINUTES}m, got ${stale.expiresAt.toISOString()}`,
  );
  assert.ok(
    stale.expiresAt.getTime() < staleExpiry.getTime(),
    "stale cooldown should have been shortened",
  );

  const fresh = byId.get(FRESH_REGION_ID);
  assert.ok(fresh, "fresh row should still exist");
  assert.equal(
    fresh.expiresAt.getTime(),
    freshExpiry.getTime(),
    "short cooldown must not be modified",
  );
});
