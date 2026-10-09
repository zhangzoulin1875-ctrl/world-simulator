import assert from "node:assert/strict";
import test, { after, before } from "node:test";

process.env.ADMIN_TOKEN = "test-admin-token-xyz";
const { sql } = await import("drizzle-orm");
const { db, pool } = await import("@workspace/db");
const express = (await import("express")).default;
const { runMilitaryMigrations } = await import("../lib/militaryMigrations");
const router = (await import("./militaryAdmin")).default;

const SHIP = 981, INF = 982;
let server: import("node:http").Server; let base = "";
async function patch(id: number, body: unknown, token: string | null = "test-admin-token-xyz") {
  const r = await fetch(`${base}/military-admin/templates/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json", ...(token ? { "x-admin-token": token } : {}) }, body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
async function row(id: number) {
  const r = await db.execute(sql`SELECT wood_cost_per_unit AS w, ore_cost_per_unit AS o, hp FROM military_unit_templates WHERE id = ${id}`);
  const x = r.rows[0] as { w: number; o: number; hp: number }; return { w: Number(x.w), o: Number(x.o), hp: Number(x.hp) };
}
const reset = async () => {
  await db.execute(sql`DELETE FROM military_unit_templates WHERE id IN (${SHIP},${INF})`);
  const ins = (id: number, cat: string) => db.execute(sql`INSERT INTO military_unit_templates (id,category,name,hp,attack,defense,speed,accuracy,range,prod_cost_per_100,pop_cost_per_unit,money_cost_per_unit,wood_cost_per_unit,ore_cost_per_unit)
    VALUES (${id},${cat},${"管理員測試" + id},100,100,25,1,50,'ranged',100,1,10,5,5)`);
  await ins(SHIP, "ship"); await ins(INF, "infantry");
};

before(async () => {
  await runMilitaryMigrations();
  const app = express(); app.use(express.json());
  // 正式環境由 pino-http 提供 req.log;測試 app 沒有,補一個空殼(否則成功路徑的 req.log.info 會拋例外變 500)。
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {} }; next(); });
  app.use(router);
  await new Promise<void>((ok) => { server = app.listen(0, () => ok()); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await db.execute(sql`DELETE FROM military_unit_templates WHERE id IN (${SHIP},${INF})`);
  await new Promise((ok) => server.close(ok)); await pool.end();
});

test("船:木材改成 0 → 400 SHIP_MATERIAL_FLOOR,資料不變", async () => {
  await reset();
  const r = await patch(SHIP, { woodCostPerUnit: 0 });
  assert.equal(r.status, 400); assert.equal(r.json.code, "SHIP_MATERIAL_FLOOR"); assert.match(r.json.error, /木材.*至少 3/);
  assert.deepEqual(await row(SHIP), { w: 5, o: 5, hp: 100 });
});
test("船:礦石改成 2 → 400;改成剛好 3 → 放行", async () => {
  await reset();
  const bad = await patch(SHIP, { oreCostPerUnit: 2 }); assert.equal(bad.status, 400); assert.match(bad.json.error, /礦石.*至少 3/);
  const ok = await patch(SHIP, { oreCostPerUnit: 3 }); assert.equal(ok.status, 200); assert.equal((await row(SHIP)).o, 3);
});
test("船:同時把兩項改成 0 → 400,兩項都不變", async () => {
  await reset();
  const r = await patch(SHIP, { woodCostPerUnit: 0, oreCostPerUnit: 0 });
  assert.equal(r.status, 400); assert.deepEqual(await row(SHIP), { w: 5, o: 5, hp: 100 });
});
test("船:木材合法、礦石違規 → 整筆拒絕,不會只寫入合法的那一半", async () => {
  await reset();
  const r = await patch(SHIP, { woodCostPerUnit: 9, oreCostPerUnit: 0 });
  assert.equal(r.status, 400); assert.deepEqual(await row(SHIP), { w: 5, o: 5, hp: 100 });
});
test("船:只改別的欄位(HP)不被木礦檢查擋下,即使舊資料本來違規也不受影響", async () => {
  await reset();
  await db.execute(sql`UPDATE military_unit_templates SET wood_cost_per_unit = 0, ore_cost_per_unit = 0 WHERE id = ${SHIP}`);
  const r = await patch(SHIP, { hp: 777 });
  assert.equal(r.status, 200); assert.equal((await row(SHIP)).hp, 777);
});
test("船:提高木礦(5→50)放行", async () => {
  await reset();
  const r = await patch(SHIP, { woodCostPerUnit: 50, oreCostPerUnit: 60 });
  assert.equal(r.status, 200); const x = await row(SHIP); assert.deepEqual([x.w, x.o], [50, 60]);
});
test("非船艦:可改成 0 木 0 礦(規則只針對船)", async () => {
  await reset();
  const r = await patch(INF, { woodCostPerUnit: 0, oreCostPerUnit: 0 });
  assert.equal(r.status, 200); const x = await row(INF); assert.deepEqual([x.w, x.o], [0, 0]);
});
test("沒帶或帶錯管理員 token → 401,且不會因下限檢查洩漏資訊", async () => {
  await reset();
  assert.equal((await patch(SHIP, { woodCostPerUnit: 0 }, null)).status, 401);
  assert.equal((await patch(SHIP, { woodCostPerUnit: 0 }, "wrong")).status, 401);
});
test("不存在的模板 → 404(先於下限檢查)", async () => {
  assert.equal((await patch(999999, { woodCostPerUnit: 0 })).status, 404);
});
