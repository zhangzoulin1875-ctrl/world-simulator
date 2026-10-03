/**
 * Task #109 — 互動歷史端點（GET /api/diplomacy/nations/:nationId/relation-events）
 * 的真實資料庫整合測試。此端點以 pair 雙向查詢回傳兩國間的關係動作紀錄
 * （送禮／侮辱／設館／撤館）。這裡鎖住其隱私與正確性不變量，避免日後查詢
 * 條件被改壞而外洩「對方與第三國」或「我與第三國」的紀錄、或回傳保留窗外
 * 的舊紀錄：
 *
 *  1. 三國情境（A↔B、A↔C、B↔C 各有事件）：以 A 查 B 只見 A↔B 紀錄，
 *     A↔C 與 B↔C 一律排除。
 *  2. 雙向：A→B 與 B→A 的事件都會被撈到，byMe 旗標正確。
 *  3. 排序新→舊（createdAt desc）。
 *  4. 保留窗外（createdAt < now − RELATION_EVENTS_RETENTION_MS）排除。
 *  5. limit 上限（RELATION_EVENTS_UI_MAX_ENTRIES = 30）。
 *  6. 對自己查詢回 400。
 *
 * 走真正的 Express 端點（掛 session cookie），因此驗證的是線上查詢本身。
 * 需要 DATABASE_URL 指向已由正常伺服器啟動遷移過的資料庫。所有資料以
 * `__relevttest__` / `relevttest-` 前綴標記，跑前跑後自清，可重複執行：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the relation-events tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { inArray, like, or, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  diplomacyRelationEventsTable,
  userSessionsTable,
} = await import("@workspace/db");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");
const { RELATION_EVENTS_RETENTION_MS } = await import("../lib/diplomacy");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const diplomacyRouter = (await import("./diplomacy")).default;

const NATION_MARKER = "__relevttest__";
const USER_MARKER = "relevttest-";

const runId = randomBytes(4).toString("hex");

const DAY_MS = 24 * 60 * 60 * 1000;

let server: http.Server;
let baseUrl: string;

// A 為擁有者（掛 session）；B、C 為第三國。
let nationA: string;
let nationB: string;
let nationC: string;
let ownerUserId: string;
let sessionToken: string;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

async function createNation(label: string, discordUserId?: string) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${label}-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: discordUserId ?? null,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function insertEvent(
  actorNationId: string,
  targetNationId: string,
  action: string,
  createdAt: Date,
) {
  await db.insert(diplomacyRelationEventsTable).values({
    actorNationId,
    targetNationId,
    action,
    createdAt,
  });
}

async function clearEvents() {
  const ids = [nationA, nationB, nationC].filter(Boolean);
  if (ids.length === 0) return;
  await db
    .delete(diplomacyRelationEventsTable)
    .where(
      or(
        inArray(diplomacyRelationEventsTable.actorNationId, ids),
        inArray(diplomacyRelationEventsTable.targetNationId, ids),
      ),
    );
}

async function cleanup() {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${NATION_MARKER + "%"}`);
  await db
    .delete(userSessionsTable)
    .where(like(userSessionsTable.discordUserId, `${USER_MARKER}%`));
}

async function getEvents(nationId: string): Promise<{ status: number; json: any }> {
  const res = await fetch(
    `${baseUrl}/api/diplomacy/nations/${nationId}/relation-events`,
    {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` },
    },
  );
  return { status: res.status, json: await res.json() };
}

before(async () => {
  await runDiplomacyMigrations();
  await cleanup();

  ownerUserId = `${USER_MARKER}owner-${runId}`;
  nationA = await createNation("A", ownerUserId);
  nationB = await createNation("B");
  nationC = await createNation("C");

  sessionToken = await createSession({
    discordUserId: ownerUserId,
    username: ownerUserId,
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
  app.use("/api", diplomacyRouter);
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

test("三國情境：以 A 查 B 只見 A↔B 紀錄，A↔C 與 B↔C 一律排除", async () => {
  await clearEvents();
  // A↔B（雙向）
  await insertEvent(nationA, nationB, "gift", daysAgo(1));
  await insertEvent(nationB, nationA, "insult", daysAgo(2));
  // A↔C：不得混入
  await insertEvent(nationA, nationC, "gift", daysAgo(1));
  await insertEvent(nationC, nationA, "insult", daysAgo(1));
  // B↔C：完全與 A 無關，不得混入
  await insertEvent(nationB, nationC, "gift", daysAgo(1));
  await insertEvent(nationC, nationB, "insult", daysAgo(1));

  const { status, json } = await getEvents(nationB);
  assert.equal(status, 200);
  const actions = json.events.map((e: any) => e.action).sort();
  assert.equal(json.events.length, 2, "只應回傳 A↔B 的兩筆");
  assert.deepEqual(actions, ["gift", "insult"]);
});

test("雙向：A→B 與 B→A 都被撈到，byMe 旗標正確", async () => {
  await clearEvents();
  await insertEvent(nationA, nationB, "gift", daysAgo(1)); // 我做的
  await insertEvent(nationB, nationA, "insult", daysAgo(2)); // 對方做的

  const { status, json } = await getEvents(nationB);
  assert.equal(status, 200);
  assert.equal(json.events.length, 2);
  // 新→舊：gift(1天前) 在前、insult(2天前) 在後。
  assert.equal(json.events[0].action, "gift");
  assert.equal(json.events[0].byMe, true, "A→B 應為 byMe=true");
  assert.equal(json.events[1].action, "insult");
  assert.equal(json.events[1].byMe, false, "B→A 應為 byMe=false");
});

test("排序：依 createdAt 新→舊", async () => {
  await clearEvents();
  await insertEvent(nationA, nationB, "embassy", daysAgo(3));
  await insertEvent(nationA, nationB, "gift", daysAgo(1));
  await insertEvent(nationA, nationB, "insult", daysAgo(2));

  const { json } = await getEvents(nationB);
  assert.deepEqual(
    json.events.map((e: any) => e.action),
    ["gift", "insult", "embassy"],
    "應為 1天前 → 2天前 → 3天前",
  );
});

test("保留窗外（> RELATION_EVENTS_RETENTION_MS）排除", async () => {
  await clearEvents();
  const retentionDays = RELATION_EVENTS_RETENTION_MS / DAY_MS;
  await insertEvent(nationA, nationB, "gift", daysAgo(1)); // 窗內
  await insertEvent(nationA, nationB, "insult", daysAgo(retentionDays + 1)); // 窗外

  const { json } = await getEvents(nationB);
  assert.equal(json.events.length, 1, "窗外舊紀錄應被排除");
  assert.equal(json.events[0].action, "gift");
});

test("limit 上限：最多回傳 30 筆（最新的）", async () => {
  await clearEvents();
  // 35 筆全落在保留窗內（0.1 ~ 3.5 天前），時間互不相同。
  for (let i = 1; i <= 35; i++) {
    await insertEvent(nationA, nationB, "gift", daysAgo(i * 0.1));
  }

  const { json } = await getEvents(nationB);
  assert.equal(json.events.length, 30, "limit 上限為 30");
  // 新→舊：第一筆應為最新（0.1 天前）。
  const times = json.events.map((e: any) => new Date(e.createdAt).getTime());
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i - 1] >= times[i], "必須維持新→舊排序");
  }
});

test("對自己查詢回 400", async () => {
  await clearEvents();
  const { status, json } = await getEvents(nationA);
  assert.equal(status, 400);
  assert.ok(
    String(json.error ?? "").includes("自己"),
    `錯誤訊息應說明不可查詢自己：${JSON.stringify(json)}`,
  );
});
