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
  regionBuildingsTable,
  mapRegionsTable,
  mapRegionEraStatsTable,
  worldGameStateTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runGameMigrations } from "./gameMigrations";
import { runPoliticsMigrations } from "./politicsMigrations";
import { runEconomyMigrations } from "./economyMigrations";
import { runWorldSimMigrations } from "./worldSimMigrations";
import { runMapRegionSync } from "./mapRegions";
import { runMapRegionEraStatsSync } from "./mapRegionEraStats";
import { runTurnUpdate, TREASURY_CRISIS_PENALTY } from "./turnEngine";
import {
  buildingOutput,
  buildingUpkeep,
  BUILDING_OUTPUT_PER_LEVEL,
  BUILDING_UPKEEP_PER_LEVEL,
} from "./regionBuildings";
import { upkeepShortfallMilitaryPenalty } from "./militaryPolitics";
import { computeNationFoodReport } from "./foodData";
import { FOOD_CALIBRATION, foodEraIndexForEra } from "./food";
import { getGameBalanceSettings } from "./gameBalance";
import { unrestTick, clampPct } from "./politics";
import { getPoliticsSettings } from "./politicsSettings";

/**
 * Task #431 — 伐木場／礦場每回合產出與維護費整合測試：建築純函式（50×等級
 * 產出、100×等級維護費）已有單元測試，但「每日回合結算實際把 wood/ore 入帳、
 * 金錢扣維護費、金錢不足時歸零＋赤字懲罰＋通知」的完整路徑內嵌在 turnEngine，
 * 回合引擎改動時可能悄悄失效。
 *
 * 測試策略：真實 dev DB、名稱前綴標記、self-cleaning。
 * - 兩個測試國家共用同一次強制回合：
 *   富國（國庫充足、稅率 0、無軍隊）→ 金錢變化恰為 −Σ(100×level)、
 *   wood/ore 恰增 Σ(50×level)；
 *   窮國（金錢 < 維護費、稅率 0）→ 金錢歸零、赤字懲罰（四滿意度 −10／
 *   穩定 −8／暴動 +8）、軍方滿意度依缺口比例扣分、「軍隊維護費不足」
 *   站內通知；wood/ore 仍照常入帳（資源產出不受金錢缺口影響）。
 * - 快照／還原 world_game_state 全部時鐘欄位（memory: forced-turn 鐵則），
 *   世界固定在 roman 中段（year 400、yearsPerTurn=1 → 不跨時代）、
 *   人口增長倍率 0。
 * - 農民比例 100（預設）→ 不飢荒（回合前以同口徑糧食報告驗證前置條件），
 *   滿意度變化只來自國庫危機懲罰。
 * - anthropic.messages.create 覆寫為拋錯：AI 結算（政治/內閣/超事件）全部
 *   graceful degrade，不另外改動滿意度。
 */

const TEST_TAG = "__bldg_turn_test__";
const runId = randomBytes(4).toString("hex");
const ERA_SLUG = "roman";
const START_SATISFACTION = 60;
const START_STABILITY = 50;
const START_UNREST = 10;
const START_MILITARY_SATISFACTION = 60;

const RICH_MONEY = 1_000_000;
const POOR_MONEY = 100;

// 富國：伐木場 3 級 + 礦場 2 級；窮國：礦場 3 級（維護 300 > 金錢 100）。
const RICH_LUMBER_LEVEL = 3;
const RICH_MINE_LEVEL = 2;
const POOR_MINE_LEVEL = 3;

/**
 * 強制回合測試用的 session-level advisory lock key。與
 * famineTurn.integration.test.ts 共用同一個 key，確保兩個測試檔案
 * 在 validation 並發環境下（test:integration + 獨立執行）不會同時修改
 * world_game_state singleton 列，造成世界狀態交叉污染。
 */
const FORCED_TURN_LOCK_KEY = 9_999_999_901;

/**
 * 以 session-level advisory lock 序列化強制回合測試的 world_game_state
 * 快照－修改－結算－還原 流程，防止並發測試進程相互污染。
 */
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
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

let richId: string;
let poorId: string;
const richUserId = `${TEST_TAG}rich_${runId}`;
const poorUserId = `${TEST_TAG}poor_${runId}`;

async function cleanup() {
  await db
    .delete(playerNotificationsTable)
    .where(like(playerNotificationsTable.discordUserId, `${TEST_TAG}%`));
  // region_buildings / region_controls 皆 ON DELETE CASCADE。
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${TEST_TAG}%`));
}

async function loadNation(id: string) {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, id))
    .limit(1);
  assert.ok(row, "測試國家應存在");
  return row;
}

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await runEconomyMigrations();
  await runWorldSimMigrations();
  await runMapRegionSync();
  await runMapRegionEraStatsSync();
  await cleanup();

  const insertNation = async (name: string, userId: string, money: number) => {
    const [nation] = await db
      .insert(playerNationsTable)
      .values({
        name,
        leaderName: TEST_TAG,
        government: "君主制",
        discordUserId: userId,
        isNpc: false,
        money,
        taxRatePct: 0, // 稅收 0 → 金錢變化只剩維護費，可精確斷言。
        stability: START_STABILITY,
        unrest: START_UNREST,
        satisfactionFarmers: START_SATISFACTION,
        satisfactionWorkers: START_SATISFACTION,
        satisfactionNobles: START_SATISFACTION,
        satisfactionClergy: START_SATISFACTION,
        satisfactionMilitary: START_MILITARY_SATISFACTION,
      })
      .returning({ id: playerNationsTable.id });
    assert.ok(nation, "測試國家建立失敗");
    return nation.id;
  };
  richId = await insertNation(`${TEST_TAG}rich_${runId}`, richUserId, RICH_MONEY);
  poorId = await insertNation(`${TEST_TAG}poor_${runId}`, poorUserId, POOR_MONEY);

  // 挑四個「無人掌控、無建築」且 roman 時代有人口的地區，各國 100% 掌控兩個，
  // 並在其上放建築（region_buildings 對 (region, type) 唯一）。
  // 面積基準糧食公式（2026-07 起）：產出 = 面積 × 肥沃度 × 時代指數 × 農民
  // 比例 × 校準常數，與人口脫鉤 → 額外要求每區「農民比例 100 的產出 > 該區
  // roman 人口」，確保前置條件「兩國皆不飢荒」在新公式下必定成立。
  // 時代指數可被平衡頁面覆寫（存 DB）：用「生效值」推導前置條件，
  // 與 computeNationFoodReport 實際口徑一致。
  const romanIndex = foodEraIndexForEra(
    ERA_SLUG,
    (await getGameBalanceSettings()).food.eraIndex,
  );
  const controlled = await db
    .select({ regionId: regionControlsTable.regionId })
    .from(regionControlsTable);
  const controlledSet = new Set(controlled.map((r) => r.regionId));
  const built = await db
    .select({ regionId: regionBuildingsTable.regionId })
    .from(regionBuildingsTable);
  const builtSet = new Set(built.map((r) => r.regionId));
  const eraRows = await db
    .select({
      regionId: mapRegionEraStatsTable.regionId,
      population: mapRegionEraStatsTable.population,
      fertility: mapRegionsTable.soilFertility,
      areaKm2: mapRegionsTable.areaKm2,
    })
    .from(mapRegionEraStatsTable)
    .innerJoin(
      mapRegionsTable,
      eq(mapRegionsTable.id, mapRegionEraStatsTable.regionId),
    )
    .where(eq(mapRegionEraStatsTable.era, ERA_SLUG))
    .orderBy(sql`${mapRegionEraStatsTable.population} DESC`);
  const free = eraRows
    .filter((r) => {
      if (controlledSet.has(r.regionId) || builtSet.has(r.regionId)) {
        return false;
      }
      const pop = Number(r.population);
      if (pop <= 0) return false;
      const baseOutput =
        (r.areaKm2 ?? 0) * (r.fertility ?? 0) * romanIndex * FOOD_CALIBRATION;
      return baseOutput > pop;
    })
    .slice(0, 4);
  assert.equal(
    free.length,
    4,
    "需要四個無人掌控、無建築、有人口且面積基準產出 > 人口消耗的地區",
  );
  const [richA, richB, poorA, poorB] = free.map((r) => r.regionId) as [
    number,
    number,
    number,
    number,
  ];
  await db.insert(regionControlsTable).values([
    { regionId: richA, nationId: richId, percent: 100 },
    { regionId: richB, nationId: richId, percent: 100 },
    { regionId: poorA, nationId: poorId, percent: 100 },
    { regionId: poorB, nationId: poorId, percent: 100 },
  ]);
  await db.insert(regionBuildingsTable).values([
    {
      nationId: richId,
      regionId: richA,
      buildingType: "lumber_mill",
      level: RICH_LUMBER_LEVEL,
    },
    {
      nationId: richId,
      regionId: richB,
      buildingType: "mine",
      level: RICH_MINE_LEVEL,
    },
    {
      nationId: poorId,
      regionId: poorA,
      buildingType: "mine",
      level: POOR_MINE_LEVEL,
    },
  ]);
});

after(async () => {
  anthropic.messages.create = realMessagesCreate;
  await cleanup();
  await pool.end();
});

test("回合結算：建築產出入帳、維護費扣款、金錢不足時歸零＋赤字懲罰", async () => {
  await withForcedTurnLock(async () => {
  // 世界時鐘快照（forced-turn 鐵則：還原全部時鐘欄位＋本測試額外改動的欄位）。
  const [worldBefore] = await db
    .select({
      currentEra: worldGameStateTable.currentEra,
      statsEra: worldGameStateTable.statsEra,
      gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
      lastTurnDate: worldGameStateTable.lastTurnDate,
      lastTurnAt: worldGameStateTable.lastTurnAt,
      yearsPerTurn: worldGameStateTable.yearsPerTurn,
      populationGrowthMultiplierPct:
        worldGameStateTable.populationGrowthMultiplierPct,
    })
    .from(worldGameStateTable)
    .where(eq(worldGameStateTable.id, 1))
    .limit(1);
  assert.ok(worldBefore, "world_game_state 應存在");

  await db
    .update(worldGameStateTable)
    .set({
      currentEra: ERA_SLUG,
      statsEra: ERA_SLUG,
      gameDate: "0400-01-01",
      yearsPerTurn: 1,
      populationGrowthMultiplierPct: 0,
    })
    .where(eq(worldGameStateTable.id, 1));

  // 前置條件：兩國皆不飢荒（農民比例 100），滿意度變化只來自國庫危機懲罰。
  const richBefore = await loadNation(richId);
  const poorBefore = await loadNation(poorId);
  const richFood = await computeNationFoodReport(richBefore, ERA_SLUG);
  const poorFood = await computeNationFoodReport(poorBefore, ERA_SLUG);
  assert.equal(richFood.famine, false, "前置條件：富國不應飢荒");
  assert.equal(poorFood.famine, false, "前置條件：窮國不應飢荒");

  // 期望值全部由 regionBuildings 純函式推導（不硬編）。
  const richWoodGain = buildingOutput(RICH_LUMBER_LEVEL);
  const richOreGain = buildingOutput(RICH_MINE_LEVEL);
  const richUpkeep =
    buildingUpkeep(RICH_LUMBER_LEVEL) + buildingUpkeep(RICH_MINE_LEVEL);
  const poorOreGain = buildingOutput(POOR_MINE_LEVEL);
  const poorUpkeep = buildingUpkeep(POOR_MINE_LEVEL);
  assert.equal(richWoodGain, RICH_LUMBER_LEVEL * BUILDING_OUTPUT_PER_LEVEL);
  assert.equal(
    richUpkeep,
    (RICH_LUMBER_LEVEL + RICH_MINE_LEVEL) * BUILDING_UPKEEP_PER_LEVEL,
  );
  assert.ok(poorUpkeep > POOR_MONEY, "前置條件：窮國維護費應超過國庫");
  const poorShortfall = poorUpkeep - POOR_MONEY;

  // AI 全數拋錯：政治/內閣/超事件結算 graceful degrade，不干擾滿意度斷言。
  anthropic.messages.create = (async () => {
    throw new Error("模擬 AI 失敗");
  }) as unknown as MessagesCreate;

  try {
    const summary = await runTurnUpdate(new Date(), { force: true });
    assert.equal(summary.ran, true, "強制回合應完成");
    assert.equal(summary.era, ERA_SLUG, "不應跨時代");
  } finally {
    anthropic.messages.create = realMessagesCreate;
    await db
      .update(worldGameStateTable)
      .set({
        currentEra: worldBefore.currentEra,
        statsEra: worldBefore.statsEra,
        gameDate: worldBefore.gameDate,
        lastTurnDate: worldBefore.lastTurnDate,
        lastTurnAt: worldBefore.lastTurnAt,
        yearsPerTurn: worldBefore.yearsPerTurn,
        populationGrowthMultiplierPct:
          worldBefore.populationGrowthMultiplierPct,
      })
      .where(eq(worldGameStateTable.id, 1));
  }

  // 政治結算的每回合暴動/穩定 tick 是確定性純函式（unrestTick），期望值以
  // 同一套函式推導。新國家已解鎖方向 = 法律 + 文化 + 軍方（Task #402 第五
  // 方向恆有效、Task #521 文化開局即啟用）：法律基準 = 農民滿意度、文化基準
  // = 工人滿意度、軍方滿意度獨立欄位。
  const politicsSettings = await getPoliticsSettings();

  // 1) 富國：wood/ore 增量 = Σ(50×level)、金錢恰扣 Σ(100×level)（稅率 0、
  //    無軍隊 → 金錢變化只剩建築維護費）。無國庫危機 → 滿意度不變，
  //    穩定/暴動只受政治 tick 影響。
  const richAfter = await loadNation(richId);
  assert.equal(richAfter.wood, richBefore.wood + richWoodGain, "富國木材入帳");
  assert.equal(richAfter.ore, richBefore.ore + richOreGain, "富國礦石入帳");
  assert.equal(
    richAfter.money,
    RICH_MONEY - richUpkeep,
    "富國金錢應恰扣建築維護費",
  );
  assert.equal(richAfter.satisfactionFarmers, START_SATISFACTION);
  const richTick = unrestTick(
    [START_SATISFACTION, START_SATISFACTION, START_MILITARY_SATISFACTION],
    politicsSettings,
  );
  assert.equal(
    richAfter.stability,
    clampPct(START_STABILITY + richTick.stabilityDelta),
    "富國穩定度只受政治 tick 影響（無國庫危機懲罰）",
  );
  assert.equal(
    richAfter.unrest,
    clampPct(START_UNREST + richTick.unrestDelta),
    "富國暴動度只受政治 tick 影響（無國庫危機懲罰）",
  );

  // 2) 窮國：金錢歸零（不為負）、wood/ore 仍照常入帳、赤字懲罰套用。
  const poorAfter = await loadNation(poorId);
  assert.equal(poorAfter.money, 0, "窮國金錢應歸零而非為負");
  assert.equal(
    poorAfter.ore,
    poorBefore.ore + poorOreGain,
    "金錢缺口不影響礦石入帳",
  );
  assert.equal(poorAfter.wood, poorBefore.wood, "窮國無伐木場 → 木材不變");
  const deficit = TREASURY_CRISIS_PENALTY.deficit;
  assert.equal(
    poorAfter.satisfactionFarmers,
    START_SATISFACTION + deficit.satisfaction,
    "赤字：農民滿意度 −10",
  );
  assert.equal(
    poorAfter.satisfactionWorkers,
    START_SATISFACTION + deficit.satisfaction,
  );
  assert.equal(
    poorAfter.satisfactionNobles,
    START_SATISFACTION + deficit.satisfaction,
  );
  assert.equal(
    poorAfter.satisfactionClergy,
    START_SATISFACTION + deficit.satisfaction,
  );
  // 軍方滿意度依缺口比例扣分（純函式同口徑）。
  const militaryPenalty = upkeepShortfallMilitaryPenalty(
    poorShortfall,
    poorUpkeep,
  );
  assert.ok(militaryPenalty > 0, "缺口 > 0 → 軍方懲罰應 > 0");
  // 穩定/暴動 = 赤字懲罰（回合結算）＋政治 tick（用懲罰後的有效滿意度）。
  const poorTick = unrestTick(
    [
      START_SATISFACTION + deficit.satisfaction,
      START_SATISFACTION + deficit.satisfaction,
      START_MILITARY_SATISFACTION - militaryPenalty,
    ],
    politicsSettings,
  );
  assert.equal(
    poorAfter.stability,
    clampPct(START_STABILITY + deficit.stability + poorTick.stabilityDelta),
    "窮國穩定度 = 赤字 −8 ＋政治 tick",
  );
  assert.equal(
    poorAfter.unrest,
    clampPct(START_UNREST + deficit.unrest + poorTick.unrestDelta),
    "窮國暴動度 = 赤字 +8 ＋政治 tick",
  );
  assert.equal(
    poorAfter.satisfactionMilitary,
    START_MILITARY_SATISFACTION - militaryPenalty,
    "軍方滿意度依缺口比例扣分",
  );

  // 3) 「軍隊維護費不足」站內通知（fire-and-forget → 輪詢最多 5 秒），
  //    且富國不應收到。
  let shortfallNotice: { body: string } | undefined;
  for (let i = 0; i < 25 && !shortfallNotice; i++) {
    const rows = await db
      .select({ body: playerNotificationsTable.body })
      .from(playerNotificationsTable)
      .where(
        and(
          eq(playerNotificationsTable.discordUserId, poorUserId),
          eq(playerNotificationsTable.title, "軍隊維護費不足"),
        ),
      )
      .limit(1);
    shortfallNotice = rows[0];
    if (!shortfallNotice) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(shortfallNotice, "窮國應收到維護費不足站內通知");
  assert.ok(
    shortfallNotice.body.includes(poorShortfall.toLocaleString("zh-TW")),
    "通知內文應含缺口數字",
  );
  const richNotices = await db
    .select({ id: playerNotificationsTable.id })
    .from(playerNotificationsTable)
    .where(
      and(
        eq(playerNotificationsTable.discordUserId, richUserId),
        inArray(playerNotificationsTable.title, [
          "軍隊維護費不足",
          "國庫見底",
        ]),
      ),
    );
  assert.equal(richNotices.length, 0, "富國不應收到國庫危機通知");
  }); // withForcedTurnLock
});
