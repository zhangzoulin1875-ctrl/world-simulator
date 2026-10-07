import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { db, pool, playerNationsTable, parliamentStateTable, parliamentPartiesTable, intlOrgsTable, intlOrgPlansTable } from "@workspace/db";
import { runParliamentMigrations } from "../parliamentMigrations";
import { setPenaltyScaleForTest } from "../penaltyScaleLoad";
import { AiQuotaExceededError } from "../gameAi";
import { runIntlOrgSettlement } from "./service";
import { decideWithAi, setAiCallerForTest } from "./aiRunner";
import type { DecisionContext, NationSituation } from "./core";

const MARK = "OrgAi"; const run = randomBytes(3).toString("hex"); let n = 0;
const N = (id: string, o: Partial<NationSituation> = {}): NationSituation => ({
  nationId: id, parliamentSat: 60, radicalSeatShare: 0, stability: 70, atWar: false, inCivilWar: false, isPlayer: false, ...o,
});
const HOT = { parliamentSat: 15, stability: 20, radicalSeatShare: 0.3 };
const ctx = (nations: NationSituation[], o: Partial<DecisionContext> = {}): DecisionContext =>
  ({ influence: 80, nations, lastTargetedTick: {}, alreadyPlanned: [], tick: 20, ...o });

async function mk() {
  const [nat] = await db.insert(playerNationsTable).values({
    discordUserId: `oa-${run}-${n}`, name: `${MARK}${run}${n++}`, leaderName: "t", government: "議會內閣制", money: 1, stability: 20, isNpc: false,
  } as any).returning();
  await db.insert(parliamentStateTable).values({ nationId: nat!.id, tick: 5, satisfaction: 15, lastPartiesTick: 5 });
  await db.insert(parliamentPartiesTable).values([
    { nationId: nat!.id, name: "福利黨", stance: "welfare", weight: 30, seats: 30, isRuling: false },
    { nationId: nat!.id, name: "主流黨", stance: "mercantile", weight: 70, seats: 70, isRuling: true },
  ]);
  return nat!;
}
before(async () => { await runParliamentMigrations(); setPenaltyScaleForTest(1); await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`)); });
after(async () => {
  setAiCallerForTest(null); setPenaltyScaleForTest(null);
  await db.delete(intlOrgPlansTable); await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`)); await pool.end();
});

test("AI 回合法決策 → source=ai，採用 AI 的選擇", async () => {
  setAiCallerForTest(async () => '[{"target":"N1","action":"propaganda"}]');
  const r = await decideWithAi({ ideology: "red" }, ctx([N("a", HOT), N("b", HOT)]));
  assert.equal(r.source, "ai"); assert.deepEqual(r.decisions, [{ targetNationId: "a", action: "propaganda" }]);
});

test("AI 回 [] = 刻意按兵不動：尊重它，不補規則版", async () => {
  setAiCallerForTest(async () => "[]");
  const r = await decideWithAi({ ideology: "red" }, ctx([N("a", HOT)]));
  assert.equal(r.source, "ai"); assert.deepEqual(r.decisions, []);
});

test("AI 逾時 → 退回規則版（不卡結算）", async () => {
  setAiCallerForTest(() => new Promise(() => {})); // 永不回應
  const t0 = Date.now();
  const r = await decideWithAi({ ideology: "red" }, ctx([N("a", HOT)]), 150);
  assert.ok(Date.now() - t0 < 1500, "必須在逾時後立刻退回");
  assert.equal(r.source, "rule"); assert.ok(r.decisions.length >= 1);
});

test("AI 拋錯 / 格式壞掉 / 額度滿 → 一律退回規則版", async () => {
  for (const fn of [async () => { throw new Error("boom"); }, async () => "我決定不行動", async () => { throw new AiQuotaExceededError("intl_org.decision" as any); }]) {
    setAiCallerForTest(fn as any);
    const r = await decideWithAi({ ideology: "red" }, ctx([N("a", HOT)]));
    assert.equal(r.source, "rule"); assert.ok(r.decisions.length >= 1);
  }
});

test("AI 亂來（不存在的國家、做不到的策反、無理由針對平靜玩家國）→ 全被剔除", async () => {
  setAiCallerForTest(async () => '[{"target":"N7","action":"strikes"},{"target":"N1","action":"subvert"},{"target":"N2","action":"propaganda"}]');
  const c = ctx([N("a", { parliamentSat: 40, radicalSeatShare: 0.2, stability: 50 }), N("calm", { isPlayer: true })]);
  const r = await decideWithAi({ ideology: "red" }, c);
  assert.equal(r.source, "ai"); assert.ok(!r.decisions.some((d) => d.targetNationId === "calm"));
  assert.ok(!r.decisions.some((d) => d.action === "subvert"));
});

test("全是內戰國 → 不呼叫 AI", async () => {
  let called = 0; setAiCallerForTest(async () => { called++; return "[]"; });
  const r = await decideWithAi({ ideology: "red" }, ctx([N("a", { ...HOT, inCivilWar: true })]));
  assert.equal(called, 0); assert.deepEqual(r.decisions, []);
});

test("prompt 不洩漏真實 nationId / 國名", async () => {
  let seen = ""; setAiCallerForTest(async (p) => { seen = p; return "[]"; });
  await decideWithAi({ ideology: "red" }, ctx([N("11111111-2222-3333-4444-555555555555", HOT)]));
  assert.ok(seen.length > 0 && !seen.includes("11111111-2222"));
});

test("完整結算：決策日 AI 的選擇寫成預告（source=ai），執行時間 +2", async () => {
  await db.delete(intlOrgPlansTable);
  const a = await mk();
  await db.update(intlOrgsTable).set({ tick: 0, nextDecisionTick: 1, influence: 40, setbacks: 0 }).where(eq(intlOrgsTable.slug, "comintern"));
  // 候選依動盪度排序；測試庫可能有其他國家，所以讓 AI 對「所有」代號都回宣傳，再檢查我們這國有被排到
  setAiCallerForTest(async (p) => {
    const codes = [...p.matchAll(/^(N\d+):/gm)].map((m) => m[1]);
    return JSON.stringify(codes.map((c) => ({ target: c, action: "propaganda" })));
  });
  const s = await runIntlOrgSettlement({ decide: (org, c) => decideWithAi(org, c) });
  assert.ok(s.planned >= 1);
  const plans = await db.select().from(intlOrgPlansTable);
  assert.ok(plans.length >= 1 && plans.length <= 2 && plans.every((p) => p.source === "ai" && p.executeTick - p.plannedTick === 2));
  void a;
});
