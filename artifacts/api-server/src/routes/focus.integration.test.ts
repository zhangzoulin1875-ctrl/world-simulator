import { governmentSlugByLabel } from "../lib/governments";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { readBranches } from "../lib/focus/branchService";
const { eq, like } = await import("drizzle-orm");
const { db, pool, playerNationsTable, focusStatesTable, focusBranchesTable } = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runFocusMigrations } = await import("../lib/focusMigrations");
const { runParliamentMigrations } = await import("../lib/parliamentMigrations");
const { createSession } = await import("../lib/sessions");
const { default: app } = await import("../app");
const { findEdge, edgesFrom } = await import("../lib/focus/regimeGraph");

const MARK = "FocR"; const run = randomBytes(3).toString("hex");
let server: import("node:http").Server; let base = "";
const made: string[] = [];
/**
 * 建一個測試國家。預設會把「君主專制 → 君主立憲制」固定寫進它的國策樹,讓依賴這條路的測試不因隨機抽選而不穩;
 * 要測隨機分支本身時傳 fixTree:false。
 */
async function mk(gov: string, extra: Record<string, unknown> = {}, fixTree = true) {
  const uid = `fr-${run}-${made.length}`;
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: uid, name: `${MARK}${run}${made.length}`, leaderName: "t", government: gov, money: 10_000, ...extra,
  } as any).returning();
  made.push(n!.id);
  const slug = governmentSlugByLabel(gov);
  if (fixTree && slug) {
    const to = edgesFrom(slug).slice(0, 3).map((e) => e.to); // 固定前三條出邊(含君主專制 → 君主立憲制)
    if (to.length > 0) await db.insert(focusBranchesTable).values(to.map((t) => ({ nationId: n!.id, fromGovernment: slug, toGovernment: t })));
  }
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

test("GET /focus:只列出自己抽到的分支(君主專制 5 條出邊 → 只看到 3~5 條)+ 共產革命", async () => {
  const { n, cookie } = await mk("君主專制", {}, false);
  const r = await get(cookie); assert.equal(r.status, 200);
  const j: any = await r.json();
  const ids: string[] = j.focuses.map((f: any) => f.id);
  const allExits = ["constitutional_monarchy", "military_dictatorship", "theocracy", "elective_monarchy", "dual_monarchy"]
    .map((to) => findEdge("absolute_monarchy", to)!.focusId);
  const transitions = ids.filter((id) => id !== "regime.communist_revolution");
  assert.ok(ids.includes("regime.communist_revolution"), "共產革命永遠在,不佔分支名額");
  assert.ok(transitions.length >= 3 && transitions.length <= 5, `轉型應為 3~5 條,實際 ${transitions.length}`);
  for (const id of transitions) assert.ok(allExits.includes(id), `${id} 必須是君主專制的合法出口`);
  // 畫面上的分支 = 資料庫裡存的那一套
  const stored = (await readBranches(n.id, "absolute_monarchy"))!;
  assert.deepEqual(transitions.slice().sort(), stored.map((to) => findEdge("absolute_monarchy", to)!.focusId).sort());
  // 再讀一次:固定不變(不重抽)
  const j2: any = await (await get(cookie)).json();
  assert.deepEqual(j2.focuses.map((f: any) => f.id).sort(), ids.slice().sort(), "分支一旦抽出就固定");
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

test("不在自己樹上的轉型:清單看不到、POST /start 被擋且不扣點(即使條件與點數都夠)", async () => {
  const { n, cookie } = await mk("君主專制", { politicalSupport: 90 }, false);
  const only = "constitutional_monarchy"; // 樹上只放這一條
  await db.insert(focusBranchesTable).values({ nationId: n.id, fromGovernment: "absolute_monarchy", toGovernment: only });
  await give(n.id, 500);
  const offTree = findEdge("absolute_monarchy", "military_dictatorship")!.focusId;
  const onTree = findEdge("absolute_monarchy", only)!.focusId;

  const j: any = await (await get(cookie)).json();
  const ids: string[] = j.focuses.map((f: any) => f.id);
  assert.ok(ids.includes(onTree), "樹上的看得到");
  assert.ok(!ids.includes(offTree), "沒抽到的完全不顯示");

  const before = (await db.select().from(focusStatesTable).where(eq(focusStatesTable.nationId, n.id)))[0]!.points;
  const r = await post("start", cookie, { focusId: offTree });
  assert.ok(r.status >= 400 && r.status < 500, `應被擋,實際 ${r.status}`);
  const body: any = await r.json();
  assert.ok(JSON.stringify(body).includes("not_in_tree") || JSON.stringify(body).includes("國策樹"), JSON.stringify(body));
  const after = (await db.select().from(focusStatesTable).where(eq(focusStatesTable.nationId, n.id)))[0]!.points;
  assert.equal(after, before, "被擋時不可扣點");
});

test("共產革命不受樹限制:即使樹上只有 1 條轉型,革命入口仍在", async () => {
  const { n, cookie } = await mk("貴族制", {}, false);
  await db.insert(focusBranchesTable).values({ nationId: n.id, fromGovernment: "aristocracy", toGovernment: edgesFrom("aristocracy")[0]!.to });
  const j: any = await (await get(cookie)).json();
  const ids: string[] = j.focuses.map((f: any) => f.id);
  assert.ok(ids.includes("regime.communist_revolution"));
  assert.equal(ids.filter((id) => id !== "regime.communist_revolution").length, 1);
});

test("出邊 ≤3 的政體(神權制):全部出邊都在樹上,不會少", async () => {
  const { cookie } = await mk("神權制", {}, false);
  const j: any = await (await get(cookie)).json();
  const transitions = j.focuses.filter((f: any) => f.id !== "regime.communist_revolution").map((f: any) => f.id).sort();
  assert.deepEqual(transitions, edgesFrom("theocracy").map((e) => e.focusId).sort());
});

test("分支表壞掉(例如線上 migration 落後)時,國策頁降級成不套用樹限制,不會整頁 500", async () => {
  const { cookie } = await mk("君主專制", {}, false);
  await pool.query("ALTER TABLE focus_branch_roots RENAME TO focus_branch_roots_bak");
  try {
    const r = await get(cookie);
    assert.equal(r.status, 200, "抽選失敗也要能讀");
    const j: any = await r.json();
    assert.ok(j.focuses.length >= 5, "降級後顯示全部出口,而不是空白");
  } finally {
    await pool.query("ALTER TABLE focus_branch_roots_bak RENAME TO focus_branch_roots");
  }
});

test("GET /focus 帶 tree:14 個節點、目前政體唯一、邊的 walkable 與清單一致", async () => {
  const { n, cookie } = await mk("君主專制", {}, false);
  const only = ["constitutional_monarchy", "theocracy"];
  await db.insert(focusBranchesTable).values(only.map((t) => ({ nationId: n.id, fromGovernment: "absolute_monarchy", toGovernment: t })));
  const j: any = await (await get(cookie)).json();
  assert.equal(j.tree.nodes.length, 14);
  assert.equal(j.tree.currentGovernment, "absolute_monarchy");
  assert.equal(j.tree.limited, true);
  assert.deepEqual(j.tree.nodes.filter((x: any) => x.isCurrent).map((x: any) => x.slug), ["absolute_monarchy"]);
  const walk = j.tree.edges.filter((e: any) => e.walkable).map((e: any) => e.to).sort();
  assert.deepEqual(walk, only.slice().sort());
  const listed = j.focuses.filter((f: any) => f.id !== "regime.communist_revolution").map((f: any) => f.id).sort();
  assert.deepEqual(j.tree.edges.filter((e: any) => e.walkable).map((e: any) => e.focusId).sort(), listed, "樹上能走的 = 清單上看得到的");
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
