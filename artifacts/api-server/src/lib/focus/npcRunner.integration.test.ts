import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { and, eq, like, inArray } from "drizzle-orm";
import {
  db, pool, playerNationsTable, parliamentStateTable, focusStatesTable, focusActiveTable,
  regionControlsTable, mapRegionsTable, diplomacyWarsTable,
} from "@workspace/db";
import { isNull } from "drizzle-orm";
import { runGameMigrations, runRegionControlMigrations } from "../gameMigrations";
import { runDiplomacyMigrations } from "../diplomacyMigrations";
import { runWarMigrations } from "../warMigrations";
import { runParliamentMigrations } from "../parliamentMigrations";
import { runFocusMigrations } from "../focusMigrations";
import { setCatalogForTest, FOCUS_CATALOG } from "./catalog";
import { runNpcFocusDecisions } from "./npcRunner";
import { settleNationFocus } from "./service";
import { settleCivilWars } from "../civilWarEngine";
import { governmentLabel } from "../governments";

const TAG = "npcfocus-test";
let regionIds: number[] = [];
const ALWAYS = () => 0; // 永遠通過「要不要考慮」,並抽到第一個候選

async function mkNpc(gov: string, over: Record<string, unknown> = {}, focus: Record<string, unknown> = {}) {
  const [n] = await db.insert(playerNationsTable).values({
    name: `${TAG}-${Math.random().toString(36).slice(2, 8)}`, leaderName: TAG, government: governmentLabel(gov)!,
    isNpc: true, stability: 60, politicalSupport: 70, satisfactionMilitary: 60, money: 50000, ...over,
  } as never).returning();
  await db.insert(parliamentStateTable).values({ nationId: n!.id, satisfaction: 65 }).onConflictDoNothing();
  await db.insert(focusStatesTable).values({ nationId: n!.id, points: 200, redLean: 0, blackLean: 0, ...focus });
  return n!;
}
const actives = async (id: string) => db.select().from(focusActiveTable).where(eq(focusActiveTable.nationId, id));
const cleanup = async () => { await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`)); };

before(async () => {
  await runGameMigrations(); await runRegionControlMigrations(); await runDiplomacyMigrations();
  await runWarMigrations(); await runParliamentMigrations(); await runFocusMigrations();
  await cleanup();
  const rows = await db.select({ id: mapRegionsTable.id }).from(mapRegionsTable)
    .leftJoin(regionControlsTable, eq(regionControlsTable.regionId, mapRegionsTable.id))
    .where(isNull(regionControlsTable.id)).orderBy(mapRegionsTable.id).offset(320).limit(6);
  regionIds = rows.map((r) => r.id);
});
after(async () => { setCatalogForTest(null); await cleanup(); await pool.end(); });
beforeEach(async () => { setCatalogForTest(FOCUS_CATALOG); await cleanup(); });

test("NPC 有足夠點數與條件時,會真的啟動一條轉型國策(點數被預扣)", async () => {
  const npc = await mkNpc("absolute_monarchy", { politicalSupport: 80, stability: 70 });
  const r = await runNpcFocusDecisions(ALWAYS);
  assert.ok(r.started >= 1, JSON.stringify(r));
  const a = (await actives(npc.id)).filter((x) => x.focusId.startsWith("regime."));
  assert.equal(a.length, 1);
  const [st] = await db.select().from(focusStatesTable).where(eq(focusStatesTable.nationId, npc.id));
  assert.ok(st!.points < 200, "點數已預扣");
});

test("不會動玩家國家", async () => {
  const [p] = await db.insert(playerNationsTable).values({
    name: `${TAG}-player`, leaderName: TAG, discordUserId: `${TAG}-u`, government: governmentLabel("absolute_monarchy")!,
    stability: 70, politicalSupport: 80, isNpc: false,
  } as never).returning();
  await db.insert(focusStatesTable).values({ nationId: p!.id, points: 500 });
  await runNpcFocusDecisions(ALWAYS);
  assert.equal((await actives(p!.id)).length, 0, "玩家不會被自動選國策");
});

test("擲骰沒過(94% 的回合)什麼都不做", async () => {
  const npc = await mkNpc("absolute_monarchy", { politicalSupport: 80, stability: 70 });
  const r = await runNpcFocusDecisions(() => 0.99);
  assert.equal(r.started, 0);
  assert.equal((await actives(npc.id)).length, 0);
});

test("已有進行中轉型的 NPC 不會再開第二條;點數不足不動", async () => {
  const a = await mkNpc("absolute_monarchy", { politicalSupport: 80, stability: 70 });
  await runNpcFocusDecisions(ALWAYS);
  const before = (await actives(a.id)).length;
  await runNpcFocusDecisions(ALWAYS);
  assert.equal((await actives(a.id)).length, before, "沒有多開");
  const broke = await mkNpc("absolute_monarchy", { politicalSupport: 80, stability: 70 }, { points: 1 });
  await runNpcFocusDecisions(ALWAYS);
  assert.equal((await actives(broke.id)).length, 0);
});

test("全域奪權上限:即使所有 NPC 都符合紅線革命條件,同時進行的不超過上限", async () => {
  // 只保留三條革命國策,逼每個 NPC 的唯一候選就是革命(奪權線)
  setCatalogForTest(FOCUS_CATALOG.filter((f) => f.id === "regime.communist_revolution"));
  const made = [];
  for (let i = 0; i < 12; i++) made.push(await mkNpc("absolute_monarchy", { stability: 20, politicalSupport: 20 }, { points: 200, redLean: 90 }));
  await runNpcFocusDecisions(ALWAYS);
  const ids = made.map((m) => m.id);
  const running = await db.select().from(focusActiveTable).where(inArray(focusActiveTable.nationId, ids));
  // 其他 NPC(資料庫裡可能已有)也會算進總數;上限 = max(1, floor(總NPC×5%)),這裡 12 隻 → 至少 1
  assert.ok(running.length >= 1, "至少啟動一個");
  assert.ok(running.length <= Math.max(1, Math.floor((await db.select().from(playerNationsTable).where(eq(playerNationsTable.isNpc, true))).length * 0.05)), `實際 ${running.length} 個超過上限`);
});

test("端到端:NPC 完成革命國策 → 開內戰(NPC 當革命方留 35%)→ 政體不變", async () => {
  setCatalogForTest(FOCUS_CATALOG.filter((f) => f.id === "regime.communist_revolution"));
  const npc = await mkNpc("absolute_monarchy", { stability: 20, politicalSupport: 20 }, { points: 200, redLean: 90 });
  for (const r of regionIds.slice(0, 2)) await db.insert(regionControlsTable).values({ regionId: r, nationId: npc.id, percent: 100 });
  const run = await runNpcFocusDecisions(ALWAYS);
  assert.ok(run.started >= 1);
  const a = (await actives(npc.id))[0]!;
  for (let i = 0; i < a.totalTurns + 3; i++) {
    const [fresh] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, npc.id));
    await settleNationFocus(fresh!, "classical", { rand: () => 0.99 });
  }
  const [after] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, npc.id));
  assert.equal(after!.government, governmentLabel("absolute_monarchy"), "打贏前政體不變");
  const [w] = await db.select().from(diplomacyWarsTable).where(and(eq(diplomacyWarsTable.isCivilWar, true), eq(diplomacyWarsTable.rebelNationId, npc.id)));
  assert.ok(w, "開了以該 NPC 為革命方的內戰");
  // NPC 在內戰中就不會再被安排新轉型
  const again = await runNpcFocusDecisions(ALWAYS);
  const extra = (await actives(npc.id)).filter((x) => x.focusId !== a.focusId);
  assert.equal(extra.length, 0);
  assert.ok(again.started >= 0);
  await settleCivilWars(); // 不應丟錯
});
