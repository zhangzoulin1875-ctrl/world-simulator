/**
 * Task #105 — integration tests (real DB) for the war-campaign concurrency
 * protections:
 *
 *  1. Two concurrent initiateCampaign() for the same attacker + region pair →
 *     exactly ONE campaign is created, the duplicate gets WarActionError 409
 *     （Task #648 的複合主鍵仍允許「不同戰役」同地區多對多攻打)。
 *  2. Two concurrent PUT /api/war/campaigns/:id/legions on two different
 *     campaigns of the same player, each requesting the full national army →
 *     one 200 and one 400 可用兵力不足（pg_advisory_xact_lock serializes the
 *     cross-campaign availability check）; committed frontline never exceeds
 *     the owned quantity.
 *
 * Requires DATABASE_URL pointing at a database migrated by a normal server
 * start (map_regions, map_region_adjacencies, player_nations, region_controls,
 * diplomacy_wars, war_* tables and the seeded default unit templates must
 * exist). All rows created here carry a recognizable marker and are cleaned
 * up before AND after the run:
 * `pnpm --filter @workspace/api-server run test:integration`.
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the war race tests");
}

// requireAdmin reads ADMIN_TOKEN once at module load; set it before the war
// router (and its requireAdmin middleware) is imported below so the admin
// settle/force-end endpoints are reachable in this suite.
const ADMIN_TOKEN = `wartest-admin-${randomBytes(4).toString("hex")}`;
process.env.ADMIN_TOKEN = ADMIN_TOKEN;

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, gt, inArray, like, notExists, notInArray, sql } =
  await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerArmiesTable,
  regionControlsTable,
  mapRegionAdjacenciesTable,
  userSessionsTable,
  militaryUnitTemplatesTable,
  diplomacyWarsTable,
  diplomacyTreatiesTable,
  diplomacyRelationsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  warCampaignOrdersTable,
  playerWoundedUnitsTable,
  warRegionCooldownsTable,
  warRegionEngagementsTable,
  worldGameStateTable,
  mapRegionEraStatsTable,
  playerNotificationsTable,
} = await import("@workspace/db");
type WarCampaign = Awaited<ReturnType<typeof initiateCampaign>>;
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const {
  initiateCampaign,
  settleDueCampaigns,
  settleCampaign,
  forceEndCampaign,
  applyGlobalWarCycleHours,
  flushWarBackgroundWork,
  WarActionError,
} = await import("../lib/warEngine");
const { allocateProportionally, areaCaptureSpeedFactor, scaleTerritoryShift } =
  await import("../lib/war");
const { MAP_REGION_AREAS_KM2 } = await import("../lib/mapRegionAreas.generated");
const { mapRegionsTable } = await import("@workspace/db");

/** Task #412 — 依地區面積算出結算實際套用的領土轉移（與 applyCycleResult 同邏輯）。 */
async function expectedShiftForRegion(
  regionId: number,
  aiShift: number,
): Promise<number> {
  const [region] = await db
    .select({ name: mapRegionsTable.name })
    .from(mapRegionsTable)
    .where(eq(mapRegionsTable.id, regionId));
  const area = region ? (MAP_REGION_AREAS_KM2[region.name] ?? null) : null;
  return scaleTerritoryShift(aiShift, areaCaptureSpeedFactor(area));
}
const { getEraSlugs } = await import("../lib/nationStats");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runWallMigrations } = await import("../lib/wallMigrations");
const { applyWorldSimSettingsInTransaction } = await import("./worldSim");
const warRouter = (await import("./war")).default;

/**
 * Marker prefixes so leftovers from any (even crashed) run are removable.
 * Deliberately distinct from the `__racetest__`/`racetest-` and
 * `__miltest__`/`miltest-` namespaces of the other suites — their LIKE
 * cleanup patterns require the literal "racetest"/"miltest", which
 * "wartest" never contains（`_` 是 LIKE 的單字元萬用字元）.
 */
const NATION_MARKER = "__wartest__";
const USER_MARKER = "wartest-";

const runId = randomBytes(4).toString("hex");
const userId = `${USER_MARKER}${runId}`;
const attackerName = `${NATION_MARKER}${runId}-a`;
const defenderName = `${NATION_MARKER}${runId}-npc`;

let server: http.Server;
let baseUrl: string;
let sessionToken: string;

let attackerId: string;
let defenderId: string;
/** pair 1: attacker r1 → defender r2; pair 2: attacker r3 → defender r4 */
let r1: number, r2: number, r3: number, r4: number;
let templateId: number;
const OWNED_QUANTITY = 1000;

let warId: number;
let campaign1Id: number;

/** Task #354 同區測試就地取用的備援地區；結算結束會留下 24h 冷卻（不隨國家刪除
 *  級聯），於 after() 一併清除。 */
const spareRegions: number[] = [];

/** NPC nations auto-founded by the Task #250 unowned-territory tests, cleaned
 *  up by id in after()（their `${region}王國` names don't match NATION_MARKER）. */
const foundedNpcIds: string[] = [];
/** 無主 nations created by the promote test（is_npc=false, discordUserId=null）;
 *  they don't carry a session but do carry NATION_MARKER, so cleanup() removes
 *  them — tracked here only for clarity. */
const unownedNationIds: string[] = [];

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
  // Deleting nations cascades to region_controls, player_armies (via
  // discord_user_id FKs), diplomacy_wars, war_campaigns (and from there to
  // legions / legion units / engagements / orders / reports). NOTE:
  // war_region_cooldowns is keyed by region only (no nation FK), so it does
  // NOT cascade — the ceasefire test ends campaigns and leaves 24h cooldowns
  // on the picked regions. Region selection in before() skips cooling
  // regions, and after() deletes the cooldowns this run created.
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

before(async () => {
  await runWallMigrations();
  await cleanup();

  // Two disjoint adjacency pairs whose four regions are all unclaimed and
  // not in post-war cooldown (a previous run's ceasefire leaves 24h
  // cooldowns), so the test can hand them out without touching real game
  // data.
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

  // Attacker = player nation with a session; defender = NPC（可應戰）.
  const [attacker] = await db
    .insert(playerNationsTable)
    .values({
      discordUserId: userId,
      name: attackerName,
      leaderName: "戰役競態測試領袖",
      government: "君主制",
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

  // Active war between the two（diplomacy_wars 要求 nation_a_id < nation_b_id）.
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

  // Task #549 — 預設兵種已移除：測試自建玩家自創步兵模板＋國家常備軍，
  // 並為 NPC 守方建立專屬模板（開戰守門要求 NPC 有可用兵種）。
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
  const [tpl] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ...unitBase,
      ownerDiscordUserId: userId,
      name: `${NATION_MARKER}${runId}-步兵`,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  assert.ok(tpl, "player infantry template must be inserted");
  templateId = tpl!.id;
  await db.insert(militaryUnitTemplatesTable).values({
    ...unitBase,
    ownerNationId: defenderId,
    name: `${NATION_MARKER}${runId}-NPC步兵`,
  });
  await db
    .insert(playerArmiesTable)
    .values({ discordUserId: userId, templateId, quantity: OWNED_QUANTITY });

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
  app.use("/api", warRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // Remove the region cooldowns this run's ceasefire created（keyed by
  // region only — no cascade from nation deletion）.
  await db
    .delete(warRegionCooldownsTable)
    .where(
      inArray(warRegionCooldownsTable.regionId, [r1, r2, r3, r4, ...spareRegions]),
    );
  // Auto-founded NPCs（Task #250）carry `${region}王國` names outside the
  // NATION_MARKER namespace; delete by id so their region_controls /
  // diplomacy_wars / war_campaigns / engagements cascade away.
  if (foundedNpcIds.length > 0) {
    await db
      .delete(playerNationsTable)
      .where(inArray(playerNationsTable.id, foundedNpcIds));
  }
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  // 等待開戰時觸發的背景地形簡報寫入落地，避免關閉連線池後遲到的寫入噴出
  // "Cannot use a pool after calling end on the pool" 汙染日誌、遮蔽真正的失敗。
  await flushWarBackgroundWork();
  await pool.end();
});

// Task #648 — 複合主鍵（campaign_id, region_id）允許「不同戰役」同地區多對多攻打
// （多國混戰同一塊地)。但「同一攻擊方、同一組出發→目標地區」不可重複開戰:
// 玩家連點/並發請求兩次只能建出一場(第二次 409),否則同一支軍隊會重複出動。
test("concurrent initiate on the same attacker+region pair → exactly one campaign, the other is rejected 409", async () => {
  const initiate = () =>
    initiateCampaign({
      attackerNationId: attackerId,
      attackerRegionId: r1,
      defenderRegionId: r2,
    });
  const results = await Promise.allSettled([initiate(), initiate()]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  assert.equal(
    fulfilled.length,
    1,
    `expected exactly one campaign to be created, got ${fulfilled.length}: ` +
      JSON.stringify(
        results.map((r) =>
          r.status === "rejected" ? String(r.reason) : "ok",
        ),
      ),
  );
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]!.reason instanceof WarActionError &&
      (rejected[0]!.reason as InstanceType<typeof WarActionError>).status === 409,
    `the duplicate must be rejected with WarActionError 409, got ${String(rejected[0]!.reason)}`,
  );

  // DB 只有一場 active 戰役;後續測試以它為 campaign1。
  const campaigns = await db
    .select({ id: warCampaignsTable.id })
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.attackerNationId, attackerId),
        eq(warCampaignsTable.attackerRegionId, r1),
        eq(warCampaignsTable.defenderRegionId, r2),
        eq(warCampaignsTable.status, "active"),
      ),
    )
    .orderBy(warCampaignsTable.id);
  assert.equal(campaigns.length, 1, `expected 1 active campaign, got ${campaigns.length}`);
  campaign1Id = campaigns[0]!.id;

  // 一場戰役對每個地區各一列交戰鎖 → 恰 2 列。
  const engagements = await db
    .select({ regionId: warRegionEngagementsTable.regionId, campaignId: warRegionEngagementsTable.campaignId })
    .from(warRegionEngagementsTable)
    .where(inArray(warRegionEngagementsTable.regionId, [r1, r2]));
  assert.ok(engagements.length >= 2, `expected ≥2 engagement rows, got ${engagements.length}`);
});

// 回歸(玩家回報):依序(非並發)再開一次同一組出發→目標也要被擋下。
test("sequential duplicate initiate on the same attacker+region pair is rejected 409", async () => {
  await assert.rejects(
    () =>
      initiateCampaign({
        attackerNationId: attackerId,
        attackerRegionId: r1,
        defenderRegionId: r2,
      }),
    (err: unknown) =>
      err instanceof WarActionError &&
      (err as InstanceType<typeof WarActionError>).status === 409,
  );
  const [{ n }] = (await db.execute(
    sql`select count(*)::int as n from war_campaigns where attacker_nation_id = ${attackerId} and attacker_region_id = ${r1} and defender_region_id = ${r2} and status = 'active'`,
  )).rows as { n: number }[];
  assert.equal(n, 1);
});

/**
 * Task #349 — 同區爭奪：找一塊未受控、非冷卻且不屬於本測試四塊地的地區，
 * 供同區測試就地建立 60/40 控制。
 */
async function findSpareRegion(): Promise<number> {
  const [row] = await db
    .selectDistinct({ id: mapRegionAdjacenciesTable.regionId })
    .from(mapRegionAdjacenciesTable)
    .where(
      and(
        notInArray(mapRegionAdjacenciesTable.regionId, [r1, r2, r3, r4]),
        notExists(
          db
            .select({ one: sql`1` })
            .from(regionControlsTable)
            .where(
              eq(regionControlsTable.regionId, mapRegionAdjacenciesTable.regionId),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(warRegionCooldownsTable)
            .where(
              and(
                eq(
                  warRegionCooldownsTable.regionId,
                  mapRegionAdjacenciesTable.regionId,
                ),
                gt(warRegionCooldownsTable.expiresAt, new Date()),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  assert.ok(row, "need a spare uncontrolled region for the same-region test");
  return row.id;
}

test("same-region 爭奪：attacker+enemy share one region → single-region campaign", async () => {
  const rc = await findSpareRegion();
  // 攻守雙方同時掌控此地（60/40）。
  await db.insert(regionControlsTable).values([
    { regionId: rc, nationId: attackerId, percent: 60 },
    { regionId: rc, nationId: defenderId, percent: 40 },
  ]);

  const campaign = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId: rc,
    defenderRegionId: rc,
  });
  assert.equal(campaign.attackerRegionId, rc);
  assert.equal(campaign.defenderRegionId, rc);

  // war_region_engagements.region_id 為 PK — 同區只留單一列（不因重複而衝突）。
  const engagements = await db
    .select({ regionId: warRegionEngagementsTable.regionId })
    .from(warRegionEngagementsTable)
    .where(eq(warRegionEngagementsTable.campaignId, campaign.id));
  assert.equal(engagements.length, 1);
  assert.equal(engagements[0]!.regionId, rc);
});

test("same-region 爭奪：無交戰敵國同在此地 → 400 拒絕", async () => {
  const rc = await findSpareRegion();
  // 只有攻擊方持有此地，敵國並未在此地佈控。
  await db
    .insert(regionControlsTable)
    .values({ regionId: rc, nationId: attackerId, percent: 100 });

  await assert.rejects(
    () =>
      initiateCampaign({
        attackerNationId: attackerId,
        attackerRegionId: rc,
        defenderRegionId: rc,
      }),
    (err: unknown) => {
      assert.ok(err instanceof WarActionError, `got ${String(err)}`);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

/**
 * Task #353 — 多國混戰同區爭奪：同一塊地有兩個以上交戰敵國時，玩家可用
 * defenderNationId 指定要爭奪的對象（預設仍取比例最高者）。此處建立兩個
 * 交戰 NPC 敵國與攻方共控一地，驗證指定較低比例者也能開戰、且三方控制列
 * 不被誤動、Σ 不變。
 */
test("same-region 多國混戰：defenderNationId 指定較低比例的交戰敵國", async () => {
  const rc = await findSpareRegion();
  // 兩個交戰 NPC 敵國。
  const [npcHigh] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${runId}-multi-high`,
      isNpc: true,
      government: "君主制",
    })
    .returning({ id: playerNationsTable.id });
  const [npcLow] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${runId}-multi-low`,
      isNpc: true,
      government: "君主制",
    })
    .returning({ id: playerNationsTable.id });
  const highId = npcHigh!.id;
  const lowId = npcLow!.id;

  // 攻方 40 ｜ high 35 ｜ low 25（Σ=100）。
  await db.insert(regionControlsTable).values([
    { regionId: rc, nationId: attackerId, percent: 40 },
    { regionId: rc, nationId: highId, percent: 35 },
    { regionId: rc, nationId: lowId, percent: 25 },
  ]);

  // 與兩個 NPC 都開戰（canonical a<b）。
  for (const enemy of [highId, lowId]) {
    const [a, b] = [attackerId, enemy].sort();
    await db.insert(diplomacyWarsTable).values({
      nationAId: a!,
      nationBId: b!,
      declaredByNationId: attackerId,
    });
  }

  // 指定較低比例的 low 為爭奪對象（若只取最高者會選到 high）。
  const campaign = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId: rc,
    defenderRegionId: rc,
    defenderNationId: lowId,
  });
  assert.equal(campaign.defenderNationId, lowId);
  assert.equal(campaign.defenderRegionId, rc);

  // 第三方（high）控制列不受影響；三方總和仍為 100。
  const controls = await db
    .select({
      nationId: regionControlsTable.nationId,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, rc));
  const byNation = new Map(controls.map((c) => [c.nationId, c.percent]));
  assert.equal(byNation.get(highId), 35);
  assert.equal(
    controls.reduce((s, c) => s + c.percent, 0),
    100,
  );

  // 清乾淨此戰役佔用的 engagement 與控制，避免影響後續 findSpareRegion。
  await db
    .delete(playerNationsTable)
    .where(inArray(playerNationsTable.id, [highId, lowId]));
  await db
    .delete(regionControlsTable)
    .where(eq(regionControlsTable.regionId, rc));
});

test("same-region 多國混戰：defenderNationId 未在該地佈控 → 400", async () => {
  const rc = await findSpareRegion();
  await db.insert(regionControlsTable).values([
    { regionId: rc, nationId: attackerId, percent: 60 },
    { regionId: rc, nationId: defenderId, percent: 40 },
  ]);
  // defenderId 有交戰但傳入一個不在此地的國家 id。
  await assert.rejects(
    () =>
      initiateCampaign({
        attackerNationId: attackerId,
        attackerRegionId: rc,
        defenderRegionId: rc,
        defenderNationId: attackerId, // 用己方 id：不會被視為敵國佈控目標
      }),
    (err: unknown) => {
      assert.ok(err instanceof WarActionError, `got ${String(err)}`);
      assert.equal(err.status, 400);
      return true;
    },
  );
  await db
    .delete(regionControlsTable)
    .where(eq(regionControlsTable.regionId, rc));
});

test("same-region 多國混戰：defenderNationId 非交戰國 → 400", async () => {
  const rc = await findSpareRegion();
  // 一個未與攻方交戰、但在此地佈控的 NPC。
  const [neutral] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${runId}-neutral`,
      isNpc: true,
      government: "君主制",
    })
    .returning({ id: playerNationsTable.id });
  const neutralId = neutral!.id;
  await db.insert(regionControlsTable).values([
    { regionId: rc, nationId: attackerId, percent: 70 },
    { regionId: rc, nationId: neutralId, percent: 30 },
  ]);

  await assert.rejects(
    () =>
      initiateCampaign({
        attackerNationId: attackerId,
        attackerRegionId: rc,
        defenderRegionId: rc,
        defenderNationId: neutralId,
      }),
    (err: unknown) => {
      assert.ok(err instanceof WarActionError, `got ${String(err)}`);
      assert.equal(err.status, 400);
      return true;
    },
  );
  await db
    .delete(playerNationsTable)
    .where(eq(playerNationsTable.id, neutralId));
  await db
    .delete(regionControlsTable)
    .where(eq(regionControlsTable.regionId, rc));
});

/**
 * Task #354 — 同區爭奪結算的真實資料整合測試（僅驗證，不改動生產邏輯）。
 *
 * 三個測試都靠一個把 `anthropic.messages.create` 換成罐頭回應的樁函式，讓
 * `resolveWarCycleAi` 得到一份固定的戰役結算結果（territoryShiftPct /
 * localPopulationLossPct 由測試指定），因此領土與人口的計算是決定性的、可斷言。
 * 其他 AI 呼叫（NPC 指令）以事先寫入的指令列跳過；開戰時的地形簡報屬背景工作、
 * 於 after() 的 flushWarBackgroundWork 收斂，皆與本結算無關。
 */
// Task #569 — 開戰時的背景地形簡報（generateTerrainBrief）原本會打真 Anthropic
// API（quality 模型），而 flushWarBackgroundWork 會等它落地，每場戰役多耗
// 10–30 秒。本檔不驗證地形簡報內容，於模組載入即安裝「基準樁」；restoreAi()
// 也回到基準樁——本檔絕不打真 Anthropic API。
//
// 基準樁依 system prompt 分流：
// - NPC 兵種組設計（designNpcUnitSet，「兵種設計 AI」）→ 回傳貼齊預設基準的
//   合法 JSON 陣列。空地／無主國家「即時建國 NPC」測試會就地建立全新 NPC，
//   開戰守門（Task #549）要求 NPC 必須有專屬兵種模板，先前靠真 AI 設計。
// - 其他（地形簡報等）→ 回傳合法簡報文字（50–1000 字）。NPC 城牆決策收到
//   非 JSON 會走確定性後援，不阻塞開戰。
const TERRAIN_BRIEF_STUB_TEXT =
  "測試樁地形簡報：兩地區以丘陵與河谷相接，攻守要點在渡口與城郊高地，補給線沿河而行，雨季氾濫時僅高地可通行。".repeat(2);
const UNIT_ANALYSIS_STUB_TEXT = JSON.stringify({
  counterSummary: "無顯著兵種克制關係。",
  tacticalEdge: "neutral",
  tacticalBonus: 0,
});
const NPC_UNIT_SET_STUB_TEXT = JSON.stringify(
  (["infantry", "ranged", "armor", "artillery", "ship"] as const).map(
    (category) => ({
      category,
      name: `測試樁兵種-${category}`,
      description: "測試樁兵種：數值貼齊預設基準，僅供整合測試決定性使用。",
      hp: 100,
      attack: 100,
      defense: 10,
      speed: 1,
      accuracy: 80,
      range:
        category === "ranged" || category === "artillery" || category === "ship"
          ? "ranged"
          : "melee",
      antiCavalryPct: 0,
      antiRangedPct: 0,
      antiArtilleryPct: 0,
      siegePct: 0,
      prodCostPer100: 1,
      popCostPerUnit: 1,
      moneyCostPerUnit: 1,
      upkeepPerUnit: 0.1,
      prodUpkeepPerUnit: 0.1,
      woodCostPerUnit: 0,
      oreCostPerUnit: 0,
    }),
  ),
);
const baselineAiStub = (async (params: { system?: unknown }) => {
  const system = typeof params?.system === "string" ? params.system : "";
  if (system.includes("兵種設計 AI")) {
    return { content: [{ type: "text", text: NPC_UNIT_SET_STUB_TEXT }] };
  }
  if (system.includes("兵種分析 AI")) {
    return { content: [{ type: "text", text: UNIT_ANALYSIS_STUB_TEXT }] };
  }
  return { content: [{ type: "text", text: TERRAIN_BRIEF_STUB_TEXT }] };
}) as unknown as typeof anthropic.messages.create;
anthropic.messages.create = baselineAiStub;

/** 罐頭戰役結算結果；欄位與 warCycleResultSchema 對齊。 */
function warCycleResult(_overrides: {
  defenderRegion?: number;
  attackerRegion?: number;
} = {}): unknown {
  const report = "同區爭奪結算測試戰報".repeat(6); // ≥50 字，滿足 min(50)
  const side = {
    legions: [
      {
        slot: "A",
        aggressionPct: 50,
        woundedSharePct: 0,
        moraleDelta: 0,
        supplyDelta: 0,
      },
    ],
    warWearinessDelta: 0, // 保持雙方厭戰度不變 → 攻擊修正相同 → 戰力對比純由兵力決定
  };
  return {
    attackerReport: report,
    defenderReport: report,
    attacker: side,
    defender: side,
  };
}

/**
 * 安裝樁：兵種分析呼叫（"兵種分析 AI"）回傳空分析 JSON，
 * 其餘呼叫（週期結算）回傳指定結算結果。
 */
function installAiStub(result: unknown): void {
  anthropic.messages.create = (async (params: { system?: unknown }) => {
    const system = typeof params?.system === "string" ? params.system : "";
    if (system.includes("兵種分析 AI")) {
      return { content: [{ type: "text", text: UNIT_ANALYSIS_STUB_TEXT }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }) as unknown as typeof anthropic.messages.create;
}
function restoreAi(): void {
  anthropic.messages.create = baselineAiStub;
}

/** 同區測試共用的場景搭建：就地建立攻守控制、開戰、以決定性軍團取代自動軍團。 */
async function setupSameRegionCampaign(opts: {
  attackerPct: number;
  defenderPct: number;
  attackerTroops: number;
  defenderTroops: number;
}): Promise<WarCampaign> {
  const rc = await findSpareRegion();
  spareRegions.push(rc);
  await db.insert(regionControlsTable).values([
    { regionId: rc, nationId: attackerId, percent: opts.attackerPct },
    { regionId: rc, nationId: defenderId, percent: opts.defenderPct },
  ]);

  const campaign = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId: rc,
    defenderRegionId: rc,
  });

  // 移除開戰時自動建立的軍團，改放單一決定性軍團（同一步兵範本、同士氣補給），
  // 讓雙方戰力對比只由兵力數量決定。
  await db
    .delete(warCampaignLegionsTable)
    .where(eq(warCampaignLegionsTable.campaignId, campaign.id));
  for (const [nationId, quantity] of [
    [attackerId, opts.attackerTroops],
    [defenderId, opts.defenderTroops],
  ] as const) {
    const [legion] = await db
      .insert(warCampaignLegionsTable)
      .values({
        campaignId: campaign.id,
        nationId,
        slot: "A",
        morale: 80,
        supply: 100,
        garrisoningCity: false,
      })
      .returning({ id: warCampaignLegionsTable.id });
    await db.insert(warCampaignLegionUnitsTable).values({
      legionId: legion!.id,
      templateId,
      quantity,
      wounded: 0,
    });
  }

  // 事先寫入 NPC 防守方本週期指令 → 跳過結算中的 NPC 指令 AI 生成。
  await db.insert(warCampaignOrdersTable).values({
    campaignId: campaign.id,
    nationId: defenderId,
    cycleNumber: campaign.cycleNumber,
    orderType: "command",
    body: "同區爭奪測試：固定防守指令",
  });

  return campaign;
}

async function controlPct(regionId: number, nationId: string): Promise<number> {
  const [row] = await db
    .select({ percent: regionControlsTable.percent })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, regionId),
        eq(regionControlsTable.nationId, nationId),
      ),
    );
  return row?.percent ?? 0;
}
async function controlBonus(
  regionId: number,
  nationId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ bonus: regionControlsTable.populationBonus })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, regionId),
        eq(regionControlsTable.nationId, nationId),
      ),
    );
  return row ? row.bonus : null;
}
async function regionSumPct(regionId: number): Promise<number> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${regionControlsTable.percent}), 0)`,
    })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, regionId));
  return Number(row!.total);
}

test("same-region 結算：均勢下 AI 淨轉移使雙方控制率互補更新且 Σ≤100", async () => {
  // 均勢（雙方兵力相同）→ 伺服器確定性推進為 0，淨轉移＝AI 的 defenderRegion。
  const campaign = await setupSameRegionCampaign({
    attackerPct: 60,
    defenderPct: 40,
    attackerTroops: 1000,
    defenderTroops: 1000,
  });
  const rc = campaign.defenderRegionId;

  installAiStub(warCycleResult());
  try {
    const res = await settleCampaign(campaign.id);
    assert.equal(res.settled, true, `結算應成功：${JSON.stringify(res)}`);
    assert.equal(res.ended, false, "均勢下不應分出勝負");
  } finally {
    restoreAi();
  }

  // 均勢（雙方兵力相同）+ aggressionPct=50（neutral）→ AI 領土移轉為 0，
  // 純靠 counter 有微幅確定性波動；攻守互補（Σ 守恆）。
  const atk = await controlPct(rc, attackerId);
  const def = await controlPct(rc, defenderId);
  assert.ok(atk <= 60, "均勢下 aggressionPct=50 → AI 領土移轉為 0，攻擊方不應得到領土");
  assert.equal(atk - 60, 40 - def, "攻擊方所得須等於防守方所失（淨轉移守恆）");
  assert.ok((await regionSumPct(rc)) <= 100, "同區控制率總和不得超過 100");

  // 戰役仍進行中（未分勝負）。
  const [row] = await db
    .select({ status: warCampaignsTable.status })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign.id));
  assert.equal(row!.status, "active");

  // 清掉此戰役以釋放攻擊方前線兵力與地區交戰鎖；結算會把傷亡沉澱到全國傷兵池
  // （player_wounded_units，以 discordUserId 為鍵、不隨戰役級聯刪除），會壓低可用
  // 兵力並影響後續測試，故一併清除。
  await db
    .delete(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign.id));
  await db
    .delete(playerWoundedUnitsTable)
    .where(eq(playerWoundedUnitsTable.discordUserId, userId));
  // 結算會依戰死數永久扣減全國常備軍（player_armies.quantity），還原成滿編以免
  // 壓低後續測試可用兵力。
  await db
    .update(playerArmiesTable)
    .set({ quantity: OWNED_QUANTITY })
    .where(
      and(
        eq(playerArmiesTable.discordUserId, userId),
        eq(playerArmiesTable.templateId, templateId),
      ),
    );
});

test("same-region 結算：攻擊方被逐出（控制率歸零、戰役結束、防守方勝）", async () => {
  // 防守方兵力遠大於攻擊方 → 反攻上限＋AI 負向轉移把攻擊方推到 0。
  // Task #412：領土轉移依地區面積縮放（最低 0.35 倍），故攻擊方初始持分
  // 取 5%，確保縮放後的負向轉移（|-15|×0.35 ≈ 5）單一週期即可清零。
  const campaign = await setupSameRegionCampaign({
    attackerPct: 5,
    defenderPct: 95,
    attackerTroops: 100,
    defenderTroops: 100_000,
  });
  const rc = campaign.defenderRegionId;

  installAiStub(warCycleResult({ defenderRegion: -15 }));
  try {
    const res = await settleCampaign(campaign.id);
    assert.equal(res.ended, true, "攻擊方被逐出後戰役應結束");
  } finally {
    restoreAi();
  }

  // 攻擊方在此地的控制列被刪除（歸零），防守方獨占（Σ≤100）。
  const [atkRow] = await db
    .select({ one: sql`1` })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, rc),
        eq(regionControlsTable.nationId, attackerId),
      ),
    );
  assert.equal(atkRow, undefined, "攻擊方控制列應被刪除（控制率歸零）");
  assert.equal(await controlPct(rc, defenderId), 100, "防守方應獨占此地");
  assert.ok((await regionSumPct(rc)) <= 100, "控制率總和不得超過 100");

  // 戰役已結束、防守方為勝方、結束原因為領土。
  const [row] = await db
    .select({
      status: warCampaignsTable.status,
      winnerNationId: warCampaignsTable.winnerNationId,
      endReason: warCampaignsTable.endReason,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign.id));
  assert.equal(row!.status, "ended");
  assert.equal(row!.winnerNationId, defenderId);
  assert.equal(row!.endReason, "territory");

  // 清掉此（已結束）戰役以釋放攻擊方前線兵力；並清空結算沉澱到全國傷兵池的傷兵
  // （以 discordUserId 為鍵、不隨戰役級聯刪除），避免壓低可用兵力影響後續測試。
  await db
    .delete(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign.id));
  await db
    .delete(playerWoundedUnitsTable)
    .where(eq(playerWoundedUnitsTable.discordUserId, userId));
  // 結算會依戰死數永久扣減全國常備軍（player_armies.quantity），還原成滿編以免
  // 壓低後續測試可用兵力。
  await db
    .update(playerArmiesTable)
    .set({ quantity: OWNED_QUANTITY })
    .where(
      and(
        eq(playerArmiesTable.discordUserId, userId),
        eq(playerArmiesTable.templateId, templateId),
      ),
    );
});

test("same-region 結算：共享地區的人口損失只計一次", async () => {
  // 均勢、無領土轉移（defenderRegion=0）→ 控制率不變，人口損失數學單純。
  const campaign = await setupSameRegionCampaign({
    attackerPct: 60,
    defenderPct: 40,
    attackerTroops: 1000,
    defenderTroops: 1000,
  });
  const rc = campaign.defenderRegionId;

  // 引擎以 statsEra 的地區人口計算損失；用同一時代人口推導期望值。
  const { statsEra } = await getEraSlugs();
  const [eraRow] = await db
    .select({ population: mapRegionEraStatsTable.population })
    .from(mapRegionEraStatsTable)
    .where(
      and(
        eq(mapRegionEraStatsTable.regionId, rc),
        eq(mapRegionEraStatsTable.era, statsEra),
      ),
    );
  const regionPop = eraRow!.population;
  assert.ok(regionPop > 0, "測試地區在數據時代須有正的人口");

  // computeLocalPopulationLossPct(50, "neutral", 0, 0) = (50/100)*5 = 2.5
  const lossPct = 2.5; // 確定性公式：aggressionPct=50 / neutral → 2.5%
  // 同區只計一次：合計人口＝popOf(rc)×(60+40)/100＝popOf(rc)。
  const attackerCombinedPop = (regionPop * 60) / 100;
  const defenderCombinedPop = (regionPop * 40) / 100;
  const expectedTotalLoss = Math.floor(
    ((attackerCombinedPop + defenderCombinedPop) * lossPct) / 100,
  );
  assert.ok(expectedTotalLoss > 0, "期望的人口損失須為正");
  const [expAtkLoss, expDefLoss] = allocateProportionally(
    [attackerCombinedPop, defenderCombinedPop],
    expectedTotalLoss,
  ) as [number, number];

  const atkBonusBefore = (await controlBonus(rc, attackerId)) ?? 0;
  const defBonusBefore = (await controlBonus(rc, defenderId)) ?? 0;

  installAiStub(warCycleResult());
  try {
    const res = await settleCampaign(campaign.id);
    assert.equal(res.settled, true, `結算應成功：${JSON.stringify(res)}`);
  } finally {
    restoreAi();
  }

  // 控制率不變（無領土轉移）。
  assert.equal(await controlPct(rc, attackerId), 60);
  assert.equal(await controlPct(rc, defenderId), 40);

  // 人口損失累加於 region_controls.population_bonus（負向）；兩方合計恰為
  // 單次計算的總損失。若共享地區被重複加總，總損失會是兩倍——本斷言即排除該情形。
  const atkBonusAfter = (await controlBonus(rc, attackerId)) ?? 0;
  const defBonusAfter = (await controlBonus(rc, defenderId)) ?? 0;
  const atkDelta = atkBonusAfter - atkBonusBefore;
  const defDelta = defBonusAfter - defBonusBefore;
  assert.equal(atkDelta, -expAtkLoss, "攻擊方人口損失分配不符");
  assert.equal(defDelta, -expDefLoss, "防守方人口損失分配不符");
  assert.equal(
    atkDelta + defDelta,
    -expectedTotalLoss,
    "共享地區的人口損失總量必須只計一次（非兩倍）",
  );
  assert.notEqual(
    atkDelta + defDelta,
    -2 * expectedTotalLoss,
    "人口損失不得因同區重複加總而變成兩倍",
  );

  // 清掉此戰役以釋放攻擊方前線兵力與地區交戰鎖；並清空結算沉澱到全國傷兵池的傷兵
  // （以 discordUserId 為鍵、不隨戰役級聯刪除），避免壓低可用兵力影響後續測試。
  await db
    .delete(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign.id));
  await db
    .delete(playerWoundedUnitsTable)
    .where(eq(playerWoundedUnitsTable.discordUserId, userId));
  // 結算會依戰死數永久扣減全國常備軍（player_armies.quantity），還原成滿編以免
  // 壓低後續測試可用兵力。
  await db
    .update(playerArmiesTable)
    .set({ quantity: OWNED_QUANTITY })
    .where(
      and(
        eq(playerArmiesTable.discordUserId, userId),
        eq(playerArmiesTable.templateId, templateId),
      ),
    );
});

test("Task #448 — 結算途中戰役被收尾（刪除）→ 安全跳過不拋錯", async () => {
  // NPC 防守方且「不」預先寫入指令 → 結算會走 NPC 指令 AI 生成路徑（anthropic
  // 樁）。樁在 AI 呼叫期間把戰役硬刪（模擬停戰 endCampaignsForWar／cascade 刪除
  // 與結算撞車），使後續 war_campaign_orders 寫入觸發 23503——修正後應視為戰役
  // 已收尾並安全回傳，而非拋錯讓結算迴圈反覆噴 ERROR。
  const campaign = await setupSameRegionCampaign({
    attackerPct: 60,
    defenderPct: 40,
    attackerTroops: 1000,
    defenderTroops: 1000,
  });
  // 移除 setup 預寫的 NPC 指令，強迫結算進入 NPC 指令生成（AI 樁）路徑。
  await db
    .delete(warCampaignOrdersTable)
    .where(eq(warCampaignOrdersTable.campaignId, campaign.id));

  // 先收斂開戰的地形簡報等背景 AI 工作，避免其誤觸下面的「刪戰役」樁。
  await flushWarBackgroundWork();

  anthropic.messages.create = (async () => {
    // 模擬結算進行中戰役被另一流程收尾（cascade 刪除 legions/orders/engagements）。
    await db
      .delete(warCampaignsTable)
      .where(eq(warCampaignsTable.id, campaign.id));
    // AI 失敗 → generateNpcOrders 用罐頭指令 → 直接進入 orders 寫入（FK 已失效）。
    throw new Error("simulated AI failure while campaign was torn down");
  }) as unknown as typeof anthropic.messages.create;

  try {
    const res = await settleCampaign(campaign.id);
    assert.equal(res.settled, false, `不應完成結算：${JSON.stringify(res)}`);
    assert.equal(res.ended, true, "應視為戰役已收尾");
  } finally {
    restoreAi();
  }

  // 戰役已刪除；不應留下任何孤兒指令列。
  const [gone] = await db
    .select({ one: sql`1` })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign.id));
  assert.equal(gone, undefined, "戰役應已刪除");
  const orphanOrders = await db
    .select({ one: sql`1` })
    .from(warCampaignOrdersTable)
    .where(eq(warCampaignOrdersTable.campaignId, campaign.id));
  assert.equal(orphanOrders.length, 0, "不應留下孤兒指令列");
});

test("Task #452 — 結算途中管理端 forceEndCampaign → 結算被守門擋下、收尾只做一次", async () => {
  // 場景：結算已進入 AI 週期判定（anthropic 樁）期間，管理端呼叫
  // forceEndCampaign 強制結束同一戰役。applyCycleResult 的 status='active'
  // 條件 UPDATE 守門必須讓結算回傳「戰役已由其他流程結算」且不拋錯，
  // 冷卻／傷兵回收／結束通知全部只由 forceEndCampaign 做一次。
  const campaign = await setupSameRegionCampaign({
    attackerPct: 60,
    defenderPct: 40,
    attackerTroops: 1000,
    defenderTroops: 1000,
  });
  const rc = campaign.defenderRegionId;

  // 攻擊方前線帶傷兵 → 收尾時會回流全國傷兵池；若收尾被重複執行會加兩次。
  const WOUNDED = 137;
  const [atkLegion] = await db
    .select({ id: warCampaignLegionsTable.id })
    .from(warCampaignLegionsTable)
    .where(
      and(
        eq(warCampaignLegionsTable.campaignId, campaign.id),
        eq(warCampaignLegionsTable.nationId, attackerId),
      ),
    );
  await db
    .update(warCampaignLegionUnitsTable)
    .set({ wounded: WOUNDED })
    .where(eq(warCampaignLegionUnitsTable.legionId, atkLegion!.id));

  // 收斂開戰的地形簡報等背景 AI 工作，避免其誤觸下面的樁。
  await flushWarBackgroundWork();

  // AI 樁：三階段流程中，兵種分析（phase 1）回傳空分析 JSON；
  // 週期結算（phase 3）才執行 forceEndCampaign 並回傳合法結算結果，
  // 讓結算繼續走到 applyCycleResult 的守門。
  const canned = warCycleResult({ defenderRegion: 10 });
  let forceEnded: WarCampaign | null = null;
  anthropic.messages.create = (async (params: { system?: unknown }) => {
    const system = typeof params?.system === "string" ? params.system : "";
    if (system.includes("兵種分析 AI")) {
      return { content: [{ type: "text", text: UNIT_ANALYSIS_STUB_TEXT }] };
    }
    forceEnded = (await forceEndCampaign(
      campaign.id,
      "ceasefire",
    )) as WarCampaign | null;
    return { content: [{ type: "text", text: JSON.stringify(canned) }] };
  }) as unknown as typeof anthropic.messages.create;

  try {
    const res = await settleCampaign(campaign.id);
    assert.equal(res.settled, false, `結算不應完成：${JSON.stringify(res)}`);
    assert.equal(res.ended, false, "守門路徑不重複宣告結束");
    assert.equal(res.message, "戰役已由其他流程結算");
  } finally {
    restoreAi();
  }
  assert.ok(forceEnded, "forceEndCampaign 應成功結束戰役（回傳非 null）");

  // 戰役狀態：只被 forceEndCampaign 收尾一次。
  const [row] = await db
    .select({
      status: warCampaignsTable.status,
      endReason: warCampaignsTable.endReason,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign.id));
  assert.equal(row?.status, "ended");
  assert.equal(row?.endReason, "ceasefire");

  // 控制率不變：結算的領土轉移（AI 淨轉移 10）必須被守門完全擋下。
  assert.equal(await controlPct(rc, attackerId), 60, "守門後控制率不得變動");
  assert.equal(await controlPct(rc, defenderId), 40, "守門後控制率不得變動");

  // 傷兵只回流一次（若結算又跑一次收尾會變 2×WOUNDED）。
  const [woundedRow] = await db
    .select({ wounded: playerWoundedUnitsTable.wounded })
    .from(playerWoundedUnitsTable)
    .where(
      and(
        eq(playerWoundedUnitsTable.discordUserId, userId),
        eq(playerWoundedUnitsTable.templateId, templateId),
      ),
    );
  assert.equal(woundedRow?.wounded, WOUNDED, "前線傷兵應恰好回流一次");

  // 地區冷卻已寫入（regionId 為 PK，天然單列）。
  const cooldowns = await db
    .select({ one: sql`1` })
    .from(warRegionCooldownsTable)
    .where(eq(warRegionCooldownsTable.regionId, rc));
  assert.equal(cooldowns.length, 1, "應留下一筆地區冷卻");

  // 地區交戰鎖已釋放。
  const engagements = await db
    .select({ one: sql`1` })
    .from(warRegionEngagementsTable)
    .where(eq(warRegionEngagementsTable.campaignId, campaign.id));
  assert.equal(engagements.length, 0, "交戰鎖應已釋放");

  // 通知只發一次：站內通知為背景寫入，輪詢至出現後再確認總數恰為 1
  //（forceEndCampaign 的結束通知；結算守門路徑不得再發戰報／結束通知）。
  const linkPath = `/game/military/war/${campaign.id}`;
  const countNotifications = async () => {
    const rows = await db
      .select({ one: sql`1` })
      .from(playerNotificationsTable)
      .where(
        and(
          eq(playerNotificationsTable.discordUserId, userId),
          eq(playerNotificationsTable.linkPath, linkPath),
        ),
      );
    return rows.length;
  };
  let n = 0;
  for (let i = 0; i < 20 && n === 0; i++) {
    n = await countNotifications();
    if (n === 0) await new Promise((r) => setTimeout(r, 100));
  }
  // 再等一拍，確保若有第二則（重複）通知也已落庫可被抓到。
  await new Promise((r) => setTimeout(r, 200));
  n = await countNotifications();
  assert.equal(n, 1, "戰役結束通知應恰好一則（不得重複發送）");

  // 清理：刪戰役釋放測試名額；清空回流傷兵、還原常備軍與本測試的通知。
  await db
    .delete(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign.id));
  await db
    .delete(playerWoundedUnitsTable)
    .where(eq(playerWoundedUnitsTable.discordUserId, userId));
  await db
    .update(playerArmiesTable)
    .set({ quantity: OWNED_QUANTITY })
    .where(
      and(
        eq(playerArmiesTable.discordUserId, userId),
        eq(playerArmiesTable.templateId, templateId),
      ),
    );
  await db
    .delete(playerNotificationsTable)
    .where(
      and(
        eq(playerNotificationsTable.discordUserId, userId),
        eq(playerNotificationsTable.linkPath, linkPath),
      ),
    );
});

test("concurrent legions PUT on two campaigns → cross-campaign over-allocation blocked", async () => {
  // Second campaign on the disjoint pair（r3 → r4）.
  const campaign2 = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId: r3,
    defenderRegionId: r4,
  });

  const putLegions = (campaignId: number) =>
    api("PUT", `/api/war/campaigns/${campaignId}/legions`, {
      legions: [
        { slot: "A", units: [{ templateId, quantity: OWNED_QUANTITY }] },
      ],
    });
  const [a, b] = await Promise.all([
    putLegions(campaign1Id),
    putLegions(campaign2.id),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(
    statuses,
    [200, 400],
    `expected one winner and one loser, got ${a.status}/${b.status}: ` +
      `${JSON.stringify(a.json)} / ${JSON.stringify(b.json)}`,
  );
  const loser = a.status === 400 ? a : b;
  assert.match(String(loser.json.error ?? ""), /可用兵力不足/);

  // The committed frontline never exceeds the owned quantity.
  const [committed] = await db
    .select({
      total: sql<string>`COALESCE(SUM(${warCampaignLegionUnitsTable.quantity} + ${warCampaignLegionUnitsTable.wounded}), 0)`,
    })
    .from(warCampaignLegionUnitsTable)
    .innerJoin(
      warCampaignLegionsTable,
      eq(warCampaignLegionsTable.id, warCampaignLegionUnitsTable.legionId),
    )
    .where(eq(warCampaignLegionsTable.nationId, attackerId));
  assert.equal(Number(committed!.total), OWNED_QUANTITY);
});

test("applyGlobalWarCycleHours updates every active campaign and resets nextResolveAt", async () => {
  const newCycleHours = 1;
  const now = new Date();
  const affected = await applyGlobalWarCycleHours(newCycleHours, now);
  // 至少本測試套件建立的兩場戰役會被套用（可能夾雜其他殘留 active 戰役）.
  assert.ok(affected >= 2, `expected ≥2 active campaigns, got ${affected}`);

  const expected = now.getTime() + newCycleHours * 3_600_000;
  const rows = await db
    .select({
      id: warCampaignsTable.id,
      cycleHours: warCampaignsTable.cycleHours,
      nextResolveAt: warCampaignsTable.nextResolveAt,
    })
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.warId, warId),
        eq(warCampaignsTable.status, "active"),
      ),
    );
  assert.ok(rows.length >= 2, "both campaigns of this war must be active");
  for (const row of rows) {
    assert.equal(row.cycleHours, newCycleHours);
    assert.equal(
      row.nextResolveAt.getTime(),
      expected,
      `campaign ${row.id} nextResolveAt should be exactly now + ${newCycleHours}h`,
    );
  }
});

test("applyWorldSimSettingsInTransaction rolls back world_game_state when applying to campaigns throws", async () => {
  // 舊值快照：world_game_state.warCycleHours + 本 war 進行中戰役的 cycle_hours/next_resolve_at。
  const [stateBefore] = await db
    .select({ warCycleHours: worldGameStateTable.warCycleHours })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1));
  assert.ok(stateBefore, "world_game_state id=1 must exist");
  const oldWarCycle = stateBefore!.warCycleHours;
  // 選一個和舊值不同、且落在合法範圍（1–720）的新週期，確保「若寫入成功會被觀察到」。
  const newWarCycle = oldWarCycle === 2 ? 3 : 2;

  const campaignsBefore = await db
    .select({
      id: warCampaignsTable.id,
      cycleHours: warCampaignsTable.cycleHours,
      nextResolveAt: warCampaignsTable.nextResolveAt,
    })
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.warId, warId),
        eq(warCampaignsTable.status, "active"),
      ),
    );
  assert.ok(campaignsBefore.length >= 2, "both campaigns must be active");

  // 套用戰役階段拋錯 → 整筆交易還原。
  await assert.rejects(
    applyWorldSimSettingsInTransaction(
      { warCycleHours: newWarCycle, updatedAt: sql`NOW()` },
      {
        warCycleHours: newWarCycle,
        applyWarCycle: async () => {
          throw new Error("boom: 模擬套用戰役失敗");
        },
      },
    ),
    /boom/,
  );

  // world_game_state.warCycleHours 維持舊值（未被半套寫入）。
  const [stateAfter] = await db
    .select({ warCycleHours: worldGameStateTable.warCycleHours })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1));
  assert.equal(
    stateAfter!.warCycleHours,
    oldWarCycle,
    "world_game_state.warCycleHours must be rolled back to its old value",
  );

  // 進行中戰役的 cycle_hours / next_resolve_at 未變。
  for (const before of campaignsBefore) {
    const [after] = await db
      .select({
        cycleHours: warCampaignsTable.cycleHours,
        nextResolveAt: warCampaignsTable.nextResolveAt,
      })
      .from(warCampaignsTable)
      .where(eq(warCampaignsTable.id, before.id));
    assert.equal(after!.cycleHours, before.cycleHours);
    assert.equal(
      after!.nextResolveAt.getTime(),
      before.nextResolveAt.getTime(),
      `campaign ${before.id} nextResolveAt must not change on rollback`,
    );
  }
});

test("applyWorldSimSettingsInTransaction commits both the setting and the campaign cycle on success", async () => {
  const [stateBefore] = await db
    .select({ warCycleHours: worldGameStateTable.warCycleHours })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1));
  const newWarCycle = stateBefore!.warCycleHours === 5 ? 6 : 5;

  const activeIds = await db
    .select({ id: warCampaignsTable.id })
    .from(warCampaignsTable)
    .where(
      and(
        eq(warCampaignsTable.warId, warId),
        eq(warCampaignsTable.status, "active"),
      ),
    );
  assert.ok(activeIds.length >= 2, "both campaigns must be active");

  const { affected } = await applyWorldSimSettingsInTransaction(
    { warCycleHours: newWarCycle, updatedAt: sql`NOW()` },
    { warCycleHours: newWarCycle },
  );
  // affected 為「所有 active 戰役」數（可能夾雜其他殘留），至少涵蓋本 war 的兩場。
  assert.ok(
    affected >= activeIds.length,
    `affected ${affected} should cover ≥${activeIds.length} active campaigns`,
  );

  // 全域設定與戰役週期一起更新。
  const [stateAfter] = await db
    .select({ warCycleHours: worldGameStateTable.warCycleHours })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1));
  assert.equal(stateAfter!.warCycleHours, newWarCycle);

  for (const { id } of activeIds) {
    const [row] = await db
      .select({ cycleHours: warCampaignsTable.cycleHours })
      .from(warCampaignsTable)
      .where(eq(warCampaignsTable.id, id));
    assert.equal(row!.cycleHours, newWarCycle);
  }
});

test("settle loop picks up and settles a campaign that became due after the override", async () => {
  // 讓結算走罐頭僵持結果（failCount ≥ MAX_AI_FAIL_COUNT），避免依賴真實 AI；
  // 並把 nextResolveAt 拉到過去，模擬「新週期到期」後被迴圈挑中。
  const [before] = await db
    .select({
      cycleNumber: warCampaignsTable.cycleNumber,
      cycleHours: warCampaignsTable.cycleHours,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign1Id));
  assert.ok(before, "campaign1 must exist");

  const duePast = new Date(Date.now() - 60_000);
  await db
    .update(warCampaignsTable)
    .set({ failCount: 3, nextResolveAt: duePast })
    .where(eq(warCampaignsTable.id, campaign1Id));

  const now = new Date();
  await settleDueCampaigns(now);

  const [after] = await db
    .select({
      cycleNumber: warCampaignsTable.cycleNumber,
      nextResolveAt: warCampaignsTable.nextResolveAt,
      status: warCampaignsTable.status,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign1Id));
  // 被結算：週期數前進一格、下次結算時間重新排到未來（依 cycleHours）.
  assert.equal(after!.cycleNumber, before!.cycleNumber + 1);
  assert.ok(
    after!.nextResolveAt.getTime() > now.getTime(),
    `nextResolveAt ${after!.nextResolveAt.toISOString()} should be in the future`,
  );
  const expected = now.getTime() + before!.cycleHours * 3_600_000;
  assert.ok(
    Math.abs(after!.nextResolveAt.getTime() - expected) < 5 * 60_000,
    `nextResolveAt ${after!.nextResolveAt.toISOString()} should be ≈ now + ${before!.cycleHours}h`,
  );
});

test("requireDue 到期重驗：尚未到期的戰役被跳過，不會一次結算兩次", async () => {
  // 前一個測試剛結算過 campaign1 → nextResolveAt 已排到未來。模擬「到期清單
  // 快照取出後、輪到本戰役前，已被另一個迴圈結算」：帶 requireDue 再結算一次
  // 必須被守門擋下，cycleNumber／nextResolveAt 完全不動。
  const [before] = await db
    .select({
      cycleNumber: warCampaignsTable.cycleNumber,
      nextResolveAt: warCampaignsTable.nextResolveAt,
      status: warCampaignsTable.status,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign1Id));
  assert.ok(before, "campaign1 must exist");
  assert.equal(before!.status, "active");
  assert.ok(
    before!.nextResolveAt.getTime() > Date.now(),
    "precondition: campaign1 nextResolveAt must be in the future",
  );

  // failCount=3 → 若守門失效真的進入結算，會走罐頭僵持結果（不打真實 AI），
  // 測試仍能從 cycleNumber+1 觀察到「多結算一次」而失敗。
  await db
    .update(warCampaignsTable)
    .set({ failCount: 3 })
    .where(eq(warCampaignsTable.id, campaign1Id));

  try {
    const res = await settleCampaign(campaign1Id, { requireDue: true });
    assert.equal(res.settled, false, "not-yet-due campaign must be skipped");
    assert.equal(res.ended, false);
    assert.ok(
      res.message?.includes("尚未到期"),
      `message should mention 尚未到期, got: ${res.message}`,
    );

    const [after] = await db
      .select({
        cycleNumber: warCampaignsTable.cycleNumber,
        nextResolveAt: warCampaignsTable.nextResolveAt,
        status: warCampaignsTable.status,
      })
      .from(warCampaignsTable)
      .where(eq(warCampaignsTable.id, campaign1Id));
    assert.equal(after!.cycleNumber, before!.cycleNumber, "cycleNumber must not advance");
    assert.equal(
      after!.nextResolveAt.getTime(),
      before!.nextResolveAt.getTime(),
      "nextResolveAt must not change",
    );
    assert.equal(after!.status, "active");
  } finally {
    await db
      .update(warCampaignsTable)
      .set({ failCount: 0 })
      .where(eq(warCampaignsTable.id, campaign1Id));
  }
});

test("ceasefire accept ends the war, clears the proposal metadata and ends all campaigns", async () => {
  // 對方（NPC）已提出停戰 → 我方接受。
  await db
    .update(diplomacyWarsTable)
    .set({ ceasefireProposedBy: defenderId })
    .where(eq(diplomacyWarsTable.id, warId));

  const res = await api(
    "POST",
    `/api/diplomacy/wars/${warId}/ceasefire/accept`,
  );
  assert.equal(res.status, 200, JSON.stringify(res.json));

  const [war] = await db
    .select({
      endedAt: diplomacyWarsTable.endedAt,
      ceasefireProposedBy: diplomacyWarsTable.ceasefireProposedBy,
    })
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, warId));
  assert.ok(war!.endedAt, "war must be ended");
  assert.equal(war!.ceasefireProposedBy, null);

  const campaigns = await db
    .select({ status: warCampaignsTable.status })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.warId, warId));
  assert.ok(campaigns.length >= 2);
  for (const c of campaigns) assert.equal(c.status, "ended");
});

test("applyGlobalWarCycleHours leaves ended campaigns untouched", async () => {
  // 停戰後 campaign1 已結束；全域週期套用只影響進行中戰役 → 已結束者的
  // cycleHours／nextResolveAt 不受影響。
  const [before] = await db
    .select({
      status: warCampaignsTable.status,
      cycleHours: warCampaignsTable.cycleHours,
      nextResolveAt: warCampaignsTable.nextResolveAt,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign1Id));
  assert.equal(before!.status, "ended");

  await applyGlobalWarCycleHours(12, new Date());

  const [after] = await db
    .select({
      cycleHours: warCampaignsTable.cycleHours,
      nextResolveAt: warCampaignsTable.nextResolveAt,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign1Id));
  assert.equal(after!.cycleHours, before!.cycleHours);
  assert.equal(
    after!.nextResolveAt.getTime(),
    before!.nextResolveAt.getTime(),
    "ended campaign's nextResolveAt must not change",
  );
});

/**
 * Find `count` disjoint adjacency pairs whose both regions are uncontrolled and
 * not in post-war cooldown, excluding every region in `exclude`（so successive
 * unowned-territory tests never collide with each other or the before() pairs）.
 */
async function pickEmptyPairs(
  count: number,
  exclude: number[],
): Promise<Array<{ a: number; b: number }>> {
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
  const rows = await db
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
        exclude.length > 0
          ? and(
              notInArray(mapRegionAdjacenciesTable.regionId, exclude),
              notInArray(mapRegionAdjacenciesTable.adjacentRegionId, exclude),
            )
          : undefined,
      ),
    )
    .orderBy(
      mapRegionAdjacenciesTable.regionId,
      mapRegionAdjacenciesTable.adjacentRegionId,
    )
    .limit(300);
  const used = new Set<number>(exclude);
  const picked: Array<{ a: number; b: number }> = [];
  for (const row of rows) {
    if (used.has(row.a) || used.has(row.b)) continue;
    picked.push({ a: row.a, b: row.b });
    used.add(row.a);
    used.add(row.b);
    if (picked.length === count) break;
  }
  return picked;
}

test("Task #250 — 攻打完全無主的空地 → 即時建國成 NPC、自動宣戰並開戰", async () => {
  const [pair] = await pickEmptyPairs(1, [r1, r2, r3, r4]);
  assert.ok(pair, "need one empty adjacent pair for the found-empty test");
  const attackerRegionId = pair!.a;
  const emptyRegionId = pair!.b;

  // 攻擊方掌控出發地；目標地完全無主（無 region_controls）。
  await db.insert(regionControlsTable).values({
    regionId: attackerRegionId,
    nationId: attackerId,
    percent: 100,
  });

  const campaign = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId,
    defenderRegionId: emptyRegionId,
  });
  foundedNpcIds.push(campaign.defenderNationId);

  // 防守方應為新建的 NPC（is_npc=true、無 Discord 擁有者），並 100% 掌控空地。
  const [defender] = await db
    .select({
      isNpc: playerNationsTable.isNpc,
      discordUserId: playerNationsTable.discordUserId,
      name: playerNationsTable.name,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, campaign.defenderNationId));
  assert.ok(defender, "founded defender nation must exist");
  assert.equal(defender!.isNpc, true, "founded defender must be an NPC");
  assert.equal(
    defender!.discordUserId,
    null,
    "founded NPC must not own a Discord user id（never write discord_user_id）",
  );

  const controls = await db
    .select({ nationId: regionControlsTable.nationId })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, emptyRegionId),
        gt(regionControlsTable.percent, 0),
      ),
    );
  assert.equal(controls.length, 1, "empty region gets exactly one controller");
  assert.equal(controls[0]!.nationId, campaign.defenderNationId);

  // 自動建立進行中的戰爭（繞過關係值 < 0 限制）。
  const wars = await db
    .select({ endedAt: diplomacyWarsTable.endedAt })
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, campaign.warId));
  assert.ok(wars[0], "a diplomacy war must back the campaign");
  assert.equal(wars[0]!.endedAt, null, "the war must be active");
});

test("Task #250 — 兩玩家併發攻打同一空地 → 恰好建立一個 NPC 防守方", async () => {
  const [pair] = await pickEmptyPairs(1, [r1, r2, r3, r4]);
  assert.ok(pair, "need one empty adjacent pair for the concurrency test");
  const attackerRegionId = pair!.a;
  const emptyRegionId = pair!.b;
  await db.insert(regionControlsTable).values({
    regionId: attackerRegionId,
    nationId: attackerId,
    percent: 100,
  });

  const initiate = () =>
    initiateCampaign({
      attackerNationId: attackerId,
      attackerRegionId,
      defenderRegionId: emptyRegionId,
    });
  const results = await Promise.allSettled([initiate(), initiate()]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  for (const r of fulfilled) {
    foundedNpcIds.push(
      (r as PromiseFulfilledResult<WarCampaign>).value.defenderNationId,
    );
  }
  assert.equal(
    fulfilled.length,
    1,
    "advisory lock + engagement PK must let exactly one attack win",
  );
  assert.equal(rejected.length, 1);
  assert.ok(
    (rejected[0] as PromiseRejectedResult).reason instanceof WarActionError,
    "loser must fail with a WarActionError",
  );

  // 無論競態如何，空地最終只有一個（NPC）控制者。
  const controls = await db
    .select({ nationId: regionControlsTable.nationId })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, emptyRegionId),
        gt(regionControlsTable.percent, 0),
      ),
    );
  assert.equal(controls.length, 1, "empty region ends with one controller only");
});

test("Task #250 — 攻打無主國家（is_npc=false, discordUserId=null）→ 升格為應戰 NPC", async () => {
  const [pair] = await pickEmptyPairs(1, [r1, r2, r3, r4]);
  assert.ok(pair, "need one empty adjacent pair for the promote test");
  const attackerRegionId = pair!.a;
  const unownedRegionId = pair!.b;

  // 無主國家：有領土但無人接手（is_npc=false、discordUserId=null）。
  const [unowned] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${runId}-ownerless`,
      government: "君主制",
      isNpc: false,
    })
    .returning({ id: playerNationsTable.id });
  unownedNationIds.push(unowned!.id);
  await db.insert(regionControlsTable).values([
    { regionId: attackerRegionId, nationId: attackerId, percent: 100 },
    { regionId: unownedRegionId, nationId: unowned!.id, percent: 100 },
  ]);

  const campaign = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId,
    defenderRegionId: unownedRegionId,
  });

  // 防守方應為原無主國家（同 id），只是 is_npc 升格為 true；領土不變。
  assert.equal(
    campaign.defenderNationId,
    unowned!.id,
    "the ownerless nation itself becomes the defender（promoted, not replaced）",
  );
  const [defender] = await db
    .select({
      isNpc: playerNationsTable.isNpc,
      discordUserId: playerNationsTable.discordUserId,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, unowned!.id));
  assert.equal(defender!.isNpc, true, "ownerless nation is promoted to NPC");
  assert.equal(
    defender!.discordUserId,
    null,
    "promotion must never write discord_user_id",
  );

  const wars = await db
    .select({ endedAt: diplomacyWarsTable.endedAt })
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, campaign.warId));
  assert.ok(wars[0], "a diplomacy war must back the promote campaign");
  assert.equal(wars[0]!.endedAt, null, "the war must be active");
});

/**
 * Task #502 — 同地區爭奪支援無人剩餘領土：
 * 玩家部分掌控（<100%）且剩餘為空地或無主國家時，同區發起會即時建國／
 * 升格 NPC 應戰，且新 NPC 只取得剩餘比例（Σ 不變、永不 100%）。
 */
test("Task #502 — 同區爭奪空地剩餘：即時建國 NPC 只取得剩餘比例", async () => {
  const rc = await findSpareRegion();
  spareRegions.push(rc);
  // 攻擊方僅掌控 60%，其餘 40% 無人持有。
  await db
    .insert(regionControlsTable)
    .values({ regionId: rc, nationId: attackerId, percent: 60 });

  const campaign = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId: rc,
    defenderRegionId: rc,
  });
  foundedNpcIds.push(campaign.defenderNationId);
  assert.equal(campaign.attackerRegionId, rc);
  assert.equal(campaign.defenderRegionId, rc);
  assert.notEqual(campaign.defenderNationId, attackerId);

  // 防守方 = 新建 NPC（is_npc=true、無 discord_user_id），恰好取得剩餘 40%。
  const [defender] = await db
    .select({
      isNpc: playerNationsTable.isNpc,
      discordUserId: playerNationsTable.discordUserId,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, campaign.defenderNationId));
  assert.equal(defender!.isNpc, true, "founded defender must be an NPC");
  assert.equal(defender!.discordUserId, null, "never write discord_user_id");

  const controls = await db
    .select({
      nationId: regionControlsTable.nationId,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, rc));
  const byNation = new Map(controls.map((c) => [c.nationId, c.percent]));
  assert.equal(byNation.get(attackerId), 60, "attacker share untouched");
  assert.equal(
    byNation.get(campaign.defenderNationId),
    40,
    "founded NPC gets exactly the 40% remainder, never 100%",
  );
  assert.equal(
    controls.reduce((s, c) => s + c.percent, 0),
    100,
    "region Σ(percent) stays ≤ 100",
  );

  // 自動建立進行中的戰爭。
  const [war] = await db
    .select({ endedAt: diplomacyWarsTable.endedAt })
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, campaign.warId));
  assert.ok(war, "a diplomacy war must back the same-region remainder campaign");
  assert.equal(war!.endedAt, null, "the war must be active");
});

test("Task #502 — 同區爭奪無主國家剩餘：升格 NPC、比例不變", async () => {
  const rc = await findSpareRegion();
  spareRegions.push(rc);
  // 無主國家（is_npc=false、discordUserId=null）持有剩餘 30%。
  const [unowned] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${runId}-remainder-ownerless`,
      government: "君主制",
      isNpc: false,
    })
    .returning({ id: playerNationsTable.id });
  unownedNationIds.push(unowned!.id);
  await db.insert(regionControlsTable).values([
    { regionId: rc, nationId: attackerId, percent: 70 },
    { regionId: rc, nationId: unowned!.id, percent: 30 },
  ]);

  const campaign = await initiateCampaign({
    attackerNationId: attackerId,
    attackerRegionId: rc,
    defenderRegionId: rc,
  });
  assert.equal(
    campaign.defenderNationId,
    unowned!.id,
    "the ownerless holder itself becomes the defender（promoted, not replaced）",
  );

  const [defender] = await db
    .select({
      isNpc: playerNationsTable.isNpc,
      discordUserId: playerNationsTable.discordUserId,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, unowned!.id));
  assert.equal(defender!.isNpc, true, "ownerless nation is promoted to NPC");
  assert.equal(defender!.discordUserId, null, "never write discord_user_id");

  // 比例不變：攻方 70、升格 NPC 30、Σ=100。
  const controls = await db
    .select({
      nationId: regionControlsTable.nationId,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, rc));
  const byNation = new Map(controls.map((c) => [c.nationId, c.percent]));
  assert.equal(byNation.get(attackerId), 70);
  assert.equal(byNation.get(unowned!.id), 30, "promoted share unchanged");
  assert.equal(
    controls.reduce((s, c) => s + c.percent, 0),
    100,
  );
});

test("Task #502 — 已完全掌控（100%）→ 400 zh-TW 明確拒絕", async () => {
  const rc = await findSpareRegion();
  await db
    .insert(regionControlsTable)
    .values({ regionId: rc, nationId: attackerId, percent: 100 });

  await assert.rejects(
    () =>
      initiateCampaign({
        attackerNationId: attackerId,
        attackerRegionId: rc,
        defenderRegionId: rc,
      }),
    (err: unknown) => {
      assert.ok(err instanceof WarActionError, `got ${String(err)}`);
      assert.equal(err.status, 400);
      assert.match(err.message, /已完全掌控/);
      assert.match(err.message, /沒有可爭奪的剩餘領土/);
      return true;
    },
  );
  await db
    .delete(regionControlsTable)
    .where(eq(regionControlsTable.regionId, rc));
});

test("Task #502 — 附庸發起同區爭奪需宗主同意：NPC 宗主與目標交好 → 403", async () => {
  const rc = await findSpareRegion();
  // 無主國家持有剩餘 40%（作為宗主判定的「宣戰目標」）。
  const [unowned] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${runId}-consent-ownerless`,
      government: "君主制",
      isNpc: false,
    })
    .returning({ id: playerNationsTable.id });
  unownedNationIds.push(unowned!.id);
  // NPC 宗主。
  const [suzerain] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${runId}-suzerain`,
      isNpc: true,
      government: "君主制",
    })
    .returning({ id: playerNationsTable.id });
  const suzerainId = suzerain!.id;
  await db.insert(regionControlsTable).values([
    { regionId: rc, nationId: attackerId, percent: 60 },
    { regionId: rc, nationId: unowned!.id, percent: 40 },
  ]);
  // 生效中的附庸條約：攻擊方為附庸（proposerIsVassal=true）。
  const [treaty] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: attackerId,
      targetNationId: suzerainId,
      type: "vassal",
      status: "active",
      proposerIsVassal: true,
    })
    .returning({ id: diplomacyTreatiesTable.id });
  // 宗主與無主目標關係良好（>0）→ 確定性判定拒絕。
  const [low, high] = [suzerainId, unowned!.id].sort();
  await db
    .insert(diplomacyRelationsTable)
    .values({ nationAId: low!, nationBId: high!, score: 50 });

  try {
    await assert.rejects(
      () =>
        initiateCampaign({
          attackerNationId: attackerId,
          attackerRegionId: rc,
          defenderRegionId: rc,
        }),
      (err: unknown) => {
        assert.ok(err instanceof WarActionError, `got ${String(err)}`);
        assert.equal(err.status, 403, "NPC suzerain denial must be 403");
        assert.match(err.message, /宗主國/);
        return true;
      },
    );
    // 守門拒絕後不得殘留任何升格／建國副作用。
    const [holder] = await db
      .select({ isNpc: playerNationsTable.isNpc })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, unowned!.id));
    assert.equal(holder!.isNpc, false, "denied gate must not promote the holder");
  } finally {
    // 條約留著會讓後續（若新增）測試的攻擊方仍是附庸；就地清掉。
    await db
      .delete(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.id, treaty!.id));
    await db
      .delete(regionControlsTable)
      .where(eq(regionControlsTable.regionId, rc));
  }
});
