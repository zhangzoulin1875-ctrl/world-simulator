import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
const { eq } = await import("drizzle-orm");
const { db, pool, worldGameStateTable } = await import("@workspace/db");
const { runWorldSimMigrations } = await import("../lib/worldSimMigrations");
const { refreshCostTuning, applyCostTuning } = await import("../lib/costTuningLoad");
const { getCostTuning, setCostTuning, COST_TUNING_DEFAULT, effectivePriceScale, standardNationPopulation } = await import("../lib/nationCostScale");
const { penaltyScaleFor } = await import("../lib/penaltyScale");
const { default: app } = await import("../app");

const ADMIN = { authorization: `Bearer ${process.env["ADMIN_TOKEN"]}` };
let server: import("node:http").Server; let base = "";
let original: { costLinearPct: number; costCurvePct: number } | null = null;
let createdRow = false;

const put = (body: unknown, headers: Record<string, string> = ADMIN) =>
  fetch(`${base}/api/turn/settings`, { method: "PUT", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) });
const preview = (q: string, headers: Record<string, string> = ADMIN) => fetch(`${base}/api/turn/cost-preview${q}`, { headers: { origin: base, ...headers } });
const dbVals = async () => (await db.select({ costLinearPct: worldGameStateTable.costLinearPct, costCurvePct: worldGameStateTable.costCurvePct }).from(worldGameStateTable).where(eq(worldGameStateTable.id, 1)))[0]!;
const stdPop = (era: string) => Math.round(standardNationPopulation(era));

before(async () => {
  await runWorldSimMigrations();
  const [row] = await db.select().from(worldGameStateTable).where(eq(worldGameStateTable.id, 1));
  if (!row) { await db.insert(worldGameStateTable).values({ id: 1, currentEra: "industrial", gameDate: "1850-01-01" } as never); createdRow = true; }
  else original = { costLinearPct: row.costLinearPct, costCurvePct: row.costCurvePct };
  server = app.listen(0); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  await db.update(worldGameStateTable).set({ costLinearPct: 100, costCurvePct: 100 }).where(eq(worldGameStateTable.id, 1));
  setCostTuning(COST_TUNING_DEFAULT);
});
after(async () => {
  server.close();
  if (createdRow) await db.delete(worldGameStateTable).where(eq(worldGameStateTable.id, 1));
  else if (original) await db.update(worldGameStateTable).set(original).where(eq(worldGameStateTable.id, 1));
  setCostTuning(COST_TUNING_DEFAULT);
  await pool.end();
});

test("遷移:兩個欄位存在、預設 100、資料庫層有範圍限制(CHECK)", async () => {
  assert.deepEqual(await dbVals(), { costLinearPct: 100, costCurvePct: 100 });
  await assert.rejects(db.update(worldGameStateTable).set({ costLinearPct: 5 }).where(eq(worldGameStateTable.id, 1)), "線性 < 10 被資料庫擋");
  await assert.rejects(db.update(worldGameStateTable).set({ costLinearPct: 501 }).where(eq(worldGameStateTable.id, 1)));
  await assert.rejects(db.update(worldGameStateTable).set({ costCurvePct: 201 }).where(eq(worldGameStateTable.id, 1)));
  await assert.rejects(db.update(worldGameStateTable).set({ costCurvePct: -1 }).where(eq(worldGameStateTable.id, 1)));
});

test("未帶管理員 token:設定與預覽都 401,資料不變", async () => {
  assert.equal((await put({ costLinearPct: 300 }, {})).status, 401);
  assert.equal((await put({ costLinearPct: 300 }, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await preview("?linear=300", {})).status, 401);
  assert.deepEqual(await dbVals(), { costLinearPct: 100, costCurvePct: 100 });
  assert.deepEqual(getCostTuning(), { linearPct: 100, curvePct: 100 });
});

test("GET 設定回傳兩個旋鈕目前值", async () => {
  await db.update(worldGameStateTable).set({ costLinearPct: 150, costCurvePct: 40 }).where(eq(worldGameStateTable.id, 1));
  const j: any = await (await fetch(`${base}/api/turn/settings`, { headers: ADMIN })).json();
  assert.equal(j.settings.costLinearPct, 150); assert.equal(j.settings.costCurvePct, 40);
});

test("儲存:寫進資料庫,並且『同一個程序立刻』生效(不用重啟、不用等刷新)", async () => {
  const k0 = penaltyScaleFor(stdPop("industrial"), "industrial");
  const p0 = effectivePriceScale(148, stdPop("industrial"), "industrial");
  const r = await put({ costLinearPct: 250, costCurvePct: 60 });
  assert.equal(r.status, 200);
  assert.deepEqual(await dbVals(), { costLinearPct: 250, costCurvePct: 60 });
  assert.deepEqual(getCostTuning(), { linearPct: 250, curvePct: 60 }, "儲存後本程序立刻套用");
  const k1 = penaltyScaleFor(stdPop("industrial"), "industrial");
  assert.ok(Math.abs(k1 / k0 - 2.5) < 0.01, `事件倍率變成 2.5 倍: ${k1 / k0}`);
  assert.ok(Math.abs(effectivePriceScale(148, stdPop("industrial"), "industrial") / p0 - 2.5) < 0.01, "造價也跟著變");
});

test("只改一個旋鈕:另一個不變", async () => {
  await put({ costLinearPct: 200, costCurvePct: 80 });
  await put({ costLinearPct: 300 });
  assert.deepEqual(await dbVals(), { costLinearPct: 300, costCurvePct: 80 });
  assert.deepEqual(getCostTuning(), { linearPct: 300, curvePct: 80 });
  await put({ costCurvePct: 120 });
  assert.deepEqual(await dbVals(), { costLinearPct: 300, costCurvePct: 120 });
  assert.deepEqual(getCostTuning(), { linearPct: 300, curvePct: 120 });
});

test("邊界值可存:線性 10 / 500,函數 0 / 200", async () => {
  for (const [l, c] of [[10, 0], [500, 200], [10, 200], [500, 0]] as const) {
    assert.equal((await put({ costLinearPct: l, costCurvePct: c })).status, 200, `${l}/${c}`);
    assert.deepEqual(await dbVals(), { costLinearPct: l, costCurvePct: c });
  }
});

test("非法輸入 400 且完全不改(含資料庫與記憶體):超出範圍、小數、字串、NaN、null、布林", async () => {
  await put({ costLinearPct: 200, costCurvePct: 70 });
  const bad: unknown[] = [
    { costLinearPct: 9 }, { costLinearPct: 501 }, { costLinearPct: -1 }, { costLinearPct: 0 },
    { costCurvePct: -1 }, { costCurvePct: 201 }, { costLinearPct: 100.5 }, { costCurvePct: 99.9 },
    { costLinearPct: "300" }, { costCurvePct: "abc" }, { costLinearPct: null }, { costCurvePct: true }, { costLinearPct: [] },
    { costLinearPct: 300, costCurvePct: 999 }, // 一個合法一個非法:整筆拒絕,合法那個也不能被存
  ];
  for (const b of bad) {
    const r = await put(b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.match(((await r.json()) as any).error, /開銷/);
  }
  assert.deepEqual(await dbVals(), { costLinearPct: 200, costCurvePct: 70 }, "資料庫沒被改");
  assert.deepEqual(getCostTuning(), { linearPct: 200, curvePct: 70 }, "記憶體沒被改");
});

test("多台伺服器:另一個程序直接改了資料庫,refreshCostTuning 會把它收斂過來", async () => {
  await db.update(worldGameStateTable).set({ costLinearPct: 400, costCurvePct: 30 }).where(eq(worldGameStateTable.id, 1));
  assert.deepEqual(getCostTuning(), { linearPct: 100, curvePct: 100 }, "刷新前還是舊值");
  assert.deepEqual(await refreshCostTuning(), { linearPct: 400, curvePct: 30 });
  assert.deepEqual(getCostTuning(), { linearPct: 400, curvePct: 30 });
});

test("applyCostTuning 只更新有給的欄位,且會夾限", async () => {
  applyCostTuning({ linearPct: 150 });
  assert.deepEqual(getCostTuning(), { linearPct: 150, curvePct: 100 });
  applyCostTuning({ curvePct: 99999 });
  assert.deepEqual(getCostTuning(), { linearPct: 150, curvePct: 200 });
});

test("預覽:唯讀,不存檔也不改動生效值,即使請求之間穿插", async () => {
  await put({ costLinearPct: 120, costCurvePct: 90 });
  const j: any = await (await preview("?linear=400&curve=0")).json();
  assert.deepEqual(j.tuning, { linearPct: 400, curvePct: 0 }, "預覽用的是假設值");
  assert.deepEqual(getCostTuning(), { linearPct: 120, curvePct: 90 }, "生效值沒被預覽改走");
  assert.deepEqual(await dbVals(), { costLinearPct: 120, costCurvePct: 90 }, "資料庫沒被預覽改走");
  const many = await Promise.all([preview("?linear=10&curve=200"), preview("?linear=500&curve=0"), preview("?linear=250"), preview("")]);
  assert.ok(many.every((r) => r.status === 200));
  assert.deepEqual(getCostTuning(), { linearPct: 120, curvePct: 90 }, "並發預覽後生效值仍不變");
});

test("預覽內容:每個時代一列、數字有限、時代越後越大;線性 200% 的事件金額約為 100% 的兩倍", async () => {
  const a: any = await (await preview("?linear=100&curve=100")).json();
  const b: any = await (await preview("?linear=200&curve=100")).json();
  assert.equal(a.rows.length, 14);
  for (const r of a.rows) for (const k of ["standardTax", "event", "focus", "constitution", "report", "eventSmall", "eventLarge"]) assert.ok(Number.isFinite(r[k]) && r[k] > 0, `${r.era}.${k}`);
  for (let i = 1; i < a.rows.length; i++) assert.ok(a.rows[i].event >= a.rows[i - 1].event, a.rows[i].era);
  const ind = (j: any) => j.rows.find((r: any) => r.era === "industrial");
  assert.ok(Math.abs(ind(b).event / ind(a).event - 2) < 0.02);
  // 預設下:中後期標準國一筆平均事件約 1 回合稅收(上一輪的設計目標)
  assert.ok(ind(a).eventTurns > 0.9 && ind(a).eventTurns < 1.15, `${ind(a).eventTurns}`);
});

test("預覽:函數 0% 時,小國/大國事件價格相同;100% 時大國 > 小國", async () => {
  const flat: any = await (await preview("?linear=100&curve=0")).json();
  const norm: any = await (await preview("?linear=100&curve=100")).json();
  const m = (j: any) => j.rows.find((r: any) => r.era === "modern");
  assert.equal(m(flat).eventSmall, m(flat).eventLarge);
  assert.ok(m(norm).eventLarge > m(norm).eventSmall);
});

test("預覽收到亂參數:夾限後仍回 200,不炸", async () => {
  for (const q of ["?linear=abc&curve=xyz", "?linear=-5&curve=9999", "?linear=NaN", "?linear=&curve="]) {
    const r = await preview(q); assert.equal(r.status, 200, q);
    const j: any = await r.json(); assert.ok(j.tuning.linearPct >= 10 && j.tuning.linearPct <= 500 && j.tuning.curvePct >= 0 && j.tuning.curvePct <= 200, q);
  }
});

test("與其他回合設定共存:同一次 PUT 同時帶旋鈕與別的欄位,兩邊都存", async () => {
  const before = (await (await fetch(`${base}/api/turn/settings`, { headers: ADMIN })).json() as any).settings;
  const r = await put({ costLinearPct: 180, techMultiplierPct: before.techMultiplierPct });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as any).settings.costLinearPct, 180);
  assert.deepEqual(getCostTuning(), { linearPct: 180, curvePct: 100 });
});
