import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import {
  db, pool, playerNationsTable, parliamentStateTable, focusStatesTable, focusActiveTable, focusCompletedTable,
  regionControlsTable, mapRegionsTable, diplomacyWarsTable,
} from "@workspace/db";
import { runGameMigrations, runRegionControlMigrations } from "../gameMigrations";
import { runDiplomacyMigrations } from "../diplomacyMigrations";
import { runWarMigrations } from "../warMigrations";
import { runParliamentMigrations } from "../parliamentMigrations";
import { runFocusMigrations } from "../focusMigrations";
import { settleNationFocus, startFocus } from "./service";
import { setCatalogForTest, FOCUS_CATALOG, getFocusDef } from "./catalog";
import { governmentLabel } from "../governments";

const TAG = "revfocus-test";
const ERA = "classical";
let nationId = "";
let regionIds: number[] = [];

const load = async () => (await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId)))[0]!;
const land = async (id: string) =>
  (await db.select({ s: sql<number>`COALESCE(SUM(percent),0)::int` }).from(regionControlsTable).where(eq(regionControlsTable.nationId, id)))[0]!.s;

before(async () => {
  await runGameMigrations(); await runRegionControlMigrations(); await runDiplomacyMigrations();
  await runWarMigrations(); await runParliamentMigrations(); await runFocusMigrations();
  await db.delete(playerNationsTable).where(eq(playerNationsTable.leaderName, TAG));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  const rows = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable)
    .leftJoin(regionControlsTable, eq(regionControlsTable.regionId, mapRegionsTable.id))
    .where(isNull(regionControlsTable.id)).orderBy(mapRegionsTable.id).offset(300).limit(4);
  regionIds = rows.map((r) => r.id);
  assert.ok(regionIds.length >= 3);
});
after(async () => {
  setCatalogForTest(null);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  await pool.end();
});
beforeEach(async () => {
  setCatalogForTest(FOCUS_CATALOG);
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
  const [n] = await db.insert(playerNationsTable).values({
    name: `${TAG}-國`, leaderName: TAG, discordUserId: `${TAG}-u`, government: governmentLabel("absolute_monarchy")!,
    stability: 30, politicalSupport: 50, satisfactionMilitary: 60, money: 50000,
  } as never).returning({ id: playerNationsTable.id });
  nationId = n!.id;
  await db.insert(parliamentStateTable).values({ nationId, satisfaction: 65 }).onConflictDoNothing();
  for (const r of regionIds.slice(0, 2)) await db.insert(regionControlsTable).values({ regionId: r, nationId, percent: 100 });
  // 紅線傾向夠高 + 政治點數充足
  await db.insert(focusStatesTable).values({ nationId, points: 200, redLean: 80, blackLean: 0 })
    .onConflictDoUpdate({ target: focusStatesTable.nationId, set: { points: 200, redLean: 80, blackLean: 0 } });
});

test("共產革命是單一通用入口:未鎖定,且任何非紅線終點政體都可見", () => {
  const def = getFocusDef("regime.communist_revolution")!;
  assert.ok(def);
  assert.equal(def.unavailableReason, undefined);
  assert.equal(def.governments, undefined, "不限政體");
  for (const old of ["regime.absolute_monarchy_red_revolution", "regime.military_dictatorship_red_revolution", "regime.theocracy_red_revolution"]) {
    assert.equal(getFocusDef(old), undefined, `${old} 已被通用入口取代`);
  }
});

test("可以啟動革命國策(傾向與穩定度達標)", async () => {
  const r = await startFocus(await load(), "regime.communist_revolution");
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("革命國策完成:開內戰、玩家是革命方只留 35% 土地、政體不變、代價生效", async () => {
  const start = await startFocus(await load(), "regime.communist_revolution");
  assert.equal(start.ok, true, JSON.stringify(start));
  const beforeN = await load();
  const total = (start as { totalTurns: number }).totalTurns;
  for (let i = 0; i < total + 3; i++) await settleNationFocus(await load(), ERA, { rand: () => 0.99 });
  const after = await load();
  assert.equal(after.government, governmentLabel("absolute_monarchy"), "打贏之前政體不變");
  assert.equal(await land(nationId), 70, "200 × 35%");
  const w = (await db.select().from(diplomacyWarsTable).where(and(eq(diplomacyWarsTable.isCivilWar, true), eq(diplomacyWarsTable.rebelNationId, nationId))))[0]!;
  assert.ok(w, "寫下了以玩家為革命方的內戰");
  assert.equal(w.rebelIdeology, "red");
  assert.equal(w.endedAt, null);
  assert.ok(after.stability <= beforeN.stability - 20 + 5, `穩定度被扣(含期間被動變動): ${beforeN.stability} -> ${after.stability}`);
  assert.ok(after.money <= beforeN.money - 2000 + 1, "金錢 -2000");
  const done = await db.select().from(focusCompletedTable).where(eq(focusCompletedTable.nationId, nationId));
  assert.ok(done.some((d) => d.focusId === "regime.communist_revolution"));
});

test("革命爆發後,該國進行中的戰役被終止(國土被切走)", async () => {
  const { warCampaignsTable } = await import("@workspace/db");
  const { canonicalPair } = await import("../diplomacy");
  const [other] = await db.insert(playerNationsTable).values({
    name: `${TAG}-敵`, leaderName: "x", government: governmentLabel("absolute_monarchy")!, isNpc: true,
  } as never).returning({ id: playerNationsTable.id });
  await db.insert(regionControlsTable).values({ regionId: regionIds[2]!, nationId: other!.id, percent: 100 });
  const { low, high } = canonicalPair(other!.id, nationId);
  const [war] = await db.insert(diplomacyWarsTable).values({ nationAId: low, nationBId: high, declaredByNationId: other!.id })
    .returning({ id: diplomacyWarsTable.id });
  const [camp] = await db.insert(warCampaignsTable).values({
    warId: war!.id, attackerNationId: other!.id, defenderNationId: nationId,
    attackerRegionId: regionIds[2]!, defenderRegionId: regionIds[0]!, status: "active", nextResolveAt: new Date(Date.now() + 3600_000),
  } as never).returning({ id: warCampaignsTable.id });
  assert.ok(camp, "戰役建立成功");

  const start = await startFocus(await load(), "regime.communist_revolution");
  assert.equal(start.ok, true, JSON.stringify(start));
  const total = (start as { totalTurns: number }).totalTurns;
  for (let i = 0; i < total + 3; i++) await settleNationFocus(await load(), ERA, { rand: () => 0.99 });
  const [c] = await db.select().from(warCampaignsTable).where(eq(warCampaignsTable.id, camp!.id));
  assert.notEqual(c!.status, "active", "戰役已被終止");
});

test("沒有土地時革命國策完成:不爆發、退還點數、不扣代價", async () => {
  await db.delete(regionControlsTable).where(eq(regionControlsTable.nationId, nationId));
  const start = await startFocus(await load(), "regime.communist_revolution");
  assert.equal(start.ok, true, JSON.stringify(start));
  const beforeN = await load();
  const total = (start as { totalTurns: number }).totalTurns;
  for (let i = 0; i < total + 3; i++) await settleNationFocus(await load(), ERA, { rand: () => 0.99 });
  const wars = await db.select().from(diplomacyWarsTable).where(and(eq(diplomacyWarsTable.isCivilWar, true), eq(diplomacyWarsTable.rebelNationId, nationId)));
  assert.equal(wars.length, 0);
  assert.equal((await load()).money, beforeN.money, "沒扣錢");
  const done = await db.select().from(focusCompletedTable).where(eq(focusCompletedTable.nationId, nationId));
  assert.ok(!done.some((d) => d.focusId === "regime.communist_revolution"), "不記為完成,可重選");
});

test("一般(非革命)轉型國策完成仍是直接換政體,不切地、不開內戰", async () => {
  await db.update(playerNationsTable).set({ politicalSupport: 80, stability: 70 }).where(eq(playerNationsTable.id, nationId));
  const start = await startFocus(await load(), "regime.absolute_monarchy_to_constitutional_monarchy");
  assert.equal(start.ok, true, JSON.stringify(start));
  const total = (start as { totalTurns: number }).totalTurns;
  for (let i = 0; i < total + 3; i++) await settleNationFocus(await load(), ERA, { rand: () => 0.99 });
  const after = await load();
  assert.equal(after.government, governmentLabel("constitutional_monarchy"), "直接換成君主立憲");
  assert.equal(await land(nationId), 200, "一般轉型不切地");
  const wars = await db.select().from(diplomacyWarsTable).where(and(eq(diplomacyWarsTable.isCivilWar, true), eq(diplomacyWarsTable.rebelNationId, nationId)));
  assert.equal(wars.length, 0, "沒有開內戰");
});
