/**
 * Task #570 — NPC 締約資源上限的路由整合測試（真 DB + 真實 HTTP 路由）。
 *
 * 涵蓋：
 *  1. GET /api/diplomacy/nations/:id/treaty-caps：NPC → 200 回各資源上限；
 *     真人國家 → 400 zh-TW。
 *  2. POST /api/diplomacy/treaties 提案守門：對 NPC 要求超過上限的一次性
 *     金錢／每回合輸送（兩種 proposerIsPayer 方向）／單區讓渡比例 →
 *     提案當下就 400（訊息列出上限），且不寫入任何條約列、不呼叫 AI。
 *  3. 真人↔真人條約完全不受上限影響（同樣的超額要求照常成立提案）。
 *
 * 注意：POST 路由掛 aiRateLimit（5/min/IP），本檔 POST 總數必須 ≤5。
 * 測試資料自成一體（名稱前綴 + 清理）；跑法：test-integration workflow。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the treaty-caps tests");
}

const { eq, inArray, isNull, like, or } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  diplomacyTreatiesTable,
  regionControlsTable,
  mapRegionsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");
// player_nations 的 satisfaction_* 欄位由政治遷移補上（idempotent）。
const { runPoliticsMigrations } = await import("../lib/politicsMigrations");
// world_game_state 的 npc_treaty_* 上限欄位。
const { runWorldSimMigrations } = await import("../lib/worldSimMigrations");
// region_buildings（上限快照的木／礦每回合產出來源）。
const { runResourceMigrations } = await import("../lib/resourceMigrations");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { default: treatiesRouter } = await import("./diplomacy/treaties");
const { default: relationsRouter } = await import("./diplomacy/relations");

const TEST_TAG = "__treatycaps570__";
const runId = randomBytes(4).toString("hex");
const discordUserId = `${TEST_TAG}${runId}`;
const humanTargetDiscordId = `${TEST_TAG}h${runId}`;

let myId = "";
let npcId = "";
let humanId = "";
let npcRegionId = 0;
let sessionToken = "";
let server: http.Server;
let baseUrl = "";

function proposeViaRoute(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/diplomacy/treaties`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
    },
    body: JSON.stringify(body),
  });
}

function getCapsViaRoute(nationId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/diplomacy/nations/${nationId}/treaty-caps`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
  });
}

async function treatyCountFor(nationId: string): Promise<number> {
  const rows = await db
    .select({ id: diplomacyTreatiesTable.id })
    .from(diplomacyTreatiesTable)
    .where(
      or(
        eq(diplomacyTreatiesTable.proposerNationId, nationId),
        eq(diplomacyTreatiesTable.targetNationId, nationId),
      ),
    );
  return rows.length;
}

async function cleanup() {
  const rows = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.name, `${TEST_TAG}%`));
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db
      .delete(diplomacyTreatiesTable)
      .where(
        or(
          inArray(diplomacyTreatiesTable.proposerNationId, ids),
          inArray(diplomacyTreatiesTable.targetNationId, ids),
        ),
      );
    await db
      .delete(regionControlsTable)
      .where(inArray(regionControlsTable.nationId, ids));
    await db
      .delete(playerNationsTable)
      .where(inArray(playerNationsTable.id, ids));
  }
}

before(async () => {
  await runGameMigrations();
  await runDiplomacyMigrations();
  await runPoliticsMigrations();
  await runWorldSimMigrations();
  await runResourceMigrations();
  await cleanup();

  const [me] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}me-${runId}`,
      leaderName: TEST_TAG,
      money: 1_000,
      isNpc: false,
      discordUserId,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(me, "proposer nation insert failed");
  myId = me.id;

  // NPC 資源全零 → 各項一次性／每回合上限都是 0。
  const [npc] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}npc-${runId}`,
      leaderName: TEST_TAG,
      money: 0,
      techPoints: 0,
      isNpc: true,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(npc, "npc nation insert failed");
  npcId = npc.id;

  const [human] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}human-${runId}`,
      leaderName: TEST_TAG,
      money: 0,
      techPoints: 0,
      isNpc: false,
      discordUserId: humanTargetDiscordId,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(human, "human target nation insert failed");
  humanId = human.id;

  // 借用一個無人掌控的地區給 NPC（掌控 80%）；offset 300 避開其他整合測試。
  const [regionRow] = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(300)
    .limit(1);
  assert.ok(regionRow, "測試需要一個無人掌控的地區");
  npcRegionId = regionRow.id;
  await db
    .insert(regionControlsTable)
    .values({ nationId: npcId, regionId: npcRegionId, percent: 80 });

  sessionToken = await createSession({
    discordUserId,
    username: TEST_TAG,
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
    const cookies: Record<string, string> = {};
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0) cookies[part.slice(0, idx).trim()] = part.slice(idx + 1);
    }
    (req as unknown as { cookies: Record<string, string> }).cookies = cookies;
    next();
  });
  app.use(express.json());
  app.use("/api", treatiesRouter);
  app.use("/api", relationsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await cleanup();
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
  await pool.end();
});

test("GET treaty-caps：NPC → 200 回各資源上限（零資源 NPC 全為 0）", async () => {
  const res = await getCapsViaRoute(npcId);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { caps: Record<string, number> };
  assert.ok(body.caps, "回應應包含 caps");
  assert.equal(body.caps["money"], 0);
  assert.equal(body.caps["techPoints"], 0);
  assert.equal(body.caps["wood"], 0);
  assert.equal(body.caps["ore"], 0);
  assert.equal(body.caps["maxRegions"], 3); // 預設值
  assert.equal(body.caps["regionMaxPct"], 50); // 預設值
  assert.equal(body.caps["perTurnMoney"], 0);
});

test("GET treaty-caps：真人國家 → 400 zh-TW", async () => {
  const res = await getCapsViaRoute(humanId);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("不是 NPC 國家"), body.error);
});

test("提案守門：要求 NPC 提供超過上限的一次性金錢 → 400 且不寫入條約", async () => {
  const res = await proposeViaRoute({
    targetNationId: npcId,
    type: "nonaggression",
    requestMoney: 500,
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("超過 NPC 可提供的資源上限"), body.error);
  assert.ok(body.error.includes("金錢 500 超過上限 0"), body.error);
  assert.equal(await treatyCountFor(npcId), 0, "不應寫入任何條約列");
});

test("提案守門：自訂條約 proposerIsPayer=false（NPC 付 perTurn*）超限 → 400", async () => {
  const res = await proposeViaRoute({
    targetNationId: npcId,
    type: "custom",
    customClause: "測試條款",
    proposerIsPayer: false,
    perTurnMoney: 1_000,
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("超過 NPC 可提供的資源上限"), body.error);
  assert.ok(body.error.includes("每回合金錢"), body.error);
  assert.equal(await treatyCountFor(npcId), 0);
});

test("提案守門：自訂條約 proposerIsPayer=true（NPC 付 requestPerTurn*）超限 → 400", async () => {
  const res = await proposeViaRoute({
    targetNationId: npcId,
    type: "custom",
    customClause: "測試條款",
    proposerIsPayer: true,
    requestPerTurnMoney: 1_000,
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.ok(body.error.includes("超過 NPC 可提供的資源上限"), body.error);
  assert.ok(body.error.includes("每回合金錢"), body.error);
  assert.equal(await treatyCountFor(npcId), 0);
});

test("提案守門：要求含領土 → 400（領土條約已全面禁用）", async () => {
  // 領土轉移已全面禁用，提案前置守門直接 400，不進入 NPC 資源上限邏輯。
  const res = await proposeViaRoute({
    targetNationId: npcId,
    type: "nonaggression",
    requestRegionIds: [npcRegionId],
    requestRegionPercents: { [String(npcRegionId)]: 50 },
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { message: string };
  assert.ok(
    body.message.includes("領土轉移"),
    `expected territory-disabled message, got: ${body.message}`,
  );
  assert.equal(await treatyCountFor(npcId), 0);
});

test("真人↔真人：同樣的超額要求不受上限影響，提案照常成立", async () => {
  const res = await proposeViaRoute({
    targetNationId: humanId,
    type: "nonaggression",
    requestMoney: 999_999,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    npcDecision: unknown;
    treaty: { id: number; status: string };
  };
  assert.equal(body.npcDecision, null);
  assert.equal(body.treaty.status, "proposed");
  assert.equal(await treatyCountFor(humanId), 1);
});
