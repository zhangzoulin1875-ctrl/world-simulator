/**
 * 黑市每回合結算整合測試:NPC 做市扮演穩定器,價格向基準價回歸,
 * 且絕不動到玩家國家。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");

const { db, pool, playerNationsTable, nationGoodsTable, worldGameStateTable } = await import("@workspace/db");
const { runGameMigrations } = await import("../gameMigrations");
const { runPoliticsMigrations } = await import("../politicsMigrations");
const { runEconomyMigrations } = await import("../economyMigrations");
const { runWorldSimMigrations } = await import("../worldSimMigrations");
const { runTradeMigrationsInner } = await import("../tradeMigrations");
const { GOODS } = await import("./goods");
const { executeTrade, NPC_TARGET_STOCK, NPC_MAX_PER_TURN, revertMid } = await import("./market");
const { MARKET_GOODS, readMids } = await import("./marketData");
const { runMarketTurn, MAX_NPC_MARKET_MAKERS } = await import("./marketTurn");
const { readGoods } = await import("./goodsLedger");

const TAG = "__mturn_test__";
const runId = randomBytes(4).toString("hex");
let seq = 0;

async function mk(opts: { npc: boolean; money?: number; wood?: number; ore?: number }): Promise<string> {
  const k = seq++;
  const [n] = await db.insert(playerNationsTable).values({
    name: `${TAG}${runId}_${k}`, leaderName: TAG, government: "君主制",
    discordUserId: `${TAG}${runId}_${k}`, isNpc: opts.npc,
    money: opts.money ?? 1_000_000, wood: opts.wood ?? 0, ore: opts.ore ?? 0,
  }).returning({ id: playerNationsTable.id });
  assert.ok(n); return n.id;
}
async function nat(id: string) {
  const [n] = await db.select({ money: playerNationsTable.money, wood: playerNationsTable.wood, ore: playerNationsTable.ore })
    .from(playerNationsTable).where(eq(playerNationsTable.id, id));
  assert.ok(n); return n;
}
async function setMid(good: string, mid: number | null) {
  await db.execute(sql`DELETE FROM market_prices WHERE good = ${good}`);
  if (mid !== null) await db.execute(sql`INSERT INTO market_prices (good, mid) VALUES (${good}, ${mid})`);
}
/**
 * 重設價格,並清掉本檔先前測試建立的所有國家。NPC 做市會把資料庫裡「所有」NPC
 * 都納入,所以前一個測試留下的 NPC 會污染下一個測試(實測:單獨跑過、整檔跑
 * 時 npcTrades 變 15)。每個測試以 resetPrices() 開頭 = 從乾淨狀態開始。
 */
async function resetPrices() {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}${runId}%`));
  for (const g of MARKET_GOODS) await setMid(g, null);
}
async function setGoods(id: string, good: string, stock: number) {
  await db.insert(nationGoodsTable).values({ nationId: id, good, stock });
}
/** 測試期間讓「別的」NPC 不干擾:把資料庫裡不屬於本測試的 NPC 暫時標成非 NPC。 */
let foreignNpcIds: string[] = [];
async function sidelineForeignNpcs() {
  const r = await db.execute(sql`SELECT id FROM player_nations WHERE is_npc = true AND name NOT LIKE ${TAG + "%"}`);
  foreignNpcIds = (r.rows as { id: string }[]).map((x) => x.id);
  if (foreignNpcIds.length) await db.execute(sql`UPDATE player_nations SET is_npc = false WHERE id IN (${sql.join(foreignNpcIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
}
async function restoreForeignNpcs() {
  if (foreignNpcIds.length) await db.execute(sql`UPDATE player_nations SET is_npc = true WHERE id IN (${sql.join(foreignNpcIds.map((i) => sql`${i}::uuid`), sql`, `)})`);
}
async function cleanup() { await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}${runId}%`)); }

let savedLastTurnAt: Date | null = null;
before(async () => {
  await runGameMigrations(); await runPoliticsMigrations(); await runEconomyMigrations();
  await runWorldSimMigrations(); await runTradeMigrationsInner();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  const [w] = await db.select({ t: worldGameStateTable.lastTurnAt }).from(worldGameStateTable).where(eq(worldGameStateTable.id, 1));
  savedLastTurnAt = w?.t ?? null;
  await sidelineForeignNpcs();
  await resetPrices();
});
after(async () => {
  await cleanup(); await resetPrices(); await restoreForeignNpcs();
  await db.update(worldGameStateTable).set({ lastTurnAt: savedLastTurnAt }).where(eq(worldGameStateTable.id, 1));
  await pool.end();
});

test("沒有 NPC、價格在基準:不交易,價格維持基準價", async () => {
  await resetPrices();
  const s = await runMarketTurn();
  assert.equal(s.npcTrades, 0);
  assert.equal(s.npcFailed, 0);
  const mids = await readMids();
  for (const g of MARKET_GOODS) assert.equal(mids[g], GOODS[g].basePrice);
});

test("價格被玩家推高、NPC 庫存多 → NPC 賣出 60,價格被壓低,NPC 收到錢", async () => {
  await resetPrices();
  const npc = await mk({ npc: true, money: 0 });
  await setGoods(npc, "oil", 1000);
  const high = GOODS.oil.basePrice * 2;
  await setMid("oil", high);
  const s = await runMarketTurn();
  assert.equal(s.npcTrades, 1);
  assert.equal((await readGoods(npc)).oil, 1000 - NPC_MAX_PER_TURN);
  assert.ok((await nat(npc)).money > 0);
  // NPC 賣出壓低,再加回歸 → 一定低於原本的高價。
  assert.ok((await readMids()).oil! < high);
});

test("價格被壓低、NPC 缺貨有錢 → NPC 買進托價", async () => {
  await resetPrices();
  const npc = await mk({ npc: true, money: 1_000_000 });
  const low = GOODS.cloth.basePrice * 0.5;
  await setMid("cloth", low);
  const s = await runMarketTurn();
  assert.ok(s.npcTrades >= 1);
  assert.equal((await readGoods(npc)).cloth, NPC_MAX_PER_TURN);
  assert.ok((await nat(npc)).money < 1_000_000);
  assert.ok((await readMids()).cloth! > low);
});

test("NPC 現金連一筆買單都不夠 → 不買、金錢不為負(一半現金的預算上限由 market.test.ts 的純函式測試驗證)", async () => {
  await resetPrices();
  const need = executeTrade("cloth", GOODS.cloth.basePrice * 0.5, "buy", NPC_MAX_PER_TURN).money;
  const npc = await mk({ npc: true, money: need - 1 });
  await setMid("cloth", GOODS.cloth.basePrice * 0.5);
  await runMarketTurn();
  const n = await nat(npc);
  assert.ok(n.money >= 0);
  assert.equal((await readGoods(npc)).cloth, undefined, "錢不夠就不該買");
});

test("價格在基準附近 → NPC 不出手,只做回歸", async () => {
  await resetPrices();
  const npc = await mk({ npc: true, money: 1_000_000 });
  await setGoods(npc, "spice", 1000);
  await setMid("spice", GOODS.spice.basePrice * 1.05);
  const s = await runMarketTurn();
  assert.equal(s.npcTrades, 0);
  assert.equal((await readGoods(npc)).spice, 1000);
  assert.ok(Math.abs((await readMids()).spice! - revertMid("spice", GOODS.spice.basePrice * 1.05)) < 1e-9);
});

test("NPC 的木材 / 礦石(player_nations 欄位)也參與:木材偏貴且庫存多 → 賣出", async () => {
  await resetPrices();
  const npc = await mk({ npc: true, money: 0, wood: 1000 });
  await setMid("wood", GOODS.wood.basePrice * 2);
  await runMarketTurn();
  assert.equal((await nat(npc)).wood, 1000 - NPC_MAX_PER_TURN);
  assert.ok((await nat(npc)).money > 0);
});

test("玩家國家絕不被 NPC 做市動到(金錢、木材、庫存都不變)", async () => {
  await resetPrices();
  const player = await mk({ npc: false, money: 777, wood: 999 });
  await setGoods(player, "oil", 5000);
  await setMid("oil", GOODS.oil.basePrice * 3);
  await mk({ npc: true, money: 1_000_000 });
  await runMarketTurn();
  const p = await nat(player);
  assert.equal(p.money, 777);
  assert.equal(p.wood, 999);
  assert.equal((await readGoods(player)).oil, 5000);
});

test("糧食不參與:NPC 有大量糧食也不會被賣", async () => {
  await resetPrices();
  const npc = await mk({ npc: true, money: 1_000_000 });
  await setGoods(npc, "food", 9999);
  await runMarketTurn();
  assert.equal((await readGoods(npc)).food, 9999);
});

test("回歸方向:偏高往下、偏低往上,且 NPC 成交以 actor=npc 記錄、不佔玩家額度", async () => {
  await resetPrices();
  await setMid("rare", GOODS.rare.basePrice * 2.5);
  await setMid("ore", GOODS.ore.basePrice * 0.5);
  await runMarketTurn();
  const m = await readMids();
  assert.ok(m.rare! < GOODS.rare.basePrice * 2.5 && m.rare! > GOODS.rare.basePrice);
  assert.ok(m.ore! > GOODS.ore.basePrice * 0.5 && m.ore! < GOODS.ore.basePrice);

  const npc = await mk({ npc: true, money: 0 });
  await setGoods(npc, "oil", 1000);
  await setMid("oil", GOODS.oil.basePrice * 2);
  await runMarketTurn();
  const r = await db.execute(sql`SELECT actor, COUNT(*)::int c FROM market_trades WHERE nation_id = ${npc}::uuid GROUP BY actor`);
  assert.deepEqual((r.rows as { actor: string; c: number }[]).map((x) => x.actor), ["npc"]);
});

test("多個 NPC:依序做市,價格被前一個 NPC 推動後,後一個看到的是更新後的價格", async () => {
  await resetPrices();
  const a = await mk({ npc: true, money: 0 });
  const b = await mk({ npc: true, money: 0 });
  await setGoods(a, "ironcoal", 1000);
  await setGoods(b, "ironcoal", 1000);
  await setMid("ironcoal", GOODS.ironcoal.basePrice * 1.12); // 剛好略高於觸發線
  await runMarketTurn();
  const sold = (1000 - (await readGoods(a)).ironcoal!) + (1000 - (await readGoods(b)).ironcoal!);
  // 第一個 NPC 賣 60 會把價格壓到觸發線以下,第二個就不該再賣 —— 總賣量不超過 120,且至少有一個賣了。
  assert.ok(sold >= NPC_MAX_PER_TURN && sold <= NPC_MAX_PER_TURN * 2);
});

test("NPC 數量上限:超過上限的 NPC 不參與(避免一回合打爆資料庫)", async () => {
  await resetPrices();
  const ids: string[] = [];
  for (let i = 0; i < MAX_NPC_MARKET_MAKERS + 3; i++) ids.push(await mk({ npc: true, money: 0 }));
  for (const id of ids) await setGoods(id, "oil", 1000);
  await setMid("oil", GOODS.oil.basePrice * 3);
  await runMarketTurn();
  let touched = 0;
  for (const id of ids) if ((await readGoods(id)).oil !== 1000) touched++;
  assert.ok(touched <= MAX_NPC_MARKET_MAKERS, `最多 ${MAX_NPC_MARKET_MAKERS} 個 NPC 參與,實得 ${touched}`);
  assert.ok(touched >= 1);
});

test("同一批 NPC 每回合順序固定(ORDER BY id):重跑結果可重現", async () => {
  await resetPrices();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push(await mk({ npc: true, money: 0 }));
  for (const id of ids) await setGoods(id, "oil", 1000);
  await setMid("oil", GOODS.oil.basePrice * 1.12);
  await runMarketTurn();
  const sold = new Map<string, number>();
  for (const id of ids) sold.set(id, 1000 - (await readGoods(id)).oil!);
  // 賣的應該是排序最前面的那幾個,而不是隨機的。
  const sorted = [...ids].sort();
  const sellers = sorted.filter((id) => sold.get(id)! > 0);
  assert.deepEqual(sellers, sorted.slice(0, sellers.length), "賣出的必須是 id 排序最前面的 NPC");
});

test("時代鎖:古代 NPC 不碰石油(即使價格高、庫存多);工業時代才會賣", async () => {
  await resetPrices();
  const npc = await mk({ npc: true, money: 0 });
  await setGoods(npc, "oil", 1000);
  await setMid("oil", GOODS.oil.basePrice * 2);
  const s1 = await runMarketTurn("ancient");
  assert.equal(s1.npcTrades, 0);
  assert.equal((await readGoods(npc)).oil, 1000);
  await setMid("oil", GOODS.oil.basePrice * 2);
  const s2 = await runMarketTurn("industrial");
  assert.equal(s2.npcTrades, 1);
  assert.equal((await readGoods(npc)).oil, 1000 - NPC_MAX_PER_TURN);
});
