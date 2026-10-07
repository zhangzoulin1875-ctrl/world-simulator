import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
const { eq, like } = await import("drizzle-orm");
const { db, pool, playerNationsTable, parliamentStateTable, parliamentPartiesTable } = await import("@workspace/db");
const { runParliamentMigrations } = await import("../lib/parliamentMigrations");
const { createSession } = await import("../lib/sessions");
const { default: app } = await import("../app");
const { ELECTION_INTERVAL } = await import("../lib/parliament/election");

/** 選舉 HTTP 路由整合測試:視圖、競選操作的驗證與權限。 */
const MARK = "ParlC"; const run = randomBytes(3).toString("hex");
let server: import("node:http").Server; let base = ""; let n = 0;
async function mk(gov: string, tick: number, money = 100_000) {
  const uid = `pc-${run}-${n}`;
  const [nat] = await db.insert(playerNationsTable).values({ discordUserId: uid, name: `${MARK}${run}${n++}`, leaderName: "t", government: gov, money } as any).returning();
  await db.insert(parliamentStateTable).values({ nationId: nat!.id, tick, satisfaction: 60, lastPartiesTick: tick });
  const ps = await db.insert(parliamentPartiesTable).values([
    { nationId: nat!.id, name: "甲黨", stance: "welfare", weight: 60, seats: 60, isRuling: true },
    { nationId: nat!.id, name: "乙黨", stance: "militarist", weight: 40, seats: 40 },
  ]).returning();
  const tok = await createSession({ discordUserId: uid, username: "t", avatar: null } as any);
  return { nat: nat!, ps, cookie: `dn_session=${tok}` };
}
const camp = (cookie: string, body: unknown) => fetch(`${base}/api/parliament/campaign`, {
  method: "POST", headers: { "content-type": "application/json", cookie, origin: base }, body: JSON.stringify(body),
});
const view = async (cookie: string): Promise<any> => (await fetch(`${base}/api/parliament`, { headers: { cookie } })).json();

before(async () => {
  (await import("../lib/penaltyScaleLoad")).setPenaltyScaleForTest(1);
  await runParliamentMigrations();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("未登入 → 401", async () => {
  assert.equal((await camp("", { partyId: 1, action: "canvass" })).status, 401);
});

test("GET 議會帶選舉視圖與黨綱欄位；民主在競選期", async () => {
  const { cookie } = await mk("議會內閣制", ELECTION_INTERVAL - 2);
  const j = await view(cookie);
  assert.equal(j.election.enabled, true); assert.equal(j.election.phase, "campaign");
  assert.equal(j.election.turnsUntil, 2);
  assert.equal(j.election.prices.bribe.cost, 3000);
  assert.ok("description" in j.parties[0]);
});

test("專制：視圖顯示未啟用，操作被 403", async () => {
  const { nat, cookie, ps } = await mk("君主專制", ELECTION_INTERVAL - 1);
  // 真正的橡皮圖章 = 單一忠誠黨(兩個非忠誠黨會讓議會「覺醒」升為半專制)
  await db.delete(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nat.id));
  const [stamp] = await db.insert(parliamentPartiesTable).values({ nationId: nat.id, name: "愛國黨", stance: "loyalist", weight: 1, seats: 100, isRuling: true }).returning();
  ps[0] = stamp!;
  assert.equal((await view(cookie)).election.enabled, false);
  assert.equal((await camp(cookie, { partyId: ps[0]!.id, action: "canvass" })).status, 403);
});

test("參數驗證：壞 action / 壞 partyId → 400", async () => {
  const { cookie, ps } = await mk("議會內閣制", ELECTION_INTERVAL - 1);
  assert.equal((await camp(cookie, { partyId: ps[0]!.id, action: "nuke" })).status, 400);
  assert.equal((await camp(cookie, { action: "canvass" })).status, 400);
  assert.equal((await camp(cookie, { partyId: "1; drop table", action: "canvass" })).status, 400);
  assert.equal((await camp(cookie, {})).status, 400);
});

test("競選期拉票成功：扣款、視圖出現操作紀錄；重複同招 409", async () => {
  const { nat, cookie, ps } = await mk("議會內閣制", ELECTION_INTERVAL - 1);
  const r = await camp(cookie, { partyId: ps[1]!.id, action: "canvass" });
  assert.equal(r.status, 200);
  const j: any = await r.json(); assert.equal(j.ok, true); assert.equal(j.caught, false); assert.equal(j.partyName, "乙黨");
  const [after] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nat.id));
  assert.equal(Number(after!.money), 100_000 - j.cost);
  const v = await view(cookie);
  assert.equal(v.election.actions.length, 1); assert.equal(v.election.actions[0].action, "canvass");
  assert.equal((await camp(cookie, { partyId: ps[1]!.id, action: "canvass" })).status, 409);
});

test("非競選期 409；錢不夠 402；別人的黨 404", async () => {
  const early = await mk("議會內閣制", 1);
  assert.equal((await camp(early.cookie, { partyId: early.ps[0]!.id, action: "canvass" })).status, 409);
  const poor = await mk("議會內閣制", ELECTION_INTERVAL - 1, 10);
  assert.equal((await camp(poor.cookie, { partyId: poor.ps[0]!.id, action: "bribe" })).status, 402);
  const a = await mk("議會內閣制", ELECTION_INTERVAL - 1);
  const b = await mk("議會內閣制", ELECTION_INTERVAL - 1);
  assert.equal((await camp(a.cookie, { partyId: b.ps[0]!.id, action: "canvass" })).status, 404, "不能對別國的黨下手");
});

test("半專制可操作且價格折半", async () => {
  const { cookie, ps } = await mk("君主立憲制", ELECTION_INTERVAL - 1);
  const v = await view(cookie);
  if (v.tier === "semi") {
    assert.equal(v.election.prices.bribe.cost, 1500);
    assert.equal((await camp(cookie, { partyId: ps[0]!.id, action: "canvass" })).status, 200);
  } else {
    assert.ok(["democracy", "semi"].includes(v.tier), `意外的層級 ${v.tier}`);
  }
});

test("GET 議會帶政府視圖：聯合成員旗標與穩定度；專制不啟用", async () => {
  const { nat, cookie } = await mk("議會內閣制", 1);
  // mk 造的是 甲 60 席(執政) + 乙 40 席：甲單獨過半
  const { reformGovernment } = await import("../lib/parliament/coalitionService");
  await reformGovernment(nat.id, "democracy", 1);
  const j = await view(cookie);
  assert.equal(j.government.enabled, true); assert.equal(j.government.kind, "single");
  assert.deepEqual(j.government.members.map((m: any) => m.name), ["甲黨"]);
  assert.equal(j.parties.find((p: any) => p.name === "甲黨").inCoalition, true);
  assert.equal(j.parties.find((p: any) => p.name === "乙黨").inCoalition, false);
  assert.equal(j.government.risk, "low");

  const stamp = await mk("君主專制", 1);
  await db.delete(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, stamp.nat.id));
  await db.insert(parliamentPartiesTable).values({ nationId: stamp.nat.id, name: "愛國黨", stance: "loyalist", weight: 1, seats: 100, isRuling: true });
  assert.equal((await view(stamp.cookie)).government.enabled, false);
});
