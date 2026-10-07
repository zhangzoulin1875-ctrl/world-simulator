import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, like, and } from "drizzle-orm";
import {
  db, pool, playerNationsTable, parliamentStateTable, parliamentPartiesTable, parliamentLogTable,
  parliamentCampaignActionsTable,
} from "@workspace/db";
import { runParliamentMigrations } from "../parliamentMigrations";
import { setPenaltyScaleForTest } from "../penaltyScaleLoad";
import { performCampaignAction, runElectionIfDue, buildElectionView } from "./electionService";
import { settleNationParliament } from "./service";
import { ELECTION_INTERVAL, CAMPAIGN_TURNS } from "./election";

/** 選舉 — 真資料庫整合測試。議會 tick 與席次直接寫入,精準控制階段與票數。 */
const MARK = "ElecT"; const run = randomBytes(3).toString("hex"); let n = 0;
async function mk(gov = "議會內閣制", money = 100_000) {
  const [nat] = await db.insert(playerNationsTable).values({
    discordUserId: `el-${run}-${n}`, name: `${MARK}${run}${n++}`, leaderName: "t", government: gov, money,
  } as any).returning();
  return nat!;
}
async function seed(nationId: string, tick: number, last: number | null = null, sat = 60) {
  await db.insert(parliamentStateTable).values({ nationId, tick, lastElectionTick: last, satisfaction: sat, lastPartiesTick: tick })
    .onConflictDoUpdate({ target: parliamentStateTable.nationId, set: { tick, lastElectionTick: last, satisfaction: sat, lastPartiesTick: tick } });
  await db.delete(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, nationId));
  const rows = await db.insert(parliamentPartiesTable).values([
    { nationId, name: "甲黨", stance: "welfare", weight: 50, seats: 50, isRuling: true },
    { nationId, name: "乙黨", stance: "militarist", weight: 30, seats: 30 },
    { nationId, name: "丙黨", stance: "mercantile", weight: 20, seats: 20 },
  ]).returning();
  return rows;
}
const fresh = async (id: string) => (await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id)))[0]!;
const st = async (id: string) => (await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, id)))[0]!;
const parties = (id: string) => db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, id));
const acts = (id: string) => db.select().from(parliamentCampaignActionsTable).where(eq(parliamentCampaignActionsTable.nationId, id));
const CAMP = ELECTION_INTERVAL - 1;   // 競選期內
const NEVER = () => 0.99;             // 永不被抓
const ALWAYS = () => 0;               // 一定被抓

before(async () => {
  await runParliamentMigrations();
  setPenaltyScaleForTest(1);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
});
after(async () => {
  setPenaltyScaleForTest(null);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("競選期拉票：扣款、寫記錄、不會被抓", async () => {
  const nat = await mk(); const ps = await seed(nat.id, CAMP);
  const r = await performCampaignAction(nat, "democracy", String(ps[2]!.id), "canvass", ALWAYS);
  assert.ok(r.ok); if (!r.ok) return;
  assert.equal(r.caught, false, "拉票合法,永遠不會被抓");
  assert.equal(Number((await fresh(nat.id)).money), 100_000 - r.cost);
  assert.equal((await acts(nat.id)).length, 1);
});

test("買票被抓：扣議會滿意度並寫紀錄；沒被抓則不扣", async () => {
  const nat = await mk(); const ps = await seed(nat.id, CAMP, null, 60);
  const caught = await performCampaignAction(nat, "democracy", String(ps[1]!.id), "bribe", ALWAYS);
  assert.ok(caught.ok && caught.caught); if (!caught.ok) return;
  assert.equal(caught.satisfactionAfter, 48);
  assert.equal((await st(nat.id)).satisfaction, 48);
  const logs = await db.select().from(parliamentLogTable).where(and(eq(parliamentLogTable.nationId, nat.id), eq(parliamentLogTable.kind, "election")));
  assert.equal(logs.length, 1); assert.equal(logs[0]!.satDelta, -12);
  const clean = await performCampaignAction(nat, "democracy", String(ps[2]!.id), "bribe", NEVER);
  assert.ok(clean.ok && !clean.caught);
  assert.equal((await st(nat.id)).satisfaction, 48, "沒被抓不再扣");
});

test("錢不夠：不扣錢、不寫記錄", async () => {
  const nat = await mk("議會內閣制", 100); const ps = await seed(nat.id, CAMP);
  const r = await performCampaignAction(nat, "democracy", String(ps[0]!.id), "bribe", NEVER);
  assert.ok(!r.ok && r.status === 402);
  assert.equal(Number((await fresh(nat.id)).money), 100);
  assert.equal((await acts(nat.id)).length, 0);
});

test("次數上限與重複：同黨同招擋下；並發兩次只成功一次", async () => {
  const nat = await mk(); const ps = await seed(nat.id, CAMP);
  const id = String(ps[1]!.id);
  const [a, b] = await Promise.all([
    performCampaignAction(nat, "democracy", id, "canvass", NEVER),
    performCampaignAction(nat, "democracy", id, "canvass", NEVER),
  ]);
  assert.equal([a, b].filter((x) => x.ok).length, 1, "並發重複只成功一次");
  assert.equal((await acts(nat.id)).length, 1);
  assert.equal(Number((await fresh(nat.id)).money), 100_000 - 1000, "只扣一次錢");
  const again = await performCampaignAction(nat, "democracy", id, "canvass", NEVER);
  assert.ok(!again.ok && again.status === 409);
});

test("非競選期、專制、不存在的黨都被拒絕", async () => {
  const nat = await mk(); const ps = await seed(nat.id, 1);
  const early = await performCampaignAction(nat, "democracy", String(ps[0]!.id), "canvass", NEVER);
  assert.ok(!early.ok && /競選期/.test(early.error));
  await seed(nat.id, CAMP);
  const ghost = await performCampaignAction(nat, "democracy", "999999999", "canvass", NEVER);
  assert.ok(!ghost.ok && ghost.status === 404);
  const dict = await mk("軍事獨裁");
  const d = await performCampaignAction(dict, "autocracy", "1", "canvass", NEVER);
  assert.ok(!d.ok && d.status === 403);
  assert.equal(Number((await fresh(nat.id)).money), 100_000);
});

test("開票：席次總和 100、清掉操作、重設計時器、寫紀錄", async () => {
  const nat = await mk(); const ps = await seed(nat.id, CAMP);
  await performCampaignAction(nat, "democracy", String(ps[2]!.id), "canvass", NEVER);
  const out = await runElectionIfDue(nat, "democracy", ELECTION_INTERVAL, () => 0.5);
  assert.ok(out.held);
  const after = await parties(nat.id);
  assert.equal(after.reduce((x, p) => x + p.seats, 0), 100);
  assert.equal(after.filter((p) => p.isRuling).length, 1);
  assert.equal((await acts(nat.id)).length, 0, "操作已清除");
  const s = await st(nat.id);
  assert.equal(s.lastElectionTick, ELECTION_INTERVAL); assert.equal(s.lastPartiesTick, ELECTION_INTERVAL);
  const logs = await db.select().from(parliamentLogTable).where(and(eq(parliamentLogTable.nationId, nat.id), eq(parliamentLogTable.kind, "election")));
  assert.match(logs[0]!.summary, /大選開票/);
  // 同一天不會重複開票
  assert.equal((await runElectionIfDue(nat, "democracy", ELECTION_INTERVAL, () => 0.5)).held, false);
});

test("開票：重金買票讓小黨翻盤 → 政權輪替、執政旗標轉移", async () => {
  const nat = await mk("議會內閣制", 10_000_000); const ps = await seed(nat.id, CAMP);
  const c = String(ps[2]!.id);
  for (const a of ["bribe", "canvass"] as const) await performCampaignAction(nat, "democracy", c, a, NEVER);
  await performCampaignAction(nat, "democracy", String(ps[0]!.id), "suppress", NEVER);
  await performCampaignAction(nat, "democracy", String(ps[1]!.id), "suppress", NEVER);
  const out = await runElectionIfDue(nat, "democracy", ELECTION_INTERVAL, () => 0.5);
  assert.ok(out.held && out.turnover, "小黨翻盤");
  assert.equal(out.newRulingName, "丙黨");
  assert.equal((await parties(nat.id)).find((p) => p.name === "丙黨")!.isRuling, true);
});

test("沒到大選日不開票；專制永遠不開", async () => {
  const nat = await mk(); await seed(nat.id, CAMP);
  assert.equal((await runElectionIfDue(nat, "democracy", CAMP, () => 0.5)).held, false);
  assert.equal((await runElectionIfDue(nat, "autocracy", 999, () => 0.5)).held, false);
});

test("選舉視圖：階段、倒數與價格", async () => {
  const nat = await mk(); await seed(nat.id, 0);
  let v = await buildElectionView(nat, "democracy");
  assert.equal(v.phase, "none"); assert.equal(v.turnsUntil, ELECTION_INTERVAL);
  await seed(nat.id, ELECTION_INTERVAL - CAMPAIGN_TURNS);
  v = await buildElectionView(nat, "democracy");
  assert.equal(v.phase, "campaign"); assert.equal(v.turnsUntil, CAMPAIGN_TURNS);
  assert.equal(v.prices.bribe.cost, 3000);
  const semi = await buildElectionView(nat, "semi");
  assert.equal(semi.prices.bribe.cost, 1500, "半專制折半");
  assert.equal((await buildElectionView(await mk("軍事獨裁"), "autocracy")).enabled, false);
});

test("完整結算：議會 tick 推到大選日就自動開票，且不再被定期重組洗牌", async () => {
  const nat = await mk(); await seed(nat.id, ELECTION_INTERVAL - 1, null);
  await settleNationParliament(await fresh(nat.id), null, 0);
  const s = await st(nat.id);
  assert.equal(s.tick, ELECTION_INTERVAL);
  assert.equal(s.lastElectionTick, ELECTION_INTERVAL, "結算後已開票");
  const logs = await db.select().from(parliamentLogTable).where(and(eq(parliamentLogTable.nationId, nat.id), eq(parliamentLogTable.kind, "election")));
  assert.ok(logs.some((l) => /大選開票/.test(l.summary)));
  // 12 回合沒到,結算不會重組(民主靠選舉洗牌)
  const names = (await parties(nat.id)).map((p) => p.name).sort();
  await settleNationParliament(await fresh(nat.id), null, 0);
  assert.deepEqual((await parties(nat.id)).map((p) => p.name).sort(), names);
});
