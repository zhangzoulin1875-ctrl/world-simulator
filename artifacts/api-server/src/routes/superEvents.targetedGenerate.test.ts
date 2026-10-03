/**
 * 超事件「AI 生成針對單一國家事件」端對端整合測試（真實 dev DB）。
 *
 * 核心：POST /api/super-events/admin/generate 支援 scope=targeted，把目標國家名稱
 * 作為 focus 交給 AI，並把生成的事件以 scope="targeted" + super_event_nations 落地。
 * 過去 AI 生成路徑只會產出 scope="global"，無法真正生成「針對單一國家」的事件。
 *
 * 斷言：
 *  1. scope=targeted 但未給 nationIds → 400，不建立任何事件。
 *  2. scope=targeted + nationIds=[目標] → 200，事件 scope=targeted，
 *     super_event_nations 只含目標國家（不含旁觀國家）。
 *  3. 結算（settleEvent）後：只有目標國家有 super_event_nation_impacts 與數值變動，
 *     旁觀國家（同樣掌控地區）完全不受影響——證明 targeted 精準生效於結算。
 *
 * 測試資料以 `__superevt_gen__` 前綴標記，跑前跑後自清，可重複執行：
 * `pnpm --filter @workspace/api-server run test:integration`
 */
import { strict as assert } from "node:assert";
import test, { after, before, afterEach } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the super-event tests");
}
if (!process.env.ADMIN_TOKEN) {
  throw new Error("ADMIN_TOKEN must be set to run the super-event tests");
}
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const express = (await import("express")).default;
const { eq, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionEraStatsTable,
  superEventsTable,
  superEventNationsTable,
  superEventNationImpactsTable,
} = await import("@workspace/db");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runMapRegionEraStatsSync } = await import("../lib/mapRegionEraStats");
const { runSuperEventMigrations } = await import("../lib/superEventMigrations");
const { settleEvent } = await import("../lib/superEventSettlement");
const { ERAS } = await import("../lib/mapRegionEras");
const { superEventsRouter } = await import("./superEvents");

const TEST_TAG = "__superevt_gen__";
const runId = randomBytes(4).toString("hex");
const ERA_SLUG = ERAS[0]!.slug;

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

/** AI 生成回應（genSchema）。 */
const GEN_JSON = {
  title: `${TEST_TAG}政變風暴`,
  summary: `${TEST_TAG}目標國陷入政變`,
  narrative: `${TEST_TAG}軍方突襲首都，政局動盪。`,
  category: "政變",
  severity: 70,
  kind: "disaster",
};

/** 回合判定回應（turnSchema），供 settleEvent 使用。 */
const TURN_JSON = {
  narrative: `${TEST_TAG}政變持續，秩序崩壞。`,
  effect: {
    populationDeltaPct: 0,
    productivityDeltaPct: 0,
    satisfactionFarmersDelta: 0,
    satisfactionWorkersDelta: 0,
    satisfactionClergyDelta: 0,
    satisfactionNoblesDelta: 0,
    stabilityDelta: -20,
    unrestDelta: 20,
  },
  stage: "peak",
  grantTech: null,
  npcHostility: "none",
  end: false,
};

/** 覆寫 AI：生成提示詞 → GEN_JSON；回合判定提示詞 → TURN_JSON。 */
function stubAi(): () => void {
  const fn = (async (args: { system?: string }) => {
    const system = String(args?.system ?? "");
    const json = system.includes("生成 AI") ? GEN_JSON : TURN_JSON;
    return { content: [{ type: "text", text: JSON.stringify(json) }] };
  }) as unknown as MessagesCreate;
  anthropic.messages.create = fn;
  return () => {
    anthropic.messages.create = realMessagesCreate;
  };
}

let server: http.Server;
let baseUrl: string;
let targetNationId: string;
let bystanderNationId: string;

async function deleteTestEvents() {
  await db
    .delete(superEventsTable)
    .where(sql`${superEventsTable.title} LIKE ${TEST_TAG + "%"}`);
}

async function cleanup() {
  await deleteTestEvents();
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
}

async function postGenerate(
  body: unknown,
  token: string | null = ADMIN_TOKEN,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/super-events/admin/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

before(async () => {
  await runGameMigrations();
  await runMapRegionSync();
  await runMapRegionEraStatsSync();
  await runSuperEventMigrations();
  await cleanup();

  const [target] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}target-${runId}`,
      leaderName: TEST_TAG,
      government: "君主制",
      discordUserId: `${TEST_TAG}target-${runId}`,
      isNpc: false,
      stability: 50,
      unrest: 0,
    })
    .returning({ id: playerNationsTable.id });
  targetNationId = target!.id;

  const [bystander] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}bystander-${runId}`,
      leaderName: TEST_TAG,
      government: "君主制",
      discordUserId: `${TEST_TAG}bystander-${runId}`,
      isNpc: false,
      stability: 50,
      unrest: 0,
    })
    .returning({ id: playerNationsTable.id });
  bystanderNationId = bystander!.id;

  // 挑兩個無人掌控且該時代有人口的地區，分別 100% 指派給兩國。
  const controlled = await db
    .select({ regionId: regionControlsTable.regionId })
    .from(regionControlsTable);
  const controlledSet = new Set(controlled.map((r) => r.regionId));
  const eraRows = await db
    .select({
      regionId: mapRegionEraStatsTable.regionId,
      population: mapRegionEraStatsTable.population,
    })
    .from(mapRegionEraStatsTable)
    .where(eq(mapRegionEraStatsTable.era, ERA_SLUG))
    .orderBy(sql`${mapRegionEraStatsTable.population} DESC`);
  const free = eraRows
    .filter((r) => !controlledSet.has(r.regionId) && r.population > 0)
    .slice(0, 2);
  assert.ok(free.length === 2, "需要兩個無人掌控且有人口的地區");

  await db.insert(regionControlsTable).values([
    { regionId: free[0]!.regionId, nationId: targetNationId, percent: 100 },
    { regionId: free[1]!.regionId, nationId: bystanderNationId, percent: 100 },
  ]);

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
  app.use("/api", superEventsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  anthropic.messages.create = realMessagesCreate;
  await deleteTestEvents();
});

after(async () => {
  anthropic.messages.create = realMessagesCreate;
  await cleanup();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("scope=targeted 但未給 nationIds → 400，且不建立任何事件", async () => {
  const restore = stubAi();
  try {
    const r = await postGenerate({ scope: "targeted" });
    assert.equal(r.status, 400);
  } finally {
    restore();
  }
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(superEventsTable)
    .where(sql`${superEventsTable.title} LIKE ${TEST_TAG + "%"}`);
  assert.equal(Number(row!.n), 0, "400 不應建立事件");
});

test("scope=targeted → AI 生成 scope=targeted 事件，super_event_nations 只含目標國家", async () => {
  const restore = stubAi();
  let created: { status: number; json: any };
  try {
    created = await postGenerate({
      scope: "targeted",
      nationIds: [targetNationId],
      kind: "disaster",
    });
  } finally {
    restore();
  }
  assert.equal(created.status, 200);
  assert.ok(created.json?.id, "應回傳事件 id");
  const eventId = created.json.id as string;

  const [event] = await db
    .select()
    .from(superEventsTable)
    .where(eq(superEventsTable.id, eventId))
    .limit(1);
  assert.ok(event, "事件應存在");
  assert.equal(event.scope, "targeted", "scope 應為 targeted（非 global）");
  assert.equal(event.cause, "ai", "cause 應為 ai");

  const nations = await db
    .select({ nationId: superEventNationsTable.nationId })
    .from(superEventNationsTable)
    .where(eq(superEventNationsTable.eventId, eventId));
  assert.equal(nations.length, 1, "只應有一個目標國家");
  assert.equal(nations[0]!.nationId, targetNationId, "目標必須是指定國家");
});

test("結算：targeted 事件只影響目標國家，旁觀國家零變動", async () => {
  const restore = stubAi();
  try {
    const created = await postGenerate({
      scope: "targeted",
      nationIds: [targetNationId],
    });
    assert.equal(created.status, 200);
    const eventId = created.json.id as string;

    const [event] = await db
      .select()
      .from(superEventsTable)
      .where(eq(superEventsTable.id, eventId))
      .limit(1);
    assert.ok(event);

    await settleEvent(event, 100, ERA_SLUG, ERA_SLUG);

    const impacts = await db
      .select({ nationId: superEventNationImpactsTable.nationId })
      .from(superEventNationImpactsTable)
      .where(eq(superEventNationImpactsTable.eventId, eventId));
    const impactedIds = new Set(impacts.map((i) => i.nationId));
    assert.ok(impactedIds.has(targetNationId), "目標國家應有影響紀錄");
    assert.ok(
      !impactedIds.has(bystanderNationId),
      "旁觀國家不應有任何影響紀錄",
    );

    const [bystander] = await db
      .select({
        stability: playerNationsTable.stability,
        unrest: playerNationsTable.unrest,
      })
      .from(playerNationsTable)
      .where(eq(playerNationsTable.id, bystanderNationId))
      .limit(1);
    assert.equal(bystander!.stability, 50, "旁觀國安定度不變");
    assert.equal(bystander!.unrest, 0, "旁觀國動亂度不變");
  } finally {
    restore();
  }
});
