import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
const { eq, like, and, isNull, sql } = await import("drizzle-orm");
const { db, pool, playerNationsTable, regionControlsTable, diplomacyWarsTable, parliamentStateTable, parliamentPartiesTable, parliamentLogTable, territoryChangeHistoryTable } = await import("@workspace/db");
const { runParliamentMigrations } = await import("../parliamentMigrations");
const { settleNationParliament, runParliamentSettlement } = await import("./service");

const MARK = "ParlT"; const run = randomBytes(3).toString("hex");
const made: string[] = [];
async function mkNation(gov: string, extra: Record<string, unknown> = {}) {
  const [n] = await db.insert(playerNationsTable).values({
    discordUserId: `pt-${run}-${made.length}`, name: `${MARK}${run}${made.length}`, leaderName: "t", government: gov, ...extra,
  } as any).returning();
  made.push(n!.id); return n!;
}
async function freeRegions(k: number): Promise<number[]> {
  const r = await db.execute(sql`select id from map_regions m where not exists (select 1 from region_controls c where c.region_id=m.id) order by id limit ${k}`);
  return (r.rows as any[]).map((x) => x.id);
}
async function st(id: string) { const [s] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, id)); return s!; }
async function fresh(id: string) { const [n] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id)); return n!; }

before(async () => {
  await runParliamentMigrations();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `%獨立政權`));
});
after(async () => {
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `%獨立政權`));
  await pool.end();
});

test("專制(軍事獨裁)：單一政黨 100 席、不提要求、滿意度鎖 80", async () => {
  const n = await mkNation("軍事獨裁");
  await settleNationParliament(n, null, 0);
  const ps = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, n.id));
  assert.equal(ps.length, 1); assert.equal(ps[0]!.seats, 100); assert.equal(ps[0]!.stance, "loyalist");
  const s = await st(n.id);
  assert.equal(s.satisfaction, 80); assert.equal(s.activeDemand, null); assert.equal(s.tick, 1);
});

test("民主(議會制)：5 黨、席次合計 100、第一次結算就提出要求與抗議", async () => {
  const n = await mkNation("議會內閣制");
  await settleNationParliament(n, null, 0);
  const ps = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, n.id));
  assert.equal(ps.length, 5);
  assert.equal(ps.reduce((a, p) => a + p.seats, 0), 100);
  assert.equal(ps.filter((p) => p.isRuling).length, 1, "恰有一個執政黨");
  const s = await st(n.id);
  assert.ok(s.protestText.length > 0, "抗議內容");
  assert.ok(s.activeDemand && (s.activeDemand as any).text.length > 0, "政策要求");
});

test("要求期每回合判定並寫紀錄；三回合後結案", async () => {
  const n = await mkNation("議會內閣制");
  for (let i = 0; i < 4; i++) await settleNationParliament(await fresh(n.id), null, 0);
  const logs = await db.select().from(parliamentLogTable).where(eq(parliamentLogTable.nationId, n.id));
  const j = logs.filter((l) => l.kind === "judgement");
  assert.ok(j.length >= 3, `判定紀錄 ${j.length}`);
  assert.ok(j.every((l) => /預設輕度違背|判定/.test(l.summary)));
});

test("半專制(君主立憲)：3 黨", async () => {
  const n = await mkNation("君主立憲制");
  await settleNationParliament(n, null, 0);
  const ps = await db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, n.id));
  assert.equal(ps.length, 3);
});

test("革命(單一領地)：割 40% 給 NPC 分裂政權、對玩家宣戰、記領土變動", async () => {
  const [rid] = await freeRegions(1); assert.ok(rid, "需要一塊空地區");
  const n = await mkNation("議會內閣制");
  await db.insert(regionControlsTable).values({ regionId: rid!, nationId: n.id, percent: 100 });
  await db.insert(parliamentStateTable).values({ nationId: n.id, satisfaction: 1, tick: 5, lastDemandTick: 3, lastPartiesTick: 4,
    activeDemand: { stance: "militarist", text: "x", issuedTick: 3, levels: [] } as any }).onConflictDoNothing();
  await settleNationParliament(await fresh(n.id), null, 0);
  const mine = await db.select().from(regionControlsTable).where(and(eq(regionControlsTable.nationId, n.id), eq(regionControlsTable.regionId, rid!)));
  assert.equal(mine[0]!.percent, 60, "玩家保留 60%");
  const all = await db.select().from(regionControlsTable).where(eq(regionControlsTable.regionId, rid!));
  assert.equal(all.length, 2); assert.equal(all.reduce((a, c) => a + c.percent, 0), 100);
  const rebel = all.find((c) => c.nationId !== n.id)!; assert.equal(rebel.percent, 40);
  const [rn] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, rebel.nationId));
  assert.equal(rn!.isNpc, true);
  const wars = await db.select().from(diplomacyWarsTable).where(and(isNull(diplomacyWarsTable.endedAt), eq(diplomacyWarsTable.declaredByNationId, rebel.nationId)));
  assert.equal(wars.length, 1, "分裂政權對玩家宣戰");
  const hist = await db.select().from(territoryChangeHistoryTable).where(eq(territoryChangeHistoryTable.regionId, rid!));
  assert.ok(hist.some((h) => h.changeType === "revolution"));
  const s = await st(n.id);
  assert.equal(s.satisfaction, 40, "革命後回到 40"); assert.equal(s.revolutions, 1); assert.equal(s.activeDemand, null);
});

test("專制即使議會滿意度 0 也不革命（靠軍方，不靠議會）", async () => {
  const [rid] = await freeRegions(1);
  const n = await mkNation("君主專制");
  await db.insert(regionControlsTable).values({ regionId: rid!, nationId: n.id, percent: 100 });
  await db.insert(parliamentStateTable).values({ nationId: n.id, satisfaction: 0 }).onConflictDoNothing();
  await settleNationParliament(await fresh(n.id), null, 0);
  const mine = await db.select().from(regionControlsTable).where(eq(regionControlsTable.nationId, n.id));
  assert.equal(mine[0]!.percent, 100);
  assert.equal((await st(n.id)).revolutions, 0);
});

test("全體結算：單國失敗不影響其他國，回傳統計", async () => {
  await mkNation("議會內閣制"); await mkNation("君主立憲制");
  const r = await runParliamentSettlement();
  assert.ok(r.nations >= 2); assert.equal(r.failed, 0);
});
