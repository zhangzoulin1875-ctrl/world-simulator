/**
 * 科技樹下線後的整合契約(真實 DB):
 *  1. GET /tech-tree/overview 回「年代解鎖一覽」:世界時代以內 researched、之後 locked。
 *  2. POST research / POST cancel / PUT allocation 一律 410。
 *  3. 回合研發結算不動 DB:不灌進度、不吃庫存科技點。
 *  4. 內閣選研候選為空陣列(AI 不會被提示有科技可選)。
 *  5. 領域時代與已研發節點讀取層跟隨世界時代。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the tech tree offline tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, worldGameStateTable, playerTechTreeStateTable } =
  await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { runTechTreeResearchTurn } = await import("../lib/techTreeTurn");
const { listTechTreeResearchCandidates } = await import("../lib/techTreeResearch");
const { loadResearchedNodes, getTechTreeDomainEra, loadResearchedNodesByUser } =
  await import("../lib/techTreeData");
const techTreeRouter = (await import("./techTree")).default;

const TAG = "__ttoffline__";
const runId = randomBytes(4).toString("hex");
const userId = `ttoffline-${runId}`;
let nationId = "";
let server: http.Server;
let baseUrl = "";
let token = "";
let originalEra: string | null = null;
let hadWorldRow = false;

async function setWorldEra(era: string) {
  await db.update(worldGameStateTable).set({ currentEra: era } as never).where(eq(worldGameStateTable.id, 1));
}

before(async () => {
  const [row] = await db.select().from(worldGameStateTable).where(eq(worldGameStateTable.id, 1)).limit(1);
  hadWorldRow = !!row;
  if (!row) {
    await db.insert(worldGameStateTable).values({ id: 1, currentEra: "classical", gameDate: "0001-01-01" } as never);
  }
  originalEra = (row as { currentEra?: string } | undefined)?.currentEra ?? null;

  const [n] = await db.insert(playerNationsTable)
    .values({ name: `${TAG}${runId}`, leaderName: TAG, discordUserId: userId, techPoints: 500 } as never)
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;

  token = await createSession({
    discordUserId: userId, username: userId, globalName: null, avatar: null, manageableGuildIds: [],
  });
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", techTreeRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.delete(playerTechTreeStateTable).where(eq(playerTechTreeStateTable.nationId, nationId));
  await db.delete(playerNationsTable).where(sql`${playerNationsTable.name} LIKE ${TAG + "%"}`);
  if (hadWorldRow && originalEra) await setWorldEra(originalEra);
  await pool.end();
});

const headers = () => ({ "content-type": "application/json", cookie: `${SESSION_COOKIE_NAME}=${token}` });

type Overview = {
  techGainPerTurn: number;
  stockTechPoints: number;
  allocation: { social: number; production: number; military: number };
  domains: {
    domain: string;
    eraSlug: string;
    active: unknown;
    ratioPct: number;
    perTurnPoints: number;
    nodes: { name: string; keySlug: string | null; isKey: boolean; status: string; eraSlug: string; lockedReason: string | null }[];
  }[];
};

test("overview:只列關鍵技術,世界時代以內 researched,之後 locked 並註明解鎖年代", async () => {
  await setWorldEra("high_medieval");
  const res = await fetch(`${baseUrl}/api/tech-tree/overview`, { headers: headers() });
  assert.equal(res.status, 200);
  const o = (await res.json()) as Overview;

  assert.equal(o.techGainPerTurn, 0);
  assert.deepEqual(o.allocation, { social: 0, production: 0, military: 0 });
  assert.equal(o.stockTechPoints, 500, "庫存科技點原樣保留(留給日後國策樹)");
  assert.equal(o.domains.length, 3);

  const mil = o.domains.find((d) => d.domain === "military")!;
  assert.equal(mil.eraSlug, "high_medieval");
  assert.equal(mil.active, null);
  assert.equal(mil.ratioPct, 0);
  assert.ok(mil.nodes.every((n) => n.isKey && n.keySlug), "只應列關鍵技術");

  const gunpowder = mil.nodes.find((n) => n.keySlug === "gunpowder")!;
  assert.equal(gunpowder.status, "researched");
  const musketeer = mil.nodes.find((n) => n.keySlug === "musketeer")!;
  assert.equal(musketeer.status, "locked");
  assert.match(musketeer.lockedReason ?? "", /自動解鎖/);
});

test("世界時代前進後,overview 立刻多解鎖(不需任何研發)", async () => {
  await setWorldEra("renaissance");
  const res = await fetch(`${baseUrl}/api/tech-tree/overview`, { headers: headers() });
  const o = (await res.json()) as Overview;
  const mil = o.domains.find((d) => d.domain === "military")!;
  assert.equal(mil.nodes.find((n) => n.keySlug === "musketeer")!.status, "researched");
});

test("research / cancel / allocation 一律 410", async () => {
  const r1 = await fetch(`${baseUrl}/api/tech-tree/research`, {
    method: "POST", headers: headers(), body: JSON.stringify({ nodeId: 1 }),
  });
  assert.equal(r1.status, 410);
  assert.match(((await r1.json()) as { error: string }).error, /下線/);

  const r2 = await fetch(`${baseUrl}/api/tech-tree/cancel`, {
    method: "POST", headers: headers(), body: JSON.stringify({ domain: "military" }),
  });
  assert.equal(r2.status, 410);

  const r3 = await fetch(`${baseUrl}/api/tech-tree/allocation`, {
    method: "PUT", headers: headers(), body: JSON.stringify({ social: 34, production: 33, military: 33 }),
  });
  assert.equal(r3.status, 410);
});

test("未登入仍回 401(閘門沒被下線邏輯繞過)", async () => {
  const res = await fetch(`${baseUrl}/api/tech-tree/overview`);
  assert.equal(res.status, 401);
});

test("回合研發結算:零值摘要、不建狀態列、不吃庫存科技點", async () => {
  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  const summary = await runTechTreeResearchTurn([{ nation: nation!, techGain: 1000 }]);
  assert.deepEqual(summary, {
    nations: 0, pointsApplied: 0, stockConsumed: 0, completed: 0,
    erasAdvanced: 0, npcInitialized: 0, npcResearchStarted: 0, failures: 0,
  });
  const states = await db.select().from(playerTechTreeStateTable).where(eq(playerTechTreeStateTable.nationId, nationId));
  assert.equal(states.length, 0, "不應為此國家建立任何研發狀態列");
  const [after] = await db.select({ p: playerNationsTable.techPoints }).from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  assert.equal(after!.p, 500, "庫存科技點不得被消耗");
});

test("內閣選研候選為空(三領域)", async () => {
  const [nation] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  for (const d of ["social", "production", "military"] as const) {
    assert.deepEqual(await listTechTreeResearchCandidates(nation!, d), []);
  }
});

test("讀取層:領域時代與已研發節點都跟隨世界時代", async () => {
  await setWorldEra("industrial");
  assert.equal(await getTechTreeDomainEra(userId, "military"), "industrial");
  const nodes = await loadResearchedNodes(userId, "production");
  const slugs = nodes.map((n) => n.keySlug);
  assert.ok(slugs.includes("industrialization"));
  assert.ok(!slugs.includes("electrification"), "電氣化是二戰時代,工業革命時尚未解鎖");

  const byUser = await loadResearchedNodesByUser("production");
  assert.ok(byUser.has(userId), "有主玩家應拿到同一份解鎖清單");
  assert.equal(byUser.get(userId)!.length, nodes.length);
});
