import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  parliamentStateTable,
  focusStatesTable,
  focusActiveTable,
  focusCompletedTable,
} from "@workspace/db";
import { runGameMigrations } from "../gameMigrations";
import { runFocusMigrations } from "../focusMigrations";
import { runParliamentMigrations } from "../parliamentMigrations";
import { settleNationFocus, startFocus } from "./service";
import { getFocusView } from "./view";
import { setCatalogForTest } from "./catalog";
import { governmentLabel } from "../governments";
import { setStoryQueuerForTest } from "./focusStory";
import { COMMUNIST_REVOLUTION_ID } from "./regimeFocuses";
import { politicalPointsPerTurn } from "./core";
import {
  COMMUNIST_PATH_ROOT_IDS,
  PATH_MARXIST_LENINIST_ID,
  PATH_MAOIST_ID,
  PATH_TITOIST_ID,
} from "./communistPaths";

const TAG = "cpath-test";
const ERA = "classical";
let nationId = "";

const load = async () => (await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId)))[0]!;
const fstate = async () => (await db.select().from(focusStatesTable).where(eq(focusStatesTable.nationId, nationId)))[0]!;
const give = (points: number) =>
  db.insert(focusStatesTable).values({ nationId, points }).onConflictDoUpdate({ target: focusStatesTable.nationId, set: { points } });
const markDone = (...ids: string[]) =>
  db.insert(focusCompletedTable).values(ids.map((focusId) => ({ nationId, focusId, eraSlug: ERA }))).onConflictDoNothing();
const setGov = (slug: string) =>
  db.update(playerNationsTable).set({ government: governmentLabel(slug)! }).where(eq(playerNationsTable.id, nationId));
const setSat = (s: number) =>
  db.insert(parliamentStateTable).values({ nationId, satisfaction: s })
    .onConflictDoUpdate({ target: parliamentStateTable.nationId, set: { satisfaction: s } });

before(async () => {
  setStoryQueuerForTest(() => {});
  await runGameMigrations();
  await runParliamentMigrations();
  await runFocusMigrations();
  await db.delete(playerNationsTable).where(eq(playerNationsTable.leaderName, TAG));
  const [n] = await db
    .insert(playerNationsTable)
    .values({ name: `${TAG}-nation`, leaderName: TAG, discordUserId: `${TAG}-u`, government: governmentLabel("council_system")! })
    .returning({ id: playerNationsTable.id });
  nationId = n!.id;
});

after(async () => {
  setStoryQueuerForTest(null);
  setCatalogForTest(null);
  await db.delete(playerNationsTable).where(eq(playerNationsTable.leaderName, TAG));
  await pool.end();
});

beforeEach(async () => {
  setCatalogForTest(null); // 用真實目錄
  await db.delete(focusActiveTable).where(eq(focusActiveTable.nationId, nationId));
  await db.delete(focusCompletedTable).where(eq(focusCompletedTable.nationId, nationId));
  await db.delete(focusStatesTable).where(eq(focusStatesTable.nationId, nationId));
  await db
    .update(playerNationsTable)
    .set({ coupPolicyLockTurns: 0, stability: 50, satisfactionMilitary: 60, politicalSupport: 50, money: 10_000, government: governmentLabel("council_system")! })
    .where(eq(playerNationsTable.id, nationId));
  await setSat(65);
});

const cardIds = async () => (await getFocusView(await load())).focuses.map((f) => f.id);

test("革命還沒完成:看得到路線但是鎖著(需先完成共產革命),點不下去", async () => {
  await give(100);
  const view = await getFocusView(await load());
  for (const id of COMMUNIST_PATH_ROOT_IDS) {
    const c = view.focuses.find((f) => f.id === id);
    assert.ok(c, `${id} 應出現在委員會制的列表`);
    assert.equal(c!.status, "locked", `${id} 應鎖著`);
  }
  const r = await startFocus(await load(), PATH_MAOIST_ID);
  assert.equal(r.ok, false);
  assert.equal((await fstate()).points, 100, "被擋下時不扣點");
});

test("不是委員會制(革命沒打贏/政體不符):路線完全不出現,也不能強行開始", async () => {
  await setGov("absolute_monarchy");
  await markDone(COMMUNIST_REVOLUTION_ID);
  await give(100);
  const ids = await cardIds();
  for (const id of COMMUNIST_PATH_ROOT_IDS) assert.ok(!ids.includes(id), `${id} 不該出現`);
  const r = await startFocus(await load(), PATH_MARXIST_LENINIST_ID);
  assert.equal(r.ok, false);
  assert.equal((await fstate()).points, 100);
});

test("革命完成 + 委員會制:三條路線都可選,後續國策要等起點完成才解鎖", async () => {
  await markDone(COMMUNIST_REVOLUTION_ID);
  await give(100); // 點數不足也會顯示為鎖著,所以要給足點數才能驗「可選」
  const view = await getFocusView(await load());
  for (const id of COMMUNIST_PATH_ROOT_IDS) assert.equal(view.focuses.find((f) => f.id === id)!.status, "available", id);
  assert.equal(view.focuses.find((f) => f.id === "path.ml.five_year_plan")!.status, "locked");
  assert.equal(view.focuses.find((f) => f.id === "path.mao.mass_line")!.status, "locked");
});

test("選定一條路線:花點數、實際完成後,另外兩條永久鎖死,只有自己的後續解鎖", async () => {
  await markDone(COMMUNIST_REVOLUTION_ID);
  await give(100);
  const r = await startFocus(await load(), PATH_MAOIST_ID);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await fstate()).points, 100 - 20);
  // 推進到完成(議會 65:速度 < 1,多跑幾回合;毛澤東思想自己沒加成,因為還沒完成)
  for (let i = 0; i < 20; i++) await settleNationFocus(await load(), ERA, { rand: () => 0.99 });
  const done = (await db.select().from(focusCompletedTable).where(eq(focusCompletedTable.nationId, nationId))).map((d) => d.focusId);
  assert.ok(done.includes(PATH_MAOIST_ID), "毛澤東思想應已完成");

  const view = await getFocusView(await load());
  const st = (id: string) => view.focuses.find((f) => f.id === id);
  assert.equal(st(PATH_MAOIST_ID)!.status, "completed");
  assert.equal(st(PATH_MARXIST_LENINIST_ID)!.permanentlyLocked, true, "馬列主義應永久鎖死");
  assert.equal(st(PATH_TITOIST_ID)!.permanentlyLocked, true, "鐵托主義應永久鎖死");
  assert.equal(st("path.mao.peoples_war")!.status, "available", "毛的後續解鎖");
  assert.equal(st("path.mao.mass_line")!.status, "available");
  assert.notEqual(st("path.ml.five_year_plan")!.status, "available", "馬列的後續仍鎖著");
  assert.notEqual(st("path.tito.self_management")!.status, "available", "鐵托的後續仍鎖著");

  // 嘗試走另一條會被擋,且不扣點
  const before = (await fstate()).points;
  const r2 = await startFocus(await load(), PATH_TITOIST_ID);
  assert.equal(r2.ok, false);
  assert.equal((await fstate()).points, before);
});

test("馬列主義:完成後政治點數收入永久 +1,畫面顯示的收入和實際入帳一致", async () => {
  await markDone(COMMUNIST_REVOLUTION_ID);
  const baseView = await getFocusView(await load());
  const basePerTurn = baseView.pointsPerTurn;

  await markDone(PATH_MARXIST_LENINIST_ID);
  const view = await getFocusView(await load());
  assert.equal(view.pointsPerTurn, basePerTurn + 1, "顯示的收入 +1");

  await give(0);
  const r = await settleNationFocus(await load(), ERA, { rand: () => 0.99 });
  assert.equal(r.pointsGained, view.pointsPerTurn, "實際入帳 = 畫面顯示");
  assert.equal((await fstate()).points, view.pointsPerTurn);
});

test("鐵托主義同樣 +1 政治點數;毛澤東思想不加點數(它加國策速度)", async () => {
  await markDone(COMMUNIST_REVOLUTION_ID);
  const base = (await getFocusView(await load())).pointsPerTurn;
  await markDone(PATH_TITOIST_ID);
  assert.equal((await getFocusView(await load())).pointsPerTurn, base + 1);
  await db.delete(focusCompletedTable).where(eq(focusCompletedTable.focusId, PATH_TITOIST_ID));
  await markDone(PATH_MAOIST_ID);
  assert.equal((await getFocusView(await load())).pointsPerTurn, base, "毛不加點數");
});

test("毛澤東思想:完成後國策完成得更快(同樣的國策少花回合)", async () => {
  await markDone(COMMUNIST_REVOLUTION_ID, PATH_MAOIST_ID);
  // 不受路線影響的對照:同一份進度,有加成應該比沒加成前進更多
  await give(100);
  const r = await startFocus(await load(), "path.mao.peoples_war");
  assert.equal(r.ok, true, JSON.stringify(r));
  await settleNationFocus(await load(), ERA, { rand: () => 0.99 });
  const [a] = await db.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, nationId));
  assert.ok(a, "仍在進行");
  // 議會 65 的基礎倍率 <1;有 +15% 時進度必須大於基礎倍率
  const { focusSpeedMultiplier } = await import("./core");
  const base = focusSpeedMultiplier(65);
  assert.ok(a!.progress > base + 1e-9, `有加速的進度 ${a!.progress} 應大於基礎 ${base}`);
  assert.ok(Math.abs(a!.progress - base * 1.15) < 1e-3);
});

test("收入計算沒有改到既有行為:沒完成任何路線時,收入 = 公式值(不含任何常駐加成)", async () => {
  const view = await getFocusView(await load());
  const { parliamentTier } = await import("../parliament/core");
  const { governmentSlugByLabel } = await import("../governments");
  const { computeNationStats } = await import("../nationStats");
  const n = await load();
  const tier = parliamentTier(governmentSlugByLabel(n.government));
  const stats = await computeNationStats(n.id, ERA).catch(() => ({ population: 0 }));
  assert.equal(view.pointsPerTurn, politicalPointsPerTurn({ tier, population: stats.population, satisfaction: 65 }));
});
