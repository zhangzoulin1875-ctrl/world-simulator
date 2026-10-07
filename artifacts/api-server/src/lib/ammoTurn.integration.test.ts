import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, sql, like } from "drizzle-orm";
import {
  db, pool, playerNationsTable, playerNotificationsTable, regionControlsTable,
  regionBuildingsTable, mapRegionEraStatsTable, worldGameStateTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runGameMigrations } from "./gameMigrations";
import { runPoliticsMigrations } from "./politicsMigrations";
import { runEconomyMigrations } from "./economyMigrations";
import { runWorldSimMigrations } from "./worldSimMigrations";
import { runMapRegionSync } from "./mapRegions";
import { runMapRegionEraStatsSync } from "./mapRegionEraStats";
import { runTurnUpdate } from "./turnEngine";
import { buildingOutput } from "./regionBuildings";
import { ammoEraFactor, npcAmmoStipend, ammoStockCap, npcAmmoStockCap } from "./supply";

/**
 * 補給系統 — 回合結算的彈藥入庫整合測試（真 DB、強制回合）。
 *  - 玩家：軍工廠 Lv2 → 每回合入庫 buildingOutput(2)=100（產出不隨時代變；時代係數只放大軍隊「需求」），不超過倉容（Lv2×5,000）。
 *  - 玩家：庫存已接近倉容 → 封頂在倉容，不溢出。
 *  - NPC：沒工廠，領「地區數×配額」，倉容依地區數。
 *  - 冷兵器時代：彈藥係數 0 → NPC 不領配額（玩家端由建造路由擋下軍工廠）。
 * 強制回合共用 famineTurn/regionBuildingsTurn 的 advisory lock key，避免並發污染世界時鐘。
 */
const TAG = "__ammo_turn_test__";
const runId = randomBytes(4).toString("hex");
const LOCK_KEY = 9_999_999_901;
const WW1 = "ww1";
const PLANT_LEVEL = 2;

type MessagesCreate = typeof anthropic.messages.create;
const realCreate: MessagesCreate = anthropic.messages.create.bind(anthropic.messages);

let playerId = "", fullId = "", npcId = "";
const playerUser = `${TAG}p_${runId}`;
const fullUser = `${TAG}f_${runId}`;
let npcRegions = 0;

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    try { return await fn(); } finally { await c.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]); }
  } finally { c.release(); }
}
async function cleanup() {
  await db.delete(playerNotificationsTable).where(like(playerNotificationsTable.discordUserId, `${TAG}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}%`));
}
async function ammoOf(id: string): Promise<number> {
  const [r] = await db.select({ a: playerNationsTable.ammo }).from(playerNationsTable).where(eq(playerNationsTable.id, id));
  return Number(r!.a);
}
async function forcedTurn(era: string, gameDate: string) {
  await withLock(async () => {
    const [w] = await db.select({
      currentEra: worldGameStateTable.currentEra, statsEra: worldGameStateTable.statsEra,
      gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
      lastTurnDate: worldGameStateTable.lastTurnDate, lastTurnAt: worldGameStateTable.lastTurnAt,
      yearsPerTurn: worldGameStateTable.yearsPerTurn,
      pm: worldGameStateTable.populationGrowthMultiplierPct,
    }).from(worldGameStateTable).where(eq(worldGameStateTable.id, 1)).limit(1);
    assert.ok(w, "world_game_state 應存在");
    await db.update(worldGameStateTable).set({
      currentEra: era, statsEra: era, gameDate, yearsPerTurn: 1, populationGrowthMultiplierPct: 0,
    }).where(eq(worldGameStateTable.id, 1));
    anthropic.messages.create = (async () => { throw new Error("模擬 AI 失敗"); }) as unknown as MessagesCreate;
    try {
      const s = await runTurnUpdate(new Date(), { force: true });
      assert.equal(s.ran, true, "強制回合應完成");
    } finally {
      anthropic.messages.create = realCreate;
      await db.update(worldGameStateTable).set({
        currentEra: w.currentEra, statsEra: w.statsEra, gameDate: w.gameDate, lastTurnDate: w.lastTurnDate,
        lastTurnAt: w.lastTurnAt, yearsPerTurn: w.yearsPerTurn, populationGrowthMultiplierPct: w.pm,
      }).where(eq(worldGameStateTable.id, 1));
    }
  });
}

before(async () => {
  await runGameMigrations(); await runPoliticsMigrations(); await runEconomyMigrations();
  await runWorldSimMigrations(); await runMapRegionSync(); await runMapRegionEraStatsSync();
  await cleanup();
  const mk = async (name: string, o: { user?: string; npc?: boolean; ammo: number }) => {
    const [n] = await db.insert(playerNationsTable).values({
      name, leaderName: TAG, government: "君主制", discordUserId: o.user ?? null, isNpc: o.npc ?? false,
      money: 1_000_000, taxRatePct: 0, ammo: o.ammo,
    }).returning({ id: playerNationsTable.id });
    return n!.id;
  };
  playerId = await mk(`${TAG}player_${runId}`, { user: playerUser, ammo: 0 });
  fullId = await mk(`${TAG}full_${runId}`, { user: fullUser, ammo: 9_990 }); // 倉容 10,000，差 10
  npcId = await mk(`${TAG}npc_${runId}`, { npc: true, ammo: 0 });

  const controlled = new Set((await db.select({ r: regionControlsTable.regionId }).from(regionControlsTable)).map((x) => x.r));
  const built = new Set((await db.select({ r: regionBuildingsTable.regionId }).from(regionBuildingsTable)).map((x) => x.r));
  const free = (await db.select({ r: mapRegionEraStatsTable.regionId, p: mapRegionEraStatsTable.population })
    .from(mapRegionEraStatsTable).where(eq(mapRegionEraStatsTable.era, WW1)).orderBy(sql`${mapRegionEraStatsTable.population} DESC`))
    .filter((x) => !controlled.has(x.r) && !built.has(x.r) && Number(x.p) > 0).slice(0, 5);
  assert.equal(free.length, 5, "需要五個無人掌控、無建築、有人口的地區");
  const [a, b, c, d, e] = free.map((x) => x.r) as [number, number, number, number, number];
  await db.insert(regionControlsTable).values([
    { regionId: a, nationId: playerId, percent: 100 },
    { regionId: b, nationId: fullId, percent: 100 },
    { regionId: c, nationId: npcId, percent: 100 },
    { regionId: d, nationId: npcId, percent: 100 },
    { regionId: e, nationId: npcId, percent: 100 },
  ]);
  npcRegions = 3;
  await db.insert(regionBuildingsTable).values([
    { nationId: playerId, regionId: a, buildingType: "munitions_plant", level: PLANT_LEVEL },
    { nationId: fullId, regionId: b, buildingType: "munitions_plant", level: PLANT_LEVEL },
  ]);
});
after(async () => { anthropic.messages.create = realCreate; await cleanup(); await pool.end(); });

test("字面值自檢：Lv2 軍工廠基礎產出 100、倉容 10,000；ww1 係數 > 0", () => {
  assert.equal(buildingOutput(PLANT_LEVEL), 100);
  assert.equal(ammoStockCap(PLANT_LEVEL), 10_000);
  assert.ok(ammoEraFactor(WW1) > 0);
  assert.equal(ammoEraFactor("roman"), 0);
});

test("火藥時代回合：玩家軍工廠入庫、倉容封頂、NPC 領配額", async () => {
  await forcedTurn(WW1, "1914-01-01");
  const expectedPlayer = Math.min(ammoStockCap(PLANT_LEVEL), buildingOutput(PLANT_LEVEL));
  const player = await ammoOf(playerId);
  assert.ok(player > 0, "有軍工廠的玩家應入庫彈藥");
  assert.equal(player, 100, "玩家入庫量 = 軍工廠基礎產出（Lv2 = 100），不乘時代係數");
  assert.equal(player, expectedPlayer);

  assert.equal(await ammoOf(fullId), ammoStockCap(PLANT_LEVEL), "庫存接近倉容時封頂，不溢出");

  const expectedNpc = Math.min(npcAmmoStockCap(npcRegions), Math.floor(npcAmmoStipend(npcRegions, WW1)));
  const npc = await ammoOf(npcId);
  assert.ok(npc > 0, "NPC 應領到配額");
  assert.equal(npc, expectedNpc, "NPC 入庫量 = 地區數 × 配額 × 時代係數");
});

test("冷兵器時代回合：NPC 不領配額（彈藥係數 0）；建造路由另擋下軍工廠", async () => {
  await db.update(playerNationsTable).set({ ammo: 0 }).where(eq(playerNationsTable.id, npcId));
  assert.equal(await ammoOf(npcId), 0, "前置：清零已生效");
  await forcedTurn("roman", "0400-01-01"); // 與既有回合測試同口徑：roman、year 400（彈藥係數 0）
  assert.equal(await ammoOf(npcId), 0, "冷兵器時代 NPC 沒有彈藥配額");
});
