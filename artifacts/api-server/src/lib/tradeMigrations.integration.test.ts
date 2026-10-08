import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { db, pool, playerNationsTable, nationGoodsTable } from "@workspace/db";
import { runGameMigrations } from "./gameMigrations";
import { runTradeMigrationsInner } from "./tradeMigrations";

/** 貿易系統 nation_goods 表:冪等、約束、級聯刪除。 */
const TAG = "__trade_mig__";
const runId = randomBytes(4).toString("hex");
let nationId = "";


/** drizzle 把 pg 錯誤包在 cause 裡,頂層只有 "Failed query"。比對 cause 的 code/訊息。 */
async function rejectsWithPg(fn: () => Promise<unknown>, code: string, msg?: string) {
  try {
    await fn();
  } catch (e: any) {
    const cause = e?.cause ?? e;
    assert.equal(cause?.code, code, `期望 pg 錯誤碼 ${code},實際 ${cause?.code}:${cause?.message}`);
    return;
  }
  assert.fail(`${msg ?? "應該被拒絕"},但成功了`);
}

async function cleanup() {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
}

before(async () => {
  await runGameMigrations();
  await runTradeMigrationsInner();
  await cleanup();
  const [n] = await db.insert(playerNationsTable).values({
    name: `${TAG}${runId}`, leaderName: TAG, government: "君主制", discordUserId: `${TAG}u_${runId}`,
  }).returning({ id: playerNationsTable.id });
  nationId = n!.id;
});
after(async () => { await cleanup(); await pool.end(); });

test("遷移冪等:連跑多次不報錯、不重複建表", async () => {
  await runTradeMigrationsInner();
  await runTradeMigrationsInner();
  const r = await pool.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'nation_goods'",
  );
  assert.equal(r.rows[0].n, 1);
});

test("可寫入並讀回糧食庫存", async () => {
  await db.insert(nationGoodsTable).values({ nationId, good: "food", stock: 6000 });
  const [row] = await db.select().from(nationGoodsTable)
    .where(and(eq(nationGoodsTable.nationId, nationId), eq(nationGoodsTable.good, "food")));
  assert.equal(Number(row!.stock), 6000);
});

test("同國同貨物不能重複(複合主鍵)", async () => {
  await rejectsWithPg(
    () => db.insert(nationGoodsTable).values({ nationId, good: "food", stock: 1 }),
    "23505",
    "重複的 (nation, good) 應被拒絕",
  );
});

test("拒絕負庫存(CHECK stock >= 0)", async () => {
  await rejectsWithPg(
    () => db.insert(nationGoodsTable).values({ nationId, good: "oil", stock: -1 }),
    "23514",
    "負庫存應被拒絕",
  );
});

test("拒絕未知貨物,且木材/礦石不得進本表(沿用 player_nations 欄位,避免雙帳)", async () => {
  for (const bad of ["gold", "wood", "ore", ""]) {
    await rejectsWithPg(
      () => db.insert(nationGoodsTable).values({ nationId, good: bad, stock: 1 }),
      "23514",
      `應拒絕 ${JSON.stringify(bad)}`,
    );
  }
});

test("六種表內貨物都能寫入", async () => {
  for (const good of ["ironcoal", "oil", "rare", "spice", "cloth"]) {
    await db.insert(nationGoodsTable).values({ nationId, good, stock: 10 });
  }
  const rows = await db.select().from(nationGoodsTable).where(eq(nationGoodsTable.nationId, nationId));
  assert.equal(rows.length, 6);
});

test("刪除國家會連帶刪除其庫存(ON DELETE CASCADE)", async () => {
  await db.delete(playerNationsTable).where(eq(playerNationsTable.id, nationId));
  const rows = await db.select().from(nationGoodsTable).where(eq(nationGoodsTable.nationId, nationId));
  assert.equal(rows.length, 0);
});
