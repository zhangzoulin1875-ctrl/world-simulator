/**
 * Task #568 — integration tests (real DB) for the recruit-only immediate
 * production spend (flow) vs the long-term occupation (stock):
 *
 *  1. Recruit inserts a recruit_production_spends row; the resources snapshot
 *     reflects total − occupation − current-turn spend.
 *  2. Precise re-check: when occupation fits but occupation + current-turn
 *     spend + this spend exceeds total production → 400 生產力不足（本次招募需
 *     花費…）, full rollback (no spend row, spent counters unchanged).
 *  3. Concurrency: two recruits racing for a budget that fits only one →
 *     one 200 / one 400, exactly one spend row written.
 *  4. Cross-turn expiry: rows with created_at ≤ world_game_state.last_turn_at
 *     no longer count as current-turn spend (predicate-level check; the turn
 *     engine additionally deletes stale rows after claiming a turn).
 *  5. Disband gives no refund: spend rows and the current-turn total are
 *     unchanged after disbanding, while the occupation is released.
 *
 * Rows carry a unique marker and are cleaned before AND after the run. The
 * world_game_state.last_turn_at column is snapshotted and restored (shared
 * dev DB — later sequential files must see the original clock).
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the recruit spend turn tests",
  );
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, like, notExists, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  userSessionsTable,
  militaryUnitTemplatesTable,
  playerArmiesTable,
  recruitProductionSpendsTable,
  worldGameStateTable,
} = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { recruitCost, recruitProductionSpend, MIN_UPKEEP_PER_UNIT } =
  await import("../lib/military");
const { loadCurrentTurnRecruitSpend } = await import("../lib/recruitSpend");
const { computeNationStats, getStatsEraSlug } = await import(
  "../lib/nationStats"
);
const militaryRouter = (await import("./../routes/military")).default;

/** Markers distinct from other suites (LIKE-safe: no bare underscores that
 * could match foreign prefixes). */
const NATION_MARKER = "__spendtest__";
const USER_MARKER = "spendtest-";

const runId = randomBytes(4).toString("hex");
const userId = `${USER_MARKER}${runId}-${process.pid}`;
const nationName = `${NATION_MARKER}${runId}-${process.pid}`;

let server: http.Server;
let baseUrl: string;
let sessionToken: string;

let nationId: string;
let regionId: number;
let eraSlug: string;
let stats: { population: number; production: number };
let template: {
  id: number;
  prodCostPer100: number;
  popCostPerUnit: number;
  moneyCostPerUnit: number;
  woodCostPerUnit: number;
  oreCostPerUnit: number;
  prodUpkeepPerUnit: number;
};

/** 共用開發 DB：快照＋還原 world_game_state.last_turn_at（見記憶教訓）。 */
let savedLastTurnAt: Date | null = null;

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function cleanup(): Promise<void> {
  // Deleting nations cascades to region_controls, player_armies (user FK) and
  // recruit_production_spends (nation FK).
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function nationRow() {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "test nation must exist");
  return row!;
}

async function spendRows() {
  return db
    .select()
    .from(recruitProductionSpendsTable)
    .where(eq(recruitProductionSpendsTable.nationId, nationId));
}

async function resetState(): Promise<void> {
  await db
    .delete(playerArmiesTable)
    .where(eq(playerArmiesTable.discordUserId, userId));
  await db
    .delete(recruitProductionSpendsTable)
    .where(eq(recruitProductionSpendsTable.nationId, nationId));
  await db
    .update(playerNationsTable)
    .set({ productionSpent: 0, populationSpent: 0 })
    .where(eq(playerNationsTable.id, nationId));
}

async function setLastTurnAt(value: Date | null): Promise<void> {
  await db
    .update(worldGameStateTable)
    .set({ lastTurnAt: value })
    .where(eq(worldGameStateTable.id, 1));
}

before(async () => {
  await cleanup();

  const [world] = await db
    .select({ lastTurnAt: worldGameStateTable.lastTurnAt })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1));
  savedLastTurnAt = world?.lastTurnAt ?? null;

  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .where(
      notExists(
        db
          .select({ one: sql`1` })
          .from(regionControlsTable)
          .where(eq(regionControlsTable.regionId, mapRegionsTable.id)),
      ),
    )
    .orderBy(mapRegionsTable.id)
    .limit(1);
  assert.equal(regions.length, 1, "need an unclaimed region to run the tests");
  regionId = regions[0]!.id;

  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      discordUserId: userId,
      name: nationName,
      leaderName: "花費測試領袖",
      government: "君主制",
    })
    .returning({ id: playerNationsTable.id });
  nationId = nation!.id;
  await db
    .insert(regionControlsTable)
    .values({ regionId, nationId, percent: 100 });

  eraSlug = await getStatsEraSlug();
  stats = await computeNationStats(nationId, eraSlug);
  assert.ok(
    stats.production > 0 && stats.population > 0,
    `controlled region must yield stats (got ${JSON.stringify(stats)})`,
  );

  const [tpl] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ownerDiscordUserId: userId,
      isDefault: false,
      category: "infantry",
      name: `${NATION_MARKER}unit-${runId}`,
      eraSlug,
      hp: 100,
      attack: 100,
      defense: 10,
      speed: 1,
      accuracy: 80,
      range: "melee",
      prodCostPer100: 1,
      popCostPerUnit: 1,
      moneyCostPerUnit: 10,
      prodUpkeepPerUnit: MIN_UPKEEP_PER_UNIT,
    })
    .returning({
      id: militaryUnitTemplatesTable.id,
      prodCostPer100: militaryUnitTemplatesTable.prodCostPer100,
      popCostPerUnit: militaryUnitTemplatesTable.popCostPerUnit,
      moneyCostPerUnit: militaryUnitTemplatesTable.moneyCostPerUnit,
      woodCostPerUnit: militaryUnitTemplatesTable.woodCostPerUnit,
      oreCostPerUnit: militaryUnitTemplatesTable.oreCostPerUnit,
      prodUpkeepPerUnit: militaryUnitTemplatesTable.prodUpkeepPerUnit,
    });
  assert.ok(tpl, "custom test template must be inserted");
  template = tpl!;

  sessionToken = await createSession({
    discordUserId: userId,
    username: userId,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info() {},
      warn() {},
      error() {},
    };
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", militaryRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await setLastTurnAt(savedLastTurnAt);
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

test("recruit writes a spend row; snapshot deducts occupation + current-turn spend", async () => {
  await resetState();
  const quantity = 100;
  const cost = recruitCost(template, quantity);
  const spend = recruitProductionSpend(template, quantity);
  assert.ok(spend >= 1, "test order must spend at least 1 production");

  const r = await api("POST", "/api/military/recruit", {
    templateId: template.id,
    quantity,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const rows = await spendRows();
  assert.equal(rows.length, 1, "exactly one spend row per recruit");
  assert.equal(rows[0]!.amount, spend);
  assert.equal(rows[0]!.quantity, quantity);
  assert.equal(rows[0]!.templateId, template.id);

  assert.equal(await loadCurrentTurnRecruitSpend(nationId), spend);
  assert.equal(r.json.resources.currentTurnSpend, spend);
  assert.equal(
    r.json.resources.production,
    Math.max(0, stats.production - cost.production - spend),
    "available = total − occupation − current-turn spend",
  );
});

test("spend re-check: occupation fits but spend does not → 400 + full rollback", async () => {
  await resetState();
  const quantity = 100;
  const cost = recruitCost(template, quantity);
  const spend = recruitProductionSpend(template, quantity);

  // Leave room for the occupation but NOT for occupation + spend: the coarse
  // conditional-UPDATE guard passes, the precise post-lock re-check must fail
  // and roll the whole transaction back.
  const spent = stats.production - cost.production - (spend - 1);
  assert.ok(spent >= 0, "budget setup must be non-negative");
  await db
    .update(playerNationsTable)
    .set({ productionSpent: spent })
    .where(eq(playerNationsTable.id, nationId));

  const r = await api("POST", "/api/military/recruit", {
    templateId: template.id,
    quantity,
  });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(String(r.json.error ?? ""), /生產力不足（本次招募需花費/);

  const nation = await nationRow();
  assert.equal(nation.productionSpent, spent, "occupation must be rolled back");
  assert.equal((await spendRows()).length, 0, "no spend row may survive");
  assert.equal(await loadCurrentTurnRecruitSpend(nationId), 0);
});

test("concurrent recruits racing one spend budget → one 200, one 400, one spend row", async () => {
  await resetState();
  const quantity = 100;
  const cost = recruitCost(template, quantity);
  const spend = recruitProductionSpend(template, quantity);

  // Room for both occupations but only one spend: the row lock serializes the
  // two transactions, the loser's precise re-check must fail.
  const spent = stats.production - 2 * cost.production - spend;
  assert.ok(
    spent >= 0,
    `region budget must fit two occupations + one spend (production ${stats.production})`,
  );
  await db
    .update(playerNationsTable)
    .set({ productionSpent: spent })
    .where(eq(playerNationsTable.id, nationId));

  const recruit = () =>
    api("POST", "/api/military/recruit", { templateId: template.id, quantity });
  const [a, b] = await Promise.all([recruit(), recruit()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(
    statuses,
    [200, 400],
    `expected one winner and one loser, got ${a.status}/${b.status}: ` +
      `${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`,
  );
  const loser = a.status === 400 ? a : b;
  assert.match(String(loser.json.error ?? ""), /生產力不足/);

  assert.equal((await spendRows()).length, 1, "spend row written exactly once");
  assert.equal(await loadCurrentTurnRecruitSpend(nationId), spend);
  const nation = await nationRow();
  assert.equal(
    nation.productionSpent,
    spent + cost.production,
    "loser's occupation must be rolled back with its transaction",
  );
});

test("cross-turn expiry: rows at or before last_turn_at stop counting", async () => {
  await resetState();
  const quantity = 100;
  const spend = recruitProductionSpend(template, quantity);

  const r = await api("POST", "/api/military/recruit", {
    templateId: template.id,
    quantity,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(await loadCurrentTurnRecruitSpend(nationId), spend);

  // Simulate a turn having run after the recruit: predicate must exclude it.
  await setLastTurnAt(new Date(Date.now() + 1000));
  assert.equal(
    await loadCurrentTurnRecruitSpend(nationId),
    0,
    "spend recorded before last_turn_at must no longer count",
  );

  // last_turn_at = NULL → everything counts as current turn again.
  await setLastTurnAt(null);
  assert.equal(await loadCurrentTurnRecruitSpend(nationId), spend);

  await setLastTurnAt(savedLastTurnAt);
});

test("disband refunds occupation but never the recruit spend", async () => {
  await resetState();
  const quantity = 100;
  const cost = recruitCost(template, quantity);
  const spend = recruitProductionSpend(template, quantity);

  const r = await api("POST", "/api/military/recruit", {
    templateId: template.id,
    quantity,
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  const d = await api("POST", "/api/military/armies/disband", {
    templateId: template.id,
    quantity,
  });
  assert.equal(d.status, 200, JSON.stringify(d.json));

  const nation = await nationRow();
  assert.equal(
    nation.productionSpent,
    0,
    "disbanding all releases the full occupation",
  );
  assert.equal(nation.populationSpent, 0);
  assert.equal(
    (await spendRows()).length,
    1,
    "spend rows are never deleted by disband",
  );
  assert.equal(
    await loadCurrentTurnRecruitSpend(nationId),
    spend,
    "current-turn spend is not refunded by disband",
  );
  assert.equal(cost.production > 0, true);
});
