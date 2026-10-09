/**
 * 賽季凍結中介層整合測試(需要 DATABASE_URL):用真的 Express + HTTP 驗證。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import type { Server } from "node:http";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set to run the freeze middleware tests");

const express = (await import("express")).default;
const { sql } = await import("drizzle-orm");
const { db, pool } = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runOilRigMigrations } = await import("../lib/oilRigMigrations");
const { _resetFrozenCacheForTest } = await import("../lib/oilRigService");
const { seasonFreeze } = await import("./seasonFreeze");

let server: Server; let base = "";
const call = (method: string, path: string, headers: Record<string, string> = {}) =>
  fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : "{}" });
const setStatus = async (status: string) => {
  await db.execute(sql`UPDATE oil_seasons SET status = ${status}`);
  _resetFrozenCacheForTest();
};

before(async () => {
  await runGameMigrations(); await runOilRigMigrations();
  await db.execute(sql`DELETE FROM oil_scores`); await db.execute(sql`DELETE FROM oil_seasons`);
  await db.execute(sql`INSERT INTO oil_seasons (season_number, status) VALUES (1, 'active')`);
  const app = express();
  app.use(seasonFreeze);
  app.use((_req, res) => { res.json({ reached: true }); });
  await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.close();
  await db.execute(sql`DELETE FROM oil_scores`); await db.execute(sql`DELETE FROM oil_seasons`);
  await pool.end();
});

test("未凍結:玩家寫入照常通過", async () => {
  await setStatus("active");
  assert.equal((await call("POST", "/api/military/armies/disband")).status, 200);
});

test("凍結:玩家寫入(POST/PUT/PATCH/DELETE)一律 423 並帶 SEASON_FROZEN", async () => {
  await setStatus("cooldown");
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    const r = await call(m, "/api/economy/build");
    assert.equal(r.status, 423, m);
    assert.equal(((await r.json()) as { code: string }).code, "SEASON_FROZEN");
  }
});

test("凍結:讀取(GET)放行,玩家看得到榜單與地圖", async () => {
  await setStatus("cooldown");
  for (const p of ["/api/oil-rigs", "/api/map/regions", "/api/player/me"]) assert.equal((await call("GET", p)).status, 200, p);
});

test("凍結:登入流程放行,玩家進得來", async () => {
  await setStatus("cooldown");
  assert.equal((await call("POST", "/api/auth/logout")).status, 200);
});

test("凍結:管理員 Bearer 放行(才能手動重置),但沒帶 Bearer 的 admin 路徑仍被擋", async () => {
  await setStatus("cooldown");
  assert.equal((await call("POST", "/api/admin/oil-rigs/reset", { authorization: "Bearer x" })).status, 200);
  assert.equal((await call("POST", "/api/admin/oil-rigs/reset")).status, 423);
});

test("凍結:非 admin 路徑即使帶 Bearer 也不能繞過", async () => {
  await setStatus("cooldown");
  assert.equal((await call("POST", "/api/economy/build", { authorization: "Bearer x" })).status, 423);
});

test("路徑帶查詢字串與結尾斜線也不能繞過", async () => {
  await setStatus("cooldown");
  assert.equal((await call("POST", "/api/economy/build/?a=1")).status, 423);
  assert.equal((await call("POST", "/api/authx/steal")).status, 423, "/api/authx 不是 /api/auth/ 前綴");
});

test("解凍後立刻恢復", async () => {
  await setStatus("cooldown");
  assert.equal((await call("POST", "/api/economy/build")).status, 423);
  await setStatus("active");
  assert.equal((await call("POST", "/api/economy/build")).status, 200);
});
