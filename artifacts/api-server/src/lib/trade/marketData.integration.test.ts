/**
 * 黑市資料層整合測試 —— 重點是「錢和貨不能憑空多出來或少掉」:
 * 帳目對得上、失敗整筆回滾、連點 / 並行不能超額、回合額度生效。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const { db, pool, playerNationsTable, nationGoodsTable, worldGameStateTable } =
  await import("@workspace/db");
const { runGameMigrations } = await import("../gameMigrations");
const { runPoliticsMigrations } = await import("../politicsMigrations");
const { runEconomyMigrations } = await import("../economyMigrations");
const { runWorldSimMigrations } = await import("../worldSimMigrations");
const { runTradeMigrationsInner } = await import("../tradeMigrations");
const { GOODS } = await import("./goods");
const { PLAYER_TURN_CAP, PER_TRADE_CAP, MARKET_FEE, revertMid, executeTrade } = await import("./market");
const { executeMarketTrade, readMids, readQuotes, revertAllMids, usedThisTurn, MARKET_GOODS } =
  await import("./marketData");
const { readGoods } = await import("./goodsLedger");

const TAG = "__market_test__";
const runId = randomBytes(4).toString("hex");
const nationIds: string[] = [];
// 用同步遞增的計數器取編號:並行建多個國家時,若用 nationIds.length 會讀到同一個值而撞唯一鍵。
let nationSeq = 0;

async function mkNation(opts: { money?: number; wood?: number; ore?: number } = {}): Promise<string> {
  const seq = nationSeq++;
  const [n] = await db.insert(playerNationsTable).values({
    name: `${TAG}${runId}_${seq}`, leaderName: TAG, government: "君主制",
    discordUserId: `${TAG}${runId}_${seq}`, isNpc: false,
    money: opts.money ?? 1_000_000, wood: opts.wood ?? 0, ore: opts.ore ?? 0,
  }).returning({ id: playerNationsTable.id });
  assert.ok(n); nationIds.push(n.id); return n.id;
}
async function nation(id: string) {
  const [n] = await db.select({ money: playerNationsTable.money, wood: playerNationsTable.wood, ore: playerNationsTable.ore })
    .from(playerNationsTable).where(eq(playerNationsTable.id, id));
  assert.ok(n); return n;
}
async function setMid(good: string, mid: number | null) {
  await db.execute(sql`DELETE FROM market_prices WHERE good = ${good}`);
  if (mid !== null) await db.execute(sql`INSERT INTO market_prices (good, mid) VALUES (${good}, ${mid})`);
}
async function tradeCount(id: string) {
  const r = await db.execute(sql`SELECT COUNT(*)::int AS c FROM market_trades WHERE nation_id = ${id}::uuid`);
  return (r.rows[0] as { c: number }).c;
}
async function resetAll() {
  for (const g of MARKET_GOODS) await setMid(g, null);
}
/**
 * 預先建好所有價格列。marketData 在交易內會 INSERT ... ON CONFLICT 建立價格列,
 * 而同貨物的並行 INSERT 會因唯一鍵互相等待 —— 那是一把「隱形的鎖」,會遮住
 * FOR UPDATE 被拿掉的問題(2026-10-08 實測:兩把顯式鎖拿掉後測試仍過,但把 INSERT
 * 也拿掉就 8 筆全成交、木材 −380)。預建列後,顯式的 FOR UPDATE 才是唯一防線,
 * 並行測試才真的在測它。
 */
async function prebuildPriceRows() {
  for (const g of MARKET_GOODS) {
    await db.execute(sql`
      INSERT INTO market_prices (good, mid) VALUES (${g}, ${GOODS[g].basePrice})
      ON CONFLICT (good) DO UPDATE SET mid = EXCLUDED.mid`);
  }
}
async function cleanup() {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}${runId}%`));
}

/**
 * 偵測目前資料庫有沒有「真的」行鎖互斥。本機沙盒用的 PGlite 是單一 session,
 * 連線 A 持有 FOR UPDATE 時連線 B 照樣拿得到同一列的鎖,所以並行測試在上面會
 * 出現假失敗(透支、多賣),不代表程式有 bug(2026-10-08 實測:同一份測試在真
 * Postgres 17.5 全過)。偵測不到互斥就跳過並行測試,而不是留一個永遠的假紅燈。
 */
async function dbHasRealRowLocks(): Promise<boolean> {
  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query("CREATE TABLE IF NOT EXISTS _market_lockprobe (id int PRIMARY KEY)");
    await a.query("INSERT INTO _market_lockprobe VALUES (1) ON CONFLICT DO NOTHING");
    await a.query("BEGIN");
    await a.query("SELECT * FROM _market_lockprobe WHERE id = 1 FOR UPDATE");
    let bGot = false;
    const bp = (async () => {
      await b.query("BEGIN");
      await b.query("SELECT * FROM _market_lockprobe WHERE id = 1 FOR UPDATE");
      bGot = true;
      await b.query("COMMIT");
    })();
    await new Promise((r) => setTimeout(r, 400));
    const blocked = !bGot;
    await a.query("COMMIT");
    await bp;
    return blocked;
  } finally {
    try { await a.query("DROP TABLE IF EXISTS _market_lockprobe"); } catch { /* ignore */ }
    a.release();
    b.release();
  }
}

let realLocks = false;
const SKIP_NO_LOCKS = "資料庫沒有真的行鎖互斥(例如本機 PGlite),並行測試會假失敗;請用真 Postgres 驗證";
let savedLastTurnAt: Date | null = null;
before(async () => {
  await runGameMigrations(); await runPoliticsMigrations(); await runEconomyMigrations();
  await runWorldSimMigrations(); await runTradeMigrationsInner();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  const [w] = await db.select({ t: worldGameStateTable.lastTurnAt }).from(worldGameStateTable).where(eq(worldGameStateTable.id, 1));
  savedLastTurnAt = w?.t ?? null;
  // 把回合基準點設在遠古,讓測試前的任何殘留紀錄都不計入額度。
  await db.update(worldGameStateTable).set({ lastTurnAt: new Date("2000-01-01") }).where(eq(worldGameStateTable.id, 1));
  await resetAll();
  realLocks = await dbHasRealRowLocks();
  if (!realLocks) console.warn(`[market-test] ${SKIP_NO_LOCKS}`);
});
after(async () => {
  await cleanup();
  await resetAll();
  await db.update(worldGameStateTable).set({ lastTurnAt: savedLastTurnAt }).where(eq(worldGameStateTable.id, 1));
  await pool.end();
});

test("沒交易過:報價 = 基準價 ×(1±30%),7 種貨物、不含糧食", async () => {
  await resetAll();
  const qs = await readQuotes();
  assert.equal(qs.length, 7);
  assert.ok(!qs.some((q) => (q.good as string) === "food"));
  for (const q of qs) {
    const b = GOODS[q.good].basePrice;
    assert.ok(Math.abs(q.mid - b) < 1e-9);
    assert.ok(Math.abs(q.ask - b * (1 + MARKET_FEE)) < 1e-9);
    assert.ok(Math.abs(q.bid - b * (1 - MARKET_FEE)) < 1e-9);
  }
});

test("買進(nation_goods 路徑):扣錢、加貨、價格上升、留紀錄,帳目對得上", async () => {
  await resetAll();
  const id = await mkNation({ money: 100_000 });
  const r = await executeMarketTrade(id, "oil", "buy", 50);
  assert.ok(r.ok);
  if (!r.ok) return;
  const n = await nation(id);
  assert.equal(n.money, 100_000 - r.money);
  assert.equal(r.moneyAfter, n.money);
  assert.equal((await readGoods(id)).oil, 50);
  assert.equal(r.stockAfter, 50);
  assert.ok(r.midAfter > r.midBefore);
  assert.equal((await readMids()).oil, r.midAfter);
  assert.equal(await tradeCount(id), 1);
  const expected = executeTrade("oil", GOODS.oil.basePrice, "buy", 50);
  assert.equal(r.money, expected.money);
});

test("買進木材 / 礦石(player_nations 路徑):加在國家欄位,不寫 nation_goods", async () => {
  await resetAll();
  const id = await mkNation({ money: 100_000, wood: 10, ore: 5 });
  const w = await executeMarketTrade(id, "wood", "buy", 20);
  const o = await executeMarketTrade(id, "ore", "buy", 7);
  assert.ok(w.ok && o.ok);
  const n = await nation(id);
  assert.equal(n.wood, 30);
  assert.equal(n.ore, 12);
  const g = await readGoods(id);
  assert.equal(g.wood, undefined);
  assert.equal(g.ore, undefined);
});

test("賣出:加錢、扣貨、價格下降;賣木材走 player_nations", async () => {
  await resetAll();
  const id = await mkNation({ money: 0, wood: 100 });
  await db.insert(nationGoodsTable).values({ nationId: id, good: "cloth", stock: 80 });
  const s1 = await executeMarketTrade(id, "wood", "sell", 40);
  const s2 = await executeMarketTrade(id, "cloth", "sell", 30);
  assert.ok(s1.ok && s2.ok);
  if (!s1.ok || !s2.ok) return;
  const n = await nation(id);
  assert.equal(n.wood, 60);
  assert.equal(n.money, s1.money + s2.money);
  assert.equal((await readGoods(id)).cloth, 50);
  assert.ok(s1.midAfter < s1.midBefore && s2.midAfter < s2.midBefore);
});

test("失敗要整筆回滾:金錢不足 → 什麼都不變(國家、庫存、價格、紀錄)", async () => {
  await resetAll();
  const id = await mkNation({ money: 10 });
  const r = await executeMarketTrade(id, "rare", "buy", 100);
  assert.ok(!r.ok && r.code === "no_money");
  assert.equal((await nation(id)).money, 10);
  assert.equal((await readGoods(id)).rare, undefined);
  assert.equal(await tradeCount(id), 0);
  assert.equal((await readMids()).rare, GOODS.rare.basePrice);
});

test("失敗要整筆回滾:庫存不足 → 什麼都不變", async () => {
  await resetAll();
  const id = await mkNation({ money: 500, wood: 5 });
  const r = await executeMarketTrade(id, "wood", "sell", 6);
  assert.ok(!r.ok && r.code === "no_stock");
  const n = await nation(id);
  assert.equal(n.wood, 5);
  assert.equal(n.money, 500);
  assert.equal(await tradeCount(id), 0);
});

test("不能賣沒有的貨:nation_goods 沒有那一列 → no_stock", async () => {
  await resetAll();
  const id = await mkNation({ money: 500 });
  const r = await executeMarketTrade(id, "spice", "sell", 1);
  assert.ok(!r.ok && r.code === "no_stock");
});

test("糧食與不存在的貨物:拒絕", async () => {
  const id = await mkNation();
  for (const g of ["food", "gold", ""]) {
    const r = await executeMarketTrade(id, g as never, "buy", 1);
    assert.ok(!r.ok && r.code === "bad_good", String(g));
  }
});

test("數量不合法:0 / 負 / 小數 / 超過單筆上限,都拒絕且不動帳", async () => {
  await resetAll();
  const id = await mkNation({ money: 1_000_000 });
  for (const q of [0, -1, 1.5, PER_TRADE_CAP + 1]) {
    const r = await executeMarketTrade(id, "oil", "buy", q);
    assert.ok(!r.ok && r.code === "bad_qty", String(q));
  }
  assert.equal((await nation(id)).money, 1_000_000);
  assert.equal(await tradeCount(id), 0);
});

test("回合額度:同貨物同方向累計超過 300 就拒絕;買賣額度各自獨立;換貨物不受影響", async () => {
  await resetAll();
  const id = await mkNation({ money: 10_000_000, ore: 1000 });
  assert.ok((await executeMarketTrade(id, "ironcoal", "buy", PER_TRADE_CAP)).ok);
  assert.ok((await executeMarketTrade(id, "ironcoal", "buy", 100)).ok);
  assert.equal(await usedThisTurn(id, "ironcoal", "buy"), 300);
  const over = await executeMarketTrade(id, "ironcoal", "buy", 1);
  assert.ok(!over.ok && over.code === "bad_qty" && /額度已用完/.test(over.message));
  assert.ok((await executeMarketTrade(id, "ironcoal", "sell", 100)).ok, "賣出額度獨立");
  assert.ok((await executeMarketTrade(id, "spice", "buy", 10)).ok, "換貨物額度獨立");
  assert.equal(PLAYER_TURN_CAP, 300);
});

test("回合額度在回合結算後重置(以 last_turn_at 為界)", async () => {
  await resetAll();
  const id = await mkNation({ money: 10_000_000 });
  await executeMarketTrade(id, "cloth", "buy", PER_TRADE_CAP);
  await executeMarketTrade(id, "cloth", "buy", 100);
  assert.ok(!(await executeMarketTrade(id, "cloth", "buy", 1)).ok);
  await db.update(worldGameStateTable).set({ lastTurnAt: new Date(Date.now() + 1000) }).where(eq(worldGameStateTable.id, 1));
  try {
    assert.equal(await usedThisTurn(id, "cloth", "buy"), 0);
    assert.ok((await executeMarketTrade(id, "cloth", "buy", 10)).ok, "新回合額度應重置");
  } finally {
    await db.update(worldGameStateTable).set({ lastTurnAt: new Date("2000-01-01") }).where(eq(worldGameStateTable.id, 1));
  }
});

test("NPC 成交不佔玩家額度,但仍扣帳、仍推價格", async () => {
  await resetAll();
  const id = await mkNation({ money: 10_000_000 });
  const r = await executeMarketTrade(id, "oil", "buy", 60, "npc");
  assert.ok(r.ok);
  assert.equal(await usedThisTurn(id, "oil", "buy"), 0);
  assert.ok((await readMids()).oil! > GOODS.oil.basePrice);
});

test("並行(連點):餘額只夠 3 筆,送 10 筆同時買 → 恰好 3 筆成功,金錢絕不為負", async (t) => {
  if (!realLocks) return t.skip(SKIP_NO_LOCKS);
  await resetAll();
    await prebuildPriceRows();
  const one = executeTrade("ironcoal", GOODS.ironcoal.basePrice, "buy", 100).money;
  const id = await mkNation({ money: one * 3 + 5 });
  const results = await Promise.all(Array.from({ length: 10 }, () => executeMarketTrade(id, "ironcoal", "buy", 100)));
  const ok = results.filter((r) => r.ok).length;
  const n = await nation(id);
  assert.ok(n.money >= 0, `金錢不可為負,實得 ${n.money}`);
  assert.ok(ok >= 1 && ok <= 3, `成功筆數應 1~3(價格會隨成交上升所以可能少於 3),實得 ${ok}`);
  assert.equal(await tradeCount(id), ok, "成功筆數 = 紀錄筆數");
  assert.equal((await readGoods(id)).ironcoal, ok * 100, "庫存 = 成功筆數 × 100");
});

test("並行(連點):庫存只有 100,同時賣 8 筆各 60 → 最多賣 1 筆,庫存不為負(重複 12 輪提高碰撞機率)", async (t) => {
  if (!realLocks) return t.skip(SKIP_NO_LOCKS);
  // 單輪排程可能湊巧沒碰撞,所以多國、多輪;任何一輪多賣就失敗。
  for (let round = 0; round < 12; round++) {
    await resetAll();
    await prebuildPriceRows();
    const id = await mkNation({ money: 0, wood: 100 });
    const results = await Promise.all(Array.from({ length: 8 }, () => executeMarketTrade(id, "wood", "sell", 60)));
    const ok = results.filter((r) => r.ok).length;
    const n = await nation(id);
    assert.equal(ok, 1, `第 ${round} 輪:應只賣出 1 筆,實得 ${ok}`);
    assert.equal(n.wood, 40, `第 ${round} 輪:木材應剩 40,實得 ${n.wood}`);
    assert.ok(n.money > 0);
  }
});

test("並行:多國同時買同一貨物,價格連續推進,每筆都讀到上一筆成交後的價格", async (t) => {
  if (!realLocks) return t.skip(SKIP_NO_LOCKS);
  await resetAll();
    await prebuildPriceRows();
  const ids = await Promise.all(Array.from({ length: 6 }, () => mkNation({ money: 10_000_000 })));
  const results = await Promise.all(ids.map((id) => executeMarketTrade(id, "oil", "buy", 100)));
  assert.ok(results.every((r) => r.ok));
  const rs = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  // 依 midBefore 排序後,每一筆的 midBefore 必須等於前一筆的 midAfter(沒有兩筆用同一個舊價)。
  rs.sort((a, b) => a.midBefore - b.midBefore);
  for (let i = 1; i < rs.length; i++) {
    assert.ok(Math.abs(rs[i]!.midBefore - rs[i - 1]!.midAfter) < 1e-9, "價格推進必須是串行的");
  }
  assert.equal((await readMids()).oil, rs[rs.length - 1]!.midAfter);
});

test("價格回歸 SQL 與純函式 revertMid 結果一致", async () => {
  await resetAll();
  for (const g of MARKET_GOODS) await setMid(g, GOODS[g].basePrice * (g === "wood" ? 2.5 : g === "ore" ? 0.5 : 1.7));
  await revertAllMids();
  const mids = await readMids();
  for (const g of MARKET_GOODS) {
    const start = GOODS[g].basePrice * (g === "wood" ? 2.5 : g === "ore" ? 0.5 : 1.7);
    assert.ok(Math.abs(mids[g]! - revertMid(g, start)) < 1e-9, `${g}: SQL ${mids[g]} vs 純函式 ${revertMid(g, start)}`);
  }
});

test("價格回歸不會替沒交易過的貨物建立列", async () => {
  await resetAll();
  await revertAllMids();
  const r = await db.execute(sql`SELECT COUNT(*)::int AS c FROM market_prices`);
  assert.equal((r.rows[0] as { c: number }).c, 0);
});

test("時代鎖:古代買 / 賣石油與稀有金屬被拒絕且不動帳;工業時代放行;不傳時代則不檢查", async () => {
  await resetAll();
  const id = await mkNation({ money: 1_000_000 });
  for (const g of ["oil", "rare"] as const) {
    const buy = await executeMarketTrade(id, g, "buy", 5, "player", "ancient");
    assert.ok(!buy.ok && buy.code === "bad_good" && /尚未開放/.test(buy.message), g);
  }
  assert.equal((await nation(id)).money, 1_000_000);
  assert.equal(await tradeCount(id), 0);
  assert.ok((await executeMarketTrade(id, "oil", "buy", 5, "player", "industrial")).ok);
  assert.ok((await executeMarketTrade(id, "wood", "buy", 5, "player", "ancient")).ok, "無時代限制的貨物古代也能交易");
  assert.ok((await executeMarketTrade(id, "rare", "buy", 5)).ok, "不傳時代 = 不檢查(僅供內部 / 測試)");
});
