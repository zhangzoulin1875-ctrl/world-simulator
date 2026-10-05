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

const MARK = "DevA"; const run = randomBytes(3).toString("hex");
const ADMIN = { authorization: `Bearer ${process.env["ADMIN_TOKEN"]}` };
let server: import("node:http").Server; let base = "";
let seq = 0;
const queued: string[] = [];

async function mk(isNpc = false) {
  const uid = `da-${run}-${seq}`;
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: isNpc ? null : uid, name: `${MARK}${run}${seq++}`, leaderName: "t", government: governmentLabel("parliamentary")!, money: 10_000, isNpc,
  } as any).returning();
  const cookie = isNpc ? "" : `dn_session=${await createSession({ discordUserId: uid, username: "t", avatar: null } as any)}`;
  return { n: n!, cookie };
}
const send = (body: unknown, headers: Record<string, string> = ADMIN) =>
  fetch(`${base}/api/admin/domestic-events/send`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });
const pendingOf = async (nationId: string) =>
  (await db.select().from(domesticEventsTable).where(eq(domesticEventsTable.nationId, nationId))).filter((e) => e.status === "pending");

before(async () => {
  setEventTextQueuerForTest((id) => { queued.push(id); });
  await runGameMigrations(); await runParliamentMigrations(); await runDomesticEventMigrations();
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  setEventTextQueuerForTest(null);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}${run}%`));
  server.close(); await pool.end();
});

test("沒有管理員 token 或 token 錯誤:三個介面都拒絕,玩家的登入 session 也不行", async () => {
  const p = await mk();
  const id = "00000000-0000-0000-0000-000000000000";
  for (const headers of [{}, { authorization: "Bearer wrong" }, { cookie: p.cookie }] as Record<string, string>[]) {
    assert.equal((await fetch(`${base}/api/admin/domestic-events`, { headers })).status, 401);
    assert.equal((await send({ kind: "recall_wave", target: { type: "nation", nationId: p.n.id } }, headers)).status, 401);
    const c = await fetch(`${base}/api/admin/domestic-events/${id}/cancel`, { method: "POST", headers: { origin: base, ...headers } });
    assert.equal(c.status, 401);
  }
  assert.equal((await pendingOf(p.n.id)).length, 0, "未授權的請求不能造成任何事件");
});

test("總覽:回傳事件目錄(含效果數字)、設定與最近紀錄", async () => {
  const j = (await (await fetch(`${base}/api/admin/domestic-events`, { headers: ADMIN })).json()) as any;
  assert.equal(j.catalog.length, 5);
  assert.deepEqual(j.settings, { everyTurns: 2, chance: 0.3, deadlineTurns: 3 });
  const soc = j.catalog.find((c: any) => c.kind === "socialist_majority");
  assert.ok(soc.choices.find((c: any) => c.id === "crackdown").effects.stability < 0);
  assert.ok(Array.isArray(j.recent));
});

test("投放給單一玩家國:建立待處理事件並排入 AI 改寫;玩家端能看到", async () => {
  const p = await mk();
  const before = queued.length;
  const r = (await (await send({ kind: "socialist_majority", target: { type: "nation", nationId: p.n.id } })).json()) as any;
  assert.equal(r.sent.length, 1);
  assert.equal(r.skipped.length, 0);
  assert.equal(queued.length, before + 1);
  const seen = (await (await fetch(`${base}/api/domestic-events`, { headers: { cookie: p.cookie } })).json()) as any;
  assert.equal(seen.pending.kind, "socialist_majority");
});

test("rewrite:false 時不排 AI 改寫", async () => {
  const p = await mk();
  const before = queued.length;
  await send({ kind: "recall_wave", target: { type: "nation", nationId: p.n.id }, rewrite: false });
  assert.equal(queued.length, before);
});

test("玩家已有待處理事件:略過(has_pending),不覆蓋原事件", async () => {
  const p = await mk();
  const ev = (await createEvent(p.n.id, getEventDef("economic_crisis")!, 1))!;
  const r = (await (await send({ kind: "recall_wave", target: { type: "nation", nationId: p.n.id } })).json()) as any;
  assert.equal(r.sent.length, 0);
  assert.equal(r.skipped[0].reason, "has_pending");
  const now = await pendingOf(p.n.id);
  assert.equal(now.length, 1);
  assert.equal(now[0]!.id, ev.id);
  assert.equal(now[0]!.kind, "economic_crisis");
});

test("NPC 與不存在的國家:略過並說明原因,不建立事件", async () => {
  const npc = await mk(true);
  const a = (await (await send({ kind: "recall_wave", target: { type: "nation", nationId: npc.n.id } })).json()) as any;
  assert.equal(a.skipped[0].reason, "npc");
  assert.equal((await pendingOf(npc.n.id)).length, 0);
  const b = (await (await send({ kind: "recall_wave", target: { type: "nation", nationId: "11111111-1111-4111-8111-111111111111" } })).json()) as any;
  assert.equal(b.skipped[0].reason, "not_found");
});

test("全體玩家投放:每個玩家國各一個事件,NPC 不收;已有事件的被略過", async () => {
  const a = await mk(); const b = await mk(); const npc = await mk(true);
  await createEvent(b.n.id, getEventDef("military_petition")!, 1);
  const r = (await (await send({ kind: "religious_revival", target: { type: "allPlayers" }, rewrite: false })).json()) as any;
  const sentIds = r.sent.map((x: any) => x.nationId);
  assert.ok(sentIds.includes(a.n.id));
  assert.ok(!sentIds.includes(b.n.id) && !sentIds.includes(npc.n.id));
  assert.ok(r.skipped.some((x: any) => x.nationId === b.n.id && x.reason === "has_pending"));
  assert.equal((await pendingOf(a.n.id))[0]!.kind, "religious_revival");
  assert.equal((await pendingOf(npc.n.id)).length, 0);
});

test("輸入檢查:未知事件種類、壞的目標、壞的國家編號都是 400", async () => {
  const p = await mk();
  assert.equal((await send({ kind: "nope", target: { type: "nation", nationId: p.n.id } })).status, 400);
  assert.equal((await send({ kind: "recall_wave", target: { type: "nation", nationId: "abc" } })).status, 400);
  assert.equal((await send({ kind: "recall_wave", target: { type: "everyone" } })).status, 400);
  assert.equal((await send({})).status, 400);
});

test("撤回:待處理事件被撤回且不改任何數值;已處理的事件撤回是 409", async () => {
  const p = await mk();
  const ev = (await createEvent(p.n.id, getEventDef("recall_wave")!, 1))!;
  const c = await fetch(`${base}/api/admin/domestic-events/${ev.id}/cancel`, { method: "POST", headers: { origin: base, ...ADMIN } });
  assert.equal(c.status, 200);
  assert.equal((await pendingOf(p.n.id)).length, 0);
  const [n] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, p.n.id));
  assert.equal(n!.stability, p.n.stability);
  const again = await fetch(`${base}/api/admin/domestic-events/${ev.id}/cancel`, { method: "POST", headers: { origin: base, ...ADMIN } });
  assert.equal(again.status, 409);
  assert.equal((await fetch(`${base}/api/admin/domestic-events/bad-id/cancel`, { method: "POST", headers: { origin: base, ...ADMIN } })).status, 400);
});

test("撤回後可以再投放同一國(唯一索引只管 pending)", async () => {
  const p = await mk();
  const ev = (await createEvent(p.n.id, getEventDef("recall_wave")!, 1))!;
  await fetch(`${base}/api/admin/domestic-events/${ev.id}/cancel`, { method: "POST", headers: { origin: base, ...ADMIN } });
  const r = (await (await send({ kind: "economic_crisis", target: { type: "nation", nationId: p.n.id }, rewrite: false })).json()) as any;
  assert.equal(r.sent.length, 1);
});
