import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  parliamentStateTable,
  politicsEntriesTable,
  focusStatesTable,
  focusActiveTable,
  focusCompletedTable,
  focusBranchesTable,
  focusBranchRootsTable,
} from "@workspace/db";
import { runGameMigrations } from "../gameMigrations";
import { runFocusMigrations } from "../focusMigrations";
import { runParliamentMigrations } from "../parliamentMigrations";
import { settleNationFocus, startFocus, cancelFocus, runFocusSettlement } from "./service";
import { setPenaltyScaleForTest } from "../penaltyScaleLoad";
import { getFocusView } from "./view";
import { setCatalogForTest, FOCUS_CATALOG } from "./catalog";
import { findEdge, edgesFrom } from "./regimeGraph";
import { SAMPLE_CATALOG } from "./catalog.sample";
import type { FocusDef } from "./types";
import { governmentLabel } from "../governments";
import { setStoryQueuerForTest } from "./focusStory";
import { COMMUNIST_REVOLUTION_COST } from "./regimeFocuses";

const TAG = "focussvc-test";
const ERA = "classical";
let nationId = "";

const load = async () => (await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId)))[0]!;
const fstate = async () => (await db.select().from(focusStatesTable).where(eq(focusStatesTable.nationId, nationId)))[0]!;
const setSat = (s: number) =>
  db.insert(parliamentStateTable).values({ nationId, satisfaction: s })
    .onConflictDoUpdate({ target: parliamentStateTable.nationId, set: { satisfaction: s } });

before(async () => {
  setPenaltyScaleForTest(1); // 原有測試測流程,固定倍率 1
  setStoryQueuerForTest(() => {}); // 測試不該真的去打 AI、也不該在清理資料後還有背景寫入
  await runGameMigrations();
  await runParliamentMigrations();
  await runFocusMigrations();
  await db.delete(playerNationsTable).where(eq(playerNationsTable.leaderName, TAG));
  const [n] = await db
    .insert(playerNationsTable)
    .values({ name: `${TAG}-國`, leaderName: TAG, discordUserId: `${TAG}-u`, government: governmentLabel("absolute_monarchy")! })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
  // 這個檔案測的是國策「規則」本身,不是隨機抽選:把君主專制的全部出邊固定放進樹上,
  // 否則轉型測試會因為沒抽到該條而間歇性失敗(not_in_tree)
  await db.insert(focusBranchRootsTable).values({ nationId, fromGovernment: "absolute_monarchy" });
  await db.insert(focusBranchesTable).values(
    edgesFrom("absolute_monarchy").map((e) => ({ nationId, fromGovernment: "absolute_monarchy", toGovernment: e.to })),
  );
});

after(async () => {
  setStoryQueuerForTest(null);
  setCatalogForTest(null);
  await db.delete(playerNationsTable).where(eq(playerNationsTable.leaderName, TAG));
  await pool.end();
});

beforeEach(async () => {
  await db.delete(focusActiveTable).where(eq(focusActiveTable.nationId, nationId));
  await db.delete(focusCompletedTable).where(eq(focusCompletedTable.nationId, nationId));
  await db.delete(focusStatesTable).where(eq(focusStatesTable.nationId, nationId));
  await db.update(playerNationsTable).set({ coupPolicyLockTurns: 0, stability: 50, satisfactionMilitary: 60, politicalSupport: 50, money: 10_000, government: governmentLabel("absolute_monarchy")! }).where(eq(playerNationsTable.id, nationId));
  await db.delete(politicsEntriesTable).where(eq(politicsEntriesTable.nationId, nationId));
  await setSat(65);
  setCatalogForTest(SAMPLE_CATALOG);
});

const give = (points: number) =>
  db.insert(focusStatesTable).values({ nationId, points }).onConflictDoUpdate({ target: focusStatesTable.nationId, set: { points } });

test("每回合發政治點數,且不超過庫存上限", async () => {
  const n = await load();
  const r = await settleNationFocus(n, ERA);
  assert.ok(r.pointsGained >= 1);
  const s1 = await fstate();
  assert.equal(s1.points, r.pointsGained);
  await db.update(focusStatesTable).set({ points: 9999 }).where(eq(focusStatesTable.nationId, nationId));
  const r2 = await settleNationFocus(n, ERA);
  assert.equal(r2.pointsGained, 0, "已超過上限不再發");
  assert.equal((await fstate()).points, 9999, "既有庫存不被砍");
});

test("啟動:預扣點數、建立進行中、同槽位第二條被擋", async () => {
  await give(50);
  const n = await load();
  const r = await startFocus(n, "regime.royal_decree");
  assert.equal(r.ok, true);
  assert.equal((await fstate()).points, 50 - 6);
  const again = await startFocus(n, "regime.royal_decree");
  assert.equal(again.ok, false);
  const busy = await startFocus(n, "regime.to_constitutional_monarchy"); // 同為 main 槽
  assert.equal(busy.ok, false);
});

test("點數不足、前置缺失、政體不符皆被擋並說明原因", async () => {
  await give(2);
  const n = await load();
  const r1 = await startFocus(n, "regime.royal_decree");
  assert.deepEqual([r1.ok, !r1.ok && r1.reason], [false, "insufficient_points"]);
  await give(100);
  const r2 = await startFocus(n, "mil.standing_army");
  assert.deepEqual([r2.ok, !r2.ok && r2.reason], [false, "prereq_missing"]);
  const r3 = await startFocus(n, "int.workers_councils"); // 只開放給議會類政體
  assert.deepEqual([r3.ok, !r3.ok && r3.reason], [false, "government_not_allowed"]);
  const r4 = await startFocus(n, "no.such_focus");
  assert.deepEqual([r4.ok, !r4.ok && r4.reason], [false, "unknown_focus"]);
});

test("推進到完成:寫入已完成、刪進行中、套用一次性效果(議會滿意度)", async () => {
  await give(50);
  await setSat(65); // 速度 1.0
  const n = await load();
  await startFocus(n, "regime.royal_decree"); // turns 4,議會 -6
  for (let i = 0; i < 3; i++) {
    const r = await settleNationFocus(await load(), ERA);
    assert.deepEqual(r.completed, []);
  }
  const done = await settleNationFocus(await load(), ERA);
  assert.deepEqual(done.completed, ["regime.royal_decree"]);
  assert.equal((await db.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, nationId))).length, 0);
  assert.equal((await db.select().from(focusCompletedTable).where(eq(focusCompletedTable.nationId, nationId))).length, 1);
  const [par] = await db.select().from(parliamentStateTable).where(eq(parliamentStateTable.nationId, nationId));
  assert.equal(par!.satisfaction, 65 - 6, "議會滿意度 -6");
});

test("完成後互斥分岔:選了一個,另外兩個永久鎖定", async () => {
  await give(200);
  await db.insert(focusCompletedTable).values({ nationId, focusId: "regime.royal_decree" });
  const n = await load();
  assert.equal((await startFocus(n, "mil.standing_army")).ok, true);
  for (let i = 0; i < 8; i++) await settleNationFocus(await load(), ERA);
  assert.equal((await db.select().from(focusCompletedTable).where(eq(focusCompletedTable.focusId, "mil.standing_army"))).length >= 1, true);
  const lev = await startFocus(await load(), "mil.levy_mobilization");
  assert.deepEqual([lev.ok, !lev.ok && lev.reason], [false, "excluded_by_completed"]);
});

test("互斥對象正在進行中,也不能同時啟動另一條(含跨槽位)", async () => {
  await give(200);
  await db.insert(focusCompletedTable).values({ nationId, focusId: "regime.royal_decree" });
  const n = await load();
  assert.equal((await startFocus(n, "mil.standing_army")).ok, true);
  const other = await startFocus(n, "mil.levy_mobilization");
  assert.equal(other.ok, false);
});

test("議會滿意度 <=15:進度停擺,但點數照發", async () => {
  await give(50);
  await setSat(10);
  const n = await load();
  await startFocus(n, "regime.royal_decree");
  const before = (await fstate()).points;
  const r = await settleNationFocus(await load(), ERA);
  assert.equal(r.stalled, true);
  assert.ok(r.pointsGained >= 1);
  assert.equal((await fstate()).points, before + r.pointsGained);
  const [a] = await db.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, nationId));
  assert.equal(a!.progress, 0);
});

test("政變鎖定期間:不能啟動、進度不動、點數照發", async () => {
  await give(50);
  const n = await load();
  await startFocus(n, "regime.royal_decree");
  await db.update(playerNationsTable).set({ coupPolicyLockTurns: 3 }).where(eq(playerNationsTable.id, nationId));
  const r = await settleNationFocus(await load(), ERA);
  assert.deepEqual(r.completed, []);
  const [a] = await db.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, nationId));
  assert.equal(a!.progress, 0, "鎖定期間進度不動");
  const blocked = await startFocus(await load(), "regime.to_constitutional_monarchy");
  assert.deepEqual([blocked.ok, !blocked.ok && blocked.reason], [false, "policy_locked"]);
});

test("客觀條件:未滿足被擋並說明;滿足後可啟動(取代舊接受度)", async () => {
  await give(100);
  await db.insert(focusCompletedTable).values({ nationId, focusId: "regime.royal_decree" });
  await db.update(playerNationsTable).set({ politicalSupport: 30 }).where(eq(playerNationsTable.id, nationId));
  const n = await load();
  const no = await startFocus(n, "regime.to_constitutional_monarchy"); // 需支持度 >= 55
  assert.equal(no.ok, false);
  assert.ok(!no.ok && no.message.includes("政治支持度"));
  assert.equal((await fstate()).points, 100, "被擋時不扣點");
  await db.update(playerNationsTable).set({ politicalSupport: 70 }).where(eq(playerNationsTable.id, nationId));
  assert.equal((await startFocus(await load(), "regime.to_constitutional_monarchy")).ok, true);
});

test("時代鎖:未到 minEra 不能啟動", async () => {
  const future: FocusDef = {
    id: "eco.future_grid", domain: "economy", track: "stable", slot: "side",
    title: "t", description: "d", cost: 5, turns: 3, requires: [], minEra: "future",
    effects: [{ kind: "modifier", stat: "taxIncome", value: -1 }],
  };
  setCatalogForTest([...SAMPLE_CATALOG, future]);
  await give(50);
  const r = await startFocus(await load(), "eco.future_grid");
  assert.deepEqual([r.ok, !r.ok && r.reason], [false, "era_locked"]);
});

test("取消:退還 50%(捨去)並釋放槽位", async () => {
  await give(50);
  const n = await load();
  await startFocus(n, "regime.royal_decree"); // 花 6
  assert.equal((await fstate()).points, 44);
  const c = await cancelFocus(n, "regime.royal_decree");
  assert.deepEqual(c, { ok: true, refunded: 3 });
  assert.equal((await fstate()).points, 47);
  assert.equal((await cancelFocus(n, "regime.royal_decree")).ok, false, "重複取消失敗");
  assert.equal((await startFocus(n, "regime.royal_decree")).ok, true, "槽位已釋放");
});

test("連續重複啟動同一國策:只會成功一次,點數只扣一次", async () => {
  // 注意:測試用的是 PGlite(單一會話的嵌入式 Postgres),無法模擬真正的多連線併發,
  // 所以這裡驗證的是「業務語意」。真正的併發保證由三層提供:
  //   1) pg_advisory_xact_lock(以國家為單位序列化) 2) 唯一索引(每槽位一條/同國策一次)
  //   3) startFocus 捕捉 23505 轉成明確訊息。後兩層在任何資料庫都成立。
  await give(50);
  const n = await load();
  const rs = [];
  for (let i = 0; i < 4; i++) rs.push(await startFocus(n, "regime.royal_decree"));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal((await fstate()).points, 44);
  assert.equal((await db.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, nationId))).length, 1);
});

test("槽位已被其他紀錄佔用:回絕且不扣點(交易回滾)", async () => {
  await give(50);
  const n = await load();
  // 直接塞一筆同槽位的進行中紀錄(模擬別處已佔用)。23505 捕捉路徑需要真多連線才能觸發,
  // 沙箱的 PGlite 做不到,所以此測試只驗證「被擋且不扣點」。
  await db.insert(focusActiveTable).values({ nationId, focusId: "other.focus", slot: "main", totalTurns: 3, spentPoints: 1 });
  const r = await startFocus(n, "regime.royal_decree");
  assert.equal(r.ok, false);
  assert.equal((await fstate()).points, 50, "失敗時不扣點(交易回滾)");
});

test("傾向值與一次性效果:完成總體戰動員 → 黑線 +25、穩定度 -8,夾在 0-100", async () => {
  await give(100);
  await db.insert(focusCompletedTable).values([{ nationId, focusId: "regime.royal_decree" }, { nationId, focusId: "mil.standing_army" }]);
  await db.update(playerNationsTable).set({ stability: 5 }).where(eq(playerNationsTable.id, nationId));
  const n = await load();
  assert.equal((await startFocus(n, "mil.total_mobilization")).ok, true); // turns 8, 需 requiresAny 之一
  for (let i = 0; i < 9; i++) await settleNationFocus(await load(), ERA);
  const s = await fstate();
  assert.equal(s.blackLean, 25);
  assert.equal((await load()).stability, 0, "5 - 8 夾在 0");
});

test("目錄已移除的進行中國策:完成時不崩潰,仍記為完成", async () => {
  await give(50);
  await startFocus(await load(), "regime.royal_decree");
  setCatalogForTest([]); // 模擬版本更新移除了該國策
  for (let i = 0; i < 5; i++) await settleNationFocus(await load(), ERA);
  assert.equal((await db.select().from(focusCompletedTable).where(eq(focusCompletedTable.nationId, nationId))).length, 1);
});

test("runFocusSettlement:單國錯誤不影響整批,回傳統計", async () => {
  const r = await runFocusSettlement();
  assert.ok(r.nations >= 1);
  assert.equal(r.failed, 0);
});

// ── 政體轉型 ────────────────────────────────────────────────

const edgeFocus = (from: string, to: string) => findEdge(from, to)!.focusId;

test("轉型國策完成:政體真的改變、支持度重設、寫入政治條目、議會黨派檔位可重建", async () => {
  setCatalogForTest(FOCUS_CATALOG);
  const id = edgeFocus("absolute_monarchy", "constitutional_monarchy"); // reform:支持度>=55
  await give(100);
  await db.update(playerNationsTable).set({ politicalSupport: 70 }).where(eq(playerNationsTable.id, nationId));
  const start = await startFocus(await load(), id);
  assert.equal(start.ok, true, JSON.stringify(start));
  await setSat(65);
  for (let i = 0; i < 9; i++) await settleNationFocus(await load(), ERA);
  const n = await load();
  assert.equal(n.government, governmentLabel("constitutional_monarchy"));
  assert.equal(n.politicalSupport, 55, "支持度重設為 governmentChangeSupportReset 預設 55");
  const entries = await db.select().from(politicsEntriesTable).where(eq(politicsEntriesTable.nationId, nationId));
  assert.ok(entries.some((e) => e.title === "政體變更"));
  assert.equal((await db.select().from(focusCompletedTable).where(eq(focusCompletedTable.nationId, nationId))).length, 1);
  // 政體變了:原本以君主專制為起點的國策不再可見/可啟動
  const again = await startFocus(await load(), edgeFocus("absolute_monarchy", "theocracy"));
  assert.deepEqual([again.ok, !again.ok && again.reason], [false, "government_not_allowed"]);
});

test("轉型條件未達:被擋並說明,且不扣點、不換政體", async () => {
  setCatalogForTest(FOCUS_CATALOG);
  await give(100);
  const r = await startFocus(await load(), edgeFocus("absolute_monarchy", "military_dictatorship")); // 需黑線傾向>=50
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.message.includes("傾向值"), JSON.stringify(r));
  assert.equal((await fstate()).points, 100);
  assert.equal((await load()).government, governmentLabel("absolute_monarchy"));
});

test("黑線轉型:傾向值達標後可走到軍事獨裁,並承擔穩定度/金錢代價", async () => {
  setCatalogForTest(FOCUS_CATALOG);
  await give(100);
  await db.update(focusStatesTable).set({ blackLean: 60 }).where(eq(focusStatesTable.nationId, nationId));
  await db.update(playerNationsTable).set({ satisfactionMilitary: 70, stability: 60, money: 5000 }).where(eq(playerNationsTable.id, nationId));
  assert.equal((await startFocus(await load(), edgeFocus("absolute_monarchy", "military_dictatorship"))).ok, true);
  await setSat(65);
  for (let i = 0; i < 12; i++) await settleNationFocus(await load(), ERA);
  const n = await load();
  assert.equal(n.government, governmentLabel("military_dictatorship"));
  assert.equal(n.stability, 48, "穩定度 -12");
  assert.equal(n.money, 3800, "金錢 -1200");
});

test("起點政體在完成前被改掉:不轉型、全額退點、可重選", async () => {
  setCatalogForTest(FOCUS_CATALOG);
  await give(100);
  await db.update(playerNationsTable).set({ politicalSupport: 70 }).where(eq(playerNationsTable.id, nationId));
  const id = edgeFocus("absolute_monarchy", "constitutional_monarchy");
  const s = await startFocus(await load(), id);
  assert.equal(s.ok, true);
  const afterStart = (await fstate()).points;
  // 期間政體被別的力量(例如革命)改掉
  await db.update(playerNationsTable).set({ government: governmentLabel("aristocracy")! }).where(eq(playerNationsTable.id, nationId));
  await setSat(65);
  for (let i = 0; i < 9; i++) await settleNationFocus(await load(), ERA);
  const n = await load();
  assert.equal(n.government, governmentLabel("aristocracy"), "不會憑空跳政體");
  assert.equal((await db.select().from(focusCompletedTable).where(eq(focusCompletedTable.nationId, nationId))).length, 0, "沒有記為完成");
  assert.ok((await fstate()).points >= afterStart + 20, "預扣點數全額退還(reform 成本 20)");
});

test("轉型完成後,同時進行中的其他轉型國策作廢並退點", async () => {
  setCatalogForTest(FOCUS_CATALOG);
  // 兩條轉型都從君主專制出發,但只有 main 槽,所以把第二條手動塞進 side 槽模擬
  await give(100);
  await db.update(playerNationsTable).set({ politicalSupport: 70 }).where(eq(playerNationsTable.id, nationId));
  const a = edgeFocus("absolute_monarchy", "constitutional_monarchy");
  const b = edgeFocus("absolute_monarchy", "dual_monarchy");
  assert.equal((await startFocus(await load(), a)).ok, true);
  await db.insert(focusActiveTable).values({ nationId, focusId: b, slot: "side", totalTurns: 50, spentPoints: 14 });
  const before = (await fstate()).points;
  await setSat(65);
  for (let i = 0; i < 9; i++) await settleNationFocus(await load(), ERA);
  assert.equal((await load()).government, governmentLabel("constitutional_monarchy"));
  const actives = await db.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, nationId));
  assert.equal(actives.length, 0, "第二條轉型作廢");
  assert.ok((await fstate()).points >= before + 14, "作廢的那條退回預扣點數");
});

test("共產革命國策:條件全滿足可以推行(預扣點數,啟動當下不換政體)", async () => {
  setCatalogForTest(FOCUS_CATALOG);
  await give(100);
  await db.update(focusStatesTable).set({ redLean: 90 }).where(eq(focusStatesTable.nationId, nationId));
  await db.update(playerNationsTable).set({ stability: 20 }).where(eq(playerNationsTable.id, nationId));
  const r = await startFocus(await load(), "regime.communist_revolution");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await fstate()).points, 100 - COMMUNIST_REVOLUTION_COST, "預扣 45 點");
  assert.equal((await load()).government, governmentLabel("absolute_monarchy"), "啟動時政體不變");
});

test("共產革命國策:紅線傾向不足或穩定度太高仍被擋,不扣點", async () => {
  setCatalogForTest(FOCUS_CATALOG);
  await give(100);
  await db.update(focusStatesTable).set({ redLean: 10 }).where(eq(focusStatesTable.nationId, nationId));
  await db.update(playerNationsTable).set({ stability: 20 }).where(eq(playerNationsTable.id, nationId));
  const low = await startFocus(await load(), "regime.communist_revolution");
  assert.equal(low.ok, false);
  assert.ok(!low.ok && low.reason === "condition_failed");
  await db.update(focusStatesTable).set({ redLean: 90 }).where(eq(focusStatesTable.nationId, nationId));
  await db.update(playerNationsTable).set({ stability: 80 }).where(eq(playerNationsTable.id, nationId));
  const calm = await startFocus(await load(), "regime.communist_revolution");
  assert.equal(calm.ok, false);
  assert.ok(!calm.ok && calm.reason === "condition_failed");
  assert.equal((await fstate()).points, 100, "都沒扣點");
});

// ── 黑紅線傾向值被動增長 ──────────────────────────────────
const setNation = (p: Record<string, unknown>) => db.update(playerNationsTable).set(p as never).where(eq(playerNationsTable.id, nationId));

test("傾向值:民怨沸騰的國家每回合累積紅線,寫進資料庫", async () => {
  await setNation({ stability: 20, politicalSupport: 15 });
  await setSat(20);
  await give(0);
  for (let i = 0; i < 5; i++) await settleNationFocus(await load(), ERA, { rand: () => 0 });
  const s = await fstate();
  assert.equal(s.redLean, 10, "5 回合 × +2");
  assert.equal(s.blackLean, 0);
});

test("傾向值:軍國擴張累積黑線(用批次事實:戰爭中、軍隊占比高)", async () => {
  await setNation({ satisfactionMilitary: 85 });
  await give(0);
  const n = await load();
  await settleNationFocus(n, ERA, { atWarNationIds: new Set([nationId]), armyPopulationByNation: new Map([[nationId, 1e12]]), rand: () => 0 });
  assert.equal((await fstate()).blackLean, 2);
});

test("傾向值:政變鎖定期間照樣累積(不像國策推進那樣被凍結)", async () => {
  await setNation({ stability: 20, politicalSupport: 15, coupPolicyLockTurns: 3 });
  await setSat(20);
  await give(0);
  await settleNationFocus(await load(), ERA, { rand: () => 0 });
  assert.equal((await fstate()).redLean, 2);
});

test("傾向值:穩定的國家會讓既有紅線衰減,且不低於 0", async () => {
  await setNation({ stability: 80 });
  await give(0);
  await db.update(focusStatesTable).set({ redLean: 1 }).where(eq(focusStatesTable.nationId, nationId));
  for (let i = 0; i < 4; i++) await settleNationFocus(await load(), ERA, { rand: () => 0 });
  assert.equal((await fstate()).redLean, 0);
});

test("傾向值:被動增長與國策完成的一次性 lean 效果同回合並存,互不覆蓋", async () => {
  const def: FocusDef = {
    id: "test.lean_both", title: "測試", description: "d", domain: "military", track: "black", slot: "main", requires: [], cost: 1, turns: 1,
    effects: [{ kind: "lean", side: "black", value: 10 }],
  } as unknown as FocusDef;
  setCatalogForTest([def]);
  await setNation({ satisfactionMilitary: 85 });
  await give(20);
  const r = await startFocus(await load(), "test.lean_both");
  assert.equal(r.ok, true, JSON.stringify(r));
  await settleNationFocus(await load(), ERA, { atWarNationIds: new Set([nationId]), rand: () => 0 });
  // 被動:(85-60)*0.04 + 0.5 = 1.5 → rand=0 進位為 2;一次性 +10 → 共 12
  assert.equal((await fstate()).blackLean, 12);
});

test("傾向值:runFocusSettlement 批次版可正常跑完(含批次查戰爭/軍隊),不報錯", async () => {
  await give(0);
  const r = await runFocusSettlement();
  assert.equal(r.failed, 0);
});

test("縮放:國策完成時的金錢效果(代價)依倍率放大,穩定度等百分點不變;國策頁顯示的金額 = 實扣", async () => {
  setCatalogForTest(FOCUS_CATALOG);
  setPenaltyScaleForTest(148);
  try {
    await give(100);
    await db.update(focusStatesTable).set({ blackLean: 60 }).where(eq(focusStatesTable.nationId, nationId));
    await db.update(playerNationsTable).set({ satisfactionMilitary: 70, stability: 60, money: 1_000_000 }).where(eq(playerNationsTable.id, nationId));
    const id = edgeFocus("absolute_monarchy", "military_dictatorship");
    // 啟動前,國策頁上的代價文字要是縮放後的金額
    const view = await getFocusView(await load());
    const card = view.focuses.find((f) => f.id === id);
    assert.ok(card, "國策頁看得到這個國策");
    assert.ok(card!.costs.some((c) => c.includes("177,600")), `代價應顯示 -177,600(1200×148),實際:${JSON.stringify(card!.costs)}`);

    assert.equal((await startFocus(await load(), id)).ok, true);
    await setSat(65);
    for (let i = 0; i < 12; i++) await settleNationFocus(await load(), ERA);
    const n = await load();
    assert.equal(n.government, governmentLabel("military_dictatorship"));
    assert.equal(n.stability, 48, "穩定度 -12 不隨倍率變");
    assert.equal(n.money, 1_000_000 - 1200 * 148, "金錢 -1200 × 148");
  } finally { setPenaltyScaleForTest(1); }
});
