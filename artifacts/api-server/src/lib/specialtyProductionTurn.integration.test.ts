import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, sql, and, like, inArray } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  playerNotificationsTable,
  regionControlsTable,
  mapRegionsTable,
  nationGoodsTable,
  worldGameStateTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runGameMigrations } from "./gameMigrations";
import { runPoliticsMigrations } from "./politicsMigrations";
import { runEconomyMigrations } from "./economyMigrations";
import { runWorldSimMigrations } from "./worldSimMigrations";
import { runTradeMigrationsInner } from "./tradeMigrations";
import { runMapRegionSync } from "./mapRegions";
import { runMapRegionEraStatsSync } from "./mapRegionEraStats";
import { runTurnUpdate } from "./turnEngine";
import { readGoods } from "./trade/goodsLedger";

/**
 * 貿易系統階段 1-D — 地區特產產出端到端整合測試。
 *
 * 純函式(production.test.ts)已證明公式;這裡證明「回合引擎真的把特產入庫」:
 * - 鐵煤/石油/稀有金屬 → nation_goods;礦石/木材 → player_nations 欄位(不雙帳)
 * - 時代解鎖:古典時代石油、稀有金屬為 0,工業時代才有
 * - 連續兩回合累加(原子 stock = stock + n,而非覆蓋)
 * - 控制比例 50% 產量減半
 * 沿用 famineTurn 的鐵則:advisory lock、快照還原世界時鐘、AI 全部拋錯。
 */

const TEST_TAG = "__specialty_turn_test__";
const runId = randomBytes(4).toString("hex");
// 與 famineTurn / regionBuildingsTurn 共用同一把鎖,避免併發污染 world_game_state。
const FORCED_TURN_LOCK_KEY = 9_999_999_901;

// 真實特產地區(名稱鍵見 trade/regionSpecialties.ts):
const TOP = "南非德蘭"; // 礦★ 鐵煤★ 稀★ → 工業時代 30/30/30
const OIL = "利雅德"; // 油★ → 工業時代 30
const SIDE = "蘇格蘭高地"; // 礦(次產) → 10

async function withForcedTurnLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [FORCED_TURN_LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [FORCED_TURN_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(anthropic.messages);

let nationId: string;
const discordUserId = `${TEST_TAG}${runId}`;
const regionIds: Record<string, number> = {};

async function cleanup() {
  await db.delete(playerNotificationsTable).where(like(playerNotificationsTable.discordUserId, `${TEST_TAG}${runId}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TEST_TAG}${runId}%`));
}

async function purgeStaleLeftovers() {
  await db.delete(playerNotificationsTable).where(
    and(like(playerNotificationsTable.discordUserId, `${TEST_TAG}%`), sql`${playerNotificationsTable.createdAt} < NOW() - INTERVAL '30 minutes'`),
  );
  await db.delete(playerNationsTable).where(
    and(like(playerNationsTable.name, `${TEST_TAG}%`), sql`${playerNationsTable.createdAt} < NOW() - INTERVAL '30 minutes'`),
  );
}

async function loadNation() {
  const [row] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId)).limit(1);
  assert.ok(row, "測試國家應存在");
  return row;
}

async function snapshotWorld() {
  const [w] = await db
    .select({
      currentEra: worldGameStateTable.currentEra,
      statsEra: worldGameStateTable.statsEra,
      gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
      lastTurnDate: worldGameStateTable.lastTurnDate,
      lastTurnAt: worldGameStateTable.lastTurnAt,
      yearsPerTurn: worldGameStateTable.yearsPerTurn,
      populationGrowthMultiplierPct: worldGameStateTable.populationGrowthMultiplierPct,
    })
    .from(worldGameStateTable).where(eq(worldGameStateTable.id, 1)).limit(1);
  assert.ok(w);
  return w;
}

async function restoreWorld(w: Awaited<ReturnType<typeof snapshotWorld>>) {
  await db.update(worldGameStateTable).set({
    currentEra: w.currentEra, statsEra: w.statsEra, gameDate: w.gameDate,
    lastTurnDate: w.lastTurnDate, lastTurnAt: w.lastTurnAt, yearsPerTurn: w.yearsPerTurn,
    populationGrowthMultiplierPct: w.populationGrowthMultiplierPct,
  }).where(eq(worldGameStateTable.id, 1));
}

/** 把世界釘在指定時代(year 對應時代中段;yearsPerTurn=1 不跨時代)。 */
async function pinWorld(era: string, gameDate: string) {
  await db.update(worldGameStateTable).set({
    currentEra: era, statsEra: era, gameDate, yearsPerTurn: 1, populationGrowthMultiplierPct: 0,
  }).where(eq(worldGameStateTable.id, 1));
}

async function runOneTurn(era: string, gameDate: string) {
  const snap = await snapshotWorld();
  try {
    await pinWorld(era, gameDate);
    anthropic.messages.create = (async () => { throw new Error("模擬 AI 失敗"); }) as unknown as MessagesCreate;
    const summary = await runTurnUpdate(new Date(), { force: true });
    assert.equal(summary.ran, true, "強制回合應完成");
  } finally {
    anthropic.messages.create = realMessagesCreate;
    await restoreWorld(snap);
  }
}

async function setControl(name: string, percent: number) {
  const regionId = regionIds[name]!;
  await db.delete(regionControlsTable).where(and(eq(regionControlsTable.regionId, regionId), eq(regionControlsTable.nationId, nationId)));
  if (percent > 0) await db.insert(regionControlsTable).values({ regionId, nationId, percent });
}

async function resetGoods(woodOre = { wood: 0, ore: 0 }) {
  await db.delete(nationGoodsTable).where(eq(nationGoodsTable.nationId, nationId));
  await db.update(playerNationsTable).set({ wood: woodOre.wood, ore: woodOre.ore }).where(eq(playerNationsTable.id, nationId));
}

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await runEconomyMigrations();
  await runWorldSimMigrations();
  await runTradeMigrationsInner();
  await runMapRegionSync();
  await runMapRegionEraStatsSync();
  await purgeStaleLeftovers();
  await cleanup();

  const [nation] = await db.insert(playerNationsTable).values({
    name: `${TEST_TAG}${runId}`, leaderName: TEST_TAG, government: "君主制", discordUserId, isNpc: false,
    money: 1_000_000, farmerPopulationPct: 100, stability: 50, unrest: 0,
  }).returning({ id: playerNationsTable.id });
  assert.ok(nation);
  nationId = nation.id;

  const rows = await db.select({ id: mapRegionsTable.id, name: mapRegionsTable.name })
    .from(mapRegionsTable).where(inArray(mapRegionsTable.name, [TOP, OIL, SIDE]));
  for (const r of rows) regionIds[r.name] = r.id;
  for (const n of [TOP, OIL, SIDE]) assert.ok(regionIds[n], `地圖應有地區 ${n}`);

  // 這三區若被別的國家掌控(本機開發庫),本測試的 100% 假設會破功;先讓出來。
  await db.delete(regionControlsTable).where(inArray(regionControlsTable.regionId, Object.values(regionIds)));
});

after(async () => {
  anthropic.messages.create = realMessagesCreate;
  await cleanup();
  await pool.end();
});

test("工業時代:全控頂級區 → 鐵煤/稀有金屬進 nation_goods、礦石進 player_nations(不雙帳)", async () => {
  await withForcedTurnLock(async () => {
    await resetGoods();
    await setControl(TOP, 100);
    await runOneTurn("industrial", "1800-01-01");

    const goods = await readGoods(nationId);
    assert.equal(goods.ironcoal, 30, "鐵煤 3×10");
    assert.equal(goods.rare, 30, "稀有金屬 3×10(工業時代已解鎖)");
    assert.equal(goods.ore, undefined, "礦石不得進 nation_goods(沿用 player_nations 欄位)");

    const n = await loadNation();
    assert.equal(n.ore, 30, "礦石 3×10 併入 player_nations.ore");
    assert.equal(n.wood, 0);
  });
});

test("石油:古典時代 0(整列都不該出現),工業時代才有", async () => {
  await withForcedTurnLock(async () => {
    await resetGoods();
    await setControl(TOP, 0);
    await setControl(OIL, 100);

    await runOneTurn("classical", "0100-01-01");
    assert.equal((await readGoods(nationId)).oil, undefined, "古典時代沒有石油,連 0 的列也不該寫");

    await runOneTurn("industrial", "1800-01-01");
    assert.equal((await readGoods(nationId)).oil, 30, "工業時代解鎖");
  });
});

test("連續兩回合累加(原子 stock = stock + n,不是覆蓋)", async () => {
  await withForcedTurnLock(async () => {
    await resetGoods();
    await setControl(OIL, 0);
    await setControl(TOP, 100);
    await runOneTurn("industrial", "1800-01-01");
    await runOneTurn("industrial", "1800-01-01");
    const goods = await readGoods(nationId);
    assert.equal(goods.ironcoal, 60, "兩回合 30 + 30");
    assert.equal(goods.rare, 60);
    assert.equal((await loadNation()).ore, 60, "礦石也累加");
  });
});

test("控制比例 50% → 產量減半;同貨物多區相加(礦石:頂級區 15 + 次產區 5 = 20)", async () => {
  await withForcedTurnLock(async () => {
    await resetGoods();
    await setControl(OIL, 0);
    await setControl(TOP, 50);
    await setControl(SIDE, 50);
    await runOneTurn("industrial", "1800-01-01");
    const goods = await readGoods(nationId);
    assert.equal(goods.ironcoal, 15);
    assert.equal(goods.rare, 15);
    assert.equal((await loadNation()).ore, 20, "礦石:3×50%×10 + 1×50%×10 = 15 + 5");
  });
});

test("沒有控制任何特產地區 → 不寫任何貨物列、木材礦石不變", async () => {
  await withForcedTurnLock(async () => {
    await resetGoods({ wood: 7, ore: 9 });
    await setControl(TOP, 0);
    await setControl(OIL, 0);
    await setControl(SIDE, 0);
    await runOneTurn("industrial", "1800-01-01");
    // 糧食庫存列(1-C 的懶初始化)是正常存在的;這裡只要求沒有任何「特產貨物」列。
    const goods = await readGoods(nationId);
    const { food: _food, ...specialtyGoods } = goods;
    assert.deepEqual(specialtyGoods, {}, "沒有特產就不該有任何特產貨物列");
    const n = await loadNation();
    assert.equal(n.wood, 7);
    assert.equal(n.ore, 9);
  });
});
