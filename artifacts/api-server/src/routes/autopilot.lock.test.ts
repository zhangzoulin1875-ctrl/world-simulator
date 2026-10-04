/**
 * AI 全權託管 — 鎖定／API 整合測試（真實 DB、真實 session）。
 *
 * 驗證：
 *  1. 未託管：寫入不被鎖。
 *  2. 啟用託管：GET 顯示 enabled；玩家寫入一律 423 + code=AUTOPILOT_LOCKED；
 *     讀取（GET）不受影響。
 *  3. 放行名單：解除託管、登出、通知已讀在鎖定中仍可呼叫。
 *  4. 託管中重複啟用 → 被鎖定擋下（423）。
 *  5. 解除後：寫入恢復；風格／方針被截斷與正規化（未知風格 → balanced、方針 ≤500 字）。
 *  6. 無 session（管理員 Bearer 等）不受鎖定影響。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the autopilot lock tests");
}

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq, like } = await import("drizzle-orm");
const { db, pool, playerNationsTable, userSessionsTable, autopilotSettingsTable } =
  await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const { runAutopilotMigrations } = await import("../lib/autopilotMigrations");
const { invalidateAutopilotCache } = await import("../lib/autopilotState");
const { autopilotLock } = await import("../middlewares/autopilotLock");
const autopilotRouter = (await import("./autopilot")).default;

const TAG = `autopilot-lock-test-${process.pid}-${randomBytes(3).toString("hex")}`;
const USER = `${TAG}-user`;
let nationId = "";
let token = "";
let server: http.Server;
let baseUrl = "";

async function cleanup(): Promise<void> {
  const rows = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.discordUserId, `${TAG}%`));
  for (const r of rows) {
    await db.delete(autopilotSettingsTable).where(eq(autopilotSettingsTable.nationId, r.id));
  }
  await db.delete(playerNationsTable).where(like(playerNationsTable.discordUserId, `${TAG}%`));
  await db.delete(userSessionsTable).where(like(userSessionsTable.discordUserId, `${TAG}%`));
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie !== false) headers["cookie"] = `${SESSION_COOKIE_NAME}=${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

before(async () => {
  await runAutopilotMigrations();
  await cleanup();
  const [n] = await db
    .insert(playerNationsTable)
    .values({ discordUserId: USER, name: `${TAG}-國` })
    .returning();
  nationId = n!.id;
  token = await createSession({
    discordUserId: USER,
    username: USER,
    globalName: null,
    avatar: null,
    manageableGuildIds: [],
  });

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use(autopilotLock);
  // 代表性的玩家寫入路由（與真實路由同路徑，驗證鎖定與放行名單）。
  for (const [m, p] of [
    ["post", "/api/military/recruit"],
    ["put", "/api/economy/whatever"],
    ["delete", "/api/player/nation"],
    ["post", "/api/player/nation/quit"],
    ["post", "/api/auth/logout"],
    ["post", "/api/player/notifications/read"],
  ] as const) {
    (app as any)[m](p, (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ ok: true }));
  }
  app.get("/api/economy/overview", (_req, res) => res.json({ ok: true }));
  app.use("/api", autopilotRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await cleanup();
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

test("未託管：寫入不被鎖，GET 顯示 enabled=false", async () => {
  invalidateAutopilotCache();
  assert.equal((await call("POST", "/api/military/recruit", { body: {} })).status, 200);
  const g = await call("GET", "/api/player/autopilot");
  assert.equal(g.status, 200);
  assert.equal(g.json.enabled, false);
});

test("啟用託管：風格正規化、方針截斷到 500 字；託管中重複啟用被鎖定擋下（423）", async () => {
  const long = "字".repeat(800);
  const r = await call("POST", "/api/player/autopilot/enable", {
    body: { style: "not-a-style", directive: `  ${long}  ` },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, true);
  assert.equal(r.json.style, "balanced", "未知風格退回均衡");
  assert.equal(r.json.directive.length, 500, "方針最多 500 字");
  assert.ok(r.json.enabledAt);

  const dup = await call("POST", "/api/player/autopilot/enable", { body: { style: "steady" } });
  // 鎖定中介層在路由之前就擋下（比路由內的 409 更早，也更安全）。
  assert.equal(dup.status, 423);
  assert.equal(dup.json.code, "AUTOPILOT_LOCKED");
});

test("託管中：玩家寫入一律 423 + AUTOPILOT_LOCKED（含退出／刪除國家），讀取不受影響", async () => {
  for (const [m, p] of [
    ["POST", "/api/military/recruit"],
    ["PUT", "/api/economy/whatever"],
    ["DELETE", "/api/player/nation"],
    ["POST", "/api/player/nation/quit"],
  ]) {
    const r = await call(m!, p!, { body: {} });
    assert.equal(r.status, 423, `${m} ${p} 應被鎖`);
    assert.equal(r.json.code, "AUTOPILOT_LOCKED");
  }
  assert.equal((await call("GET", "/api/economy/overview")).status, 200);
  assert.equal((await call("GET", "/api/player/autopilot")).json.enabled, true);
});

test("託管中放行名單：登出、通知已讀仍可呼叫", async () => {
  assert.equal((await call("POST", "/api/auth/logout", { body: {} })).status, 200);
  assert.equal((await call("POST", "/api/player/notifications/read", { body: {} })).status, 200);
});

test("無 session（管理員 Bearer 等）不受鎖定影響", async () => {
  const r = await call("POST", "/api/military/recruit", { body: {}, cookie: false });
  assert.equal(r.status, 200);
});

test("解除託管：鎖定中可解除、立即恢復寫入；再次啟用重置回合數", async () => {
  const d = await call("POST", "/api/player/autopilot/disable", { body: {} });
  assert.equal(d.status, 200);
  assert.equal(d.json.enabled, false);
  assert.equal((await call("POST", "/api/military/recruit", { body: {} })).status, 200, "解除後寫入恢復");

  await db.update(autopilotSettingsTable).set({ turnsRun: 7 }).where(eq(autopilotSettingsTable.nationId, nationId));
  const again = await call("POST", "/api/player/autopilot/enable", { body: { style: "expansion", directive: "多蓋糧倉" } });
  assert.equal(again.status, 200);
  assert.equal(again.json.style, "expansion");
  assert.equal(again.json.turnsRun, 0, "重新啟用重置回合數");
  await call("POST", "/api/player/autopilot/disable", { body: {} });
});
