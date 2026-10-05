import { governmentSlugByLabel } from "../lib/governments";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
const { eq, like } = await import("drizzle-orm");
const { db, pool, playerNationsTable, focusStatesTable } = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runFocusMigrations } = await import("../lib/focusMigrations");
const { runParliamentMigrations } = await import("../lib/parliamentMigrations");
const { createSession } = await import("../lib/sessions");
const { default: app } = await import("../app");
const { findEdge } = await import("../lib/focus/regimeGraph");

const MARK = "FocR"; const run = randomBytes(3).toString("hex");
let server: import("node:http").Server; let base = "";
const made: string[] = [];
async function mk(gov: string, extra: Record<string, unknown> = {}) {
  const uid = `fr-${run}-${made.length}`;
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: uid, name: `${MARK}${run}${made.length}`, leaderName: "t", government: gov, money: 10_000, ...extra,
  } as any).returning();
  made.push(n!.id);
  const tok = await createSession({ discordUserId: uid, username: "t", avatar: null } as any);
  return { n: n!, cookie: `dn_session=${tok}` };
}
const give = (nationId: string, points: number, more: Record<string, unknown> = {}) =>
  db.insert(focusStatesTable).values({ nationId, points, ...more } as any)
    .onConflictDoUpdate({ target: focusStatesTable.nationId, set: { points, ...more } as any });
const get = (cookie: string) => fetch(`${base}/api/focus`, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown) =>
  fetch(`${base}/api/focus/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: base }, body: JSON.stringify(body) });

before(async () => {
  await runGameMigrations(); await runParliamentMigrations(); await runFocusMigrations();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.close();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("未登入:三個端點都 401", async () => {
  assert.equal((await fetch(`${base}/api/focus`)).status, 401);
  const anon = (path: string) => fetch(`${base}/api/focus/${path}`, { method: "POST", headers: { origin: base } });
  assert.equal((await anon("start")).status, 401);
  assert.equal((await anon("cancel")).status, 401);
  // 帶著登入 cookie、卻沒有 Origin 的 POST(典型 CSRF)會被擋下 403,不會走到業務邏輯
  const { n, cookie } = await mk("君主專制");
  await give(n.id, 100);
  const forged = await fetch(`${base}/api/focus/start`, {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ focusId: findEdge("absolute_monarchy", "constitutional_monarchy")!.focusId }),
  });
  assert.equal(forged.status, 403);
  const [st] = await db.select().from(focusStatesTable).where(eq(focusStatesTable.nationId, n.id));
  assert.equal(st!.points, 100, "被 CSRF 擋下時不扣點");
});

test("GET /focus:只列出該政體看得到的國策(君主專制只看到自己的出口)", async () => {
  const { cookie } = await mk("君主專制");
  const r = await get(cookie); assert.equal(r.status, 200);
  const j: any = await r.json();
  const ids: string[] = j.focuses.map((f: any) => f.id);
  const expected = [
    ...["constitutional_monarchy", "military_dictatorship", "theocracy", "elective_monarchy", "dual_monarchy"]
      .map((to) => findEdge("absolute_monarchy", to)!.focusId),
    "regime.communist_revolution",
  ].sort();
  assert.deepEqual(ids.slice().sort(), expected, "只看得到 6 條出口(5 條轉型 + 1 條紅色革命)");
  for (const f of j.focuses) {
    if (f.id === "regime.communist_revolution") {
      assert.equal(f.transitionTo, null, "革命不是和平轉型:沒有目標政體,打贏才改制");
    } else {
      assert.ok(f.transitionTo, "轉型國策要標示目標政體");
    }
    assert.ok(f.costs.length > 0, "每個國策都要列出代價");
    assert.ok(f.title && f.description);
  }
  assert.ok(j.pointsPerTurn >= 1); assert.ok(j.pointsCap >= j.pointsPerTurn);
  assert.deepEqual(j.active, []);
});

test("共產革命對所有非紅線終點的政體都可見;紅線終點(委員會制/社會主義委員會)不顯示", async () => {
  const seen: Record<string, boolean> = {};
  for (const g of ["貴族制", "君主立憲制", "總統制民主", "議會內閣制", "君主專制", "神權制", "軍事獨裁", "財閥共和", "邦聯制", "議會共和制", "選舉君主制", "二元君主制", "委員會制", "社會主義委員會制"]) {
    assert.ok(governmentSlugByLabel(g), `測試用的政體標籤必須有效:${g}`);
    const { cookie } = await mk(g);
    const r = await get(cookie); assert.equal(r.status, 200, g);
    const j: any = await r.json();
    seen[g] = j.focuses.some((f: any) => f.id === "regime.communist_revolution");
  }
  for (const g of Object.keys(seen).filter((k) => k !== "委員會制" && k !== "社會主義委員會制")) assert.equal(seen[g], true, `${g} 應看得到共產革命`);
  for (const g of ["委員會制", "社會主義委員會制"]) assert.equal(seen[g], false, `${g} 已是紅線終點,不該再看到`);
});

test("點數不足/條件未達:標為 locked 並給原因;達標後變 available", async () => {
  const { n, cookie } = await mk("君主專制", { politicalSupport: 30 });
  await give(n.id, 0);
  const id = findEdge("absolute_monarchy", "constitutional_monarchy")!.focusId;
  let j: any = await (await get(cookie)).json();
  let card = j.focuses.find((f: any) => f.id === id);
  assert.equal(card.status, "locked"); assert.ok(card.lockedReason.includes("點數"));
  assert.equal(card.permanentlyLocked, false);
  await give(n.id, 100);
  j = await (await get(cookie)).json(); card = j.focuses.find((f: any) => f.id === id);
  assert.equal(card.status, "locked"); assert.ok(card.lockedReason.includes("政治支持度"), card.lockedReason);
  await db.update(playerNationsTable).set({ politicalSupport: 70 }).where(eq(playerNationsTable.id, n.id));
  j = await (await get(cookie)).json(); card = j.focuses.find((f: any) => f.id === id);
  assert.equal(card.status, "available"); assert.equal(card.lockedReason, null);
});

test("畫面說「可啟動」就真的能啟動;說「鎖定」就真的被擋(共用同一套判斷)", async () => {
  const { n, cookie } = await mk("君主專制", { politicalSupport: 70, satisfactionMilitary: 70, stability: 60 });
  await give(n.id, 1000, { blackLean: 0 });
  const j: any = await (await get(cookie)).json();
  const avail = j.focuses.filter((f: any) => f.status === "available");
  const locked = j.focuses.filter((f: any) => f.status === "locked");
  assert.ok(avail.length >= 1 && locked.length >= 1, "兩種狀態都要有,測試才有意義");
  // 鎖定的每一個,實際啟動都必須被擋,且訊息與畫面上的原因一致
  for (const f of locked) {
    const r = await post("start", cookie, { focusId: f.id });
    assert.equal(r.status, 409, f.id);
    assert.equal(((await r.json()) as any).error, f.lockedReason, f.id);
  }
  // 可啟動的:同槽位只能先開一個,開第一個必須成功
  const first = await post("start", cookie, { focusId: avail[0].id });
  assert.equal(first.status, 200, await first.clone().text());
});

test("POST /start:成功後回傳最新畫面(點數已扣、進行中出現、該卡變 active)", async () => {
  const { n, cookie } = await mk("君主專制", { politicalSupport: 70 });
  await give(n.id, 100);
  const id = findEdge("absolute_monarchy", "constitutional_monarchy")!.focusId;
  const r = await post("start", cookie, { focusId: id }); assert.equal(r.status, 200);
  const j: any = await r.json();
  assert.equal(j.ok, true); assert.equal(j.spent, 20);
  assert.equal(j.view.points, 80);
  assert.equal(j.view.active.length, 1);
  assert.equal(j.view.active[0].id, id);
  assert.equal(j.view.active[0].refundOnCancel, 10);
  assert.ok(j.view.active[0].remainingTurns >= 1);
  assert.equal(j.view.focuses.find((f: any) => f.id === id).status, "active");
});

test("POST /start:錯誤請求的狀態碼(400 缺 id / 404 不存在 / 409 業務拒絕)", async () => {
  const { n, cookie } = await mk("君主專制");
  await give(n.id, 100);
  assert.equal((await post("start", cookie, {})).status, 400);
  assert.equal((await post("start", cookie, { focusId: "" })).status, 400);
  const nf = await post("start", cookie, { focusId: "no.such" }); assert.equal(nf.status, 404);
  // 別的政體的國策:不能啟動(政體不符),也是 409
  const other = findEdge("parliamentary", "council_system")!.focusId;
  const wrong = await post("start", cookie, { focusId: other });
  assert.equal(wrong.status, 409); assert.equal(((await wrong.json()) as any).reason, "government_not_allowed");
});

test("POST /cancel:退 50%、槽位釋放;重複取消 409", async () => {
  const { n, cookie } = await mk("君主專制", { politicalSupport: 70 });
  await give(n.id, 100);
  const id = findEdge("absolute_monarchy", "constitutional_monarchy")!.focusId;
  await post("start", cookie, { focusId: id });
  const c = await post("cancel", cookie, { focusId: id }); assert.equal(c.status, 200);
  const j: any = await c.json();
  assert.equal(j.refunded, 10); assert.equal(j.view.points, 90); assert.deepEqual(j.view.active, []);
  assert.equal((await post("cancel", cookie, { focusId: id })).status, 409);
  assert.equal((await post("cancel", cookie, {})).status, 400);
});

test("別人的國家互不影響:A 啟動國策,B 的畫面不變", async () => {
  const a = await mk("君主專制", { politicalSupport: 70 });
  const b = await mk("君主專制", { politicalSupport: 70 });
  await give(a.n.id, 100); await give(b.n.id, 100);
  await post("start", a.cookie, { focusId: findEdge("absolute_monarchy", "constitutional_monarchy")!.focusId });
  const jb: any = await (await get(b.cookie)).json();
  assert.equal(jb.points, 100); assert.deepEqual(jb.active, []);
});

test("政變鎖定期間:畫面顯示鎖定回合數,所有國策標為 locked", async () => {
  const { n, cookie } = await mk("君主專制", { politicalSupport: 70, coupPolicyLockTurns: 3 });
  await give(n.id, 100);
  const j: any = await (await get(cookie)).json();
  assert.equal(j.policyLockTurns, 3);
  assert.ok(j.focuses.every((f: any) => f.status === "locked"));
  assert.ok(j.focuses[0].lockedReason.includes("政變"));
});
