import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
const { eq, like } = await import("drizzle-orm");
const { db, pool, playerNationsTable, domesticEventsTable } = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runParliamentMigrations } = await import("../lib/parliamentMigrations");
const { runDomesticEventMigrations } = await import("../lib/domesticEvents/migrations");
const { createSession } = await import("../lib/sessions");
const { createEvent } = await import("../lib/domesticEvents/service");
const { getEventDef } = await import("../lib/domesticEvents/core");
const { setEventTextQueuerForTest } = await import("../lib/domesticEvents/text");
const { governmentLabel } = await import("../lib/governments");
const { default: app } = await import("../app");

const MARK = "DevR"; const run = randomBytes(3).toString("hex");
let server: import("node:http").Server; let base = "";
const made: string[] = [];

async function mk() {
  const uid = `dr-${run}-${made.length}`;
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: uid, name: `${MARK}${run}${made.length}`, leaderName: "t", government: governmentLabel("parliamentary")!, money: 10_000,
  } as any).returning();
  made.push(n!.id);
  const tok = await createSession({ discordUserId: uid, username: "t", avatar: null } as any);
  return { n: n!, cookie: `dn_session=${tok}` };
}
const get = (cookie?: string) => fetch(`${base}/api/domestic-events`, { headers: cookie ? { cookie } : {} });
const resolve = (id: string, cookie: string, body: unknown) =>
  fetch(`${base}/api/domestic-events/${id}/resolve`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: base }, body: JSON.stringify(body) });

before(async () => {
  setEventTextQueuerForTest(() => {});
  await runGameMigrations(); await runParliamentMigrations(); await runDomesticEventMigrations();
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  setEventTextQueuerForTest(null);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}${run}%`));
  server.close(); await pool.end();
});

test("未登入:GET 與 POST 都是 401", async () => {
  assert.equal((await get()).status, 401);
  const r = await fetch(`${base}/api/domestic-events/00000000-0000-0000-0000-000000000000/resolve`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" });
  assert.equal(r.status, 401);
});

test("沒有事件時 pending 為 null;有事件時回傳 turnsLeft 與三個選項,但不洩漏效果數字", async () => {
  const { n, cookie } = await mk();
  const empty = (await (await get(cookie)).json()) as any;
  assert.equal(empty.pending, null);
  await createEvent(n.id, getEventDef("socialist_majority")!, 2);
  const res = await get(cookie);
  assert.equal(res.status, 200);
  const j = (await res.json()) as any;
  assert.equal(j.pending.kind, "socialist_majority");
  assert.deepEqual(j.pending.choices.map((c: any) => c.id), ["comply", "crackdown", "delay"]);
  assert.ok(Number.isInteger(j.pending.turnsLeft) && j.pending.turnsLeft >= 0);
  assert.ok(!("effects" in j.pending) && !JSON.stringify(j).includes("civilWarRisk"), "不能把效果表送到前端");
});

test("POST 處理:成功回結果、事件變歷史;再送一次是 409", async () => {
  const { n, cookie } = await mk();
  const ev = (await createEvent(n.id, getEventDef("economic_crisis")!, 2))!;
  const r1 = await resolve(ev.id, cookie, { choiceId: "comply" });
  assert.equal(r1.status, 200);
  const j1 = (await r1.json()) as any;
  assert.equal(j1.ok, true);
  assert.ok(typeof j1.outcome === "string" && j1.outcome.length > 0);
  const after1 = (await (await get(cookie)).json()) as any;
  assert.equal(after1.pending, null);
  assert.equal(after1.history[0].status, "resolved");
  const r2 = await resolve(ev.id, cookie, { choiceId: "comply" });
  assert.equal(r2.status, 409);
});

test("權限邊界:不能處理別人的事件(404),對方事件不受影響", async () => {
  const a = await mk(); const b = await mk();
  const evA = (await createEvent(a.n.id, getEventDef("recall_wave")!, 2))!;
  const r = await resolve(evA.id, b.cookie, { choiceId: "crackdown" });
  assert.equal(r.status, 404);
  const [row] = await db.select().from(domesticEventsTable).where(eq(domesticEventsTable.id, evA.id));
  assert.equal(row!.status, "pending");
  const [na] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, a.n.id));
  assert.equal(na!.stability, a.n.stability);
});

test("輸入檢查:缺選項 400、事件編號格式錯 400、不存在的選項 409 以外的錯誤且不消耗事件", async () => {
  const { n, cookie } = await mk();
  const ev = (await createEvent(n.id, getEventDef("recall_wave")!, 2))!;
  assert.equal((await resolve(ev.id, cookie, {})).status, 400);
  assert.equal((await resolve("not-a-uuid", cookie, { choiceId: "comply" })).status, 400);
  const bad = await resolve(ev.id, cookie, { choiceId: "hack" });
  assert.ok(bad.status >= 400 && bad.status < 500);
  const [row] = await db.select().from(domesticEventsTable).where(eq(domesticEventsTable.id, ev.id));
  assert.equal(row!.status, "pending");
});
