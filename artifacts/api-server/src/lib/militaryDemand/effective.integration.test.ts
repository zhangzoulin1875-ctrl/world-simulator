/**
 * 軍方要求:有效滿意度一致性 + 逾時視同拒絕(2026-10-07)。
 * 回報:「軍方滿意度高於 50% 仍會被主動開戰」——根因是判定用資料庫基底值,
 * 玩家畫面看到的是 基底 + 政策加成 + 偏移 的有效值。
 */
import test, { after, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const { eq, like, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, regionControlsTable, militaryDemandsTable, politicsEntriesTable, parliamentStateTable, warCampaignsTable } = await import("@workspace/db");
const { runParliamentMigrations } = await import("../parliamentMigrations");
const { settleNationMilitaryDemand, respondToDemand, getPendingDemand, getEffectiveMilitarySatisfaction, expireDemandAsRefused } = await import("./service");
const { DEMAND_DEADLINE_TURNS } = await import("./core");

const MARK = "MeT"; const run = randomBytes(3).toString("hex");
const made: string[] = [];
async function mkNation(gov: string, sat: number) {
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: `me-${run}-${made.length}`, name: `${MARK}${run}${made.length}`, leaderName: "t",
    government: gov, satisfactionMilitary: sat,
  } as any).returning();
  made.push(n!.id); return n!;
}
async function freePair(skip: number): Promise<[number, number]> {
  const r = await db.execute(sql`
    select a.region_id as mine, a.adjacent_region_id as nb from map_region_adjacencies a
    where not exists (select 1 from region_controls c where c.region_id in (a.region_id, a.adjacent_region_id))
    order by a.region_id, a.adjacent_region_id offset ${skip} limit 1`);
  const x = (r.rows as any[])[0]; return [x.mine, x.nb];
}
async function control(regionId: number, nationId: string) { await db.insert(regionControlsTable).values({ regionId, nationId, percent: 100 }); }
async function fresh(id: string) { const [n] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id)); return n!; }
async function setTick(nationId: string, tick: number) {
  await db.insert(parliamentStateTable).values({ nationId, tick } as any)
    .onConflictDoUpdate({ target: parliamentStateTable.nationId, set: { tick } });
}
async function addMilitaryPolicy(nationId: string, satisfaction: number) {
  await db.insert(politicsEntriesTable).values({
    nationId, direction: "military", entryType: "policy", title: "測試政策", description: "t",
    modifiers: [{ target: "satisfaction", value: satisfaction }] as any, durationTurns: null, remainingTurns: null, status: "active",
  });
}
const armies = new Map<string, { armyPopulation: number }>();
const noCoup = async () => { throw new Error("coup must not run"); };
const seq = (...v: number[]) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]!; };
async function lastDemand(nationId: string) {
  const rows = await db.select().from(militaryDemandsTable).where(eq(militaryDemandsTable.nationId, nationId));
  return rows.sort((a, b) => b.id - a.id)[0];
}

before(async () => {
  await runParliamentMigrations();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
});

/** 攔截 NIM chat/completions:讓無主地 NPC 守軍的兵種設計回傳固定結果(不依賴真實 AI) */
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
afterEach(() => { globalThis.fetch = realFetch; });
after(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("【回報的 bug】基底 40 + 政策 +20:畫面 60% → 不得自動開戰", async () => {
  const [mine] = await freePair(0);
  const n = await mkNation("軍事獨裁", 40); await control(mine, n.id); await addMilitaryPolicy(n.id, 20);
  assert.equal(Math.round(await getEffectiveMilitarySatisfaction(n)), 60, "有效值 = 玩家畫面看到的數字");
  stubNpcUnitAi();
  const r = await settleNationMilitaryDemand(n, armies, noCoup, seq(0.99));
  assert.equal(r.action, "none", "有效值 60 >= 50,不得自動開戰");
  assert.equal((await db.select().from(militaryDemandsTable).where(eq(militaryDemandsTable.nationId, n.id))).length, 0, "不得有 auto_war 紀錄");
  assert.equal((await db.select().from(warCampaignsTable).where(eq(warCampaignsTable.attackerNationId, n.id))).length, 0, "不得有戰役");
});

test("反向:基底 70 + 政策 -30:畫面 40% → 應自動開戰(與畫面一致)", async () => {
  const [mine, nb] = await freePair(1);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id); await addMilitaryPolicy(n.id, -30);
  assert.equal(Math.round(await getEffectiveMilitarySatisfaction(n)), 40);
  stubNpcUnitAi();
  const r = await settleNationMilitaryDemand(n, armies, noCoup, seq(0.99));
  assert.equal(r.action, "auto_war", `got ${JSON.stringify(r)}`);
  const rec = await lastDemand(n.id);
  assert.equal(rec!.status, "auto_war");
  assert.equal(rec!.effectiveSatisfaction, 40, "留痕:決策當下的有效值");
  assert.equal(rec!.baseSatisfaction, 70, "留痕:資料庫基底值");
  void nb;
});

test("有效值判定的 18% 要求:基底 40 + 政策 +20 → 可提出要求(而非自動開戰)", async () => {
  const [mine] = await freePair(2);
  const n = await mkNation("軍事獨裁", 40); await control(mine, n.id); await addMilitaryPolicy(n.id, 20);
  const r = await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  assert.equal(r.action, "demand");
  const d = await getPendingDemand(n.id);
  assert.ok(d);
  assert.equal(d!.effectiveSatisfaction, 60, "留痕:決策當下的有效值");
  assert.equal(d!.baseSatisfaction, 40, "留痕:資料庫基底值");
});

test("要求建立時記錄回合與到期回合(tick + 2)", async () => {
  const [mine] = await freePair(3);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id); await setTick(n.id, 12); // 擲骰回合必為 4 的倍數(每 4 回合才擲一次)
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  const d = (await getPendingDemand(n.id))!;
  assert.equal(d.createdTick, 12);
  assert.equal(d.dueTick, 12 + DEMAND_DEADLINE_TURNS);
  assert.equal(d.dueTick, 14);
});

test("每 4 回合才擲一次：非擲骰回合即使亂數必中也不產生要求，擲骰回合才會", async () => {
  const [mine] = await freePair(8);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id);
  for (const tick of [13, 14, 15]) {
    await setTick(n.id, tick);
    const r = await settleNationMilitaryDemand(await fresh(n.id), armies, noCoup, seq(0));
    assert.equal(r.action, "none", `tick=${tick} 不該提出要求`);
    assert.equal(await getPendingDemand(n.id), null);
  }
  await setTick(n.id, 16);
  const hit = await settleNationMilitaryDemand(await fresh(n.id), armies, noCoup, seq(0));
  assert.equal(hit.action, "demand", "tick=16 為擲骰回合");
  assert.ok(await getPendingDemand(n.id));
});

test("未逾時:不處理、不扣分,且不會擲新的要求", async () => {
  const [mine] = await freePair(4);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id); await setTick(n.id, 20);
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  await setTick(n.id, 21); // due = 22,尚未到
  const r = await settleNationMilitaryDemand(await fresh(n.id), armies, noCoup, seq(0.0));
  assert.equal(r.action, "none");
  assert.ok(await getPendingDemand(n.id), "仍待回應");
  assert.equal((await fresh(n.id)).satisfactionMilitary, 70);
});

test("逾時:視同拒絕、扣 15、狀態 timed_out;再結算不重複扣分", async () => {
  const [mine] = await freePair(5);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id); await setTick(n.id, 32); // 擲骰回合必為 4 的倍數
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  await setTick(n.id, 34); // 到期
  const r = await settleNationMilitaryDemand(await fresh(n.id), armies, noCoup, seq(0.99));
  assert.equal(r.action, "none");
  assert.equal((await fresh(n.id)).satisfactionMilitary, 55, "70 - 15");
  assert.equal(await getPendingDemand(n.id), null);
  assert.equal((await lastDemand(n.id))!.status, "timed_out");
  // 下一回合再結算:不得再扣
  await settleNationMilitaryDemand(await fresh(n.id), armies, noCoup, seq(0.99));
  assert.equal((await fresh(n.id)).satisfactionMilitary, 55);
});

test("逾時扣分後跌破 50:同回合落入自動開戰判定(扣分有效)", async () => {
  stubNpcUnitAi();
  const [mine] = await freePair(6);
  const n = await mkNation("軍事獨裁", 60); await control(mine, n.id); await setTick(n.id, 40);
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  await setTick(n.id, 42);
  const r = await settleNationMilitaryDemand(await fresh(n.id), armies, noCoup, seq(0.99));
  assert.equal((await fresh(n.id)).satisfactionMilitary, 45, "60 - 15");
  assert.equal(r.action, "auto_war", `逾時扣到 45 < 50,同回合軍方不再請示直接開戰:${JSON.stringify(r)}`);
  const rows = await db.select().from(militaryDemandsTable).where(eq(militaryDemandsTable.nationId, n.id));
  assert.ok(rows.some((x) => x.status === "timed_out"));
  assert.ok(rows.some((x) => x.status === "auto_war"));
});

test("逾時與玩家同時回應:只扣一次(樂觀鎖)", async () => {
  const [mine] = await freePair(7);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id); await setTick(n.id, 52); // 擲骰回合必為 4 的倍數
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  const d = (await getPendingDemand(n.id))!;
  const [a, b] = await Promise.all([
    respondToDemand(await fresh(n.id), d.id, false),
    expireDemandAsRefused(await fresh(n.id), d),
  ]);
  assert.equal([a.ok, b].filter(Boolean).length, 1, "只有一方搶到");
  assert.equal((await fresh(n.id)).satisfactionMilitary, 55, "只扣一次 15");
});

test("玩家先回應 → 逾時處理不再扣分", async () => {
  const [mine] = await freePair(8);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id); await setTick(n.id, 60);
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.05));
  const d = (await getPendingDemand(n.id))!;
  await respondToDemand(await fresh(n.id), d.id, false);
  assert.equal(await expireDemandAsRefused(await fresh(n.id), d), false);
  assert.equal((await fresh(n.id)).satisfactionMilitary, 55);
});

test("舊資料(沒有 dueTick)不會被逾時處理", async () => {
  const [mine, nb] = await freePair(9);
  const n = await mkNation("軍事獨裁", 70); await control(mine, n.id); await setTick(n.id, 99);
  await db.insert(militaryDemandsTable).values({ nationId: n.id, regionId: nb, regionName: "old", status: "pending" });
  await settleNationMilitaryDemand(n, armies, noCoup, seq(0.99));
  assert.ok(await getPendingDemand(n.id), "舊要求維持待回應");
  assert.equal((await fresh(n.id)).satisfactionMilitary, 70);
});

test("民主國家:有逾時要求也不處理、不扣分(軍方永遠無要求)", async () => {
  const [mine] = await freePair(10);
  const n = await mkNation("總統制民主", 0); await control(mine, n.id);
  const r = await settleNationMilitaryDemand(n, armies, noCoup, seq(0.0));
  assert.equal(r.action, "none");
});
