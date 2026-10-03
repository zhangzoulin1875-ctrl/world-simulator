import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import {
  MAP_REGION_SEED,
  MAP_ADJACENCY_PAIRS,
  EXPECTED_ISOLATED,
  EXPECTED_REGION_COUNT,
  EXPECTED_MACRO_REGION_COUNT,
} from "./mapConstants.generated";

/**
 * 地區資料表與接壤關聯（二代地圖，373 區 × 14 大地區）。
 *
 * 常數（MAP_REGION_SEED / MAP_ADJACENCY_PAIRS / EXPECTED_ISOLATED / 兩個計數）
 * 由 scripts/src/worldmap/generateMapConstants.ts 從 regionMaster.ts 與
 * world-districts.topo.json 自動產生，見 mapConstants.generated.ts（請勿手改）。
 * 接壤以 topojson 共享弧線（陸地邊界）為準，另加少數人工橋樑／隧道／堤道；
 * 純海峽（無固定連結）不算接壤 → 該島為孤立區（has_no_land_border）。
 *
 * 同步為冪等：建表、依名稱 upsert 地區、以種子全量取代接壤（雙向）、刪除
 * 過期列、重算孤立旗標；可於每次啟動重跑。
 */

export {
  MAP_REGION_SEED,
  MAP_ADJACENCY_PAIRS,
  EXPECTED_ISOLATED,
  EXPECTED_REGION_COUNT,
  EXPECTED_MACRO_REGION_COUNT,
};

export interface MapRegionSeedRow {
  name: string;
  macro: string;
}

export function getSeedRows(): MapRegionSeedRow[] {
  const rows: MapRegionSeedRow[] = [];
  for (const [macro, names] of Object.entries(MAP_REGION_SEED)) {
    for (const name of names) rows.push({ name, macro });
  }
  return rows;
}

/**
 * Validate internal consistency of the seed constants. Throws on any
 * violation so a bad edit fails loudly at boot (and in the unit test)
 * instead of silently writing a broken map.
 */
export function validateMapRegionSeed(): void {
  const rows = getSeedRows();
  const names = new Set<string>();
  for (const row of rows) {
    if (names.has(row.name)) {
      throw new Error(`map region seed: duplicate region name ${row.name}`);
    }
    names.add(row.name);
  }
  if (rows.length !== EXPECTED_REGION_COUNT) {
    throw new Error(
      `map region seed: expected ${EXPECTED_REGION_COUNT} regions, got ${rows.length}`,
    );
  }
  const macroCount = Object.keys(MAP_REGION_SEED).length;
  if (macroCount !== EXPECTED_MACRO_REGION_COUNT) {
    throw new Error(
      `map region seed: expected ${EXPECTED_MACRO_REGION_COUNT} macro regions, got ${macroCount}`,
    );
  }

  const seenPairs = new Set<string>();
  const withNeighbour = new Set<string>();
  for (const [a, b] of MAP_ADJACENCY_PAIRS) {
    if (a === b) throw new Error(`map region seed: self adjacency for ${a}`);
    if (!names.has(a)) throw new Error(`map region seed: unknown region in pair: ${a}`);
    if (!names.has(b)) throw new Error(`map region seed: unknown region in pair: ${b}`);
    const key = [a, b].sort().join("\u0000");
    if (seenPairs.has(key)) {
      throw new Error(`map region seed: duplicate adjacency pair ${a} – ${b}`);
    }
    seenPairs.add(key);
    withNeighbour.add(a);
    withNeighbour.add(b);
  }

  const isolated = [...names].filter((n) => !withNeighbour.has(n)).sort();
  const expected = [...EXPECTED_ISOLATED].sort();
  if (
    isolated.length !== expected.length ||
    isolated.some((n, i) => n !== expected[i])
  ) {
    throw new Error(
      `map region seed: isolated set mismatch. derived=[${isolated.join(",")}] expected=[${expected.join(",")}]`,
    );
  }
}

/** Directed adjacency list (both directions of every undirected pair). */
export function getDirectedAdjacency(): Array<[string, string]> {
  const directed: Array<[string, string]> = [];
  for (const [a, b] of MAP_ADJACENCY_PAIRS) {
    directed.push([a, b]);
    directed.push([b, a]);
  }
  return directed;
}

/**
 * Idempotent startup sync: create tables if missing, upsert the 191 regions,
 * make the adjacency table exactly match the seed (both directions), and
 * recompute has_no_land_border. Safe to re-run on every boot.
 */
export async function runMapRegionSync(): Promise<void> {
  validateMapRegionSeed();

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS map_regions (
      id serial PRIMARY KEY,
      name text NOT NULL,
      macro_region text NOT NULL,
      has_no_land_border boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS map_regions_name_uidx ON map_regions (name)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS map_regions_macro_idx ON map_regions (macro_region)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS map_region_adjacencies (
      id serial PRIMARY KEY,
      region_id integer NOT NULL,
      adjacent_region_id integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT map_region_adjacencies_region_id_map_regions_id_fk
        FOREIGN KEY (region_id) REFERENCES map_regions(id) ON DELETE CASCADE,
      CONSTRAINT map_region_adjacencies_adjacent_region_id_map_regions_id_fk
        FOREIGN KEY (adjacent_region_id) REFERENCES map_regions(id) ON DELETE CASCADE
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS map_region_adjacencies_pair_uidx
      ON map_region_adjacencies (region_id, adjacent_region_id)
  `);
  // Defense in depth: no self-loops at the DB level either. ADD CONSTRAINT
  // has no IF NOT EXISTS, so guard via pg_constraint.
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'map_region_adjacencies_no_self_check'
      ) THEN
        ALTER TABLE map_region_adjacencies
          ADD CONSTRAINT map_region_adjacencies_no_self_check
          CHECK (region_id <> adjacent_region_id);
      END IF;
    END $$
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS map_region_adjacencies_adjacent_idx
      ON map_region_adjacencies (adjacent_region_id)
  `);

  const rows = getSeedRows();

  // Upsert all regions by name; keep macro_region in sync with the seed.
  await db.execute(sql`
    INSERT INTO map_regions (name, macro_region)
    SELECT e->>'name', e->>'macro'
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) AS e
    ON CONFLICT (name) DO UPDATE
      SET macro_region = EXCLUDED.macro_region, updated_at = NOW()
      WHERE map_regions.macro_region <> EXCLUDED.macro_region
  `);

  // Remove regions that are no longer in the seed (adjacencies cascade).
  const staleRegions = await db.execute(sql`
    DELETE FROM map_regions
    WHERE name NOT IN (
      SELECT jsonb_array_elements_text(${JSON.stringify(rows.map((r) => r.name))}::jsonb)
    )
    RETURNING name
  `);
  if (staleRegions.rows.length > 0) {
    logger.warn(
      { removed: staleRegions.rows.map((r) => (r as { name: string }).name) },
      "map region sync: removed regions no longer in seed",
    );
  }

  // Resolve name → id.
  const idRows = await db.execute<{ id: number; name: string }>(sql`
    SELECT id, name FROM map_regions
  `);
  const idByName = new Map<string, number>();
  for (const row of idRows.rows as Array<{ id: number; name: string }>) {
    idByName.set(row.name, row.id);
  }

  const directedIdPairs: Array<[number, number]> = [];
  for (const [a, b] of getDirectedAdjacency()) {
    const aId = idByName.get(a);
    const bId = idByName.get(b);
    if (aId === undefined || bId === undefined) {
      throw new Error(`map region sync: missing id for pair ${a} – ${b}`);
    }
    directedIdPairs.push([aId, bId]);
  }
  const pairsJson = JSON.stringify(directedIdPairs);

  // Insert missing adjacency rows (both directions are in the list).
  await db.execute(sql`
    INSERT INTO map_region_adjacencies (region_id, adjacent_region_id)
    SELECT (e->>0)::int, (e->>1)::int
    FROM jsonb_array_elements(${pairsJson}::jsonb) AS e
    ON CONFLICT (region_id, adjacent_region_id) DO NOTHING
  `);

  // Remove adjacency rows that are not in the seed any more.
  const staleAdj = await db.execute(sql`
    DELETE FROM map_region_adjacencies a
    WHERE NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(${pairsJson}::jsonb) AS e
      WHERE (e->>0)::int = a.region_id AND (e->>1)::int = a.adjacent_region_id
    )
    RETURNING a.id
  `);
  if (staleAdj.rows.length > 0) {
    logger.warn(
      { removed: staleAdj.rows.length },
      "map region sync: removed stale adjacency rows",
    );
  }

  // Recompute the isolation flag from actual adjacency rows.
  await db.execute(sql`
    UPDATE map_regions r
    SET has_no_land_border = sub.isolated, updated_at = NOW()
    FROM (
      SELECT r2.id,
        NOT EXISTS (
          SELECT 1 FROM map_region_adjacencies a WHERE a.region_id = r2.id
        ) AS isolated
      FROM map_regions r2
    ) AS sub
    WHERE sub.id = r.id AND r.has_no_land_border IS DISTINCT FROM sub.isolated
  `);

  const summary = await db.execute<{
    regions: number;
    adjacencies: number;
    isolated: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM map_regions) AS regions,
      (SELECT count(*)::int FROM map_region_adjacencies) AS adjacencies,
      (SELECT count(*)::int FROM map_regions WHERE has_no_land_border) AS isolated
  `);
  logger.info(
    summary.rows[0] as Record<string, number>,
    "map region sync complete",
  );
}
