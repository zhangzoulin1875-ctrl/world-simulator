import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const { eq, like, and, or, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, regionControlsTable, diplomacyWarsTable, diplomacyRelationsTable, militaryDemandsTable, warCampaignsTable } = await import("@workspace/db");
const { runParliamentMigrations } = await import("../parliamentMigrations");
const { settleNationMilitaryDemand, respondToDemand, getPendingDemand } = await import("./service");

const MARK = "MdT"; const run = randomBytes(3).toString("hex");
const made: string[] = [];
async function mkNation(gov: string, sat: number, extra: Record<string, unknown> = {}) {
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: `md-${run}-${made.length}`, name: `${MARK}${run}${made.length}`, leaderName: "t",
    government: gov, satisfactionMilitary: sat, ...extra,
  } as any).returning();
  made.push(n!.id); return n!;
}
async function mkNpc(name: string) {
  const [n] = await db.insert(playerNationsTable).values({ name: `${MARK}${run}${name}`, government: "君主立憲制", isNpc: true } as any).returning();
  made.push(n!.id); return n!;
}
/** 取一個有鄰居的區域對 [mine, neighbor],且兩者都沒被任何人控制 */
async function freePair(skip = 0): Promise<[number, number]> {
  const r = await db.execute(sql`
    select a.region_id as mine, a.adjacent_region_id as nb from map_region_adjacencies a
    where not exists (select 1 from region_controls c where c.region_id in (a.region_id, a.adjacent_region_id))
    order by a.region_id, a.adjacent_region_id offset ${skip} limit 1`);
  const x = (r.rows as any[])[0]; return [x.mine, x.nb];
}
async function control(regionId: number, nationId: string, percent = 100) {
  await db.insert(regionControlsTable).values({ regionId, nationId, percent });
}
async function fresh(id: string) { const [n] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id)); return n!; }
const armies = new Map<string, { armyPopulation: number }>();
const noCoup = async () => { throw new Error("coup must not run"); };
const seq = (...v: number[]) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]!; };
async function isAdjacent(a: number, b: number): Promise<boolean> {
  const r = await db.execute(sql`select 1 from map_region_adjacencies where region_id = ${a} and adjacent_region_id = ${b} limit 1`);
  return r.rows.length > 0;
}
async function campaignsBy(id: string) { return db.select().from(warCampaignsTable).where(eq(warCampaignsTable.attackerNationId, id)); }
async function wars(a: string, b: string) {
  return db.select().from(diplomacyWarsTable).where(or(
    and(eq(diplomacyWarsTable.nationAId, a), eq(diplomacyWarsTable.nationBId, b)),
    and(eq(diplomacyWarsTable.nationAId, b), eq(diplomacyWarsTable.nationBId, a))));
}


/** 攔截 NIM chat/completions:讓 NPC 守軍的兵種設計回傳固定結果(不依賴真實 AI) */
const realFetch = globalThis.fetch;
function stubNpcUnitAi() {
  const unit = {
    category: "infantry", name: "守軍步兵", description: "測試用守軍", hp: 100, attack: 10, defense: 10, speed: 1,
    accuracy: 50, range: "melee", antiCavalryPct: 0, antiRangedPct: 0, antiArtilleryPct: 0, siegePct: 0,
    prodCostPer100: 1, popCostPerUnit: 1, moneyCostPerUnit: 10, upkeepPerUnit: 0, prodUpkeepPerUnit: 0,
    woodCostPerUnit: 0, oreCostPerUnit: 0,
  };
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    if (!url.includes("/chat/completions")) return realFetch(input, init);
    const cats = ["infantry", "ranged", "armor", "artillery", "ship", "air", "siege"];
    const body = JSON.stringify(init?.body ? JSON.parse(String(init.body)) : {});
    const wanted = cats.filter((c) => body.includes(c));
    const list = (wanted.length ? wanted : ["infantry"]).map((c) => ({ ...unit, category: c, name: `守軍${c}` }));
    return new Response(JSON.stringify({
      id: "stub", model: "stub", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(list) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
function restoreFetch() { globalThis.fetch = realFetch; }

afterEach(() => { restoreFetch(); });
before(async () => {
  await runParliamentMigrations();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
});
after(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `%軍閥政權`));
  await pool.end();
});

test("獨裁:擲中 20% → 產生要求(目標=相鄰無主地),且不扣分", async () => {
  const [mine, nb] = await freePair(0);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id);
  const r = await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  assert.equal(r.action, "demand");
  const d = await getPendingDemand(n.id);
  assert.ok(d); assert.equal(d!.regionId, nb); assert.equal(d!.targetNationId, null);
  assert.equal((await fresh(n.id)).satisfactionMilitary, 70);
  // 有待回應要求時不再擲新的
  assert.equal((await settleNationMilitaryDemand(await fresh(n.id), armies, noCoup, seq(0.0))).action, "none");
});

test("獨裁:沒擲中 → 不產生要求", async () => {
  const [mine] = await freePair(1);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id);
  assert.equal((await settleNationMilitaryDemand(n, armies, noCoup, seq(0.5))).action, "none");
  assert.equal(await getPendingDemand(n.id), null);
});

test("民主國家:軍方永遠無要求,連 0 滿意度也不開戰不政變", async () => {
  const [mine] = await freePair(2);
  const n = await mkNation("總統制民主", 0); await control(mine, n.id);
  for (const r of [0, 0.5]) assert.equal((await settleNationMilitaryDemand(n, armies, noCoup, seq(r))).action, "none");
  assert.equal(await getPendingDemand(n.id), null);
});

test("拒絕:軍方滿意度 -15;重複回應只扣一次", async () => {
  const [mine] = await freePair(3);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id);
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  const d = (await getPendingDemand(n.id))!;
  const r1 = await respondToDemand(await fresh(n.id), d.id, false);
  assert.equal(r1.ok, true); assert.equal(r1.newSatisfaction, 55);
  assert.equal((await fresh(n.id)).satisfactionMilitary, 55);
  const r2 = await respondToDemand(await fresh(n.id), d.id, false);
  assert.equal(r2.ok, false);
  assert.equal((await fresh(n.id)).satisfactionMilitary, 55);
  assert.equal(await getPendingDemand(n.id), null);
});

test("同意:對相鄰他國開戰(視為一般戰爭,寫入 diplomacy_wars),不扣分", async () => {
  stubNpcUnitAi();
  const [mine, nb] = await freePair(4);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id);
  const foe = await mkNpc("foe"); await control(nb, foe.id);
  await db.insert(diplomacyRelationsTable).values({
    nationAId: n.id < foe.id ? n.id : foe.id, nationBId: n.id < foe.id ? foe.id : n.id, score: -40,
  }).onConflictDoNothing();
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  const d = (await getPendingDemand(n.id))!;
  assert.equal(d.targetNationId, foe.id);
  const r = await respondToDemand(await fresh(n.id), d.id, true);
  assert.equal(r.ok, true); assert.equal(r.warStarted, true);
  assert.equal((await wars(n.id, foe.id)).length, 1);
  assert.equal((await fresh(n.id)).satisfactionMilitary, 70);
});

test("目標優先序:關係最差的他國 勝過 無主地", async () => {
  const r = await db.execute(sql`
    select a.region_id m, a.adjacent_region_id x, b.adjacent_region_id y from map_region_adjacencies a
    join map_region_adjacencies b on b.region_id = a.region_id and b.adjacent_region_id <> a.adjacent_region_id
    where not exists (select 1 from region_controls c where c.region_id in (a.region_id, a.adjacent_region_id, b.adjacent_region_id))
    order by 1,2,3 offset 20 limit 1`);
  const { m, x, y } = (r.rows as any[])[0];
  const n = await mkNation("軍事獨裁", 70); await control(m, n.id);
  const foe = await mkNpc("foe2"); await control(x, foe.id);   // y 保持無主
  await db.insert(diplomacyRelationsTable).values({
    nationAId: n.id < foe.id ? n.id : foe.id, nationBId: n.id < foe.id ? foe.id : n.id, score: -10,
  }).onConflictDoNothing();
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  assert.equal((await getPendingDemand(n.id))!.regionId, x);
  void y;
});

test("<50:不詢問直接開戰;不打盟友(改無其他目標則不動作)", async () => {
  stubNpcUnitAi();
  const [mine, nb] = await freePair(6);
  const n = await mkNation("軍事獨裁", 40); await control(mine, n.id);
  const foe = await mkNpc("foe3"); await control(nb, foe.id);
  await db.insert(diplomacyRelationsTable).values({
    nationAId: n.id < foe.id ? n.id : foe.id, nationBId: n.id < foe.id ? foe.id : n.id, score: -30,
  }).onConflictDoNothing();
  const r = await settleNationMilitaryDemand(n, armies, noCoup, seq(0.99));
  assert.equal(r.action, "auto_war");
  assert.equal((await wars(n.id, foe.id)).length, 1);
  assert.equal(await getPendingDemand(n.id), null);
});

test("<50 自動開戰:目標是同盟成員時不開戰", async () => {
  const [mine, nb] = await freePair(8);
  const n = await mkNation("軍事獨裁", 40); await control(mine, n.id);
  const ally = await mkNpc("ally"); await control(nb, ally.id);
  const al = await db.execute(sql`insert into alliances (name, founder_nation_id) values (${`MdA${run}`}, ${n.id}) returning id`);
  const aid = (al.rows as any[])[0].id;
  await db.execute(sql`insert into alliance_members (alliance_id, nation_id) values (${aid}, ${n.id}), (${aid}, ${ally.id})`);
  const r = await settleNationMilitaryDemand(n, armies, noCoup, seq(0.99));
  assert.notEqual(r.action, "auto_war");
  assert.equal((await wars(n.id, ally.id)).length, 0);
  await db.execute(sql`delete from alliances where id = ${aid}`);
});

test("<15 政變:60% 走既有軍方政變(callback)", async () => {
  const [mine] = await freePair(10);
  const n = await mkNation("軍事獨裁", 10); await control(mine, n.id);
  let called = 0;
  const r = await settleNationMilitaryDemand(n, armies, async () => { called++; }, seq(0.3));
  assert.equal(r.action, "coup_classic"); assert.equal(called, 1);
});

test("<15 政變:40% 軍閥分裂 → 新 NPC 奪走領土並對你宣戰", async () => {
  const r = await db.execute(sql`select a.region_id m, a.adjacent_region_id x from map_region_adjacencies a
    where not exists (select 1 from region_controls c where c.region_id in (a.region_id, a.adjacent_region_id)) order by 1,2 offset 30 limit 1`);
  const { m, x } = (r.rows as any[])[0];
  const n = await mkNation("軍事獨裁", 5);
  await control(m, n.id, 100); await control(x, n.id, 100);
  let called = 0;
  const res = await settleNationMilitaryDemand(n, armies, async () => { called++; }, seq(0.9));
  assert.equal(res.action, "coup_warlord"); assert.equal(called, 0);
  const rebels = await db.select().from(playerNationsTable).where(like(playerNationsTable.name, `%軍閥政權`));
  assert.ok(rebels.length >= 1);
  const rebel = rebels[rebels.length - 1]!;
  assert.equal(rebel.isNpc, true);
  assert.equal((await wars(n.id, rebel.id)).length, 1);
});

test("<50 自動開戰:目標是無主地 → 戰役系統自動生成 NPC 守軍並建立戰役", async () => {
  stubNpcUnitAi();
  const [mine, nb] = await freePair(40);
  const n = await mkNation("軍事獨裁", 40); await control(mine, n.id);
  const r = await settleNationMilitaryDemand(n, armies, noCoup, seq(0.99));
  assert.equal(r.action, "auto_war");
  const cs = await campaignsBy(n.id);
  assert.equal(cs.length, 1); assert.ok(await isAdjacent(mine, cs[0]!.defenderRegionId), 'target must border my region'); void nb;
  const [def] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, cs[0]!.defenderNationId));
  assert.ok(def); assert.equal(def!.isNpc, true);
  assert.equal((await wars(n.id, def!.id)).length, 1);
  made.push(def!.id);
});

test("同意進攻無主地 → 同樣生成 NPC 守軍並開戰,且不扣分", async () => {
  stubNpcUnitAi();
  const [mine, nb] = await freePair(50);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id);
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  const d = (await getPendingDemand(n.id))!;
  assert.ok(await isAdjacent(mine, d.regionId), 'target must border my region'); assert.equal(d.targetNationId, null); void nb;
  const r = await respondToDemand(await fresh(n.id), d.id, true);
  assert.equal(r.ok, true); assert.equal(r.warStarted, true);
  const cs = await campaignsBy(n.id);
  assert.equal(cs.length, 1);
  const [def] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, cs[0]!.defenderNationId));
  assert.equal(def!.isNpc, true); made.push(def!.id);
  assert.equal((await fresh(n.id)).satisfactionMilitary, 70);
});
