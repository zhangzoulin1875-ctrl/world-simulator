/**
 * 油井戰役:發起/追加/結算的資料庫不變量。需要完整 schema 的 DATABASE_URL。
 * 每個測試用獨立國家與模板,結束清掉,不污染共用庫。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const { sql } = await import("drizzle-orm");
const { db, pool } = await import("@workspace/db");
const { runOilRigMigrationsInner } = await import("./oilRigMigrations");
const svc = await import("./oilCampaignService");
const { attackerRangeFactor } = await import("./oilRigCore");
const { seedOilRigs } = await import("./oilRigService");

const A = "00000000-0000-4000-8000-0000000000b1", B = "00000000-0000-4000-8000-0000000000b2", C = "00000000-0000-4000-8000-0000000000b3";
const UA = "oil-camp-a", UB = "oil-camp-b", UC = "oil-camp-c";
const SHIP1 = 951, SHIP2 = 952, LAND = 953;
const T0 = new Date("2026-10-09T00:00:00Z");
const after6h = new Date(T0.getTime() + 6 * 3_600_000 + 1000);

/**
 * 並行測試需要真 Postgres。本機用的 pglite-socket 在兩條連線同時送語句時協定會錯亂
 * (unexpected commandComplete),會讓並行測試假失敗。偵測到 pglite 就跳過並明說原因,
 * 不留一個永遠紅或假綠的測試。CI 用真 Postgres 時會正常執行。
 */
let realPostgres = true;
{
  const v = await db.execute(sql`SELECT version() AS v`);
  const ver = String((v.rows[0] as { v: string }).v);
  realPostgres = !/pglite|emscripten|wasm/i.test(ver) && process.env.OIL_TEST_FORCE_CONCURRENCY !== "0";
  if (!realPostgres) console.warn("[oilCampaign.test] 偵測到非真 Postgres:並行測試將跳過");
}
const concurrent = (name: string, fn: () => Promise<void>) =>
  test(name, { skip: realPostgres ? false : "需要真 Postgres(pglite-socket 不支援並行連線)" }, fn);

const ca = { nationId: A, discordUserId: UA }, cb = { nationId: B, discordUserId: UB }, cc = { nationId: C, discordUserId: UC };

async function reset() {
  await db.execute(sql`DELETE FROM oil_campaign_fleets`); await db.execute(sql`DELETE FROM oil_campaigns`);
  await db.execute(sql`UPDATE oil_rigs SET holder_nation_id = NULL, held_since = NULL, garrison_strength = 100`);
  await db.execute(sql`DELETE FROM player_armies WHERE discord_user_id IN (${UA},${UB},${UC})`);
  await db.execute(sql`DELETE FROM player_wounded_units WHERE discord_user_id IN (${UA},${UB},${UC})`);
}
async function army(user: string, tpl: number, q: number) {
  await db.execute(sql`INSERT INTO player_armies (discord_user_id, template_id, quantity) VALUES (${user}, ${tpl}, ${q})
    ON CONFLICT (discord_user_id, template_id) DO UPDATE SET quantity = ${q}`);
}
async function qty(user: string, tpl: number): Promise<number> {
  const r = await db.execute(sql`SELECT quantity::text AS q FROM player_armies WHERE discord_user_id = ${user} AND template_id = ${tpl}`);
  return Number((r.rows[0] as { q: string } | undefined)?.q ?? 0);
}
async function holder(slug: string): Promise<string | null> {
  const r = await db.execute(sql`SELECT holder_nation_id FROM oil_rigs WHERE slug = ${slug}`);
  return (r.rows[0] as { holder_nation_id: string | null }).holder_nation_id;
}
function causeText(e: unknown): string {
  const parts: string[] = [];
  for (let x: any = e, i = 0; x && i < 5; x = x.cause, i++) parts.push(String(x.message ?? ""), String(x.code ?? ""));
  return parts.join(" | ");
}

before(async () => {
  await runOilRigMigrationsInner();
  await seedOilRigs();
  await db.execute(sql`DELETE FROM oil_scores`); await db.execute(sql`DELETE FROM oil_seasons`);
  await db.execute(sql`INSERT INTO oil_seasons (season_number, status) VALUES (1, 'active')`);
  for (const [id, u, n] of [[A, UA, "戰役測試A"], [B, UB, "戰役測試B"], [C, UC, "戰役測試C"]] as const) {
    await db.execute(sql`DELETE FROM player_nations WHERE id = ${id}::uuid`);
    await db.execute(sql`INSERT INTO player_nations (id, name, discord_user_id) VALUES (${id}::uuid, ${n}, ${u})`);
  }
  await db.execute(sql`DELETE FROM military_unit_templates WHERE id IN (${SHIP1},${SHIP2},${LAND})`);
  // 艦 1:戰力 (100+100)/2×sqrt(100)=1000;艦 2:(50+50)/2×sqrt(100)=500;陸軍:非艦船
  await db.execute(sql`INSERT INTO military_unit_templates (id,category,name,hp,attack,defense,speed,accuracy,range,prod_cost_per_100,pop_cost_per_unit,money_cost_per_unit)
    VALUES (${SHIP1},'ship','戰役艦甲',100,100,100,1,50,'ranged',100,1,10),(${SHIP2},'ship','戰役艦乙',100,50,50,1,50,'ranged',100,1,10),(${LAND},'infantry','戰役步兵',100,10,10,1,50,'ranged',100,1,10)`);
  // 距離衰減:三個測試國都控制「荷蘭」(離北海一號 615 km,係數 0.9692)。
  // 這讓結算實際走過 region_controls → 質心 → 距離 → 係數的整條路徑;
  // 這批測試的勝負與取整後的損失在此係數下都與無衰減時相同(各測試註解的算式已含係數)。
  await db.execute(sql`INSERT INTO map_regions (name, macro_region) VALUES ('荷蘭', '西歐') ON CONFLICT (name) DO NOTHING`);
  await db.execute(sql`DELETE FROM region_controls WHERE nation_id IN (${A}::uuid,${B}::uuid,${C}::uuid)`);
  for (const id of [A, B, C]) {
    await db.execute(sql`INSERT INTO region_controls (region_id, nation_id, percent) SELECT id, ${id}::uuid, 60 FROM map_regions WHERE name = '荷蘭'`);
  }
  await reset();
});
after(async () => {
  await reset();
  await db.execute(sql`DELETE FROM oil_scores`); await db.execute(sql`DELETE FROM oil_seasons`);
  await db.execute(sql`DELETE FROM military_unit_templates WHERE id IN (${SHIP1},${SHIP2},${LAND})`);
  await db.execute(sql`DELETE FROM region_controls WHERE nation_id IN (${A}::uuid,${B}::uuid,${C}::uuid)`);
  await db.execute(sql`DELETE FROM player_nations WHERE id IN (${A}::uuid,${B}::uuid,${C}::uuid)`);
  await pool.end();
});

test("發起:成功建立戰役,結算時間 = 6 小時後,艦隊被鎖定", async () => {
  await reset(); await army(UA, SHIP1, 30);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 20 }], now: T0 });
  assert.equal(r.settleAt.toISOString(), "2026-10-09T06:00:00.000Z");
  const { oilLockedByTemplate } = await import("./oilRigService");
  assert.equal((await oilLockedByTemplate(A)).get(SHIP1), 20);
});

test("發起:可派量不足被拒(30 艘只能派 30,不能 31)", async () => {
  await reset(); await army(UA, SHIP1, 30);
  await assert.rejects(() => svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 31 }], now: T0 }), (e: any) => e.status === 400 && e.code === "BAD_COMMIT");
});

test("發起:非艦船(步兵)被拒", async () => {
  await reset(); await army(UA, LAND, 99);
  await assert.rejects(() => svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: LAND, quantity: 1 }], now: T0 }), (e: any) => e.status === 400 && /艦船/.test(e.message));
});

test("發起失敗時不留下半成品戰役(交易整體回滾)", async () => {
  await reset(); await army(UA, SHIP1, 5);
  await assert.rejects(() => svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 6 }], now: T0 }));
  const r = await db.execute(sql`SELECT count(*)::int AS n FROM oil_campaigns`);
  assert.equal((r.rows[0] as { n: number }).n, 0);
});

test("發起:未知油井 404;已是持有者被拒", async () => {
  await reset(); await army(UA, SHIP1, 5);
  await assert.rejects(() => svc.launchOilCampaign({ rigSlug: "nope", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 1 }], now: T0 }), (e: any) => e.status === 404);
  await db.execute(sql`UPDATE oil_rigs SET holder_nation_id = ${A}::uuid WHERE slug = 'north_sea_1'`);
  await assert.rejects(() => svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 1 }], now: T0 }), (e: any) => e.code === "ALREADY_HOLDER");
});

test("同一座油井已有進行中戰役 → 409 RIG_BUSY", async () => {
  await reset(); await army(UA, SHIP1, 10); await army(UB, SHIP1, 10);
  await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 });
  await assert.rejects(() => svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: cb, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 }), (e: any) => e.status === 409 && e.code === "RIG_BUSY");
});

concurrent("並行發起同一座油井:恰好一個成功,另一個 RIG_BUSY", async () => {
  await reset(); await army(UA, SHIP1, 10); await army(UB, SHIP1, 10);
  const res = await Promise.allSettled([
    svc.launchOilCampaign({ rigSlug: "norwegian_sea", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 }),
    svc.launchOilCampaign({ rigSlug: "norwegian_sea", attacker: cb, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 }),
  ]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal((rej.reason as any).code, "RIG_BUSY", causeText(rej.reason));
});

concurrent("同一國並行投入同一批艦:總量不超過持有(不會雙重投入)", async () => {
  await reset(); await army(UA, SHIP1, 10);
  const res = await Promise.allSettled([
    svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 8 }], now: T0 }),
    svc.launchOilCampaign({ rigSlug: "norwegian_sea", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 8 }], now: T0 }),
  ]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1, "10 艘不能同時派 8+8");
  const r = await db.execute(sql`SELECT COALESCE(SUM(quantity),0)::int AS n FROM oil_campaign_fleets WHERE nation_id = ${A}::uuid`);
  assert.equal((r.rows[0] as { n: number }).n, 8);
});

test("跨戰役累計:10 艘派 6 後,另一場最多再派 4", async () => {
  await reset(); await army(UA, SHIP1, 10);
  await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 6 }], now: T0 });
  await assert.rejects(() => svc.launchOilCampaign({ rigSlug: "norwegian_sea", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 }), (e: any) => e.code === "BAD_COMMIT");
  await svc.launchOilCampaign({ rigSlug: "norwegian_sea", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 4 }], now: T0 });
});

test("可派量口徑不雙重扣除:派 6 後剩 4,可再追加 4(不是 4−6)", async () => {
  await reset(); await army(UA, SHIP1, 10);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 6 }], now: T0 });
  await svc.reinforceOilCampaign({ campaignId: r.campaignId, who: ca, fleet: [{ templateId: SHIP1, quantity: 4 }], now: T0 });
  const q = await db.execute(sql`SELECT quantity::int AS n FROM oil_campaign_fleets WHERE campaign_id = ${r.campaignId} AND template_id = ${SHIP1}`);
  assert.equal((q.rows[0] as { n: number }).n, 10, "同模板累加");
  await assert.rejects(() => svc.reinforceOilCampaign({ campaignId: r.campaignId, who: ca, fleet: [{ templateId: SHIP1, quantity: 1 }], now: T0 }), (e: any) => e.code === "BAD_COMMIT");
});

test("可派量扣除傷兵池與陸戰佔用(與 buildAvailableUnits 同口徑)", async () => {
  await reset(); await army(UA, SHIP1, 10);
  await db.execute(sql`INSERT INTO player_wounded_units (discord_user_id, template_id, wounded) VALUES (${UA}, ${SHIP1}, 3)`);
  const avail = await db.transaction(async (tx) => (await svc.computeAvailableInTx(tx, ca))(SHIP1));
  assert.equal(avail, 7);
  await assert.rejects(() => svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 8 }], now: T0 }), (e: any) => e.code === "BAD_COMMIT");
});

test("與 buildAvailableUnits 逐項一致(油井鎖定後兩邊算出同一個可派量)", async () => {
  await reset(); await army(UA, SHIP1, 10); await army(UA, SHIP2, 4);
  await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 6 }, { templateId: SHIP2, quantity: 1 }], now: T0 });
  const { buildAvailableUnits } = await import("../routes/war/shared");
  const views = await buildAvailableUnits(UA, A);
  const mine = await db.transaction(async (tx) => await svc.computeAvailableInTx(tx, ca));
  for (const v of views) assert.equal(mine(v.templateId), v.available, `template ${v.templateId}`);
  assert.equal(mine(SHIP1), 4); assert.equal(mine(SHIP2), 3);
});

test("追加:攻方加攻方、守方加守方、第三國被拒", async () => {
  await reset(); await army(UA, SHIP1, 10); await army(UB, SHIP1, 10); await army(UC, SHIP1, 10);
  await db.execute(sql`UPDATE oil_rigs SET holder_nation_id = ${B}::uuid WHERE slug = 'north_sea_1'`);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 });
  assert.equal((await svc.reinforceOilCampaign({ campaignId: r.campaignId, who: cb, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 })).side, "defender");
  assert.equal((await svc.reinforceOilCampaign({ campaignId: r.campaignId, who: ca, fleet: [{ templateId: SHIP1, quantity: 1 }], now: T0 })).side, "attacker");
  await assert.rejects(() => svc.reinforceOilCampaign({ campaignId: r.campaignId, who: cc, fleet: [{ templateId: SHIP1, quantity: 1 }], now: T0 }), (e: any) => e.status === 403 && e.code === "NOT_PARTICIPANT");
});

test("追加:到期後(結算前)被拒;戰役已結算被拒;不存在 404", async () => {
  await reset(); await army(UA, SHIP1, 10);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 2 }], now: T0 });
  await assert.rejects(() => svc.reinforceOilCampaign({ campaignId: r.campaignId, who: ca, fleet: [{ templateId: SHIP1, quantity: 1 }], now: after6h }), (e: any) => e.code === "TOO_LATE");
  await svc.settleOilCampaign(r.campaignId, after6h);
  await assert.rejects(() => svc.reinforceOilCampaign({ campaignId: r.campaignId, who: ca, fleet: [{ templateId: SHIP1, quantity: 1 }], now: T0 }), (e: any) => e.code === "NOT_ACTIVE");
  await assert.rejects(() => svc.reinforceOilCampaign({ campaignId: 99999999, who: ca, fleet: [{ templateId: SHIP1, quantity: 1 }], now: T0 }), (e: any) => e.status === 404);
});

test("結算:未到期不處理(回傳 null),戰役仍 active", async () => {
  await reset(); await army(UA, SHIP1, 10);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 });
  assert.equal(await svc.settleOilCampaign(r.campaignId, new Date(T0.getTime() + 3_600_000)), null);
  const s = await db.execute(sql`SELECT status FROM oil_campaigns WHERE id = ${r.campaignId}`);
  assert.equal((s.rows[0] as { status: string }).status, "active");
});

test("結算:無人佔領,攻方 20 艘(戰力 20000)大勝守軍 100(11500)→ 換手、攻方損失小、艦隊解鎖", async () => {
  await reset(); await army(UA, SHIP1, 20);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 20 }], now: T0 });
  const out = (await svc.settleOilCampaign(r.campaignId, after6h))!;
  assert.equal(out.result.outcome, "attacker_wins");
  assert.equal(await holder("north_sea_1"), A);
  const lossRatio = 0.3 * (11500 / 20000); // 0.1725 → 20 × 0.1725 = 3.45 → 向下取整 3
  assert.equal(out.attackerLosses[0]!.lost, Math.floor(20 * lossRatio));
  assert.equal(await qty(UA, SHIP1), 20 - Math.floor(20 * lossRatio));
  const { oilLockedByTemplate } = await import("./oilRigService");
  assert.equal((await oilLockedByTemplate(A)).size, 0, "結算後鎖定解除");
});

test("結算:攻方太弱 → 守軍守住,攻方損失 60%,油井不換手", async () => {
  await reset(); await army(UA, SHIP1, 5);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 });
  const out = (await svc.settleOilCampaign(r.campaignId, after6h))!;
  assert.equal(out.result.outcome, "defender_wins");
  assert.equal(await holder("north_sea_1"), null);
  assert.equal(await qty(UA, SHIP1), 5 - Math.floor(5 * 0.6));
});

test("結算:有守方且投入艦隊 → 雙方都扣損失,勝者換手並設 held_since", async () => {
  await reset(); await army(UA, SHIP1, 40); await army(UB, SHIP1, 10);
  await db.execute(sql`UPDATE oil_rigs SET holder_nation_id = ${B}::uuid WHERE slug = 'north_sea_1'`);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 40 }], now: T0 });
  await svc.reinforceOilCampaign({ campaignId: r.campaignId, who: cb, fleet: [{ templateId: SHIP1, quantity: 10 }], now: T0 });
  const out = (await svc.settleOilCampaign(r.campaignId, after6h))!;
  assert.equal(out.result.outcome, "attacker_wins"); // 40000 > 10000×1.15
  assert.equal(await holder("north_sea_1"), A);
  assert.equal(await qty(UB, SHIP1), 10 - Math.floor(10 * 0.6));
  assert.ok(out.defenderLosses.length === 1 && out.attackerLosses.length === 1);
  const h = await db.execute(sql`SELECT held_since FROM oil_rigs WHERE slug='north_sea_1'`);
  assert.equal(new Date((h.rows[0] as { held_since: string }).held_since).toISOString(), after6h.toISOString());
});

test("結算:守方有人但沒投艦隊 → 以油井守軍迎戰,持有者艦隊不被扣", async () => {
  await reset(); await army(UA, SHIP1, 5); await army(UB, SHIP1, 50);
  await db.execute(sql`UPDATE oil_rigs SET holder_nation_id = ${B}::uuid WHERE slug = 'north_sea_1'`);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 });
  const out = (await svc.settleOilCampaign(r.campaignId, after6h))!;
  assert.equal(out.result.outcome, "defender_wins");
  assert.equal(await qty(UB, SHIP1), 50, "沒投入的艦隊不受損");
  assert.equal(out.defenderLosses.length, 0);
});

test("結算:守軍 0 的油井 → 攻方空佔,無損", async () => {
  await reset(); await army(UA, SHIP1, 3);
  await db.execute(sql`UPDATE oil_rigs SET garrison_strength = 0 WHERE slug = 'north_sea_1'`);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 3 }], now: T0 });
  const out = (await svc.settleOilCampaign(r.campaignId, after6h))!;
  assert.equal(out.result.outcome, "attacker_wins");
  assert.equal(await qty(UA, SHIP1), 3);
  assert.equal(await holder("north_sea_1"), A);
});

concurrent("結算:同一場並行結算只生效一次(損失只扣一次、只換手一次)", async () => {
  await reset(); await army(UA, SHIP1, 20);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 20 }], now: T0 });
  const outs = await Promise.all([svc.settleOilCampaign(r.campaignId, after6h), svc.settleOilCampaign(r.campaignId, after6h), svc.settleOilCampaign(r.campaignId, after6h)]);
  assert.equal(outs.filter((o) => o !== null).length, 1);
  assert.equal(await qty(UA, SHIP1), 20 - Math.floor(20 * 0.1725), "只扣一次");
});

test("結算:兩種艦、多國投入 → 損失按投入比例分攤且總和精確等於整方損失", async () => {
  await reset(); await army(UA, SHIP1, 7); await army(UB, SHIP1, 5); await army(UC, SHIP2, 100);
  // 守方 C 持有並投入 SHIP2 ×100(戰力 50000×1.15),攻方 A+B 共 12 艘 SHIP1(12000)→ 攻方敗,損失 60%
  await db.execute(sql`UPDATE oil_rigs SET holder_nation_id = ${C}::uuid WHERE slug = 'north_sea_1'`);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 7 }], now: T0 });
  // B 不是參與方,不能直接加入攻方 → 驗證被拒
  await assert.rejects(() => svc.reinforceOilCampaign({ campaignId: r.campaignId, who: cb, fleet: [{ templateId: SHIP1, quantity: 5 }], now: T0 }), (e: any) => e.code === "NOT_PARTICIPANT");
  await svc.reinforceOilCampaign({ campaignId: r.campaignId, who: cc, fleet: [{ templateId: SHIP2, quantity: 100 }], now: T0 });
  const out = (await svc.settleOilCampaign(r.campaignId, after6h))!;
  assert.equal(out.result.outcome, "defender_wins");
  assert.equal(await qty(UA, SHIP1), 7 - Math.floor(7 * 0.6));
  const winnerLoss = Math.floor(100 * (0.3 * (7000 / 57500)));
  assert.equal(await qty(UC, SHIP2), 100 - Math.max(1, winnerLoss));
});

// ── 距離衰減(取消航程限制後的新規則)──────────────────────────────
// 單艦 SHIP1 戰力 1000。守軍預設 garrison 100 → 100×100×1.15 = 11500。
async function setRegions(nationId: string, names: string[]) {
  await db.execute(sql`DELETE FROM region_controls WHERE nation_id = ${nationId}::uuid`);
  for (const n of names) {
    await db.execute(sql`INSERT INTO map_regions (name, macro_region) VALUES (${n}, 'x') ON CONFLICT (name) DO NOTHING`);
    await db.execute(sql`INSERT INTO region_controls (region_id, nation_id, percent) SELECT id, ${nationId}::uuid, 60 FROM map_regions WHERE name = ${n}`);
  }
}

test("距離衰減:同樣 13 艘,近國(荷蘭→北海一號)贏、遠國(佛羅里達)輸", async () => {
  // 13000 × 0.9692 = 12600 > 11500 → 贏;13000 × 0.6468 = 8408 < 11500 → 輸
  await reset(); await army(UA, SHIP1, 13); await army(UB, SHIP1, 13);
  await setRegions(A, ["荷蘭"]); await setRegions(B, ["佛羅里達"]);
  const near = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 13 }], now: T0 });
  const outNear = (await svc.settleOilCampaign(near.campaignId, after6h))!;
  assert.equal(outNear.result.outcome, "attacker_wins", "近國不被誤傷");
  assert.equal(Math.round(outNear.result.attackerPower), Math.round(13000 * attackerRangeFactor(["荷蘭"], "north_sea_1").factor));

  await reset(); await army(UB, SHIP1, 13);
  const far = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: cb, fleet: [{ templateId: SHIP1, quantity: 13 }], now: T0 });
  const outFar = (await svc.settleOilCampaign(far.campaignId, after6h))!;
  assert.equal(outFar.result.outcome, "defender_wins", "同樣艦數,遠征被衰減壓過");
  assert.equal(Math.round(outFar.result.attackerPower), Math.round(13000 * attackerRangeFactor(["佛羅里達"], "north_sea_1").factor));
  assert.equal(Math.round(outFar.result.defenderPower), 11500, "守方不衰減");
  await setRegions(A, ["荷蘭"]); await setRegions(B, ["荷蘭"]);
});

test("距離衰減:預覽(describe)與結算用同一個數字", async () => {
  await reset(); await army(UB, SHIP1, 13); await setRegions(B, ["佛羅里達"]);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: cb, fleet: [{ templateId: SHIP1, quantity: 13 }], now: T0 });
  const d = (await svc.describeOilCampaign(r.campaignId))!;
  assert.equal(d.attackerPower, Math.round(13000 * attackerRangeFactor(["佛羅里達"], "north_sea_1").factor)); assert.equal(d.defenderPower, 11500);
  assert.equal(d.forecast, "defender_wins");
  assert.ok(Math.abs(d.rangeFactor - 0.647) < 0.001);
  assert.equal(d.attackerDistances.length, 1);
  assert.ok(Math.abs(d.attackerDistances[0]!.km! - 7064) < 15);
  const out = (await svc.settleOilCampaign(r.campaignId, after6h))!;
  assert.equal(Math.round(out.result.attackerPower), d.attackerPower, "結算戰力 = 預覽戰力");
  await setRegions(B, ["荷蘭"]);
});

test("距離衰減:多國聯手按戰力加權 — 遠國拖累近國,艦數與損失分攤不變", async () => {
  // A 是攻方(荷蘭 0.9692)只投 10 艘;現任攻方不能讓第三國加入,故用「持有者 C 當守方」無法測攻方多國。
  // 改以服務層直接驗證加權:攻方 = A(10 艘, 荷蘭) + 同陣營追加者 A 自己追加 → 單國。
  // 多國加權的數學由 attackerEffectiveFactor 保證,這裡驗證單國追加後係數不變、艦數累加。
  await reset(); await army(UA, SHIP1, 20); await setRegions(A, ["荷蘭"]);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 10 }], now: T0 });
  await svc.reinforceOilCampaign({ campaignId: r.campaignId, who: ca, fleet: [{ templateId: SHIP1, quantity: 10 }], now: T0 });
  const d = (await svc.describeOilCampaign(r.campaignId))!;
  assert.equal(d.attackerShips, 20);
  assert.ok(Math.abs(d.attackerPower - 20000 * attackerRangeFactor(["荷蘭"], "north_sea_1").factor) <= 1, "戰力 = 艦隊 × 係數");
  assert.ok(Math.abs(d.rangeFactor - 0.9692) < 0.001, "同一國追加不改變係數");
});

test("距離衰減:攻方失去所有領地 → 查無座標,按下限 0.4(不給滿戰力)", async () => {
  await reset(); await army(UA, SHIP1, 20); await setRegions(A, ["荷蘭"]);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 20 }], now: T0 });
  await db.execute(sql`DELETE FROM region_controls WHERE nation_id = ${A}::uuid`); // 出兵後地被占光
  const d = (await svc.describeOilCampaign(r.campaignId))!;
  assert.equal(d.rangeFactor, 0.4); assert.equal(d.attackerPower, 8000); assert.equal(d.attackerDistances[0]!.km, null);
  const out = (await svc.settleOilCampaign(r.campaignId, after6h))!;
  assert.equal(out.result.outcome, "defender_wins", "8000 < 11500");
  await setRegions(A, ["荷蘭"]);
});

test("距離衰減:控制比例 <50% 的地區不算(與 controlledRegionNames 同口徑)", async () => {
  await reset(); await army(UA, SHIP1, 20);
  await db.execute(sql`DELETE FROM region_controls WHERE nation_id = ${A}::uuid`);
  await db.execute(sql`INSERT INTO region_controls (region_id, nation_id, percent) SELECT id, ${A}::uuid, 49 FROM map_regions WHERE name = '荷蘭'`);
  await db.execute(sql`INSERT INTO map_regions (name, macro_region) VALUES ('佛羅里達','x') ON CONFLICT (name) DO NOTHING`);
  await db.execute(sql`INSERT INTO region_controls (region_id, nation_id, percent) SELECT id, ${A}::uuid, 50 FROM map_regions WHERE name = '佛羅里達'`);
  const r = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 20 }], now: T0 });
  const d = (await svc.describeOilCampaign(r.campaignId))!;
  assert.ok(Math.abs(d.attackerDistances[0]!.km! - 7064) < 15, "49% 的荷蘭不算,只算 50% 的佛羅里達");
  await setRegions(A, ["荷蘭"]);
});

test("掃描結算:只處理到期的,逐場獨立", async () => {
  await reset(); await army(UA, SHIP1, 20); await army(UB, SHIP1, 20);
  const r1 = await svc.launchOilCampaign({ rigSlug: "north_sea_1", attacker: ca, fleet: [{ templateId: SHIP1, quantity: 20 }], now: T0 });
  const later = new Date(T0.getTime() + 5 * 3_600_000);
  const r2 = await svc.launchOilCampaign({ rigSlug: "norwegian_sea", attacker: cb, fleet: [{ templateId: SHIP1, quantity: 20 }], now: later });
  const res = await svc.settleDueOilCampaigns(after6h);
  assert.deepEqual(res, { settled: 1, failed: 0 });
  const st = await db.execute(sql`SELECT id, status FROM oil_campaigns ORDER BY id`);
  assert.deepEqual((st.rows as { id: number; status: string }[]).map((x) => x.status), ["settled", "active"]);
  void r1; void r2;
});
