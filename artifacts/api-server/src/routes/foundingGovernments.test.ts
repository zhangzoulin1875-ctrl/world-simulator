/** 建國頁政體選項 API:三選一都要帶新手說明(guide),舊欄位維持不變(向下相容)。 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set to run founding governments tests");

const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { eq } = await import("drizzle-orm");
const { db, pool, userSessionsTable } = await import("@workspace/db");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const playerRouter = (await import("./player")).default;

const USER = `fg-test-${randomBytes(4).toString("hex")}`;
let server: http.Server;
let baseUrl = "";
let token = "";

before(async () => {
  token = await createSession({ discordUserId: USER, username: USER, globalName: null, avatar: null, manageableGuildIds: [] });
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = { info() {}, warn() {}, error() {} };
    next();
  });
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", playerRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.delete(userSessionsTable).where(eq(userSessionsTable.discordUserId, USER)).catch(() => {});
  await pool.end();
});

test("GET /player/founding-governments:三個政體都帶 guide,舊欄位仍在", async () => {
  const res = await fetch(`${baseUrl}/api/player/founding-governments`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { governments: any[] };
  assert.deepEqual(
    json.governments.map((g) => g.slug),
    ["absolute_monarchy", "aristocracy", "parliamentary_republic"],
  );
  for (const g of json.governments) {
    assert.ok(g.label && g.description, "舊欄位 label/description 必須保留");
    assert.equal(typeof g.decisionDifficulty, "number");
    assert.ok(g.guide, `${g.slug} 缺 guide`);
    assert.ok(g.guide.summary && g.guide.tip);
    assert.ok(Array.isArray(g.guide.pros) && g.guide.pros.length >= 2);
    assert.ok(Array.isArray(g.guide.cons) && g.guide.cons.length >= 2);
  }
});

test("未登入仍 401(不因新增欄位放寬權限)", async () => {
  const res = await fetch(`${baseUrl}/api/player/founding-governments`);
  assert.equal(res.status, 401);
});
