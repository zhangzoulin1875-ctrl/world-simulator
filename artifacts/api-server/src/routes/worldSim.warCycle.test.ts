/**
 * Task #324 — route-level integration test (real DB) for the "adjust the global
 * war cycle via AI world-sim → all active campaigns re-cycle immediately" path.
 *
 * The pure warEngine helper applyGlobalWarCycleHours is covered in
 * war.race.test.ts. This file closes the last gap: it drives the *endpoint*
 * (`PUT /api/world-sim/settings`) with an admin token and asserts the route
 * actually invokes the global apply when warCycleHours changes, and does NOT
 * touch campaigns when it is unchanged. Without this, a future edit to
 * worldSim.ts could silently drop the applyGlobalWarCycleHours call and no test
 * would notice.
 *
 * Coverage:
 *  1. Changing warCycleHours through the endpoint sets every active campaign's
 *     cycle_hours to the new value and resets next_resolve_at ≈ now + new cycle.
 *  2. PUT-ing the SAME warCycleHours (unchanged) leaves the campaigns' cycle_hours
 *     and next_resolve_at byte-identical (the `!== current` guard skips apply).
 *
 * The singleton world_game_state row (id=1) war_cycle_hours is snapshotted in
 * before() and restored in after() so this file never corrupts the shared row.
 * Runs serially in the test:integration workflow (--test-concurrency=1).
 *
 * Requires DATABASE_URL pointing at a DB migrated by a normal server start:
 * `pnpm --filter @workspace/api-server run test:integration`.
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the war-cycle route tests");
}

// requireAdmin reads ADMIN_TOKEN once at module load; set it before the worldSim
// router (and its requireAdmin middleware) is imported below.
const ADMIN_TOKEN = `wctest-admin-${randomBytes(4).toString("hex")}`;
process.env.ADMIN_TOKEN = ADMIN_TOKEN;

const express = (await import("express")).default;
const { and, eq, gt, inArray, like, notExists, sql } =
  await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  militaryUnitTemplatesTable,
  regionControlsTable,
  mapRegionAdjacenciesTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warRegionCooldownsTable,
  worldGameStateTable,
} = await import("@workspace/db");
const { initiateCampaign, flushWarBackgroundWork } = await import(
  "../lib/warEngine"
);
const { runWorldSimMigrations } = await import("../lib/worldSimMigrations");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");

// Task #569 — before() 的兩次 initiateCampaign 會背景生成地形簡報（真 AI），
// after() 的 flushWarBackgroundWork 會等它落地（每場 10–30 秒）。本檔不驗證
// 簡報內容，直接以合法文字樁取代，全檔絕不打真 Anthropic API。
anthropic.messages.create = (async (params: { system?: unknown }) => {
  const system = typeof params?.system === "string" ? params.system : "";
  if (system.includes("兵種分析 AI")) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            counterSummary: "無顯著兵種克制關係。",
            anachronisticUnits: [],
          }),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text: "測試樁地形簡報：兩地區以丘陵與河谷相接，攻守要點在渡口與城郊高地，補給線沿河而行，雨季氾濫時僅高地可通行。".repeat(
          2,
        ),
      },
    ],
  };
}) as unknown as typeof anthropic.messages.create;
const worldSimRouter = (await import("./worldSim")).default;

/**
 * Marker prefixes distinct from the racetest/miltest/wartest/wsapply namespaces
 * so this suite's LIKE cleanup never touches (or is touched by) those runs.
 */
const NATION_MARKER = "__wctest__";
const runId = randomBytes(4).toString("hex");
const attackerName = `${NATION_MARKER}${runId}-a`;
const defenderName = `${NATION_MARKER}${runId}-npc`;

/** Baseline cycle campaigns are created with; the endpoint changes it below. */
const BASELINE_CYCLE_HOURS = 24;
const NEW_CYCLE_HOURS = 6;
const HOUR_MS = 3_600_000;

let server: http.Server;
let baseUrl: string;

let attackerId: string;
let defenderId: string;
let warId: number;
let r1: number, r2: number, r3: number, r4: number;
const campaignIds: number[] = [];
/** Snapshot of the shared singleton to restore in after(). */
let originalWarCycleHours = BASELINE_CYCLE_HOURS;

async function adminApi(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function cleanup(): Promise<void> {
  // Deleting nations cascades to region_controls, diplomacy_wars, war_campaigns
  // (and from there to legions / engagements). war_region_cooldowns is keyed by
  // region only (no nation FK) — after() deletes the four regions this run used.
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
}

before(async () => {
  await runWorldSimMigrations();
  await cleanup();

  // Snapshot the shared singleton so we can restore it, then pin the baseline
  // so campaigns created below get cycle_hours = BASELINE_CYCLE_HOURS.
  const [state] = await db
    .select({ warCycleHours: worldGameStateTable.warCycleHours })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  assert.ok(state, "world_game_state id=1 must exist after migrations");
  originalWarCycleHours = state!.warCycleHours;
  await db
    .update(worldGameStateTable)
    .set({ warCycleHours: BASELINE_CYCLE_HOURS })
    .where(eq(worldGameStateTable.id, 1));

  // Two disjoint adjacency pairs whose four regions are all unclaimed and not in
  // post-war cooldown, so the test never touches real game data.
  const uncontrolled = (
    col:
      | typeof mapRegionAdjacenciesTable.regionId
      | typeof mapRegionAdjacenciesTable.adjacentRegionId,
  ) =>
    notExists(
      db
        .select({ one: sql`1` })
        .from(regionControlsTable)
        .where(eq(regionControlsTable.regionId, col)),
    );
  const notCooling = (
    col:
      | typeof mapRegionAdjacenciesTable.regionId
      | typeof mapRegionAdjacenciesTable.adjacentRegionId,
  ) =>
    notExists(
      db
        .select({ one: sql`1` })
        .from(warRegionCooldownsTable)
        .where(
          and(
            eq(warRegionCooldownsTable.regionId, col),
            gt(warRegionCooldownsTable.expiresAt, new Date()),
          ),
        ),
    );
  const pairs = await db
    .select({
      a: mapRegionAdjacenciesTable.regionId,
      b: mapRegionAdjacenciesTable.adjacentRegionId,
    })
    .from(mapRegionAdjacenciesTable)
    .where(
      and(
        sql`${mapRegionAdjacenciesTable.regionId} < ${mapRegionAdjacenciesTable.adjacentRegionId}`,
        uncontrolled(mapRegionAdjacenciesTable.regionId),
        uncontrolled(mapRegionAdjacenciesTable.adjacentRegionId),
        notCooling(mapRegionAdjacenciesTable.regionId),
        notCooling(mapRegionAdjacenciesTable.adjacentRegionId),
      ),
    )
    .orderBy(
      mapRegionAdjacenciesTable.regionId,
      mapRegionAdjacenciesTable.adjacentRegionId,
    )
    .limit(100);
  const pair1 = pairs[0];
  assert.ok(pair1, "need at least one unclaimed adjacent region pair");
  const pair2 = pairs.find(
    (p) =>
      p.a !== pair1.a && p.a !== pair1.b && p.b !== pair1.a && p.b !== pair1.b,
  );
  assert.ok(pair2, "need a second disjoint unclaimed adjacent region pair");
  r1 = pair1.a;
  r2 = pair1.b;
  r3 = pair2.a;
  r4 = pair2.b;

  const [attacker] = await db
    .insert(playerNationsTable)
    .values({
      name: attackerName,
      leaderName: "戰役週期路由測試",
      government: "君主制",
      isNpc: true,
    })
    .returning({ id: playerNationsTable.id });
  attackerId = attacker!.id;
  const [defender] = await db
    .insert(playerNationsTable)
    .values({ name: defenderName, isNpc: true, government: "君主制" })
    .returning({ id: playerNationsTable.id });
  defenderId = defender!.id;

  await db.insert(regionControlsTable).values([
    { regionId: r1, nationId: attackerId, percent: 100 },
    { regionId: r3, nationId: attackerId, percent: 100 },
    { regionId: r2, nationId: defenderId, percent: 100 },
    { regionId: r4, nationId: defenderId, percent: 100 },
  ]);

  const [aId, bId] = [attackerId, defenderId].sort();
  const [warRow] = await db
    .insert(diplomacyWarsTable)
    .values({
      nationAId: aId!,
      nationBId: bId!,
      declaredByNationId: attackerId,
    })
    .returning({ id: diplomacyWarsTable.id });
  warId = warRow!.id;

  // Task #549 — 預設兵種已移除：為兩個 NPC 國各建一個專屬模板
  // （開戰守門要求 NPC 有可用兵種，避免測試觸發 AI 兵種設計）。
  const unitBase = {
    category: "infantry",
    hp: 100,
    attack: 100,
    defense: 10,
    speed: 1,
    accuracy: 80,
    range: "melee",
    prodCostPer100: 1,
    popCostPerUnit: 1,
    moneyCostPerUnit: 10,
  } as const;
  await db.insert(militaryUnitTemplatesTable).values([
    {
      ...unitBase,
      ownerNationId: attackerId,
      name: `${NATION_MARKER}${runId}-攻方步兵`,
    },
    {
      ...unitBase,
      ownerNationId: defenderId,
      name: `${NATION_MARKER}${runId}-守方步兵`,
    },
  ]);

  // Two active campaigns of this war (both read war_cycle_hours = baseline).
  const c1 = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId: r1,
    defenderRegionId: r2,
  });
  const c2 = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId: r3,
    defenderRegionId: r4,
  });
  campaignIds.push(c1.id, c2.id);

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info() {},
      warn() {},
      error() {},
    };
    next();
  });
  app.use(express.json());
  app.use("/api", worldSimRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // Restore the shared singleton war_cycle_hours we mutated.
  await db
    .update(worldGameStateTable)
    .set({ warCycleHours: originalWarCycleHours })
    .where(eq(worldGameStateTable.id, 1));
  await db
    .delete(warRegionCooldownsTable)
    .where(inArray(warRegionCooldownsTable.regionId, [r1, r2, r3, r4]));
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  // Let the open-war terrain briefing background writes land before pool.end().
  await flushWarBackgroundWork();
  await pool.end();
});

test("PUT /api/world-sim/settings 改 warCycleHours → 每場進行中戰役 cycle_hours 立即更新、next_resolve_at ≈ now + 新週期", async () => {
  // Sanity: campaigns start at the baseline cycle before the endpoint call.
  const before = await db
    .select({
      id: warCampaignsTable.id,
      cycleHours: warCampaignsTable.cycleHours,
    })
    .from(warCampaignsTable)
    .where(inArray(warCampaignsTable.id, campaignIds));
  assert.equal(before.length, 2);
  for (const c of before) assert.equal(c.cycleHours, BASELINE_CYCLE_HOURS);

  const now = Date.now();
  const res = await adminApi("PUT", "/api/world-sim/settings", {
    warCycleHours: NEW_CYCLE_HOURS,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.settings.warCycleHours, NEW_CYCLE_HOURS);

  const rows = await db
    .select({
      id: warCampaignsTable.id,
      cycleHours: warCampaignsTable.cycleHours,
      nextResolveAt: warCampaignsTable.nextResolveAt,
      status: warCampaignsTable.status,
    })
    .from(warCampaignsTable)
    .where(inArray(warCampaignsTable.id, campaignIds));
  assert.equal(rows.length, 2);
  const expected = now + NEW_CYCLE_HOURS * HOUR_MS;
  for (const row of rows) {
    assert.equal(row.status, "active");
    assert.equal(
      row.cycleHours,
      NEW_CYCLE_HOURS,
      `campaign ${row.id} cycle_hours must be the new value`,
    );
    assert.ok(
      Math.abs(row.nextResolveAt.getTime() - expected) < 60_000,
      `campaign ${row.id} next_resolve_at ${row.nextResolveAt.toISOString()} should be ≈ now + ${NEW_CYCLE_HOURS}h`,
    );
  }
});

test("PUT /api/world-sim/settings warCycleHours 未變（送相同值）→ 進行中戰役 cycle_hours／next_resolve_at 完全不動", async () => {
  // After the previous test, current warCycleHours = NEW_CYCLE_HOURS.
  const before = await db
    .select({
      id: warCampaignsTable.id,
      cycleHours: warCampaignsTable.cycleHours,
      nextResolveAt: warCampaignsTable.nextResolveAt,
    })
    .from(warCampaignsTable)
    .where(inArray(warCampaignsTable.id, campaignIds));
  assert.equal(before.length, 2);

  // Re-send the SAME value plus an unrelated change so the endpoint still writes
  // the row but the `!== current` guard skips applyGlobalWarCycleHours.
  const res = await adminApi("PUT", "/api/world-sim/settings", {
    warCycleHours: NEW_CYCLE_HOURS,
    intensity: 2,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.settings.warCycleHours, NEW_CYCLE_HOURS);

  const after = await db
    .select({
      id: warCampaignsTable.id,
      cycleHours: warCampaignsTable.cycleHours,
      nextResolveAt: warCampaignsTable.nextResolveAt,
    })
    .from(warCampaignsTable)
    .where(inArray(warCampaignsTable.id, campaignIds));
  const byId = new Map(after.map((r) => [r.id, r]));
  for (const b of before) {
    const a = byId.get(b.id);
    assert.ok(a, `campaign ${b.id} must still exist`);
    assert.equal(a!.cycleHours, b.cycleHours, "cycle_hours must not change");
    assert.equal(
      a!.nextResolveAt.getTime(),
      b.nextResolveAt.getTime(),
      "next_resolve_at must not change when warCycleHours is unchanged",
    );
  }
});
