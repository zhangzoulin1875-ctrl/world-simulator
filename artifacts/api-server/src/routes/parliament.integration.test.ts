import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
const { eq, like } = await import("drizzle-orm");
const { db, pool, playerNationsTable, parliamentStateTable, parliamentLogTable } = await import("@workspace/db");
const { runParliamentMigrations } = await import("../lib/parliamentMigrations");
const { createSession } = await import("../lib/sessions");
const { default: app } = await import("../app");
const { settleNationParliament } = await import("../lib/parliament/service");

const MARK = "ParlR"; const run = randomBytes(3).toString("hex");
let server: import("node:http").Server; let base = "";
const made: string[] = [];
async function mk(gov: string, money = 10_000) {
  const uid = `pr-${run}-${made.length}`;
  const [n] = await db.insert(playerNationsTable).values({ discordUserId: uid, name: `${MARK}${run}${made.length}`, leaderName: "t", government: gov, money } as any).returning();
  made.push(n!.id);
  const tok = await createSession({ discordUserId: uid, username: "t", avatar: null } as any);
  return { n: n!, cookie: `dn_session=${tok}` };
}
const post = (cookie: string, body: unknown) => fetch(`${base}/api/parliament/report`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: base }, body: JSON.stringify(body) });
const LONG = "我們將削減無謂開支,並優先回應議會提出的軍備與民生問題,同時公開預算。";

before(async () => {
  await runParliamentMigrations();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`)); await pool.end(); });

test("未登入 → 401", async () => {
  const r = await fetch(`${base}/api/parliament`); assert.equal(r.status, 401);
});

test("GET 議會:民主有政黨、席次 100、含抗議與政策要求兩種內容", async () => {
  const { n, cookie } = await mk("議會內閣制");
  await settleNationParliament(n, null, 0);
  const r = await fetch(`${base}/api/parliament`, { headers: { cookie } }); assert.equal(r.status, 200);
  const j: any = await r.json();
  assert.equal(j.tier, "democracy"); assert.equal(j.parties.length, 5);
  assert.equal(j.parties.reduce((a: number, p: any) => a + p.seats, 0), 100);
  assert.ok(j.protest.length > 0); assert.ok(j.demand && j.demand.text.length > 0);
  assert.equal(j.report.allowed, true);
});

test("專制:橡皮圖章,不開放國情報告(403)", async () => {
  const { n, cookie } = await mk("君主專制");
  await settleNationParliament(n, null, 0);
  const g: any = await (await fetch(`${base}/api/parliament`, { headers: { cookie } })).json();
  assert.equal(g.tier, "autocracy"); assert.equal(g.report.allowed, false); assert.equal(g.demand, null);
  assert.equal((await post(cookie, { text: LONG })).status, 403);
});

test("國情報告:驗證錯誤 400、成功扣 500 並寫紀錄、冷卻中 429", async () => {
  const { n, cookie } = await mk("議會內閣制", 10_000);
  await settleNationParliament(n, null, 0);
  { const r0 = await post(cookie, { text: "短" }); const b0 = await r0.clone().text(); assert.equal(r0.status, 400, b0); }
  assert.equal((await post(cookie, {})).status, 400);
  const ok = await post(cookie, { text: LONG }); assert.equal(ok.status, 200);
  const j: any = await ok.json(); assert.ok(j.score >= 0 && j.score <= 100); assert.ok(["ai", "fallback"].includes(j.source));
  const [after] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, n.id));
  assert.equal(after!.money, 9_500);
  const logs = await db.select().from(parliamentLogTable).where(eq(parliamentLogTable.nationId, n.id));
  assert.ok(logs.some((l) => l.kind === "report"));
  assert.equal((await post(cookie, { text: LONG })).status, 429, "冷卻中");
});

test("餘額不足 → 402,且不蓋冷卻戳記(錢夠了馬上能重試)", async () => {
  const { n, cookie } = await mk("議會內閣制", 100);
  await settleNationParliament(n, null, 0);
  assert.equal((await post(cookie, { text: LONG })).status, 402);
  const [s] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, n.id));
  assert.equal(s!.lastReportTick, null, "扣款失敗要連冷卻戳記一起回滾");
  const [after] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, n.id));
  assert.equal(after!.money, 100);
});

test("並發 5 次同時提交:只有 1 次成功、只扣 1 次錢", async () => {
  const { n, cookie } = await mk("議會內閣制", 10_000);
  await settleNationParliament(n, null, 0);
  const rs = await Promise.all(Array.from({ length: 5 }, () => post(cookie, { text: LONG })));
  const codes = rs.map((r) => r.status).sort();
  assert.equal(codes.filter((c) => c === 200).length, 1, codes.join(","));
  const [after] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, n.id));
  assert.equal(after!.money, 9_500, "只能扣一次");
});
