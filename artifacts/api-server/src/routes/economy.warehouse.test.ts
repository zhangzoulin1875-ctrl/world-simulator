/**
 * 貿易系統階段 2 — 倉庫路由整合測試(GET /api/economy/warehouse)。
 *
 * 倉庫頁最重要的承諾:畫面上的「每回合 +N」必須等於回合引擎實際入帳的量。
 * 所以核心測試是:先走真正的 Express 路由取得每回合預測 → 強制回合 →
 * 再走路由,斷言各貨物庫存的增量 = 預測值(與 1-C 糧食頁同一原則)。
 * 沿用 specialtyProductionTurn 的鐵則:advisory lock、快照還原世界時鐘、AI 拋錯。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the warehouse route tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const {
  db, pool, playerNationsTable, playerNotificationsTable,
  regionControlsTable, mapRegionsTable, nationGoodsTable, worldGameStateTable,
} = await import("@workspace/db");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runPoliticsMigrations } = await import("../lib/politicsMigrations");
const { runEconomyMigrations } = await import("../lib/economyMigrations");
const { runWorldSimMigrations } = await import("../lib/worldSimMigrations");
const { runTradeMigrationsInner } = await import("../lib/tradeMigrations");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runMapRegionEraStatsSync } = await import("../lib/mapRegionEraStats");
const { runTurnUpdate } = await import("../lib/turnEngine");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const economyRouter = (await import("./economy")).default;

const TEST_TAG = "__warehouse_route_test__";
const runId = randomBytes(4).toString("hex");
const FORCED_TURN_LOCK_KEY = 9_999_999_901;
const TOP = "南非德蘭"; // 礦★ 鐵煤★ 稀★
const OIL = "利雅德"; // 油★
const SIDE = "蘇格蘭高地"; // 礦(次產)

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(anthropic.messages);

let server: http.Server;
let baseUrl: string;
let nationId: string;
let sessionToken: string;
const discordUserId = `${TEST_TAG}${runId}`;
const regionIds: Record<string, number> = {};

interface Src { regionName: string; percent: number; perTurn: number; major: boolean }
interface WGood { slug: string; label: string; tier: string; stock: number; perTurn: number; unlocked: boolean; unlockEra: string | null; sources: Src[] }
interface WResp { statsEra: string; baseOutput: number; goods: WGood[] }

async function fetchWarehouse(withCookie = true): Promise<{ status: number; json: WResp }> {
  const res = await fetch(`${baseUrl}/api/economy/warehouse`, {
    headers: withCookie ? { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } : {},
  });
  return { status: res.status, json: (await res.json()) as WResp };
}
const byslug = (r: WResp) => Object.fromEntries(r.goods.map((g) => [g.slug, g]));

async function cleanup() {
  await db.delete(playerNotificationsTable).where(like(playerNotificationsTable.discordUserId, `${TEST_TAG}${runId}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TEST_TAG}${runId}%`));
}
async function purgeStale() {
  await db.delete(playerNotificationsTable).where(and(like(playerNotificationsTable.discordUserId, `${TEST_TAG}%`), sql`${playerNotificationsTable.createdAt} < NOW() - INTERVAL '30 minutes'`));
  await db.delete(playerNationsTable).where(and(like(playerNationsTable.name, `${TEST_TAG}%`), sql`${playerNationsTable.createdAt} < NOW() - INTERVAL '30 minutes'`));
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [FORCED_TURN_LOCK_KEY]);
    try { return await fn(); } finally { await c.query("SELECT pg_advisory_unlock($1)", [FORCED_TURN_LOCK_KEY]); }
  } finally { c.release(); }
}

async function snapshotWorld() {
  const [w] = await db.select({
    currentEra: worldGameStateTable.currentEra, statsEra: worldGameStateTable.statsEra,
    gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
    lastTurnDate: worldGameStateTable.lastTurnDate, lastTurnAt: worldGameStateTable.lastTurnAt,
    yearsPerTurn: worldGameStateTable.yearsPerTurn, populationGrowthMultiplierPct: worldGameStateTable.populationGrowthMultiplierPct,
  }).from(worldGameStateTable).where(eq(worldGameStateTable.id, 1)).limit(1);
  assert.ok(w); return w;
}
async function restoreWorld(w: Awaited<ReturnType<typeof snapshotWorld>>) {
  await db.update(worldGameStateTable).set({
    currentEra: w.currentEra, statsEra: w.statsEra, gameDate: w.gameDate, lastTurnDate: w.lastTurnDate,
    lastTurnAt: w.lastTurnAt, yearsPerTurn: w.yearsPerTurn, populationGrowthMultiplierPct: w.populationGrowthMultiplierPct,
  }).where(eq(worldGameStateTable.id, 1));
}
async function pinWorld(era: string, gameDate: string) {
  await db.update(worldGameStateTable).set({ currentEra: era, statsEra: era, gameDate, yearsPerTurn: 1, populationGrowthMultiplierPct: 0 }).where(eq(worldGameStateTable.id, 1));
}

/** 釘住世界後執行 fn(路由與回合都在同一個時代口徑下),結束還原。 */
async function inWorld<T>(era: string, gameDate: string, fn: () => Promise<T>): Promise<T> {
  const snap = await snapshotWorld();
  try { await pinWorld(era, gameDate); return await fn(); } finally { await restoreWorld(snap); }
}
async function forceTurn() {
  anthropic.messages.create = (async () => { throw new Error("模擬 AI 失敗"); }) as unknown as MessagesCreate;
  try {
    const s = await runTurnUpdate(new Date(), { force: true });
    assert.equal(s.ran, true, "強制回合應完成");
  } finally { anthropic.messages.create = realMessagesCreate; }
}
async function setControl(name: string, percent: number) {
  const regionId = regionIds[name]!;
  await db.delete(regionControlsTable).where(and(eq(regionControlsTable.regionId, regionId), eq(regionControlsTable.nationId, nationId)));
  if (percent > 0) await db.insert(regionControlsTable).values({ regionId, nationId, percent });
}
async function resetStock(wood = 0, ore = 0) {
  await db.delete(nationGoodsTable).where(eq(nationGoodsTable.nationId, nationId));
  await db.update(playerNationsTable).set({ wood, ore }).where(eq(playerNationsTable.id, nationId));
}

before(async () => {
  await runGameMigrations(); await runPoliticsMigrations(); await runEconomyMigrations();
  await runWorldSimMigrations(); await runTradeMigrationsInner();
  await runMapRegionSync(); await runMapRegionEraStatsSync();
  await purgeStale(); await cleanup();

  const [nation] = await db.insert(playerNationsTable).values({
    name: `${TEST_TAG}${runId}`, leaderName: TEST_TAG, government: "君主制", discordUserId, isNpc: false,
    money: 1_000_000, farmerPopulationPct: 100, stability: 50, unrest: 0,
  }).returning({ id: playerNationsTable.id });
  assert.ok(nation); nationId = nation.id;

  const rows = await db.select({ id: mapRegionsTable.id, name: mapRegionsTable.name }).from(mapRegionsTable).where(inArray(mapRegionsTable.name, [TOP, OIL, SIDE]));
  for (const r of rows) regionIds[r.name] = r.id;
  for (const n of [TOP, OIL, SIDE]) assert.ok(regionIds[n], `地圖應有 ${n}`);
  await db.delete(regionControlsTable).where(inArray(regionControlsTable.regionId, Object.values(regionIds)));

  sessionToken = await createSession({ discordUserId, username: discordUserId, globalName: null, avatar: null, manageableGuildIds: [] });

  const app = express();
  app.use((req, _res, next) => { (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} }; next(); });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", economyRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  anthropic.messages.create = realMessagesCreate;
  await cleanup();
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  await pool.end();
});

test("未登入 → 401", async () => {
  const r = await fetchWarehouse(false);
  assert.equal(r.status, 401);
});

test("結構:7 種貨物、不含糧食、順序穩定、基準量 10", async () => {
  await withLock(async () => {
    await resetStock();
    await setControl(TOP, 0); await setControl(OIL, 0); await setControl(SIDE, 0);
    await inWorld("industrial", "1800-01-01", async () => {
      const r = await fetchWarehouse();
      assert.equal(r.status, 200);
      assert.equal(r.json.statsEra, "industrial");
      assert.equal(r.json.baseOutput, 10);
      assert.deepEqual(r.json.goods.map((g) => g.slug), ["wood", "ore", "ironcoal", "oil", "rare", "spice", "cloth"]);
      assert.ok(r.json.goods.every((g) => g.perTurn === 0 && g.sources.length === 0));
    });
  });
});

test("庫存:木材礦石讀 player_nations,其餘讀 nation_goods", async () => {
  await withLock(async () => {
    await resetStock(11, 22);
    await db.insert(nationGoodsTable).values([
      { nationId, good: "oil", stock: 33 },
      { nationId, good: "cloth", stock: 44 },
    ]);
    await setControl(TOP, 0); await setControl(OIL, 0); await setControl(SIDE, 0);
    await inWorld("industrial", "1800-01-01", async () => {
      const g = byslug((await fetchWarehouse()).json);
      assert.equal(g.wood!.stock, 11);
      assert.equal(g.ore!.stock, 22);
      assert.equal(g.oil!.stock, 33);
      assert.equal(g.cloth!.stock, 44);
      assert.equal(g.rare!.stock, 0);
    });
  });
});

test("來源明細:地區、比例、主產標示、由大到小", async () => {
  await withLock(async () => {
    await resetStock();
    await setControl(OIL, 0); await setControl(TOP, 100); await setControl(SIDE, 50);
    await inWorld("industrial", "1800-01-01", async () => {
      const ore = byslug((await fetchWarehouse()).json).ore!;
      assert.equal(ore.perTurn, 35, "礦石:南非德蘭 30 + 蘇格蘭高地 50% 次產 5");
      assert.deepEqual(ore.sources, [
        { regionName: TOP, percent: 100, perTurn: 30, major: true },
        { regionName: SIDE, percent: 50, perTurn: 5, major: false },
      ]);
    });
  });
});

test("時代解鎖:古典時代石油 unlocked=false、perTurn=0、無來源,仍列在清單", async () => {
  await withLock(async () => {
    await resetStock();
    await setControl(TOP, 0); await setControl(SIDE, 0); await setControl(OIL, 100);
    await inWorld("classical", "0100-01-01", async () => {
      const oil = byslug((await fetchWarehouse()).json).oil!;
      assert.equal(oil.unlocked, false);
      assert.equal(oil.unlockEra, "industrial");
      assert.equal(oil.perTurn, 0);
      assert.deepEqual(oil.sources, []);
    });
  });
});

test("核心承諾:路由顯示的每回合產量 = 強制回合後各貨物庫存的實際增量", async () => {
  await withLock(async () => {
    await resetStock(5, 7);
    await setControl(SIDE, 100);
    await setControl(OIL, 100);
    await setControl(TOP, 100);
    await inWorld("industrial", "1800-01-01", async () => {
      const before = (await fetchWarehouse()).json;
      const predicted = byslug(before);
      assert.ok(predicted.ore!.perTurn > 0 && predicted.oil!.perTurn > 0 && predicted.ironcoal!.perTurn > 0, "前置:應有多種貨物產量");

      await forceTurn();

      const after = byslug((await fetchWarehouse()).json);
      for (const slug of ["wood", "ore", "ironcoal", "oil", "rare", "spice", "cloth"]) {
        assert.equal(
          after[slug]!.stock - predicted[slug]!.stock,
          predicted[slug]!.perTurn,
          `${slug}:畫面預測 +${predicted[slug]!.perTurn} 應等於實際入帳增量`,
        );
      }
    });
  });
});
