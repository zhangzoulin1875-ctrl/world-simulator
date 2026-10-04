/**
 * Task #38 — integration tests (real DB) for the founding/claim race
 * protections in routes/player.ts:
 *
 *  1. Two concurrent POST /api/player/nation picking the same region →
 *     exactly one 201 and one 409, and region_controls holds exactly one row
 *     for that region (the pg_advisory_xact_lock path).
 *  2. Two concurrent claims of the same 無主國家 → one success, one 409
 *     (the conditional-UPDATE path).
 *  3. A player who already owns a nation founding again → 409 via the
 *     unique-violation → pgErrorCode path, with no half-written data.
 *
 * Requires DATABASE_URL pointing at a database that has been migrated by a
 * normal server start (map_regions, player_nations, region_controls,
 * user_sessions must exist). All rows created here carry a recognizable
 * marker and are cleaned up before AND after the run, so the test is
 * repeatable: `pnpm --filter @workspace/api-server run test:integration`.
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the player race tests");
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
  mapCitiesTable,
  techTreeNodesTable,
  cityBuildingsTable,
  nationPopulationBuffsTable,
  playerResearchedTreeNodesTable,
  militaryUnitTemplatesTable,
  playerWoundedUnitsTable,
  playerUnitCustomizationsTable,
  worldGameStateTable,
  regionBuildingsTable,
} = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { scalesFromPopulation } = await import("../lib/nationScale");
const { getEraSlugs } = await import("../lib/nationStats");
// 建國開局資源 = 設定值（古典基準）× 建國當時世界時代與所選地區人口的動態價格尺度。
async function foundingScale(regionId: number): Promise<number> {
  const era = (await getEraSlugs()).currentEra;
  const res = await db.execute<{ population: string }>(sql`
    SELECT COALESCE(SUM(population::bigint), 0)::bigint AS population
    FROM map_region_era_stats WHERE region_id = ${regionId} AND era = ${era}`);
  return scalesFromPopulation(Number(res.rows[0]?.population ?? 0), era).price;
}
const playerRouter = (await import("./player")).default;

/** Marker prefixes so leftovers from any (even crashed) run are removable. */
const NATION_MARKER = "zrct";
const USER_MARKER = "racetest-";

const runId = randomBytes(4).toString("hex");
const NATION_PREFIX = `${NATION_MARKER}${runId}`;
const userId = (label: string) => `${USER_MARKER}${label}-${runId}`;
const nationName = (label: string) =>
  `${NATION_PREFIX}${label.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;

let server: http.Server;
let baseUrl: string;

const sessionTokens = new Map<string, string>();

async function sessionFor(label: string): Promise<string> {
  const existing = sessionTokens.get(label);
  if (existing) return existing;
  const token = await createSession({
    discordUserId: userId(label),
    username: userId(label),
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });
  sessionTokens.set(label, token);
  return token;
}

async function api(
  method: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const token = await sessionFor(label);
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function unclaimedRegionIds(count: number): Promise<number[]> {
  const rows = await db
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
    .limit(count);
  assert.equal(
    rows.length,
    count,
    `need ${count} unclaimed regions to run the race tests`,
  );
  return rows.map((r) => r.id);
}

async function cleanup(): Promise<void> {
  // Child rows keyed by discord_user_id (all FK player_nations.discord_user_id)
  // — remove them first so leftovers from a crashed run can't linger.
  await db
    .delete(cityBuildingsTable)
    .where(like(cityBuildingsTable.discordUserId, `${USER_MARKER}%`));
  await db
    .delete(nationPopulationBuffsTable)
    .where(like(nationPopulationBuffsTable.discordUserId, `${USER_MARKER}%`));
  // Tech-tree rows are nation-keyed (Task #481); deleting the nations below
  // cascades them via nation_id.
  await db
    .delete(playerWoundedUnitsTable)
    .where(like(playerWoundedUnitsTable.discordUserId, `${USER_MARKER}%`));
  await db
    .delete(playerUnitCustomizationsTable)
    .where(like(playerUnitCustomizationsTable.discordUserId, `${USER_MARKER}%`));
  // Deleting nations cascades to region_controls via nation_id.
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

before(async () => {
  await cleanup();
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
  app.use("/api", playerRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

test("concurrent founding on the same region → one 201, one 409, single control row", async () => {
  const [regionId] = await unclaimedRegionIds(1);

  const found = (label: string) =>
    api("POST", "/api/player/nation", label, {
      name: nationName(label),
      leaderName: `領袖-${label}`,
      government: "absolute_monarchy",
      regionIds: [regionId],
    });

  const [a, b] = await Promise.all([found("found-a"), found("found-b")]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(
    statuses,
    [201, 409],
    `expected one winner and one loser, got ${a.status}/${b.status}: ` +
      `${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`,
  );

  const loser = a.status === 409 ? a : b;
  assert.match(String(loser.json.error ?? ""), /已被其他國家掌控|已經擁有國家/);

  // Exactly one control row for the contested region.
  const controls = await db
    .select()
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, regionId!));
  assert.equal(controls.length, 1, "contested region must have exactly one control row");
  assert.equal(controls[0]!.percent, 100);

  // Exactly one nation row was created between the two racers — no orphan
  // nation without region controls (transaction rolled back for the loser).
  const nations = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_PREFIX}found%`));
  assert.equal(nations.length, 1, "only the winner's nation row may exist");
  assert.equal(controls[0]!.nationId, nations[0]!.id);
});

// ── Task #428 — 建國三選一政體驗證 ──

test("founding without government / with an illegal government → 400 zh-TW, no rows written", async () => {
  const [regionId] = await unclaimedRegionIds(1);
  const label = "gov-invalid";

  const attempt = (government?: unknown) =>
    api("POST", "/api/player/nation", label, {
      name: nationName("gov"),
      leaderName: "政體測試",
      regionIds: [regionId],
      ...(government === undefined ? {} : { government }),
    });

  for (const bad of [
    undefined, // 缺漏
    "theocracy", // 存在但不在三選一白名單
    "military_dictatorship",
    "not_a_government",
    "君主專制", // label 不是 slug
    "",
    123,
  ]) {
    const res = await attempt(bad);
    assert.equal(
      res.status,
      400,
      `government=${JSON.stringify(bad)} must be rejected, got ${res.status}: ${JSON.stringify(res.json)}`,
    );
    assert.match(String(res.json.error ?? ""), /請選擇建國政體/);
  }

  // No nation or control rows were written by the rejected attempts.
  const nations = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_PREFIX}gov%`));
  assert.equal(nations.length, 0, "rejected founding must not create a nation");
  const controls = await db
    .select()
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, regionId!));
  assert.equal(controls.length, 0, "rejected founding must not claim the region");
});

test("founding with each of the three allowed governments → 201 and correct zh-TW label stored", async () => {
  const regionIds = await unclaimedRegionIds(3);
  const cases: readonly { slug: string; label: string; who: string }[] = [
    { slug: "absolute_monarchy", label: "君主專制", who: "gov-am" },
    { slug: "aristocracy", label: "貴族制", who: "gov-ar" },
    { slug: "parliamentary_republic", label: "議會共和制", who: "gov-pr" },
  ];
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const res = await api("POST", "/api/player/nation", c.who, {
      name: nationName(c.who),
      leaderName: `領袖-${c.who}`,
      government: c.slug,
      regionIds: [regionIds[i]],
    });
    assert.equal(res.status, 201, `${c.slug}: ${JSON.stringify(res.json)}`);
    const [row] = await db
      .select({ government: playerNationsTable.government })
      .from(playerNationsTable)
      .where(like(playerNationsTable.name, `${NATION_PREFIX}${c.who.replace(/[^a-zA-Z0-9]/g, "")}%`));
    assert.equal(row?.government, c.label, c.slug);
  }
});

test("concurrent claim of the same 無主國家 → one winner, one 409", async () => {
  const [unowned] = await db
    .insert(playerNationsTable)
    .values({
      discordUserId: null,
      name: nationName("unowned"),
      leaderName: "前朝領袖",
      government: "君主制",
    })
    .returning({ id: playerNationsTable.id });

  const claim = (label: string) =>
    api("POST", `/api/player/unowned-nations/${unowned!.id}/claim`, label);

  const [a, b] = await Promise.all([claim("claim-a"), claim("claim-b")]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(
    statuses,
    [200, 409],
    `expected one winner and one loser, got ${a.status}/${b.status}: ` +
      `${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`,
  );
  const loser = a.status === 409 ? a : b;
  assert.match(
    String(loser.json.error ?? ""),
    /剛被其他玩家接手|已經擁有國家/,
  );

  // The nation has exactly one owner, and it is one of the two racers.
  const [row] = await db
    .select({ owner: playerNationsTable.discordUserId })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, unowned!.id));
  assert.ok(row?.owner, "claimed nation must have an owner");
  assert.ok(
    [userId("claim-a"), userId("claim-b")].includes(row!.owner!),
    "owner must be one of the racing claimants",
  );
});

test("founding again while already owning a nation → 409 via unique violation, no leftover data", async () => {
  const [regionId] = await unclaimedRegionIds(1);

  // claim-a / claim-b: one of them owns the claimed nation from the previous
  // test. Use whichever owns it to hit the unique-violation path.
  const [owned] = await db
    .select({ owner: playerNationsTable.discordUserId })
    .from(playerNationsTable)
    .where(
      and(
        like(playerNationsTable.name, `${NATION_PREFIX}unowned%`),
        like(playerNationsTable.discordUserId, `${USER_MARKER}%`),
      ),
    );
  assert.ok(owned?.owner, "previous test must have produced an owned nation");
  const ownerLabel = owned!.owner === userId("claim-a") ? "claim-a" : "claim-b";

  const res = await api("POST", "/api/player/nation", ownerLabel, {
    name: nationName("second"),
    leaderName: "重複建國者",
    government: "absolute_monarchy",
    regionIds: [regionId],
  });
  assert.equal(res.status, 409, JSON.stringify(res.json));
  assert.match(String(res.json.error ?? ""), /已經擁有國家/);

  // Transaction must have rolled back completely: no second nation row and
  // no control row on the region it tried to take.
  const second = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_PREFIX}second%`));
  assert.equal(second.length, 0, "failed founding must not leave a nation row");
  const controls = await db
    .select()
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, regionId!));
  assert.equal(controls.length, 0, "failed founding must not leave region controls");
});

test("quit → 200 with every FK'd child present (buildings / pop buff / wounded / renamed default unit); user-keyed children removed, nation-keyed tech survives, nation becomes 無主", async () => {
  const [regionId] = await unclaimedRegionIds(1);
  const label = "quit-owner";
  const uid = userId(label);

  // Found a nation the normal way so discord_user_id is set and it owns a region.
  const founded = await api("POST", "/api/player/nation", label, {
    name: nationName("quit"),
    leaderName: "退位領袖",
    government: "absolute_monarchy",
    regionIds: [regionId],
  });
  assert.equal(founded.status, 201, JSON.stringify(founded.json));
  const nationId = founded.json.nation.id as string;

  // Real city + production tech to satisfy the FKs.
  const [city] = await db
    .select({ id: mapCitiesTable.id })
    .from(mapCitiesTable)
    .limit(1);
  assert.ok(city, "need at least one map city seeded");
  const [tech] = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.domain, "production"))
    .limit(1);
  assert.ok(tech, "need at least one production tech tree node seeded");

  // Tables that FK player_nations.discord_user_id — their presence previously
  // made quit fail with a 500 because nulling discord_user_id (an ON UPDATE
  // event, default NO ACTION) was restricted while any child row still
  // referenced the old value. All three must be deleted inside the quit tx.
  await db
    .insert(cityBuildingsTable)
    .values({ discordUserId: uid, cityId: city!.id, buildingType: "farm" });
  await db.insert(nationPopulationBuffsTable).values({
    discordUserId: uid,
    growthPct: 5,
    remainingTurns: 3,
    source: NATION_MARKER,
  });
  // Task #481 — 科技樹研發紀錄改鍵到 nation_id：退出後應跟著無主國家保留，
  // 不再於 quit 交易內刪除（也不再擋 discord_user_id null 化）。
  // onConflictDoNothing: if a concurrent forced-turn test advanced the world
  // era, founding auto-grants pre-era tree nodes (joinEraTech) — the fixture
  // node may already exist for this nation. Either way the child row is
  // present, which is all this test needs.
  await db
    .insert(playerResearchedTreeNodesTable)
    .values({ nationId, nodeId: tech!.id })
    .onConflictDoNothing();

  // Military child rows that also FK player_nations.discord_user_id: a wounded
  // national-pool entry, and a rename of a SEEDED DEFAULT template. The default
  // template is not owned by the player, so it does NOT cascade with the
  // owner-template delete — the customization row must be cleared explicitly or
  // it blocks the null-out → 500.
  const [tmpl] = await db
    .select({ id: militaryUnitTemplatesTable.id })
    .from(militaryUnitTemplatesTable)
    .limit(1);
  assert.ok(tmpl, "need at least one military unit template seeded");
  await db
    .insert(playerWoundedUnitsTable)
    .values({ discordUserId: uid, templateId: tmpl!.id, wounded: 3 });
  await db
    .insert(playerUnitCustomizationsTable)
    .values({ discordUserId: uid, templateId: tmpl!.id, customName: "改名部隊" });

  // Task #565 — 地區資源建築跟著無主國家保留，其 production_reserved 份額
  // 必須留在 production_spent（不變量 spent = Σ軍隊 reserved + Σ建築 reserved）。
  // 灌一筆已知 reserved 的建築 + 一個偏高的 spent（模擬還有軍隊份額），退出後
  // spent 應收斂到「只剩建築份額」而不是 0。
  const BUILDING_RESERVED = 777;
  await db.insert(regionBuildingsTable).values({
    nationId,
    regionId: regionId!,
    buildingType: "mine",
    level: 2,
    productionReserved: BUILDING_RESERVED,
  });
  await db
    .update(playerNationsTable)
    .set({ productionSpent: BUILDING_RESERVED + 500, populationSpent: 40 })
    .where(eq(playerNationsTable.id, nationId));

  const quit = await api("POST", "/api/player/nation/quit", label);
  assert.equal(
    quit.status,
    200,
    `quit must succeed, got ${quit.status}: ${JSON.stringify(quit.json)}`,
  );

  // The nation lives on but is now 無主 (discord_user_id null).
  const [row] = await db
    .select({
      owner: playerNationsTable.discordUserId,
      productionSpent: playerNationsTable.productionSpent,
      populationSpent: playerNationsTable.populationSpent,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "nation row must live on after quit (becomes 無主)");
  assert.equal(row!.owner, null, "quit must null out discord_user_id");

  // Task #565 — 不變量 spent = Σ(軍隊 reserved) + Σ(建築 reserved)：退出後
  // 軍隊全刪（份額 0），建築保留 → spent 必須等於建築份額，不能歸零也不能
  // 殘留軍隊份額（幽靈佔用）。
  assert.equal(
    Number(row!.productionSpent),
    BUILDING_RESERVED,
    "production_spent after quit must equal the surviving buildings' reserved sum",
  );
  assert.equal(
    Number(row!.populationSpent),
    0,
    "population_spent must reset to 0 on quit (buildings don't reserve population)",
  );
  const survivingBuildings = await db
    .select({ id: regionBuildingsTable.id })
    .from(regionBuildingsTable)
    .where(eq(regionBuildingsTable.nationId, nationId));
  assert.equal(
    survivingBuildings.length,
    1,
    "region buildings must survive quit (follow the ownerless nation)",
  );

  // Every child row for this user was removed by the quit transaction.
  const buildings = await db
    .select({ id: cityBuildingsTable.id })
    .from(cityBuildingsTable)
    .where(eq(cityBuildingsTable.discordUserId, uid));
  assert.equal(buildings.length, 0, "city buildings must be deleted on quit");
  const buffs = await db
    .select({ id: nationPopulationBuffsTable.id })
    .from(nationPopulationBuffsTable)
    .where(eq(nationPopulationBuffsTable.discordUserId, uid));
  assert.equal(buffs.length, 0, "population buffs must be deleted on quit");
  const techs = await db
    .select({ nodeId: playerResearchedTreeNodesTable.nodeId })
    .from(playerResearchedTreeNodesTable)
    .where(eq(playerResearchedTreeNodesTable.nationId, nationId));
  assert.ok(
    techs.some((t) => t.nodeId === tech!.id),
    "nation-keyed researched tech must survive quit (follows the ownerless nation)",
  );
  const wounded = await db
    .select({ id: playerWoundedUnitsTable.id })
    .from(playerWoundedUnitsTable)
    .where(eq(playerWoundedUnitsTable.discordUserId, uid));
  assert.equal(wounded.length, 0, "wounded national pool must be deleted on quit");
  const customs = await db
    .select({ id: playerUnitCustomizationsTable.id })
    .from(playerUnitCustomizationsTable)
    .where(eq(playerUnitCustomizationsTable.discordUserId, uid));
  assert.equal(customs.length, 0, "unit customizations must be deleted on quit");
});

// ── Task #504 — 開局資源設定：自創建國套用、接手無主國家不受影響 ──

test("founding applies world starting resources; claiming an unowned nation keeps its own resources", async () => {
  // 共用開發 DB 的全域單列：快照 → 改成測試值 → 驗證 → finally 還原。
  const [snap] = await db
    .select({
      startingTechPoints: worldGameStateTable.startingTechPoints,
      startingMoney: worldGameStateTable.startingMoney,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  assert.ok(snap, "world_game_state id=1 must exist (startup migration)");

  try {
    await db
      .update(worldGameStateTable)
      .set({ startingTechPoints: 777, startingMoney: 98765 })
      .where(eq(worldGameStateTable.id, 1));

    // 1) 自創建國 → 新國家的科技點數／金錢等於世界設定值。
    const [regionId] = await unclaimedRegionIds(1);
    const founded = await api("POST", "/api/player/nation", "starting-res", {
      name: nationName("startres"),
      leaderName: "開局資源測試",
      government: "absolute_monarchy",
      regionIds: [regionId],
    });
    assert.equal(founded.status, 201, JSON.stringify(founded.json));
    const [created] = await db
      .select({
        techPoints: playerNationsTable.techPoints,
        money: playerNationsTable.money,
      })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, founded.json.nation.id as string));
    assert.equal(created?.techPoints, Math.round(777 * (await foundingScale(regionId!))), "founding must apply startingTechPoints × 時代係數");
    assert.equal(created?.money, Math.round(98765 * (await foundingScale(regionId!))), "founding must apply startingMoney × 時代係數");

    // 2) 接手無主國家 → 沿用該國既有資源，不套用開局設定。
    const [unowned] = await db
      .insert(playerNationsTable)
      .values({
        discordUserId: null,
        name: nationName("startres-unowned"),
        leaderName: "無主國家",
        government: "君主制",
        techPoints: 42,
        money: 1234,
      })
      .returning({ id: playerNationsTable.id });
    const claimed = await api(
      "POST",
      `/api/player/unowned-nations/${unowned!.id}/claim`,
      "starting-claim",
    );
    assert.equal(claimed.status, 200, JSON.stringify(claimed.json));
    const [afterClaim] = await db
      .select({
        techPoints: playerNationsTable.techPoints,
        money: playerNationsTable.money,
      })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, unowned!.id));
    assert.equal(afterClaim?.techPoints, 42, "claim must keep existing techPoints");
    assert.equal(afterClaim?.money, 1234, "claim must keep existing money");
  } finally {
    await db
      .update(worldGameStateTable)
      .set({
        startingTechPoints: snap!.startingTechPoints,
        startingMoney: snap!.startingMoney,
      })
      .where(eq(worldGameStateTable.id, 1));
  }
});
