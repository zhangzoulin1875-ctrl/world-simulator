/**
 * 黑市路由整合測試(GET /api/economy/market、POST .../preview、POST .../trade)。
 *
 * 重點是安全與帳目:
 *  - 未登入一律 401;
 *  - 身分只認登入 session,body 帶別國 id 也無效(玩家不能替別國交易);
 *  - 型別攻擊(字串 / 小數 / NaN / 負數 / 超大)全被擋且不動帳;
 *  - 時代鎖:古代看不到也買不到石油;
 *  - 預覽與實際成交的金額一致;
 *  - 查詢頁絕不寫入(重複刷新不改變任何東西)。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { db, pool, playerNationsTable, worldGameStateTable } = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runPoliticsMigrations } = await import("../lib/politicsMigrations");
const { runEconomyMigrations } = await import("../lib/economyMigrations");
const { runWorldSimMigrations } = await import("../lib/worldSimMigrations");
const { runTradeMigrationsInner } = await import("../lib/tradeMigrations");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runMapRegionEraStatsSync } = await import("../lib/mapRegionEraStats");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { readGoods } = await import("../lib/trade/goodsLedger");
const { MARKET_GOODS } = await import("../lib/trade/marketData");
const { PER_TRADE_CAP, PLAYER_TURN_CAP } = await import("../lib/trade/market");
const economyRouter = (await import("./economy")).default;

const TAG = "__market_route_test__";
const runId = randomBytes(4).toString("hex");

let server: http.Server;
let baseUrl: string;
let nationA: string;
let nationB: string;
let tokenA: string;
let tokenB: string;
let savedLastTurnAt: Date | null = null;

type J = Record<string, unknown>;
async function call(method: "GET" | "POST", path: string, token: string | null, body?: unknown): Promise<{ status: number; json: J }> {
  const res = await fetch(`${baseUrl}/api/economy/${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json()) as J };
}
const trade = (token: string | null, body: unknown) => call("POST", "market/trade", token, body);
const preview = (token: string | null, body: unknown) => call("POST", "market/preview", token, body);
const overview = (token: string | null) => call("GET", "market", token);

async function nat(id: string) {
  const [n] = await db.select({ money: playerNationsTable.money, wood: playerNationsTable.wood }).from(playerNationsTable).where(eq(playerNationsTable.id, id));
  assert.ok(n); return n;
}
async function tradeRows() {
  const r = await db.execute(sql`SELECT COUNT(*)::int c FROM market_trades t JOIN player_nations n ON n.id = t.nation_id WHERE n.name LIKE ${TAG + runId + "%"}`);
  return (r.rows[0] as { c: number }).c;
}
async function resetMarket() {
  await db.execute(sql`DELETE FROM market_prices`);
  await db.execute(sql`DELETE FROM market_trades WHERE nation_id IN (${sql.join([nationA, nationB].map((i) => sql`${i}::uuid`), sql`, `)})`);
  await db.update(playerNationsTable).set({ money: 1_000_000, wood: 100, ore: 100 }).where(like(playerNationsTable.name, `${TAG}${runId}%`));
}
/** 釘住世界時代(路由與資料層都讀 statsEra),結束還原。 */
async function inEra<T>(era: string, fn: () => Promise<T>): Promise<T> {
  const [w] = await db.select({ currentEra: worldGameStateTable.currentEra, statsEra: worldGameStateTable.statsEra }).from(worldGameStateTable).where(eq(worldGameStateTable.id, 1));
  assert.ok(w);
  try {
    await db.update(worldGameStateTable).set({ currentEra: era, statsEra: era }).where(eq(worldGameStateTable.id, 1));
    return await fn();
  } finally {
    await db.update(worldGameStateTable).set({ currentEra: w.currentEra, statsEra: w.statsEra }).where(eq(worldGameStateTable.id, 1));
  }
}

before(async () => {
  await runGameMigrations(); await runPoliticsMigrations(); await runEconomyMigrations();
  await runWorldSimMigrations(); await runTradeMigrationsInner();
  await runMapRegionSync(); await runMapRegionEraStatsSync();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  const mk = async (suffix: string) => {
    const du = `${TAG}${runId}_${suffix}`;
    const [n] = await db.insert(playerNationsTable).values({
      name: du, leaderName: TAG, government: "君主制", discordUserId: du, isNpc: false, money: 1_000_000, wood: 100, ore: 100,
    }).returning({ id: playerNationsTable.id });
    assert.ok(n);
    const token = await createSession({ discordUserId: du, username: du, globalName: null, avatar: null, manageableGuildIds: [] });
    return { id: n.id, token };
  };
  const a = await mk("a"); const b = await mk("b");
  nationA = a.id; tokenA = a.token; nationB = b.id; tokenB = b.token;

  const [w] = await db.select({ t: worldGameStateTable.lastTurnAt }).from(worldGameStateTable).where(eq(worldGameStateTable.id, 1));
  savedLastTurnAt = w?.t ?? null;
  await db.update(worldGameStateTable).set({ lastTurnAt: new Date("2000-01-01") }).where(eq(worldGameStateTable.id, 1));

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
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}${runId}%`));
  await db.execute(sql`DELETE FROM market_prices`);
  await db.update(worldGameStateTable).set({ lastTurnAt: savedLastTurnAt }).where(eq(worldGameStateTable.id, 1));
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  await pool.end();
});

test("未登入:三個端點都回 401", async () => {
  assert.equal((await overview(null)).status, 401);
  assert.equal((await preview(null, { good: "wood", side: "buy", qty: 1 })).status, 401);
  assert.equal((await trade(null, { good: "wood", side: "buy", qty: 1 })).status, 401);
});

test("總覽:工業時代 7 種貨物;古代只有 5 種(無石油 / 稀有金屬);都不含糧食", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    const r = await overview(tokenA);
    assert.equal(r.status, 200);
    const goods = r.json.goods as { good: string }[];
    assert.deepEqual(goods.map((g) => g.good), [...MARKET_GOODS]);
    assert.ok(!goods.some((g) => g.good === "food"));
    assert.equal(r.json.fee, 0.3);
    assert.equal(r.json.perTradeCap, PER_TRADE_CAP);
    assert.equal(r.json.turnCap, PLAYER_TURN_CAP);
  });
  await inEra("ancient", async () => {
    const goods = (await overview(tokenA)).json.goods as { good: string }[];
    assert.deepEqual(goods.map((g) => g.good), ["wood", "ore", "ironcoal", "spice", "cloth"]);
  });
});

test("總覽:報價 = 中間價 ×(1±30%);持有量木材 / 礦石取自國家欄位;額度初始為 300", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    const r = await overview(tokenA);
    const wood = (r.json.goods as J[]).find((g) => g.good === "wood")!;
    assert.ok(Math.abs((wood.buyPrice as number) - (wood.mid as number) * 1.3) < 1e-9);
    assert.ok(Math.abs((wood.sellPrice as number) - (wood.mid as number) * 0.7) < 1e-9);
    assert.equal(wood.owned, 100);
    assert.equal(wood.buyLeft, 300);
    assert.equal(wood.sellLeft, 300);
    assert.equal(r.json.money, 1_000_000);
  });
});

test("總覽是純讀取:連刷 5 次,金錢 / 庫存 / 紀錄 / 價格列都不變", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    const before = { n: await nat(nationA), rows: await tradeRows(), g: await readGoods(nationA) };
    for (let i = 0; i < 5; i++) await overview(tokenA);
    assert.deepEqual(await nat(nationA), before.n);
    assert.equal(await tradeRows(), before.rows);
    assert.deepEqual(await readGoods(nationA), before.g);
    const pr = await db.execute(sql`SELECT COUNT(*)::int c FROM market_prices`);
    assert.equal((pr.rows[0] as { c: number }).c, 0, "只看報價不該建立價格列");
  });
});

test("買進:扣錢加貨、總覽反映新持有量與剩餘額度、價格上升", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    const t = await trade(tokenA, { good: "oil", side: "buy", qty: 50 });
    assert.equal(t.status, 200);
    assert.equal(t.json.ok, true);
    assert.equal((await nat(nationA)).money, 1_000_000 - (t.json.money as number));
    assert.equal((await readGoods(nationA)).oil, 50);
    const oil = ((await overview(tokenA)).json.goods as J[]).find((g) => g.good === "oil")!;
    assert.equal(oil.owned, 50);
    assert.equal(oil.buyLeft, 250);
    assert.equal(oil.sellLeft, 300);
    assert.ok((oil.mid as number) > (oil.basePrice as number));
  });
});

test("賣出:加錢扣貨(木材走國家欄位)", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    const t = await trade(tokenA, { good: "wood", side: "sell", qty: 40 });
    assert.equal(t.status, 200);
    const n = await nat(nationA);
    assert.equal(n.wood, 60);
    assert.equal(n.money, 1_000_000 + (t.json.money as number));
  });
});

test("預覽與實際成交金額一致,且預覽不動帳", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    const before = await nat(nationA);
    const p = await preview(tokenA, { good: "cloth", side: "buy", qty: 77 });
    assert.equal(p.status, 200);
    assert.deepEqual(await nat(nationA), before);
    assert.equal(await tradeRows(), 0);
    const t = await trade(tokenA, { good: "cloth", side: "buy", qty: 77 });
    assert.equal(t.json.money, p.json.money);
    assert.equal(t.json.fee, p.json.fee);
    assert.equal(t.json.midAfter, p.json.midAfter);
  });
});

test("預覽的 affordable:買不起 = false,賣出永遠 true", async () => {
  await resetMarket();
  await db.update(playerNationsTable).set({ money: 5 }).where(eq(playerNationsTable.id, nationA));
  await inEra("industrial", async () => {
    assert.equal((await preview(tokenA, { good: "oil", side: "buy", qty: 100 })).json.affordable, false);
    assert.equal((await preview(tokenA, { good: "wood", side: "sell", qty: 10 })).json.affordable, true);
  });
});

test("身分隔離:body 帶別國 id 無效,只動自己;B 的帳完全不受影響", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    const bBefore = await nat(nationB);
    const t = await trade(tokenA, { good: "wood", side: "buy", qty: 10, nationId: nationB, nation_id: nationB, discordUserId: "x" });
    assert.equal(t.status, 200);
    assert.deepEqual(await nat(nationB), bBefore);
    assert.equal((await nat(nationA)).wood, 110);
    assert.equal((await tradeRows()), 1);
  });
});

test("型別攻擊:字串 / 小數 / NaN / null / 負數 / 0 / 超過單筆上限 → 400 且完全不動帳", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    const before = await nat(nationA);
    const bad: unknown[] = ["5", 1.5, null, -3, 0, PER_TRADE_CAP + 1, [], {}, true, 1e9];
    for (const qty of bad) {
      const r = await trade(tokenA, { good: "wood", side: "buy", qty });
      assert.equal(r.status, 400, `qty=${JSON.stringify(qty)}`);
    }
    // JSON 沒有 NaN / Infinity,序列化會變 null,同樣被擋。
    assert.equal((await trade(tokenA, { good: "wood", side: "buy", qty: Number.NaN })).status, 400);
    assert.equal((await trade(tokenA, { good: "wood", side: "buy" })).status, 400, "缺 qty");
    assert.deepEqual(await nat(nationA), before);
    assert.equal(await tradeRows(), 0);
  });
});

test("壞貨物與壞方向:food / 不存在 / 原型污染字串 / side 亂填 → 400 且不動帳", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    const before = await nat(nationA);
    for (const good of ["food", "gold", "", "__proto__", "constructor", 5, null, undefined]) {
      const r = await trade(tokenA, { good, side: "buy", qty: 1 });
      assert.equal(r.status, 400, `good=${String(good)}`);
    }
    for (const side of ["BUY", "hold", "", null, 1, undefined]) {
      const r = await trade(tokenA, { good: "wood", side, qty: 1 });
      assert.equal(r.status, 400, `side=${String(side)}`);
    }
    assert.deepEqual(await nat(nationA), before);
    assert.equal(await tradeRows(), 0);
  });
});

test("body 不是物件(空 / 陣列)也不會讓伺服器炸掉:回 400", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    assert.equal((await trade(tokenA, {})).status, 400);
    assert.equal((await trade(tokenA, [])).status, 400);
    assert.equal((await preview(tokenA, {})).status, 400);
  });
});

test("時代鎖:古代買 / 賣 / 預覽石油與稀有金屬都 400 且不動帳;無時代限制的貨物照常", async () => {
  await resetMarket();
  await inEra("ancient", async () => {
    const before = await nat(nationA);
    for (const good of ["oil", "rare"]) {
      for (const fn of [trade, preview]) {
        const r = await fn(tokenA, { good, side: "buy", qty: 5 });
        assert.equal(r.status, 400, `${good}`);
        assert.match(String(r.json.error), /尚未開放/);
      }
    }
    assert.deepEqual(await nat(nationA), before);
    assert.equal((await trade(tokenA, { good: "ironcoal", side: "buy", qty: 5 })).status, 200);
  });
});

test("餘額不足 / 庫存不足 → 400 帶明確訊息與 code,帳不動", async () => {
  await resetMarket();
  await db.update(playerNationsTable).set({ money: 3 }).where(eq(playerNationsTable.id, nationA));
  await inEra("industrial", async () => {
    const a = await trade(tokenA, { good: "rare", side: "buy", qty: 100 });
    assert.equal(a.status, 400);
    assert.equal(a.json.code, "no_money");
    const b = await trade(tokenA, { good: "wood", side: "sell", qty: 101 });
    assert.equal(b.status, 400);
    assert.equal(b.json.code, "no_stock");
    assert.equal((await nat(nationA)).money, 3);
    assert.equal(await tradeRows(), 0);
  });
});

test("回合額度:買滿 300 後再買被拒;總覽顯示剩餘 0;對方國家的額度不受影響", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    assert.equal((await trade(tokenA, { good: "cloth", side: "buy", qty: PER_TRADE_CAP })).status, 200);
    assert.equal((await trade(tokenA, { good: "cloth", side: "buy", qty: 100 })).status, 200);
    const over = await trade(tokenA, { good: "cloth", side: "buy", qty: 1 });
    assert.equal(over.status, 400);
    assert.match(String(over.json.error), /額度已用完/);
    const cloth = ((await overview(tokenA)).json.goods as J[]).find((g) => g.good === "cloth")!;
    assert.equal(cloth.buyLeft, 0);
    const clothB = ((await overview(tokenB)).json.goods as J[]).find((g) => g.good === "cloth")!;
    assert.equal(clothB.buyLeft, 300, "B 的額度是自己的");
    assert.equal((await trade(tokenB, { good: "cloth", side: "buy", qty: 10 })).status, 200);
  });
});

test("兩個玩家買同一貨物:價格共享,後買的人看到被前者推高的價格", async () => {
  await resetMarket();
  await inEra("industrial", async () => {
    const a = await trade(tokenA, { good: "spice", side: "buy", qty: 150 });
    const b = await trade(tokenB, { good: "spice", side: "buy", qty: 150 });
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.ok(Math.abs((b.json.midBefore as number) - (a.json.midAfter as number)) < 1e-9, "B 的起始價 = A 成交後的價");
    assert.ok((b.json.avgPrice as number) > (a.json.avgPrice as number), "B 付得比 A 貴");
  });
});
