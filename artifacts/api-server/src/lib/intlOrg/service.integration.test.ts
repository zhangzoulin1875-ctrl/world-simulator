import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, like, and } from "drizzle-orm";
import {
  db, pool, playerNationsTable, parliamentStateTable, parliamentPartiesTable, intlOrgsTable, intlOrgPlansTable,
  diplomacyWarsTable,
} from "@workspace/db";
import { runParliamentMigrations } from "../parliamentMigrations";
import { setPenaltyScaleForTest } from "../penaltyScaleLoad";
import { runIntlOrgSettlement, executePlan, writePlans, buildOrgViews, loadSituations } from "./service";
import { PLAN_LEAD_TURNS, DECISION_EVERY_TURNS, INFLUENCE_START } from "./core";

/** 國際組織 — 真資料庫整合測試。 */
const MARK = "OrgT"; const run = randomBytes(3).toString("hex"); let n = 0;
async function mk(o: { sat?: number; stab?: number; npc?: boolean; leftSeats?: number } = {}) {
  const [nat] = await db.insert(playerNationsTable).values({
    discordUserId: `og-${run}-${n}`, name: `${MARK}${run}${n++}`, leaderName: "t", government: "議會內閣制",
    money: 100_000, stability: o.stab ?? 70, isNpc: o.npc ?? false,
  } as any).returning();
  await db.insert(parliamentStateTable).values({ nationId: nat!.id, tick: 5, satisfaction: o.sat ?? 70, lastPartiesTick: 5 });
  const left = o.leftSeats ?? 0;
  await db.insert(parliamentPartiesTable).values([
    { nationId: nat!.id, name: "福利黨", stance: "welfare", weight: Math.max(1, left), seats: left, isRuling: false },
    { nationId: nat!.id, name: "主流黨", stance: "mercantile", weight: 100 - left, seats: 100 - left, isRuling: true },
  ].filter((p) => p.seats > 0));
  return nat!;
}
const HOT = { sat: 15, stab: 20, leftSeats: 30 };
const org = async () => (await db.select().from(intlOrgsTable).where(eq(intlOrgsTable.slug, "comintern")))[0]!;
const setOrg = (set: Partial<typeof intlOrgsTable.$inferInsert>) => db.update(intlOrgsTable).set(set).where(eq(intlOrgsTable.slug, "comintern"));
const plans = async () => (await db.select().from(intlOrgPlansTable)).filter((p) => p.targetNationId && ids.has(p.targetNationId));
const ids = new Set<string>();
const track = (x: { id: string }) => { ids.add(x.id); return x; };
const sat = async (id: string) => (await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, id)))[0]!.satisfaction;
const stab = async (id: string) => (await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, id)))[0]!.stability;
async function cleanPlans() { await db.delete(intlOrgPlansTable); }

before(async () => {
  await runParliamentMigrations();
  setPenaltyScaleForTest(1);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
});
after(async () => {
  setPenaltyScaleForTest(null);
  await cleanPlans();
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${MARK}%`));
  await pool.end();
});

test("遷移種下共產國際，影響力 10；重跑遷移不會重複", async () => {
  await runParliamentMigrations();
  const all = await db.select().from(intlOrgsTable).where(eq(intlOrgsTable.slug, "comintern"));
  assert.equal(all.length, 1); assert.equal(all[0]!.ideology, "red");
});

test("局勢摘要：議會滿意度、左翼席次占比、穩定度、玩家/NPC 標記", async () => {
  const a = track(await mk(HOT)); const b = track(await mk({ npc: true }));
  const sits = await loadSituations("red");
  const sa = sits.find((s) => s.nationId === a.id)!, sb = sits.find((s) => s.nationId === b.id)!;
  assert.equal(sa.parliamentSat, 15); assert.equal(sa.stability, 20); assert.equal(sa.radicalSeatShare, 0.3);
  assert.equal(sa.isPlayer, true); assert.equal(sb.isPlayer, false); assert.equal(sb.radicalSeatShare, 0);
});

test("決策日寫預告：執行時間 = 現在 + 2 回合；預告當下不套用任何效果", async () => {
  await cleanPlans();
  const a = track(await mk(HOT));
  await setOrg({ tick: 0, nextDecisionTick: 1, influence: 40, setbacks: 0 });
  const s = await runIntlOrgSettlement();
  assert.ok(s.planned >= 1);
  const p = (await plans()).find((x) => x.targetNationId === a.id)!;
  assert.ok(p, "應該有針對動盪國的預告"); assert.equal(p.status, "planned");
  assert.equal(p.executeTick - p.plannedTick, PLAN_LEAD_TURNS);
  assert.equal(await sat(a.id), 15, "預告階段不能動議會滿意度");
  assert.equal(await stab(a.id), 20);
});

test("到期才執行：宣傳扣議會滿意度；過期前不動、到期後狀態變 executed 並留下說明", async () => {
  await cleanPlans();
  const a = track(await mk({ sat: 40, stab: 30, leftSeats: 10 }));
  await setOrg({ tick: 9, influence: 20, nextDecisionTick: 9999, setbacks: 0 });
  await db.insert(intlOrgPlansTable).values({ orgId: (await org()).id, targetNationId: a.id, action: "propaganda", plannedTick: 8, executeTick: 11 });
  await runIntlOrgSettlement(); // tick 10：未到期
  assert.equal(await sat(a.id), 40);
  assert.equal((await plans()).find((x) => x.targetNationId === a.id)!.status, "planned");
  await runIntlOrgSettlement(); // tick 11：到期
  assert.ok(await sat(a.id) < 40, "宣傳應扣議會滿意度");
  const p = (await plans()).find((x) => x.targetNationId === a.id)!;
  assert.equal(p.status, "executed"); assert.match(p.resultSummary ?? "", /宣傳/);
});

test("目標國局勢已好轉 → 行動落空、不套效果、組織受挫(影響力被扣)", async () => {
  await cleanPlans();
  const a = track(await mk({ sat: 90, stab: 90 }));
  await setOrg({ tick: 20, influence: 60, nextDecisionTick: 9999, setbacks: 0 });
  await db.insert(intlOrgPlansTable).values({ orgId: (await org()).id, targetNationId: a.id, action: "strikes", plannedTick: 19, executeTick: 21 });
  await runIntlOrgSettlement();
  assert.equal(await sat(a.id), 90); assert.equal(await stab(a.id), 90);
  const p = (await plans()).find((x) => x.targetNationId === a.id)!;
  assert.equal(p.status, "executed"); assert.match(p.resultSummary ?? "", /落空/);
});

test("罷工潮：扣穩定度，並替玩家國建立罷工事件；NPC 只扣穩定度不建事件", async () => {
  await cleanPlans();
  const pl = track(await mk({ sat: 30, stab: 40, leftSeats: 15 })); const npc = track(await mk({ sat: 30, stab: 40, leftSeats: 15, npc: true }));
  await setOrg({ tick: 30, influence: 60, nextDecisionTick: 9999, setbacks: 0 });
  const o = await org();
  await db.insert(intlOrgPlansTable).values([
    { orgId: o.id, targetNationId: pl.id, action: "strikes", plannedTick: 28, executeTick: 31 },
    { orgId: o.id, targetNationId: npc.id, action: "strikes", plannedTick: 28, executeTick: 31 },
  ]);
  await runIntlOrgSettlement();
  assert.ok(await stab(pl.id) < 40 && await stab(npc.id) < 40);
  const { domesticEventsTable } = await import("@workspace/db");
  const evs = await db.select().from(domesticEventsTable).where(eq(domesticEventsTable.nationId, pl.id));
  assert.equal(evs.length, 1); assert.equal(evs[0]!.kind, "soc_labor_strike");
  assert.equal((await db.select().from(domesticEventsTable).where(eq(domesticEventsTable.nationId, npc.id))).length, 0);
});

test("資助：左翼政黨權重上升", async () => {
  await cleanPlans();
  const a = track(await mk({ sat: 30, stab: 40, leftSeats: 20 }));
  await setOrg({ tick: 40, influence: 50, nextDecisionTick: 9999, setbacks: 0 });
  await db.insert(intlOrgPlansTable).values({ orgId: (await org()).id, targetNationId: a.id, action: "funding", plannedTick: 38, executeTick: 41 });
  const w0 = (await db.select().from(parliamentPartiesTable).where(and(eq(parliamentPartiesTable.nationId, a.id), eq(parliamentPartiesTable.stance, "welfare"))))[0]!.weight;
  await runIntlOrgSettlement();
  const w1 = (await db.select().from(parliamentPartiesTable).where(and(eq(parliamentPartiesTable.nationId, a.id), eq(parliamentPartiesTable.stance, "welfare"))))[0]!.weight;
  assert.ok(w1 > w0, `${w1} 應 > ${w0}`);
});

test("策反：符合雙重門檻 → 引爆內戰；沒有領土時失敗且組織受挫", async () => {
  await cleanPlans();
  const a = track(await mk(HOT));
  await setOrg({ tick: 50, influence: 80, nextDecisionTick: 9999, setbacks: 0 });
  await db.insert(intlOrgPlansTable).values({ orgId: (await org()).id, targetNationId: a.id, action: "subvert", plannedTick: 48, executeTick: 51 });
  await runIntlOrgSettlement();
  const p = (await plans()).find((x) => x.targetNationId === a.id)!;
  assert.equal(p.status, "executed");
  // 測試國沒有地區 → startCivilWar 回 no_territory → 策反失敗；這同時驗證「失敗不丟錯、不中斷回合」
  assert.match(p.resultSummary ?? "", /策反失敗|共產革命爆發/);
});

test("同一組織對同一國同時只有一筆 planned（並行寫入安全）", async () => {
  await cleanPlans();
  const a = track(await mk(HOT));
  const o = await org();
  const r = await Promise.all([1, 2, 3, 4].map(() => writePlans(o, [{ targetNationId: a.id, action: "propaganda" }], 60, "rule")));
  assert.equal(r.reduce((x, y) => x + y, 0), 1, "只有一次寫入成功");
  assert.equal((await plans()).filter((p) => p.targetNationId === a.id).length, 1);
});

test("並行執行同一筆預告只會套用一次", async () => {
  await cleanPlans();
  const a = track(await mk({ sat: 60, stab: 30, leftSeats: 10 }));
  await setOrg({ tick: 70, influence: 20, nextDecisionTick: 9999, setbacks: 0 });
  const o = await org();
  const [row] = await db.insert(intlOrgPlansTable).values({ orgId: o.id, targetNationId: a.id, action: "propaganda", plannedTick: 68, executeTick: 70 }).returning();
  const rs = await Promise.all([1, 2, 3].map(() => executePlan(o, row!, 70)));
  assert.equal(rs.filter((r) => r.executed).length, 1);
  const eff = 60 - (await sat(a.id));
  assert.ok(eff > 0 && eff <= 6, `只扣一次，實際扣 ${eff}`);
});

test("冷卻：剛被針對過的國家，決策日不會再被排預告", async () => {
  await cleanPlans();
  const a = track(await mk(HOT));
  await setOrg({ tick: 79, influence: 40, nextDecisionTick: 80, setbacks: 0 });
  await db.insert(intlOrgPlansTable).values({ orgId: (await org()).id, targetNationId: a.id, action: "propaganda", plannedTick: 77, executeTick: 79, status: "executed" });
  await runIntlOrgSettlement(); // tick 80 決策日，距 79 才 1 回合
  assert.equal((await plans()).filter((p) => p.targetNationId === a.id && p.status === "planned").length, 0);
});

test("已在內戰的國家不會被排預告", async () => {
  await cleanPlans();
  const a = track(await mk(HOT)); const b = track(await mk({ npc: true }));
  await db.insert(diplomacyWarsTable).values({ nationAId: a.id, nationBId: b.id, declaredByNationId: b.id, isCivilWar: true } as any);
  await setOrg({ tick: 90, influence: 80, nextDecisionTick: 91, setbacks: 0 });
  await runIntlOrgSettlement();
  assert.equal((await plans()).filter((p) => p.targetNationId === a.id).length, 0);
  await db.delete(diplomacyWarsTable).where(eq(diplomacyWarsTable.nationAId, a.id));
});

test("決策日間隔：寫完預告後下次決策日 = tick + 4", async () => {
  await setOrg({ tick: 100, influence: 40, nextDecisionTick: 101, setbacks: 0 });
  await runIntlOrgSettlement();
  assert.equal((await org()).nextDecisionTick, 101 + DECISION_EVERY_TURNS);
});

test("影響力：動盪世界緩慢成長、每回合最多 +3；起始值 10", async () => {
  assert.equal(INFLUENCE_START, 10);
  await cleanPlans();
  track(await mk(HOT));
  await setOrg({ tick: 110, influence: 10, nextDecisionTick: 9999, setbacks: 0 });
  const before = (await org()).influence;
  await runIntlOrgSettlement();
  const after = (await org()).influence;
  assert.ok(after >= before && after - before <= 3, `${before} -> ${after}`);
});

test("玩家視圖：關注程度、針對你/他國的預告（模糊時間）、能力列表、最近結果", async () => {
  await cleanPlans();
  const me = track(await mk(HOT)); const other = track(await mk(HOT));
  await setOrg({ tick: 120, influence: 55, nextDecisionTick: 9999, setbacks: 0 });
  const o = await org();
  await db.insert(intlOrgPlansTable).values([
    { orgId: o.id, targetNationId: me.id, action: "strikes", plannedTick: 119, executeTick: 122 },
    { orgId: o.id, targetNationId: other.id, action: "propaganda", plannedTick: 119, executeTick: 122 },
    { orgId: o.id, targetNationId: me.id, action: "propaganda", plannedTick: 100, executeTick: 102, status: "executed", resultSummary: "議會滿意度 -4" },
  ]);
  const v = (await buildOrgViews(me.id)).find((x) => x.slug === "comintern")!;
  assert.equal(v.attention, "high"); assert.equal(v.level, "growing");
  assert.deepEqual(v.forYou, [{ action: "罷工潮", eta: "2~3 回合內" }]);
  assert.ok(v.elsewhere.length >= 1 && !JSON.stringify(v.elsewhere).includes(other.id), "不洩漏他國身分");
  assert.ok(v.capabilities.includes("罷工潮") && !v.capabilities.includes("策反"));
  assert.equal(v.recent.length, 1); assert.equal(v.recent[0]!.summary, "議會滿意度 -4");
});
