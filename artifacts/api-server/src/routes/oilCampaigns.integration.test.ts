/** 油井戰役路由:用真實 session cookie 打真實路由。需要完整 schema 的 DATABASE_URL。 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set");
const { sql } = await import("drizzle-orm");
const { db, pool } = await import("@workspace/db");
const express = (await import("express")).default;
const cookieParser = (await import("cookie-parser")).default;
const { runOilRigMigrationsInner } = await import("../lib/oilRigMigrations");
const { seedOilRigs } = await import("../lib/oilRigService");
const { createSession, SESSION_COOKIE_NAME } = await import("../lib/sessions");
const router = (await import("./oilCampaigns")).default;
const { attackerRangeFactor } = await import("../lib/oilRigCore");

const N = "00000000-0000-4000-8000-0000000000d1", U = "oil-route-u";
const SHIP = 961;
let server: http.Server, base = "", cookie = "";
let savedEra: { rows: Array<{ current_era: string }> } | null = null;
async function setEra(era: string) {
  await db.execute(sql`UPDATE world_game_state SET current_era = ${era} WHERE id = 1`);
}

async function call(method: string, path: string, body?: unknown, withCookie = true) {
  const r = await fetch(base + path, {
    method, headers: { "content-type": "application/json", ...(withCookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
async function setup(regions: string[], techs: boolean) {
  await db.execute(sql`DELETE FROM oil_campaign_fleets`); await db.execute(sql`DELETE FROM oil_campaigns`);
  await db.execute(sql`UPDATE oil_rigs SET holder_nation_id = NULL`);
  await db.execute(sql`DELETE FROM region_controls WHERE nation_id = ${N}::uuid`);
  for (const name of regions) {
    await db.execute(sql`INSERT INTO map_regions (name, macro_region) VALUES (${name}, 'test') ON CONFLICT (name) DO NOTHING`);
    await db.execute(sql`INSERT INTO region_controls (region_id, nation_id, percent) SELECT id, ${N}::uuid, 100 FROM map_regions WHERE name = ${name}`);
  }
  await db.execute(sql`DELETE FROM player_armies WHERE discord_user_id = ${U}`);
  await db.execute(sql`INSERT INTO player_armies (discord_user_id, template_id, quantity) VALUES (${U}, ${SHIP}, 10)`);
  // 時代由 techs 決定,不繼承上一個測試的殘留(重跑整份檔案時才不會假失敗)
  await db.execute(sql`INSERT INTO world_game_state (id, current_era, game_date) VALUES (1, 'roman', '1900-01-01') ON CONFLICT (id) DO NOTHING`);
  await setEra(techs ? "roman" : "classical"); // classical 尚未解鎖海戰,roman 起解鎖
}

before(async () => {
  savedEra = (await db.execute(sql`SELECT current_era FROM world_game_state WHERE id = 1`)) as never;
  await runOilRigMigrationsInner(); await seedOilRigs();
  await db.execute(sql`DELETE FROM oil_seasons`); await db.execute(sql`INSERT INTO oil_seasons (season_number, status) VALUES (1,'active')`);
  await db.execute(sql`DELETE FROM player_nations WHERE id = ${N}::uuid`);
  await db.execute(sql`INSERT INTO player_nations (id, name, discord_user_id) VALUES (${N}::uuid, '路由測試國', ${U})`);
  await db.execute(sql`DELETE FROM military_unit_templates WHERE id = ${SHIP}`);
  await db.execute(sql`INSERT INTO military_unit_templates (id,category,name,hp,attack,defense,speed,accuracy,range,prod_cost_per_100,pop_cost_per_unit,money_cost_per_unit)
    VALUES (${SHIP},'ship','路由艦',100,100,100,1,50,'ranged',100,1,10)`);
  cookie = `${SESSION_COOKIE_NAME}=${await createSession({ discordUserId: U, username: "t", globalName: null, avatar: null, manageableGuildIds: [] })}`;
  const app = express(); app.use(express.json()); app.use(cookieParser());
  app.use((req, _res, next) => { (req as any).log = { error: (o: any) => console.error('ROUTE500', String(o?.err?.cause?.message ?? o?.err?.message ?? o?.err).slice(0,200)) }; next(); });
  app.use(router);
  server = http.createServer(app); await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (savedEra?.rows[0]) await db.execute(sql`UPDATE world_game_state SET current_era = ${savedEra.rows[0].current_era} WHERE id = 1`);
  await new Promise((r) => server.close(r));
  await db.execute(sql`DELETE FROM oil_campaign_fleets`); await db.execute(sql`DELETE FROM oil_campaigns`);
  await db.execute(sql`DELETE FROM oil_seasons`);
  await db.execute(sql`DELETE FROM region_controls WHERE nation_id = ${N}::uuid`);
  await db.execute(sql`DELETE FROM player_armies WHERE discord_user_id = ${U}`);
  await db.execute(sql`DELETE FROM user_sessions WHERE discord_user_id = ${U}`);
  await db.execute(sql`DELETE FROM military_unit_templates WHERE id = ${SHIP}`);
  await db.execute(sql`DELETE FROM player_nations WHERE id = ${N}::uuid`);
  await pool.end();
});

test("未登入 → 401(讀與寫都擋)", async () => {
  assert.equal((await call("GET", "/oil-campaigns", undefined, false)).status, 401);
  assert.equal((await call("POST", "/oil-campaigns", { rigSlug: "north_sea_1", fleet: [] }, false)).status, 401);
  assert.equal((await call("GET", "/oil-campaigns/my-fleet", undefined, false)).status, 401);
});

test("發起:缺 rigSlug 或 fleet 不是陣列 → 400", async () => {
  await setup(["荷蘭"], true);
  assert.equal((await call("POST", "/oil-campaigns", { fleet: [] })).status, 400);
  assert.equal((await call("POST", "/oil-campaigns", { rigSlug: "", fleet: [] })).status, 400);
  assert.equal((await call("POST", "/oil-campaigns", { rigSlug: "x".repeat(65), fleet: [] })).status, 400);
  assert.equal((await call("POST", "/oil-campaigns", { rigSlug: "north_sea_1", fleet: "no" })).status, 400);
  assert.equal((await call("POST", "/oil-campaigns", { rigSlug: 5, fleet: [] })).status, 400);
});

test("發起:沒研發海戰 → 403 NO_NAVAL_TECH,且沒有建立戰役", async () => {
  await setup(["荷蘭"], false);
  const r = await call("POST", "/oil-campaigns", { rigSlug: "north_sea_1", fleet: [{ templateId: SHIP, quantity: 1 }] });
  assert.equal(r.status, 403); assert.equal(r.json.code, "NO_NAVAL_TECH");
  assert.equal(Number(((await db.execute(sql`SELECT count(*)::int AS n FROM oil_campaigns`)).rows[0] as any).n), 0);
});

test("發起:未知油井 → 404", async () => {
  await setup(["荷蘭"], true);
  const r = await call("POST", "/oil-campaigns", { rigSlug: "nope", fleet: [{ templateId: SHIP, quantity: 1 }] });
  assert.equal(r.status, 404);
});

test("追加:id 非正整數 → 404;fleet 不是陣列 → 400", async () => {
  for (const id of ["abc", "0", "-3", "1.5"]) assert.equal((await call("POST", `/oil-campaigns/${id}/reinforce`, { fleet: [] })).status, 404, id);
  assert.equal((await call("POST", "/oil-campaigns/1/reinforce", { fleet: "x" })).status, 400);
  assert.equal((await call("POST", "/oil-campaigns/99999999/reinforce", { fleet: [{ templateId: SHIP, quantity: 1 }] })).status, 404);
});

test("資格查詢:沒科技時回報原因與中文訊息", async () => {
  await setup(["荷蘭"], false);
  const r = await call("GET", "/oil-campaigns/eligibility/north_sea_1");
  assert.equal(r.status, 200); assert.equal(r.json.eligible, false); assert.equal(r.json.reason, "no_naval_tech");
  assert.match(r.json.message, /海戰/);
});

test("我的艦隊:只列艦船,不含其他兵種", async () => {
  await setup(["荷蘭"], true);
  const r = await call("GET", "/oil-campaigns/my-fleet");
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.ships));
  assert.ok(r.json.ships.every((s: any) => s.templateId === SHIP));
});

test("戰役列表:回傳 delayHours = 6 與陣列", async () => {
  const r = await call("GET", "/oil-campaigns");
  assert.equal(r.status, 200); assert.equal(r.json.delayHours, 6); assert.ok(Array.isArray(r.json.campaigns));
});

test("端到端成功:羅馬時代 + 控制掛靠區 → 發起成功;追加攻方成功;艦隊被鎖;同油井再發起 409", async () => {
  await db.execute(sql`INSERT INTO world_game_state (id, current_era, game_date) VALUES (1, 'roman', '1900-01-01') ON CONFLICT (id) DO NOTHING`);
  await setEra("roman");
  await setup(["荷蘭"], true);
  const el = await call("GET", "/oil-campaigns/eligibility/north_sea_1");
  assert.equal(el.json.eligible, true, JSON.stringify(el.json));

  const r = await call("POST", "/oil-campaigns", { rigSlug: "north_sea_1", fleet: [{ templateId: SHIP, quantity: 6 }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(Number.isInteger(r.json.campaignId));

  const re = await call("POST", `/oil-campaigns/${r.json.campaignId}/reinforce`, { fleet: [{ templateId: SHIP, quantity: 4 }] });
  assert.equal(re.status, 200); assert.equal(re.json.side, "attacker");
  const over = await call("POST", `/oil-campaigns/${r.json.campaignId}/reinforce`, { fleet: [{ templateId: SHIP, quantity: 1 }] });
  assert.equal(over.status, 400); assert.equal(over.json.code, "BAD_COMMIT");

  const mine = await call("GET", "/oil-campaigns/my-fleet");
  const ship = mine.json.ships.find((x: any) => x.templateId === SHIP);
  assert.equal(ship.owned, 10); assert.equal(ship.available, 0, "10 艘全投入,可派量為 0");

  const dup = await call("POST", "/oil-campaigns", { rigSlug: "north_sea_1", fleet: [{ templateId: SHIP, quantity: 1 }] });
  assert.equal(dup.status, 409);

  const list = await call("GET", "/oil-campaigns");
  const c = list.json.campaigns.find((x: any) => x.id === r.json.campaignId);
  assert.equal(c.status, "active"); assert.equal(c.attackerShips, 10); assert.equal(c.attackerPower, Math.round(10000 * attackerRangeFactor(["荷蘭"], "north_sea_1").factor), "10 艘 × 1000 × 距離係數(荷蘭→北海一號 615 km)");
  assert.equal(c.defenderPower, 11500, "無人佔領:守軍 100 × 100 × 地利 1.15");
  assert.equal(c.forecast, "defender_wins", "9692 < 11500,現在結算攻方會輸");
});

test("取消航程限制:佛羅里達也能打北海一號(200),但資格查詢與戰役都帶出距離衰減", async () => {
  await setup(["佛羅里達"], true);
  const el = await call("GET", "/oil-campaigns/eligibility/north_sea_1");
  assert.equal(el.status, 200); assert.equal(el.json.eligible, true, JSON.stringify(el.json));
  const exp = attackerRangeFactor(["佛羅里達"], "north_sea_1");
  assert.ok(Math.abs(el.json.distanceKm - 7064) < 15, `distanceKm=${el.json.distanceKm}`);
  assert.ok(Math.abs(el.json.rangeFactor - Math.round(exp.factor * 1000) / 1000) < 1e-9);
  assert.ok(el.json.rangeFactor < 0.7 && el.json.rangeFactor >= 0.4);

  const r = await call("POST", "/oil-campaigns", { rigSlug: "north_sea_1", fleet: [{ templateId: SHIP, quantity: 10 }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const list = await call("GET", "/oil-campaigns");
  const c = list.json.campaigns.find((x: any) => x.id === r.json.campaignId);
  assert.equal(c.attackerPower, Math.round(10000 * exp.factor), "遠征戰力被衰減");
  assert.ok(Math.abs(c.rangeFactor - exp.factor) < 0.001);
  assert.ok(Array.isArray(c.attackerDistances) && c.attackerDistances.length === 1);
});

test("取消航程限制:同一座油井,近國與遠國看到不同的距離與係數", async () => {
  await setup(["荷蘭"], true);
  const near = (await call("GET", "/oil-campaigns/eligibility/north_sea_1")).json;
  await setup(["佛羅里達"], true);
  const far = (await call("GET", "/oil-campaigns/eligibility/north_sea_1")).json;
  assert.ok(near.distanceKm < far.distanceKm); assert.ok(near.rangeFactor > far.rangeFactor);
  // 多塊地取最近的
  await setup(["佛羅里達", "荷蘭"], true);
  const both = (await call("GET", "/oil-campaigns/eligibility/north_sea_1")).json;
  assert.equal(both.distanceKm, near.distanceKm); assert.equal(both.rangeFactor, near.rangeFactor);
});

test("取消航程限制:仍擋缺海戰、無沿海、未知油井(資格的其餘三道關卡不變)", async () => {
  await setup(["荷蘭"], false);
  const noTech = await call("GET", "/oil-campaigns/eligibility/north_sea_1");
  assert.equal(noTech.json.eligible, false); assert.equal(noTech.json.reason, "no_naval_tech");
  assert.equal(noTech.json.distanceKm, undefined, "不合格時不洩漏距離欄位");
  await setup(["不存在的內陸區"], true);
  assert.equal((await call("GET", "/oil-campaigns/eligibility/north_sea_1")).json.reason, "no_coastal_region");
  await setup(["荷蘭"], true);
  const unk = await call("GET", "/oil-campaigns/eligibility/nope");
  assert.equal(unk.json.eligible, false); assert.equal(unk.json.reason, "unknown_rig");
});
