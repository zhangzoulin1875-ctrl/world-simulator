import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, like } from "drizzle-orm";
import {
  db, pool, playerNationsTable, parliamentStateTable, parliamentPartiesTable, parliamentLogTable,
} from "@workspace/db";
import { runParliamentMigrations } from "../parliamentMigrations";
import { setPenaltyScaleForTest } from "../penaltyScaleLoad";
import { reformGovernment, tickGovernment, buildGovernmentView } from "./coalitionService";
import { voteOnPolicy } from "./policyVote";
import { ELECTION_INTERVAL } from "./election";
import { MAX_FORMATION_FAILURES } from "./coalition";

/** 聯合政府 — 真資料庫整合測試。席次直接寫入,精準控制組閣情境。 */
const MARK = "CoalT"; const run = randomBytes(3).toString("hex"); let n = 0;
type Seed = [name: string, stance: string, seats: number, ruling?: boolean];
async function mk(gov: string, seeds: Seed[], tick = 5, sat = 60) {
  const [nat] = await db.insert(playerNationsTable).values({
    discordUserId: `co-${run}-${n}`, name: `${MARK}${run}${n++}`, leaderName: "t", government: gov, money: 100_000,
  } as any).returning();
  await db.insert(parliamentStateTable).values({ nationId: nat!.id, tick, satisfaction: sat, lastPartiesTick: tick, lastElectionTick: 0 });
  const rows = await db.insert(parliamentPartiesTable).values(seeds.map(([name, stance, seats, ruling]) => ({
    nationId: nat!.id, name, stance, weight: seats, seats, isRuling: !!ruling,
  }))).returning();
  return { nat: nat!, rows };
}
const st = async (id: string) => (await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, id)))[0]!;
const ps = (id: string) => db.select().from(parliamentPartiesTable).where(eq(parliamentPartiesTable.nationId, id));
const logs = (id: string) => db.select().from(parliamentLogTable).where(eq(parliamentLogTable.nationId, id));
const members = async (id: string) => (await ps(id)).filter((p) => p.inCoalition).map((p) => p.name).sort();
const prime = async (id: string) => (await ps(id)).find((p) => p.isRuling)?.name ?? null;

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

test("單黨過半 → 單黨政府，只有它是成員與總理黨", async () => {
  const { nat } = await mk("議會內閣制", [["甲", "welfare", 55], ["乙", "militarist", 30], ["丙", "secular", 15]]);
  const r = await reformGovernment(nat.id, "democracy", 5);
  assert.equal(r.kind, "single");
  assert.deepEqual(await members(nat.id), ["甲"]); assert.equal(await prime(nat.id), "甲");
  assert.equal((await st(nat.id)).caretaker, false);
});

test("沒過半 → 依相容度組成聯合，總理黨為最大黨，並寫日誌", async () => {
  const { nat } = await mk("議會內閣制", [["甲", "welfare", 40], ["乙", "pacifist", 20], ["丙", "secular", 25], ["丁", "militarist", 15]]);
  const r = await reformGovernment(nat.id, "democracy", 5);
  assert.equal(r.kind, "coalition");
  assert.deepEqual(await members(nat.id), ["乙", "甲"]); assert.equal(await prime(nat.id), "甲");
  assert.ok((await logs(nat.id)).some((l) => l.kind === "coalition" && l.summary.includes("聯合政府")));
});

test("冪等：同樣席次再組一次，不重複寫日誌、結果不變", async () => {
  const { nat } = await mk("議會內閣制", [["甲", "welfare", 40], ["乙", "pacifist", 20], ["丙", "secular", 25], ["丁", "militarist", 15]]);
  await reformGovernment(nat.id, "democracy", 5);
  const before = (await logs(nat.id)).length;
  await reformGovernment(nat.id, "democracy", 6);
  assert.equal((await logs(nat.id)).length, before, "沒有變化就不該再寫一筆");
  assert.deepEqual(await members(nat.id), ["乙", "甲"]);
});

test("湊不出過半 → 看守政府：沒有成員、沒有總理黨、失敗計數 +1", async () => {
  const { nat } = await mk("議會內閣制", [["甲", "militarist", 40], ["乙", "pacifist", 35], ["丙", "pacifist", 25]]);
  const r = await reformGovernment(nat.id, "democracy", 5);
  assert.equal(r.kind, "caretaker"); assert.equal(r.earlyElection, false);
  assert.deepEqual(await members(nat.id), []); assert.equal(await prime(nat.id), null);
  const s = await st(nat.id); assert.equal(s.caretaker, true); assert.equal(s.formationFailures, 1);
});

test("連續失敗 3 次 → 提前大選：下次大選日恰好是現在", async () => {
  const { nat } = await mk("議會內閣制", [["甲", "militarist", 40], ["乙", "pacifist", 35], ["丙", "pacifist", 25]], 7);
  let last = await reformGovernment(nat.id, "democracy", 7);
  for (let i = 1; i < MAX_FORMATION_FAILURES; i++) last = await reformGovernment(nat.id, "democracy", 7);
  assert.equal(last.earlyElection, true);
  const s = await st(nat.id);
  assert.equal(s.formationFailures, 0, "觸發後歸零");
  assert.equal(s.lastElectionTick, 7 - ELECTION_INTERVAL < 0 ? 0 : 7 - ELECTION_INTERVAL);
  assert.ok((await logs(nat.id)).some((l) => l.summary.includes("提前大選")));
});

test("看守政府每回合扣議會滿意度 1，並重試組閣；席次改變後恢復正常", async () => {
  const { nat, rows } = await mk("議會內閣制", [["甲", "militarist", 40], ["乙", "pacifist", 35], ["丙", "pacifist", 25]], 5, 60);
  await reformGovernment(nat.id, "democracy", 5);
  const t1 = await tickGovernment(nat.id, "democracy", 6);
  assert.equal(t1.satDelta, -1); assert.equal((await st(nat.id)).satisfaction, 59);
  assert.equal((await st(nat.id)).caretaker, true);
  // 乙黨席次暴增 → 單獨過半，下一回合恢復
  await db.update(parliamentPartiesTable).set({ seats: 60 }).where(eq(parliamentPartiesTable.id, rows[1]!.id));
  await db.update(parliamentPartiesTable).set({ seats: 20 }).where(eq(parliamentPartiesTable.id, rows[0]!.id));
  await db.update(parliamentPartiesTable).set({ seats: 20 }).where(eq(parliamentPartiesTable.id, rows[2]!.id));
  await tickGovernment(nat.id, "democracy", 7);
  const s = await st(nat.id);
  assert.equal(s.caretaker, false); assert.equal(await prime(nat.id), "乙");
});

test("裂解：退出的是小夥伴且剩下仍過半 → 不倒閣、不扣分", async () => {
  // 甲 45 + 乙 8 + 丙 3 = 56；丙退出後 53 仍過半
  const { nat } = await mk("議會內閣制", [["甲", "welfare", 45], ["乙", "pacifist", 8], ["丙", "secular", 3], ["丁", "militarist", 44]]);
  const rows = await ps(nat.id);
  for (const r of rows) await db.update(parliamentPartiesTable).set({ inCoalition: r.name !== "丁", isRuling: r.name === "甲" }).where(eq(parliamentPartiesTable.id, r.id));
  let i = 0; // 乙不退(0.999)，丙退(0)
  const r = await tickGovernment(nat.id, "democracy", 6, () => (i++ === 0 ? 0.999 : 0));
  assert.deepEqual(r.defectors.length, 1);
  assert.equal(r.collapsed, false); assert.equal(r.satDelta, 0);
  assert.deepEqual(await members(nat.id), ["乙", "甲"]);
  assert.equal((await st(nat.id)).satisfaction, 60);
});

test("裂解：夥伴退出後不過半 → 倒閣、議會滿意度 −10、重新組閣", async () => {
  const { nat } = await mk("議會內閣制", [["甲", "welfare", 30], ["乙", "pacifist", 12], ["丙", "secular", 10], ["丁", "militarist", 48]]);
  await reformGovernment(nat.id, "democracy", 5);
  // 擴軍 48 最大，與福利 0.4 → 擴軍+福利 = 78 的聯合。把總理黨夥伴全退出
  const before = await members(nat.id);
  assert.equal(before.length, 2);
  const r = await tickGovernment(nat.id, "democracy", 6, () => 0);
  assert.equal(r.collapsed, true); assert.equal(r.satDelta, -10); assert.equal((await st(nat.id)).satisfaction, 50);
  assert.ok((await logs(nat.id)).some((l) => l.summary.includes("內閣倒台")));
  // 倒閣後已重新組閣，不會留下沒有政府的空窗
  assert.ok((await members(nat.id)).length >= 1 || (await st(nat.id)).caretaker === true);
});

test("議會滿意度不會因看守/倒閣被扣到負數", async () => {
  const { nat } = await mk("議會內閣制", [["甲", "militarist", 40], ["乙", "pacifist", 35], ["丙", "pacifist", 25]], 5, 0);
  await reformGovernment(nat.id, "democracy", 5);
  await tickGovernment(nat.id, "democracy", 6);
  assert.equal((await st(nat.id)).satisfaction, 0);
});

test("專制：清掉所有聯合旗標，不適用", async () => {
  const { nat } = await mk("君主專制", [["愛國黨", "loyalist", 100, true]]);
  await db.update(parliamentPartiesTable).set({ inCoalition: true }).where(eq(parliamentPartiesTable.nationId, nat.id));
  const r = await reformGovernment(nat.id, "autocracy", 5);
  assert.equal(r.kind, "none"); assert.deepEqual(await members(nat.id), []);
  assert.equal((await buildGovernmentView(nat.id, "autocracy")).enabled, false);
  assert.deepEqual(await tickGovernment(nat.id, "autocracy", 6), { defectors: [], collapsed: false, satDelta: 0 });
});

test("半專制：現任自動組閣，即使沒過半，也不進入看守、不裂解", async () => {
  const { nat } = await mk("君主立憲制", [["甲", "welfare", 30, true], ["乙", "militarist", 45], ["丙", "secular", 25]]);
  const r = await reformGovernment(nat.id, "semi", 5);
  assert.equal(r.kind, "single", "半專制只有現任一黨入閣（沒過半也一樣）");
  assert.deepEqual(await members(nat.id), ["甲"]);
  assert.equal(await prime(nat.id), "甲"); assert.equal((await st(nat.id)).caretaker, false);
  assert.deepEqual(await tickGovernment(nat.id, "semi", 6, () => 0), { defectors: [], collapsed: false, satDelta: 0 });
});

test("沒有政黨的國家：不丟錯、不寫壞資料", async () => {
  const [nat] = await db.insert(playerNationsTable).values({ discordUserId: `co-${run}-x`, name: `${MARK}${run}x`, leaderName: "t", government: "議會內閣制", money: 1 } as any).returning();
  await db.insert(parliamentStateTable).values({ nationId: nat!.id, tick: 1, satisfaction: 60 });
  assert.equal((await reformGovernment(nat!.id, "democracy", 1)).kind, "none");
  assert.deepEqual(await tickGovernment(nat!.id, "democracy", 2), { defectors: [], collapsed: false, satDelta: 0 });
});

test("政府視圖：成員、席次、穩定度與風險", async () => {
  const { nat } = await mk("議會內閣制", [["甲", "welfare", 40], ["乙", "pacifist", 20], ["丙", "secular", 25], ["丁", "militarist", 15]]);
  await reformGovernment(nat.id, "democracy", 5);
  const v = await buildGovernmentView(nat.id, "democracy");
  assert.equal(v.enabled, true); assert.equal(v.kind, "coalition"); assert.equal(v.seats, 60);
  assert.deepEqual(v.members.map((m) => m.name), ["甲", "乙"]);
  assert.ok(v.stability > 0 && v.stability <= 1); assert.ok(["low", "mid", "high"].includes(v.risk));
  assert.equal(v.caretaker, false); assert.equal(v.failuresLeft, 0);
});

test("看守時視圖顯示還要失敗幾次就提前大選", async () => {
  const { nat } = await mk("議會內閣制", [["甲", "militarist", 40], ["乙", "pacifist", 35], ["丙", "pacifist", 25]]);
  await reformGovernment(nat.id, "democracy", 5);
  const v = await buildGovernmentView(nat.id, "democracy");
  assert.equal(v.kind, "caretaker"); assert.equal(v.failuresLeft, MAX_FORMATION_FAILURES - 1);
});

test("政策表決：聯合內意見相左 → 政府折衷成棄權；單黨政府不受影響", async () => {
  const { nat } = await mk("議會內閣制", [["福", "welfare", 26], ["節", "fiscal_hawk", 26], ["軍", "militarist", 48]]);
  // 手動指定聯合成員（福利+節流），驗證表決用的是 DB 裡的成員旗標
  const rows = await ps(nat.id);
  for (const r of rows) await db.update(parliamentPartiesTable).set({ inCoalition: r.name !== "軍" }).where(eq(parliamentPartiesTable.id, r.id));
  const out = await voteOnPolicy(nat, "policy", [{ stance: "welfare", direction: 1 }]);
  assert.ok(out);
  assert.equal(out!.result.votes[0]!.stand, "abstain");
  assert.match(out!.result.votes[0]!.name, /執政聯盟/);
  // 取消聯合 → 回到逐黨投票：福利贊成 26、節流反對 26 → 平手否決
  await db.update(parliamentPartiesTable).set({ inCoalition: false }).where(eq(parliamentPartiesTable.nationId, nat.id));
  const out2 = await voteOnPolicy(nat, "policy", [{ stance: "welfare", direction: 1 }]);
  assert.equal(out2!.result.passed, false);
});

test("政策表決：看守政府通過門檻更高", async () => {
  const { nat } = await mk("議會內閣制", [["福", "welfare", 55], ["節", "fiscal_hawk", 45]]);
  const tags = [{ stance: "welfare" as const, direction: 1 as const }];
  await db.update(parliamentPartiesTable).set({ inCoalition: false }).where(eq(parliamentPartiesTable.nationId, nat.id));
  assert.equal((await voteOnPolicy(nat, "policy", tags))!.result.passed, true, "55 vs 45 正常通過");
  await db.update(parliamentStateTable).set({ caretaker: true }).where(eq(parliamentStateTable.nationId, nat.id));
  assert.equal((await voteOnPolicy(nat, "policy", tags))!.result.passed, false, "看守政府差距不到 10% 不通過");
});
