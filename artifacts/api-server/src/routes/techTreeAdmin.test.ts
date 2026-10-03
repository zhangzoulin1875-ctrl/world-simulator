/**
 * Task #469 — 全球統一線性科技樹管理員 CRUD 整合測試（真 DB＋真 Express）。
 *
 * 鎖定 routes/techTreeAdmin.ts 的守門與行為：
 *  - admin token 守門（無 token → 401）；
 *  - POST 欄位驗證（無效領域 400）、支線掛點驗證（不存在／跨領域 400）、
 *    keySlug 全域唯一（撞既有 → 409）；
 *  - PUT 部分更新（200）、空 body 400、不存在 404；
 *  - DELETE：已被研發／研發中沒帶 force → 409；force=1 → 研發紀錄 cascade、
 *    進行中研發歸零（active／快照／進度全清）。
 *
 * 需要 DATABASE_URL。資料以 `ttadmintest-`／`__ttadmintest__` 前綴標記、
 * 自清，可重複執行：`pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the tech tree admin tests");
}

const runId = randomBytes(4).toString("hex");
// requireAdmin 於模組載入時讀 env；動態 import 之前先確保有值。
process.env.ADMIN_TOKEN ||= `ttadmintest-token-${runId}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const express = (await import("express")).default;
const { and, eq, like } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerTechTreeStateTable,
  playerResearchedTreeNodesTable,
  techTreeNodesTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runPoliticsMigrations } = await import("../lib/politicsMigrations");
const { runTechTreeMigrations } = await import("../lib/techTreeMigrations");
const { ensureTechTreeStates } = await import("../lib/techTreeData");
const techTreeAdminRouter = (await import("./techTreeAdmin")).default;

const USER_MARKER = "ttadmintest-";
const NATION_MARKER = "__ttadmintest__";
const uid = `${USER_MARKER}${runId}`;

let server: http.Server;
let baseUrl: string;
let nationId: string;

async function cleanup() {
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  await db
    .delete(techTreeNodesTable)
    .where(like(techTreeNodesTable.lineKey, `${NATION_MARKER}%`));
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  withToken = true,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(withToken ? { "x-admin-token": ADMIN_TOKEN } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function nodeBody(overrides: Record<string, unknown> = {}) {
  return {
    domain: "social",
    eraSlug: "classical",
    lineKey: `${NATION_MARKER}line-${runId}`,
    lineLabel: `${NATION_MARKER}測試線`,
    lineKind: "branch",
    sortOrder: 1,
    name: `${NATION_MARKER}節點-${runId}`,
    description: "admin CRUD 測試節點",
    baseCost: 42,
    effects: [],
    keySlug: null,
    branchFromNodeId: null,
    ...overrides,
  };
}

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await runTechTreeMigrations();
  await cleanup();

  const [created] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: uid,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(created, "failed to create test nation");
  nationId = created.id;
  await ensureTechTreeStates(db, nationId);

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
  app.use("/api", techTreeAdminRouter);
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

test("無 admin token → 401；GET 總表需要 token", async () => {
  const noToken = await api("GET", "/admin/tech-tree", undefined, false);
  assert.equal(noToken.status, 401);

  const ok = await api("GET", "/admin/tech-tree");
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.json.nodes) && ok.json.nodes.length > 0);
  assert.ok("researchedCount" in ok.json.nodes[0]);
  assert.ok("activeCount" in ok.json.nodes[0]);
});

test("POST 驗證：無效領域 400、無效時代 400、baseCost <1 400", async () => {
  const badDomain = await api("POST", "/admin/tech-tree/nodes", nodeBody({ domain: "magic" }));
  assert.equal(badDomain.status, 400);

  const badEra = await api("POST", "/admin/tech-tree/nodes", nodeBody({ eraSlug: "no-such-era" }));
  assert.equal(badEra.status, 400);

  const badCost = await api("POST", "/admin/tech-tree/nodes", nodeBody({ baseCost: 0 }));
  assert.equal(badCost.status, 400);
});

test("POST 支線掛點驗證：不存在 400、跨領域 400", async () => {
  const missing = await api(
    "POST",
    "/admin/tech-tree/nodes",
    nodeBody({ branchFromNodeId: 2000000000 }),
  );
  assert.equal(missing.status, 400);

  const [prodNode] = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.domain, "production"))
    .limit(1);
  assert.ok(prodNode, "seeded production node missing");
  const crossDomain = await api(
    "POST",
    "/admin/tech-tree/nodes",
    nodeBody({ branchFromNodeId: prodNode.id }),
  );
  assert.equal(crossDomain.status, 400, "跨領域掛點必須 400");
});

test("POST keySlug 撞既有 → 409", async () => {
  const dup = await api(
    "POST",
    "/admin/tech-tree/nodes",
    nodeBody({ keySlug: "irrigation" }),
  );
  assert.equal(dup.status, 409);
});

test("POST → PUT → DELETE 完整生命週期（含 force 清理引用）", async () => {
  // 建立。
  const created = await api("POST", "/admin/tech-tree/nodes", nodeBody());
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const nodeId: number = created.json.node.id;
  assert.equal(created.json.node.baseCost, 42);

  // 部分更新。
  const updated = await api("PUT", `/admin/tech-tree/nodes/${nodeId}`, {
    baseCost: 77,
    name: `${NATION_MARKER}改名-${runId}`,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.node.baseCost, 77);
  assert.equal(updated.json.node.name, `${NATION_MARKER}改名-${runId}`);

  // 空 body → 400；不存在 → 404。
  assert.equal((await api("PUT", `/admin/tech-tree/nodes/${nodeId}`, {})).status, 400);
  assert.equal(
    (await api("PUT", "/admin/tech-tree/nodes/2000000000", { baseCost: 5 })).status,
    404,
  );

  // 讓測試玩家「已研發」且「研發中」此節點。
  await db
    .insert(playerResearchedTreeNodesTable)
    .values({ nationId, nodeId });
  await db
    .update(playerTechTreeStateTable)
    .set({ activeNodeId: nodeId, costSnapshot: 77, progressPoints: 10 })
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, nationId),
        eq(playerTechTreeStateTable.domain, "social"),
      ),
    );

  // 沒帶 force → 409 帶引用統計。
  const blocked = await api("DELETE", `/admin/tech-tree/nodes/${nodeId}`);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.researchedCount, 1);
  assert.equal(blocked.json.activeCount, 1);

  // force=1 → 刪除；研發紀錄 cascade、進行中研發歸零。
  const forced = await api("DELETE", `/admin/tech-tree/nodes/${nodeId}?force=1`);
  assert.equal(forced.status, 200);
  assert.equal(forced.json.ok, true);

  const nodes = await db
    .select({ id: techTreeNodesTable.id })
    .from(techTreeNodesTable)
    .where(eq(techTreeNodesTable.id, nodeId));
  assert.equal(nodes.length, 0, "節點應被刪除");
  const researched = await db
    .select({ id: playerResearchedTreeNodesTable.id })
    .from(playerResearchedTreeNodesTable)
    .where(eq(playerResearchedTreeNodesTable.nationId, nationId));
  assert.equal(researched.length, 0, "研發紀錄應 cascade 刪除");
  const [state] = await db
    .select()
    .from(playerTechTreeStateTable)
    .where(
      and(
        eq(playerTechTreeStateTable.nationId, nationId),
        eq(playerTechTreeStateTable.domain, "social"),
      ),
    )
    .limit(1);
  assert.ok(state);
  assert.equal(state.activeNodeId, null, "進行中研發應清空");
  assert.equal(state.costSnapshot, null, "成本快照應清空");
  assert.equal(state.progressPoints, 0, "進度應歸零");

  // 刪不存在的節點 → 404。
  assert.equal((await api("DELETE", `/admin/tech-tree/nodes/${nodeId}`)).status, 404);
});
