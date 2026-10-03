/**
 * Task #228 — 宣戰端點（POST /api/diplomacy/wars）的真實資料庫整合測試。
 *
 * 鎖住兩條 Task #228 的關係值規則變動：
 *
 *  1. 玩家↔玩家：不再有關係值判定，可直接宣戰（無需 relation < 0）。
 *  2. 玩家↔NPC：仍需關係值 < 0 才能宣戰；score ≥ 0 → 400；score < 0 → 200。
 *
 * 另鎖住既有守門仍生效：
 *
 *  3. 生效中的互不侵犯條約仍擋下玩家↔玩家宣戰（400）。
 *
 * 走真正的 Express 端點（掛 session cookie）。所有資料以 `__wartest__` /
 * `wartest-` 前綴標記，跑前跑後自清，可重複執行：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the diplomacy-war tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { and, eq, inArray, like, or, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  diplomacyRelationsTable,
  diplomacyWarsTable,
  diplomacyTreatiesTable,
  diplomacyRelationEventsTable,
  userSessionsTable,
} = await import("@workspace/db");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");
const { canonicalPair } = await import("../lib/diplomacy");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const diplomacyRouter = (await import("./diplomacy")).default;

const NATION_MARKER = "__wartest__";
const USER_MARKER = "wartest-";

const runId = randomBytes(4).toString("hex");

let server: http.Server;
let baseUrl: string;

let nationA: string; // 擁有者（掛 session）
let nationB: string; // 另一玩家
let nationNpc: string; // NPC
let ownerUserId: string;
let sessionToken: string;

async function createNation(
  label: string,
  opts: { discordUserId?: string | null; isNpc?: boolean } = {},
) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${label}-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: opts.discordUserId ?? null,
      isNpc: opts.isNpc ?? false,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function setRelation(a: string, b: string, score: number) {
  const { low, high } = canonicalPair(a, b);
  await db
    .insert(diplomacyRelationsTable)
    .values({ nationAId: low, nationBId: high, score })
    .onConflictDoUpdate({
      target: [diplomacyRelationsTable.nationAId, diplomacyRelationsTable.nationBId],
      set: { score },
    });
}

async function clearWarsAndTreaties() {
  const ids = [nationA, nationB, nationNpc].filter(Boolean);
  if (ids.length === 0) return;
  await db
    .delete(diplomacyWarsTable)
    .where(
      or(
        inArray(diplomacyWarsTable.nationAId, ids),
        inArray(diplomacyWarsTable.nationBId, ids),
      ),
    );
  await db
    .delete(diplomacyTreatiesTable)
    .where(
      or(
        inArray(diplomacyTreatiesTable.proposerNationId, ids),
        inArray(diplomacyTreatiesTable.targetNationId, ids),
      ),
    );
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

async function declareWar(
  targetNationId: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/diplomacy/wars`, {
    method: "POST",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ targetNationId }),
  });
  return { status: res.status, json: await res.json() };
}

before(async () => {
  await runDiplomacyMigrations();
  await cleanup();

  ownerUserId = `${USER_MARKER}owner-${runId}`;
  nationA = await createNation("A", { discordUserId: ownerUserId });
  nationB = await createNation("B", {
    discordUserId: `${USER_MARKER}B-${runId}`,
  });
  nationNpc = await createNation("NPC", {
    discordUserId: `${USER_MARKER}NPC-${runId}`,
    isNpc: true,
  });

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

test("玩家↔玩家：關係值 0（或無關係列）也能直接宣戰", async () => {
  await clearWarsAndTreaties();
  // 明確設關係值為 0，證明「非負」不再擋玩家↔玩家宣戰。
  await setRelation(nationA, nationB, 0);

  const { status, json } = await declareWar(nationB);
  assert.equal(status, 200, `應成功宣戰：${JSON.stringify(json)}`);
  assert.equal(json.targetNationId, nationB);

  const { low, high } = canonicalPair(nationA, nationB);
  const [war] = await db
    .select({ declaredBy: diplomacyWarsTable.declaredByNationId })
    .from(diplomacyWarsTable)
    .where(
      and(
        eq(diplomacyWarsTable.nationAId, low),
        eq(diplomacyWarsTable.nationBId, high),
      ),
    )
    .limit(1);
  assert.ok(war, "宣戰後應建立交戰列");
  assert.equal(war.declaredBy, nationA, "宣戰方應為 A");
});

test("玩家↔NPC：關係值 ≥ 0 → 400，不建立交戰列", async () => {
  await clearWarsAndTreaties();
  await setRelation(nationA, nationNpc, 5);

  const { status, json } = await declareWar(nationNpc);
  assert.equal(status, 400, `關係值 ≥ 0 對 NPC 宣戰應被拒：${JSON.stringify(json)}`);
  assert.ok(
    String(json.error ?? "").includes("關係值"),
    `錯誤訊息應提及關係值：${JSON.stringify(json)}`,
  );

  const { low, high } = canonicalPair(nationA, nationNpc);
  const wars = await db
    .select({ id: diplomacyWarsTable.id })
    .from(diplomacyWarsTable)
    .where(
      and(
        eq(diplomacyWarsTable.nationAId, low),
        eq(diplomacyWarsTable.nationBId, high),
      ),
    );
  assert.equal(wars.length, 0, "被拒的宣戰不得建立交戰列");
});

test("玩家↔NPC：關係值 < 0 → 200，成功宣戰", async () => {
  await clearWarsAndTreaties();
  await setRelation(nationA, nationNpc, -1);

  const { status, json } = await declareWar(nationNpc);
  assert.equal(status, 200, `關係值 < 0 對 NPC 宣戰應成功：${JSON.stringify(json)}`);
  assert.equal(json.targetNationId, nationNpc);
});

test("互不侵犯條約仍擋下玩家↔玩家宣戰（400）", async () => {
  await clearWarsAndTreaties();
  await setRelation(nationA, nationB, 0);
  // 生效中的互不侵犯條約。
  await db.insert(diplomacyTreatiesTable).values({
    proposerNationId: nationA,
    targetNationId: nationB,
    type: "nonaggression",
    status: "active",
  });

  const { status, json } = await declareWar(nationB);
  assert.equal(status, 400, `互不侵犯條約應擋下宣戰：${JSON.stringify(json)}`);
  assert.ok(
    String(json.error ?? "").includes("互不侵犯"),
    `錯誤訊息應提及互不侵犯：${JSON.stringify(json)}`,
  );
});
