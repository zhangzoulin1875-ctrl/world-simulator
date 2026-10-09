/**
 * 油井艦隊鎖定:只算 active 戰役,結算/取消後釋放,且不同國家互不影響。
 * 需要 DATABASE_URL 且已有 player_nations / military_unit_templates(完整 schema)。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const { sql } = await import("drizzle-orm");
const { db, pool } = await import("@workspace/db");
const { runOilRigMigrationsInner } = await import("./oilRigMigrations");
const { oilLockedByTemplate } = await import("./oilRigService");

const N1 = "00000000-0000-4000-8000-0000000000a1";
const N2 = "00000000-0000-4000-8000-0000000000a2";

before(async () => {
  // 最小前置表:只含油井遷移所引用的外鍵目標
  await runOilRigMigrationsInner();
  await db.execute(sql`DELETE FROM oil_campaign_fleets`); await db.execute(sql`DELETE FROM oil_campaigns`);
  await db.execute(sql`DELETE FROM oil_scores`); await db.execute(sql`DELETE FROM oil_seasons`);
  await db.execute(sql`DELETE FROM player_nations WHERE id IN (${N1}::uuid,${N2}::uuid)`);
  await db.execute(sql`INSERT INTO player_nations (id,name,discord_user_id) VALUES (${N1}::uuid,'油井測試A','oil-lock-a'),(${N2}::uuid,'油井測試B','oil-lock-b')`);
  await db.execute(sql`DELETE FROM military_unit_templates WHERE id IN (901,902)`);
  await db.execute(sql`INSERT INTO military_unit_templates (id,category,name,hp,attack,defense,speed,accuracy,range,prod_cost_per_100,pop_cost_per_unit,money_cost_per_unit)
    VALUES (901,'ship','測試艦甲',100,10,10,1,50,'ranged',100,1,10),(902,'ship','測試艦乙',100,10,10,1,50,'ranged',100,1,10)`);
  await db.execute(sql`INSERT INTO oil_seasons (season_number,status) VALUES (1,'active')`);
  await db.execute(sql`INSERT INTO oil_rigs (slug,name,sea,lng,lat) VALUES ('t1','t1','s',0,0),('t2','t2','s',1,1) ON CONFLICT DO NOTHING`);
});
after(async () => {
  await db.execute(sql`DELETE FROM oil_campaign_fleets`); await db.execute(sql`DELETE FROM oil_campaigns`);
  await db.execute(sql`DELETE FROM oil_scores`); await db.execute(sql`DELETE FROM oil_seasons`);
  // 自己插的假油井要自己刪,否則會污染共用測試庫(階段一種子測試期望剛好 16 座)
  await db.execute(sql`DELETE FROM oil_rigs WHERE slug IN ('t1','t2')`);
  await db.execute(sql`DELETE FROM military_unit_templates WHERE id IN (901,902)`);
  await db.execute(sql`DELETE FROM player_nations WHERE id IN (${N1}::uuid,${N2}::uuid)`);
  await pool.end();
});

/** drizzle 把 pg 錯誤包成 "Failed query",約束名稱在 cause 鏈裡。 */
function causeText(e: unknown): string {
  const parts: string[] = [];
  for (let x: any = e, i = 0; x && i < 5; x = x.cause, i++) parts.push(String(x.message ?? ""), String(x.constraint ?? ""), String(x.detail ?? ""));
  return parts.join(" | ");
}

async function mk(rigSlug: string, status: string, att: string, fleets: Array<[string, string, number, number]>) {
  const c = await db.execute(sql`
    INSERT INTO oil_campaigns (season_id,rig_id,attacker_nation_id,status,settle_at)
    SELECT (SELECT id FROM oil_seasons LIMIT 1),(SELECT id FROM oil_rigs WHERE slug=${rigSlug}),${att}::uuid,${status},now()+interval '6 hours' RETURNING id`);
  const id = (c.rows[0] as { id: number }).id;
  for (const [nation, side, tpl, qty] of fleets)
    await db.execute(sql`INSERT INTO oil_campaign_fleets (campaign_id,nation_id,side,template_id,quantity) VALUES (${id},${nation}::uuid,${side},${tpl},${qty})`);
  return id;
}

test("沒有戰役 → 空 Map", async () => {
  assert.equal((await oilLockedByTemplate(N1)).size, 0);
});

test("active 戰役鎖定艦數;同兵種跨多場戰役加總", async () => {
  await mk("t1", "active", N1, [[N1, "attacker", 901, 30]]);
  assert.equal((await oilLockedByTemplate(N1)).get(901), 30);
  await db.execute(sql`UPDATE oil_campaigns SET status='settled' WHERE rig_id=(SELECT id FROM oil_rigs WHERE slug='t1')`);
  await mk("t1", "active", N1, [[N1, "attacker", 901, 20], [N1, "attacker", 902, 5]]);
  await mk("t2", "active", N1, [[N1, "attacker", 901, 7]]);
  const m = await oilLockedByTemplate(N1);
  assert.equal(m.get(901), 27, "只算兩場 active:20 + 7,不含已結算的 30");
  assert.equal(m.get(902), 5);
});

test("settled 與 cancelled 的戰役不鎖定", async () => {
  await db.execute(sql`UPDATE oil_campaigns SET status='cancelled' WHERE status='active'`);
  assert.equal((await oilLockedByTemplate(N1)).size, 0);
});

test("不同國家互不影響;防守方投入的艦隊也算在該國名下", async () => {
  await db.execute(sql`DELETE FROM oil_campaign_fleets`); await db.execute(sql`DELETE FROM oil_campaigns`);
  await mk("t1", "active", N1, [[N1, "attacker", 901, 10], [N2, "defender", 901, 4]]);
  assert.equal((await oilLockedByTemplate(N1)).get(901), 10);
  assert.equal((await oilLockedByTemplate(N2)).get(901), 4);
});

test("同一座油井不能同時有兩場 active(部分唯一索引)", async () => {
  await assert.rejects(() => mk("t1", "active", N2, [[N2, "attacker", 901, 1]]), (e: unknown) => causeText(e).includes("oil_campaigns_one_active_per_rig_uidx"));
});

test("投入量必須為正(CHECK)", async () => {
  await db.execute(sql`DELETE FROM oil_campaign_fleets`); await db.execute(sql`DELETE FROM oil_campaigns`);
  await assert.rejects(() => mk("t2", "active", N1, [[N1, "attacker", 901, 0]]), (e: unknown) => causeText(e).includes("oil_campaign_fleets_qty_check"));
});

test("在交易內讀取也正確(陸戰在交易內呼叫)", async () => {
  await db.execute(sql`DELETE FROM oil_campaign_fleets`); await db.execute(sql`DELETE FROM oil_campaigns`);
  await mk("t2", "active", N1, [[N1, "attacker", 902, 9]]);
  const got = await db.transaction(async (tx) => oilLockedByTemplate(N1, tx));
  assert.equal(got.get(902), 9);
});

test("缺表時大聲失敗(不靜默放行重複派兵)", async () => {
  // 不真的改表名(會污染共用測試庫);用不存在的 schema 前綴模擬查詢失敗
  const broken = { execute: async () => { throw new Error('relation "oil_campaign_fleets" does not exist'); } } as unknown as Parameters<typeof oilLockedByTemplate>[1];
  await assert.rejects(() => oilLockedByTemplate(N1, broken), /does not exist/);
});
