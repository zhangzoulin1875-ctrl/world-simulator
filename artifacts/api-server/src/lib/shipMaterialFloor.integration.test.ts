import assert from "node:assert/strict";
import test, { after, before } from "node:test";

const { sql } = await import("drizzle-orm");
const { db, pool } = await import("@workspace/db");
const mig = await import("./militaryMigrations");
const runMig = (mig as any).runMilitaryMigrations ?? (mig as any).runMilitaryMigrationsInner ?? Object.values(mig).find((v) => typeof v === "function");

const IDS = { zero: 971, woodOnly: 972, oreOnly: 973, ok: 974, rich: 975, inf0: 976, edge2: 977 };
const ins = (id: number, cat: string, wood: number, ore: number, name: string) => db.execute(sql`
  INSERT INTO military_unit_templates (id,category,name,hp,attack,defense,speed,accuracy,range,prod_cost_per_100,pop_cost_per_unit,money_cost_per_unit,wood_cost_per_unit,ore_cost_per_unit)
  VALUES (${id},${cat},${name},100,100,25,1,50,'ranged',100,1,10,${wood},${ore})`);
async function row(id: number) {
  const r = await db.execute(sql`SELECT wood_cost_per_unit AS w, ore_cost_per_unit AS o, updated_at FROM military_unit_templates WHERE id = ${id}`);
  const x = r.rows[0] as { w: number; o: number; updated_at: string }; return { w: Number(x.w), o: Number(x.o), at: x.updated_at };
}

before(async () => {
  await runMig();
  await db.execute(sql`DELETE FROM military_unit_templates WHERE id IN (${sql.join(Object.values(IDS).map((i) => sql`${i}`), sql`,`)})`);
  await ins(IDS.zero, "ship", 0, 0, "海豹零零");
  await ins(IDS.woodOnly, "ship", 0, 10, "只缺木");
  await ins(IDS.oreOnly, "ship", 10, 1, "只缺礦");
  await ins(IDS.ok, "ship", 3, 3, "剛好合格");
  await ins(IDS.rich, "ship", 500, 900, "高成本");
  await ins(IDS.inf0, "infantry", 0, 0, "步兵零零");
  await ins(IDS.edge2, "ship", 2, 2, "差一點");
});
after(async () => {
  await db.execute(sql`DELETE FROM military_unit_templates WHERE id IN (${sql.join(Object.values(IDS).map((i) => sql`${i}`), sql`,`)})`);
  await pool.end();
});

test("遷移:現有違規的船全補到 3 木 3 礦", async () => {
  await runMig();
  assert.deepEqual([(await row(IDS.zero)).w, (await row(IDS.zero)).o], [3, 3]);
  assert.deepEqual([(await row(IDS.woodOnly)).w, (await row(IDS.woodOnly)).o], [3, 10], "只補缺的那項");
  assert.deepEqual([(await row(IDS.oreOnly)).w, (await row(IDS.oreOnly)).o], [10, 3]);
  assert.deepEqual([(await row(IDS.edge2)).w, (await row(IDS.edge2)).o], [3, 3], "2 也要補");
});
test("遷移:合格與高成本的船原值不動(只往上補,絕不拉低)", async () => {
  assert.deepEqual([(await row(IDS.ok)).w, (await row(IDS.ok)).o], [3, 3]);
  assert.deepEqual([(await row(IDS.rich)).w, (await row(IDS.rich)).o], [500, 900]);
});
test("遷移:非船艦不受影響(步兵 0 木 0 礦維持)", async () => {
  assert.deepEqual([(await row(IDS.inf0)).w, (await row(IDS.inf0)).o], [0, 0]);
});
test("遷移冪等:再跑一次不改任何值,也不更新 updated_at", async () => {
  const before = { z: await row(IDS.zero), r: await row(IDS.rich), ok: await row(IDS.ok) };
  await runMig();
  const after = { z: await row(IDS.zero), r: await row(IDS.rich), ok: await row(IDS.ok) };
  assert.deepEqual(after.z, before.z); assert.deepEqual(after.r, before.r);
  assert.equal(after.ok.at, before.ok.at, "沒違規的列不該被碰");
});
test("遷移後資料庫中不存在任何違規的船", async () => {
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM military_unit_templates WHERE category='ship' AND (wood_cost_per_unit < 3 OR ore_cost_per_unit < 3)`);
  assert.equal((r.rows[0] as { n: number }).n, 0);
});
