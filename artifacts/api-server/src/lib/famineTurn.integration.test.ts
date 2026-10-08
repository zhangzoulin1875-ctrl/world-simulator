import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, sql, and, like } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  playerNotificationsTable,
  regionControlsTable,
  mapRegionsTable,
  mapRegionEraStatsTable,
  worldGameStateTable,
  nationGoodsTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runGameMigrations } from "./gameMigrations";
import { runPoliticsMigrations } from "./politicsMigrations";
import { runEconomyMigrations } from "./economyMigrations";
import { runWorldSimMigrations } from "./worldSimMigrations";
import { runTradeMigrationsInner } from "./tradeMigrations";
import { writeFoodStock } from "./trade/foodStockData";
import { runMapRegionSync } from "./mapRegions";
import { runMapRegionEraStatsSync } from "./mapRegionEraStats";
import { runTurnUpdate } from "./turnEngine";
import { computeNationFoodReport } from "./foodData";
import {
  faminePopulationLoss,
  populationDropPenalty,
  FOOD_POLICY_SATISFACTION_COST_PER_TURN,
  FOOD_CALIBRATION,
  foodEraIndexForEra,
} from "./food";
import { supportDriftTick } from "./politics";
import { getPoliticsSettings } from "./politicsSettings";
import { getGameBalanceSettings } from "./gameBalance";

/**
 * Task #434 — 饑荒端到端整合測試：純函式（產量／消耗／饑荒判定／懲罰）已有
 * 單元測試，但「回合引擎實際跑一輪 → 饑荒國人口 −20%、滿意度/支持度依降幅
 * 扣分、站內通知寫入」的完整路徑內嵌在 turnEngine，重構可能悄悄失效。
 *
 * 測試策略：真實 dev DB、名稱前綴標記、self-cleaning。
 * - 測試國家 farmerPopulationPct=0 → 糧食產出 0、人口 > 0 → 消耗 > 0 →
 *   必定饑荒（不依賴肥沃度資料）。
 * - 快照／還原 world_game_state 全部時鐘欄位（避免污染後續整合測試檔），
 *   並在回合前把世界固定在 roman 時代中段（year 400，yearsPerTurn=1 →
 *   不會跨時代）、人口增長倍率設 0（增長量 = 0）→ 人口變化只剩饑荒損失，
 *   期望值可用同一套純函式精確推導（不硬編數字）。
 * - anthropic.messages.create 覆寫為拋錯：AI 結算（政治/內閣/超事件）全部
 *   graceful degrade，不會另外改動滿意度，讓斷言可精確。
 * - 國庫給足（1,000,000、無軍隊無建築）→ 不觸發國庫危機懲罰，滿意度變化
 *   只來自人口驟降懲罰。
 */

const TEST_TAG = "__famine_turn_test__";
const runId = randomBytes(4).toString("hex");
const ERA_SLUG = "roman"; // 200–600 年；year 400 + 1 年不跨時代。
const START_SATISFACTION = 60;
const START_SUPPORT = 60;

/**
 * 強制回合測試用的 session-level advisory lock key。與
 * regionBuildingsTurn.integration.test.ts 共用同一個 key，確保兩個測試檔案
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

let nationId: string;
const discordUserId = `${TEST_TAG}${runId}`;

async function cleanup() {
  // 只清「本 process」的列（runId 後綴）：validation harness 會讓本檔同時跑在
  // lib glob 與 test:integration 兩個 process，共用前綴的清理會互刪對方活體
  // （觀察到 twin 的 before() 把另一邊的測試國家與通知刪掉 → 假性失敗）。
  await db
    .delete(playerNotificationsTable)
    .where(like(playerNotificationsTable.discordUserId, `${TEST_TAG}${runId}%`));
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${TEST_TAG}${runId}%`));
}

async function purgeStaleLeftovers() {
  // 年齡閘門的殘留清理：只清 30 分鐘前的舊列（崩潰殘留），不動併行 twin。
  await db
    .delete(playerNotificationsTable)
    .where(
      and(
        like(playerNotificationsTable.discordUserId, `${TEST_TAG}%`),
        sql`${playerNotificationsTable.createdAt} < NOW() - INTERVAL '30 minutes'`,
      ),
    );
  await db
    .delete(playerNationsTable)
    .where(
      and(
        like(playerNationsTable.name, `${TEST_TAG}%`),
        sql`${playerNationsTable.createdAt} < NOW() - INTERVAL '30 minutes'`,
      ),
    );
}

async function loadNation() {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId))
    .limit(1);
  assert.ok(row, "測試國家應存在");
  return row;
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

  // 建立測試國家：農民比例 0 → 糧食產出 0 → 必定饑荒；國庫充足避免國庫危機。
  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}${runId}`,
      leaderName: TEST_TAG,
      government: "君主制",
      discordUserId,
      isNpc: false,
      money: 1_000_000,
      farmerPopulationPct: 0,
      foodPolicyMobilization: false,
      foodPolicyRationing: false,
      stability: 50,
      unrest: 0,
      satisfactionFarmers: START_SATISFACTION,
      satisfactionWorkers: START_SATISFACTION,
      satisfactionNobles: START_SATISFACTION,
      satisfactionClergy: START_SATISFACTION,
      politicalSupport: START_SUPPORT,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(nation, "測試國家建立失敗");
  nationId = nation.id;

  // 挑兩個「無人掌控」、roman 時代有人口、且面積基準產出足夠的地區，100%
  // 指派給測試國家，確保只影響測試資料。面積基準公式（2026-07 起）：
  // 產出 = 面積 × 肥沃度 × 時代指數 × 農民比例 × 校準常數。第二個測試
  // （脫離饑荒）要求 farmerPct=100 時「未含政策加成」的產出就 > 該區 roman
  // 人口 × 每人消耗 1（實際還有增產動員 +10% 與節約配給 −10% 當保險）；
  // 第一個測試 farmerPct=0 → 產出 0，不受面積/肥沃度影響。
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
      if (controlledSet.has(r.regionId)) return false;
      const pop = Number(r.population);
      if (pop <= 0) return false;
      const baseOutput =
        (r.areaKm2 ?? 0) * (r.fertility ?? 0) * romanIndex * FOOD_CALIBRATION;
      // 未含政策加成就要 > 人口消耗（每人 1 糧），確保脫離饑荒測試必過。
      return baseOutput > pop;
    })
    .slice(0, 2);
  assert.equal(
    free.length,
    2,
    "需要兩個無人掌控、有人口且面積基準產出 > 人口消耗的地區",
  );
  await db
    .insert(regionControlsTable)
    .values(free.map((r) => ({ regionId: r.regionId, nationId, percent: 100 })));
});

after(async () => {
  anthropic.messages.create = realMessagesCreate;
  await cleanup();
  await pool.end();
});

test("整回合：饑荒國人口 −20%、滿意度/支持度依降幅扣分、站內通知寫入", async () => {
  await withForcedTurnLock(async () => {
  // 世界時鐘快照（forced-turn 測試鐵則：還原全部時鐘欄位＋本測試額外改動的
  // yearsPerTurn / 人口增長倍率，避免污染後續整合測試檔）。
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

  // 固定世界狀態：roman 中段、每回合 1 年（不跨時代）、增長倍率 0（增長量 0
  // → 人口變化只剩饑荒損失，可精確推導）。
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

  // 糧食庫存化後，赤字國有 6 回合期初庫存撐著、不會立刻饑荒。本測試驗證的是
  // 「庫存也耗盡才饑荒」的完整路徑，所以明確宣告前提：庫存 0。
  await writeFoodStock(nationId, 0);

  // 回合前：以與回合引擎同一套口徑取得糧食報告，確認前置條件成立。
  const nationBefore = await loadNation();
  const foodBefore = await computeNationFoodReport(nationBefore, ERA_SLUG);
  assert.ok(foodBefore.population > 0, "測試國家人口應 > 0");
  assert.equal(foodBefore.production.total, 0, "農民比例 0 → 產出應為 0");
  assert.ok(foodBefore.consumption.total > 0, "有人口 → 消耗應 > 0");
  assert.equal(foodBefore.stock.current, 0, "前置條件：庫存已耗盡");
  assert.equal(foodBefore.famine, true, "前置條件：應處於饑荒");

  const popBefore = foodBefore.population;
  const expectedLoss = faminePopulationLoss(popBefore);
  assert.ok(expectedLoss > 0, "饑荒損失應 > 0");

  // AI 全數拋錯：政治/內閣/超事件結算 graceful degrade，不干擾滿意度斷言。
  anthropic.messages.create = (async () => {
    throw new Error("模擬 AI 失敗");
  }) as unknown as MessagesCreate;

  let summary: Awaited<ReturnType<typeof runTurnUpdate>>;
  try {
    summary = await runTurnUpdate(new Date(), { force: true });
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

  assert.equal(summary.ran, true, "強制回合應完成");
  assert.equal(summary.era, ERA_SLUG, "不應跨時代（statsEra 口徑固定）");

  // 1) 人口下降 20%：增長倍率 0 → 變化只剩饑荒損失（期望值由同一套純函式推導）。
  const nationAfter = await loadNation();
  const foodAfter = await computeNationFoodReport(nationAfter, ERA_SLUG);
  assert.equal(
    foodAfter.population,
    popBefore - expectedLoss,
    `饑荒後人口應為 ${popBefore} − ${expectedLoss}`,
  );

  // 2) 滿意度懲罰 = floor(降幅%) × 2（純函式同口徑），支持度同扣；
  //    無國庫危機、無糧食政策 → 滿意度變化只來自人口驟降懲罰。
  const expectedPenalty = populationDropPenalty(
    popBefore,
    popBefore - expectedLoss,
  );
  assert.ok(expectedPenalty > 0, "人口驟降懲罰應 > 0");
  const expectSat = Math.max(0, START_SATISFACTION - expectedPenalty);
  assert.equal(nationAfter.satisfactionFarmers, expectSat, "農民滿意度應依降幅扣分");
  assert.equal(nationAfter.satisfactionWorkers, expectSat, "工人滿意度應依降幅扣分");
  assert.equal(nationAfter.satisfactionNobles, expectSat, "貴族滿意度應依降幅扣分");
  assert.equal(nationAfter.satisfactionClergy, expectSat, "神職滿意度應依降幅扣分");
  // 支持度 = (START − 降幅懲罰) 再套用政治結算的支持度漂移（朝有效滿意度平均
  // 移動）。新國家已解鎖方向 = 法律 + 文化 + 軍方（Task #402 第五方向恆有效、
  // Task #521 文化開局即啟用）：法律基準 = 農民滿意度、文化基準 = 工人滿意度
  // （皆已扣分）、軍方滿意度未受人口驟降懲罰（維持預設 60）。
  const politicsSettings = await getPoliticsSettings();
  const expectedSupport = supportDriftTick(
    Math.max(0, START_SUPPORT - expectedPenalty),
    [expectSat, expectSat, 60],
    politicsSettings,
  );
  assert.equal(
    nationAfter.politicalSupport,
    expectedSupport,
    "支持度應依降幅扣分（含支持度漂移）",
  );

  // 3) 站內通知寫入（fire-and-forget 背景寫入 → 輪詢最多 5 秒）。
  let famineNotice: { title: string; body: string } | undefined;
  for (let i = 0; i < 25 && !famineNotice; i++) {
    const rows = await db
      .select({
        title: playerNotificationsTable.title,
        body: playerNotificationsTable.body,
      })
      .from(playerNotificationsTable)
      .where(
        and(
          eq(playerNotificationsTable.discordUserId, discordUserId),
          eq(playerNotificationsTable.title, "全國爆發飢荒"),
        ),
      )
      .limit(1);
    famineNotice = rows[0];
    if (!famineNotice) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(famineNotice, "應寫入饑荒站內通知");
  assert.ok(
    famineNotice.body.includes(expectedLoss.toLocaleString("zh-TW")),
    "通知內文應含實際人口損失數字",
  );
  }); // withForcedTurnLock
});

async function countFamineNotices(): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(playerNotificationsTable)
    .where(
      and(
        eq(playerNotificationsTable.discordUserId, discordUserId),
        eq(playerNotificationsTable.title, "全國爆發飢荒"),
      ),
    );
  return row?.count ?? 0;
}

test("Task #442 反向路徑：提高農民比例＋啟用糧食政策後，回合不再判定饑荒、人口不降、無新通知", async () => {
  await withForcedTurnLock(async () => {
  // 玩家操作：農民比例 0 → 100，並啟用增產動員＋節約配給。
  // 滿意度重設回起始值；支持度重設為「起始值 − 政策成本」。無人口驟降 →
  // 支持度唯一變動來源是政治結算的支持度漂移（朝有效滿意度平均），期望值
  // 用同一套純函式 supportDriftTick 推導（法律=農民滿意度已扣政策成本、
  // 軍方滿意度不吃糧食政策成本 → 維持 60）。
  const policyCost = 2 * FOOD_POLICY_SATISFACTION_COST_PER_TURN;
  const startSupport = START_SATISFACTION - policyCost;
  await db
    .update(playerNationsTable)
    .set({
      farmerPopulationPct: 100,
      foodPolicyMobilization: true,
      foodPolicyRationing: true,
      satisfactionFarmers: START_SATISFACTION,
      satisfactionWorkers: START_SATISFACTION,
      satisfactionNobles: START_SATISFACTION,
      satisfactionClergy: START_SATISFACTION,
      politicalSupport: startSupport,
      money: 1_000_000,
    })
    .where(eq(playerNationsTable.id, nationId));

  // 世界時鐘快照/還原（同上一測試的鐵則）。
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

  // 回合前：同一套糧食報告口徑確認「政策生效 → 不再饑荒」的前置條件。
  const nationBefore = await loadNation();
  assert.equal(nationBefore.farmerPopulationPct, 100);
  const foodBefore = await computeNationFoodReport(nationBefore, ERA_SLUG);
  assert.ok(foodBefore.population > 0, "測試國家人口應 > 0（上一測試饑荒後仍有殘餘）");
  assert.ok(foodBefore.production.total > 0, "農民比例 100 → 產出應 > 0");
  assert.equal(foodBefore.policies.mobilization, true, "報告應反映增產動員");
  assert.equal(foodBefore.policies.rationing, true, "報告應反映節約配給");
  assert.equal(foodBefore.famine, false, "前置條件：政策生效後不應饑荒");

  const popBefore = foodBefore.population;
  const noticesBefore = await countFamineNotices();

  anthropic.messages.create = (async () => {
    throw new Error("模擬 AI 失敗");
  }) as unknown as MessagesCreate;

  let summary: Awaited<ReturnType<typeof runTurnUpdate>>;
  try {
    summary = await runTurnUpdate(new Date(), { force: true });
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

  assert.equal(summary.ran, true, "強制回合應完成");
  assert.equal(summary.era, ERA_SLUG, "不應跨時代");

  // 1) 人口不再下降：增長倍率 0 ＋ 無饑荒 → 人口完全不變。
  const nationAfter = await loadNation();
  const foodAfter = await computeNationFoodReport(nationAfter, ERA_SLUG);
  assert.equal(foodAfter.population, popBefore, "無饑荒 → 人口應維持不變");
  assert.equal(foodAfter.famine, false, "回合後仍不應處於饑荒");

  // 2) 滿意度只扣「政策每回合成本」（兩項政策 × 每項固定成本），
  //    無人口驟降懲罰＋支持度漂移歸零 → 支持度完全不變。
  const expectSat = Math.max(0, START_SATISFACTION - policyCost);
  assert.equal(nationAfter.satisfactionFarmers, expectSat, "農民滿意度只扣政策成本");
  assert.equal(nationAfter.satisfactionWorkers, expectSat, "工人滿意度只扣政策成本");
  assert.equal(nationAfter.satisfactionNobles, expectSat, "貴族滿意度只扣政策成本");
  assert.equal(nationAfter.satisfactionClergy, expectSat, "神職滿意度只扣政策成本");
  // 支持度：無人口驟降懲罰 → 唯一變動來源是政治結算的支持度漂移（朝有效
  // 滿意度平均移動）。有效平均介於 startSupport（=法律／文化方向滿意度，
  // Task #521 文化開局即啟用）與軍方滿意度 60 之間 → 漂移只可能把支持度
  // 往上帶、且不會超過 START_SUPPORT。
  // 若饑荒懲罰誤觸（20% 人口 → 懲罰 ≥ 40），支持度會遠低於 startSupport，
  // 此區間斷言必失敗。
  assert.ok(
    nationAfter.politicalSupport >= startSupport &&
      nationAfter.politicalSupport <= START_SUPPORT,
    `無人口驟降 → 支持度應在 [${startSupport}, ${START_SUPPORT}]（實際 ${nationAfter.politicalSupport}）`,
  );

  // 3) 無新饑荒通知（fire-and-forget 背景寫入 → 靜置 2 秒後檢查計數不變）。
  await new Promise((r) => setTimeout(r, 2000));
  const noticesAfter = await countFamineNotices();
  assert.equal(noticesAfter, noticesBefore, "不應寫入新的饑荒站內通知");
  }); // withForcedTurnLock
});

// ── 貿易系統:糧食庫存 ─────────────────────────────────────────────

async function readStockRow() {
  const rows = await db
    .select({ stock: nationGoodsTable.stock })
    .from(nationGoodsTable)
    .where(and(eq(nationGoodsTable.nationId, nationId), eq(nationGoodsTable.good, "food")));
  return rows.length === 0 ? null : Number(rows[0]!.stock);
}

/** 讓測試國家處於「赤字但有庫存」:農民 0%(產出 0)、無政策。 */
async function setDeficitNation() {
  await db
    .update(playerNationsTable)
    .set({
      farmerPopulationPct: 0,
      foodPolicyMobilization: false,
      foodPolicyRationing: false,
      consecutiveFamineTurns: 0,
      satisfactionFarmers: START_SATISFACTION,
      satisfactionWorkers: START_SATISFACTION,
      satisfactionNobles: START_SATISFACTION,
      satisfactionClergy: START_SATISFACTION,
      politicalSupport: START_SUPPORT,
    })
    .where(eq(playerNationsTable.id, nationId));
}

test("庫存:報告是純讀取——連續讀 5 次,資料庫庫存列不變、不會被建立", async () => {
  await setDeficitNation();
  await db.delete(nationGoodsTable).where(eq(nationGoodsTable.nationId, nationId));
  const nation = await loadNation();
  for (let i = 0; i < 5; i++) await computeNationFoodReport(nation, ERA_SLUG);
  assert.equal(await readStockRow(), null, "讀取報告絕不能建立或改寫庫存列");
  const r1 = await computeNationFoodReport(nation, ERA_SLUG);
  const r2 = await computeNationFoodReport(nation, ERA_SLUG);
  assert.deepEqual(r1.stock.settle, r2.stock.settle, "同一狀態重複讀取結果必須相同");
});

test("庫存:查無庫存列 = 懶初始化為 6 回合消耗,赤字國不立刻饑荒", async () => {
  await setDeficitNation();
  await db.delete(nationGoodsTable).where(eq(nationGoodsTable.nationId, nationId));
  const nation = await loadNation();
  const r = await computeNationFoodReport(nation, ERA_SLUG);
  assert.equal(r.stock.initialized, false, "尚未初始化");
  assert.equal(r.production.total, 0, "前提:產出 0 = 赤字");
  assert.equal(r.stock.current, Math.floor(r.consumption.total * 6), "期初庫存 = 6 回合消耗");
  assert.equal(r.famine, false, "有期初庫存撐著,赤字國本回合不饑荒");
  assert.equal(r.stock.settle.shortfall, 0);
});

test("庫存:整回合——赤字有庫存的國家不饑荒、人口不降、無通知,庫存被寫入且下降", async () => {
  await withForcedTurnLock(async () => {
    await setDeficitNation();
    await db.delete(nationGoodsTable).where(eq(nationGoodsTable.nationId, nationId));
    await db.delete(playerNotificationsTable).where(eq(playerNotificationsTable.discordUserId, discordUserId));

    const [worldBefore] = await db
      .select({
        currentEra: worldGameStateTable.currentEra, statsEra: worldGameStateTable.statsEra,
        gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
        lastTurnDate: worldGameStateTable.lastTurnDate, lastTurnAt: worldGameStateTable.lastTurnAt,
        yearsPerTurn: worldGameStateTable.yearsPerTurn,
        populationGrowthMultiplierPct: worldGameStateTable.populationGrowthMultiplierPct,
      })
      .from(worldGameStateTable).where(eq(worldGameStateTable.id, 1)).limit(1);
    await db.update(worldGameStateTable).set({
      currentEra: ERA_SLUG, statsEra: ERA_SLUG, gameDate: "0400-01-01",
      yearsPerTurn: 1, populationGrowthMultiplierPct: 0,
    }).where(eq(worldGameStateTable.id, 1));

    const before = await computeNationFoodReport(await loadNation(), ERA_SLUG);
    const popBefore = before.population;
    const startStock = before.stock.current;
    const expected = before.stock.settle; // 顯示預測 = 回合實際結算(共用同一純函式)
    assert.equal(expected.famine, false);

    anthropic.messages.create = (async () => { throw new Error("模擬 AI 失敗"); }) as unknown as MessagesCreate;
    try {
      const summary = await runTurnUpdate(new Date(), { force: true });
      assert.equal(summary.ran, true);
    } finally {
      anthropic.messages.create = realMessagesCreate;
      await db.update(worldGameStateTable).set({
        currentEra: worldBefore!.currentEra, statsEra: worldBefore!.statsEra, gameDate: worldBefore!.gameDate,
        lastTurnDate: worldBefore!.lastTurnDate, lastTurnAt: worldBefore!.lastTurnAt,
        yearsPerTurn: worldBefore!.yearsPerTurn,
        populationGrowthMultiplierPct: worldBefore!.populationGrowthMultiplierPct,
      }).where(eq(worldGameStateTable.id, 1));
    }

    const after = await loadNation();
    const foodAfter = await computeNationFoodReport(after, ERA_SLUG);
    assert.equal(foodAfter.population, popBefore, "有庫存 → 不饑荒 → 人口不降");
    assert.equal(after.consecutiveFamineTurns ?? 0, 0, "未饑荒 → 連續饑荒回合數維持 0");

    const written = await readStockRow();
    assert.notEqual(written, null, "回合結算後庫存列應已建立(懶初始化)");
    assert.equal(written, expected.stock, "寫入的庫存 = 顯示預測的結算結果(顯示與結算一致)");
    assert.ok(written! < startStock, `赤字 → 庫存應下降:${startStock} → ${written}`);
    assert.ok(written! > 0, "6 回合庫存一回合後不會歸零");

    // 沒有饑荒通知
    const notices = await db.select().from(playerNotificationsTable)
      .where(and(eq(playerNotificationsTable.discordUserId, discordUserId), like(playerNotificationsTable.title, "%饑荒%")));
    assert.equal(notices.length, 0, "不應有饑荒通知");
  });
});

test("庫存:連續赤字回合,庫存逐步耗盡後才饑荒(庫存是緩衝,不是免死金牌)", async () => {
  await setDeficitNation();
  // 預先寫入剛好只夠半回合的庫存
  const nation = await loadNation();
  const r0 = await computeNationFoodReport(nation, ERA_SLUG);
  await writeFoodStock(nationId, Math.floor(r0.consumption.total / 2));
  const r = await computeNationFoodReport(await loadNation(), ERA_SLUG);
  assert.equal(r.famine, true, "庫存不足一回合消耗 → 本回合饑荒");
  assert.ok(r.stock.settle.shortfall > 0);
  assert.equal(r.stock.settle.stock, 0, "饑荒回合庫存歸零");
  // 補足庫存 → 立刻不饑荒
  await writeFoodStock(nationId, Math.ceil(r0.consumption.total * 2));
  const r2 = await computeNationFoodReport(await loadNation(), ERA_SLUG);
  assert.equal(r2.famine, false);
});
