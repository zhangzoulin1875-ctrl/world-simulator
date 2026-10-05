import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, sql, and, like } from "drizzle-orm";
import {
  db, pool, playerNationsTable, playerNotificationsTable, regionControlsTable,
  mapRegionsTable, mapRegionEraStatsTable, worldGameStateTable,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { runGameMigrations } from "./gameMigrations";
import { runPoliticsMigrations } from "./politicsMigrations";
import { runEconomyMigrations } from "./economyMigrations";
import { runWorldSimMigrations } from "./worldSimMigrations";
import { runMapRegionSync } from "./mapRegions";
import { runMapRegionEraStatsSync } from "./mapRegionEraStats";
import { runTurnUpdate } from "./turnEngine";
import { computeNationStats, buildNationStatBreakdown } from "./nationStats";
import { schemas } from "@workspace/api-zod";
const { GetNationStatBreakdownResponse } = schemas;
import { loadRegionGrowthInputs } from "./regionPopulation";
import { nationNetGrowth, summarizeCapacity } from "./populationCapacity";
import { getPoliticsSettings } from "./politicsSettings";
import { populationGrowthRatePct } from "./politics";

/**
 * 人口承載量(自然死亡率)端到端整合測試:純函式已有單元測試,這裡驗證
 * 「回合引擎實際跑一輪 → 各區依 logistic 增減」的完整路徑沒有被重構悄悄打壞:
 *  1) 遠低於承載量:接近舊行為(人口 × 增長率)。
 *  2) 超載:人口下降(緩慢回落),單回合降幅有上限,不是飢荒式的一次砍 20%。
 *  3) 貼近承載量:淨變化接近 0。
 * 做法:測試國家農民比例 100(糧食保底 → 不飢荒),直接改 region_controls.population_bonus
 * 把人口擺到想要的位置;世界固定在 roman 中段、1 年/回合(不跨時代)、倍率 100。
 */
const TAG = "__popcap_turn_test__";
const runId = randomBytes(4).toString("hex");
const ERA = "roman";
const LOCK_KEY = 9_999_999_901; // 與其他強制回合測試共用,避免同時改 world_game_state。

type MessagesCreate = typeof anthropic.messages.create;
const realCreate: MessagesCreate = anthropic.messages.create.bind(anthropic.messages);

let nationId: string;
let regionIds: number[] = [];
const discordUserId = `${TAG}${runId}`;

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    try { return await fn(); } finally { await c.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]); }
  } finally { c.release(); }
}
async function cleanup() {
  await db.delete(playerNotificationsTable).where(like(playerNotificationsTable.discordUserId, `${TAG}${runId}%`));
  await db.delete(playerNationsTable).where(like(playerNationsTable.name, `${TAG}${runId}%`));
}
async function loadNation() {
  const [row] = await db.select().from(playerNationsTable).where(eq(playerNationsTable.id, nationId)).limit(1);
  assert.ok(row); return row;
}
/** 把每區「累積量」設成讓該區實際人口 = 承載量 × ratio。 */
async function setLoad(ratio: number) {
  await db.update(regionControlsTable).set({ populationBonus: 0 }).where(eq(regionControlsTable.nationId, nationId));
  const inputs = await loadRegionGrowthInputs(db, nationId, ERA);
  for (const r of inputs) {
    const target = Math.round(r.capacity * ratio);
    const bonus = target - r.population; // population 此時 = 基準貢獻(累積已歸 0)
    await db.update(regionControlsTable).set({ populationBonus: bonus })
      .where(and(eq(regionControlsTable.nationId, nationId), eq(regionControlsTable.regionId, r.regionId)));
  }
}
async function popNow() {
  const n = await loadNation();
  return (await computeNationStats(n.id, ERA)).population;
}
async function runOneTurn() {
  return withLock(async () => {
    const [w] = await db.select({
      currentEra: worldGameStateTable.currentEra, statsEra: worldGameStateTable.statsEra,
      gameDate: sql<string>`to_char(${worldGameStateTable.gameDate}, 'YYYY-MM-DD')`,
      lastTurnDate: worldGameStateTable.lastTurnDate, lastTurnAt: worldGameStateTable.lastTurnAt,
      yearsPerTurn: worldGameStateTable.yearsPerTurn,
      populationGrowthMultiplierPct: worldGameStateTable.populationGrowthMultiplierPct,
    }).from(worldGameStateTable).where(eq(worldGameStateTable.id, 1)).limit(1);
    assert.ok(w);
    await db.update(worldGameStateTable).set({
      currentEra: ERA, statsEra: ERA, gameDate: "0400-01-01", yearsPerTurn: 1, populationGrowthMultiplierPct: 100,
    }).where(eq(worldGameStateTable.id, 1));
    anthropic.messages.create = (async () => { throw new Error("模擬 AI 失敗"); }) as unknown as MessagesCreate;
    try {
      const s = await runTurnUpdate(new Date(), { force: true });
      assert.equal(s.ran, true);
      assert.equal(s.era, ERA);
    } finally {
      anthropic.messages.create = realCreate;
      await db.update(worldGameStateTable).set({
        currentEra: w.currentEra, statsEra: w.statsEra, gameDate: w.gameDate, lastTurnDate: w.lastTurnDate,
        lastTurnAt: w.lastTurnAt, yearsPerTurn: w.yearsPerTurn, populationGrowthMultiplierPct: w.populationGrowthMultiplierPct,
      }).where(eq(worldGameStateTable.id, 1));
    }
  });
}

before(async () => {
  await runGameMigrations(); await runPoliticsMigrations(); await runEconomyMigrations();
  await runWorldSimMigrations(); await runMapRegionSync(); await runMapRegionEraStatsSync();
  await cleanup();
  const [nation] = await db.insert(playerNationsTable).values({
    name: `${TAG}${runId}`, leaderName: TAG, government: "君主制", discordUserId, isNpc: false,
    money: 1_000_000, farmerPopulationPct: 100, stability: 50, unrest: 0,
  }).returning({ id: playerNationsTable.id });
  nationId = nation!.id;
  const controlled = new Set((await db.select({ r: regionControlsTable.regionId }).from(regionControlsTable)).map((x) => x.r));
  const rows = await db.select({ regionId: mapRegionEraStatsTable.regionId, population: mapRegionEraStatsTable.population })
    .from(mapRegionEraStatsTable).innerJoin(mapRegionsTable, eq(mapRegionsTable.id, mapRegionEraStatsTable.regionId))
    .where(eq(mapRegionEraStatsTable.era, ERA)).orderBy(sql`${mapRegionEraStatsTable.population} DESC`);
  const free = rows.filter((r) => !controlled.has(r.regionId) && Number(r.population) > 100_000).slice(0, 2);
  assert.equal(free.length, 2, "需要兩個無人掌控、有人口的地區");
  regionIds = free.map((r) => r.regionId);
  await db.insert(regionControlsTable).values(regionIds.map((regionId) => ({ regionId, nationId, percent: 100 })));
});
after(async () => { anthropic.messages.create = realCreate; await cleanup(); await pool.end(); });

async function expectedBirthRate() {
  const n = await loadNation();
  const { computeAdjustedNationStats } = await import("./nationStats");
  const st = await computeAdjustedNationStats(n, ERA, undefined, 100);
  return st.populationGrowthRatePct;
}

test("遠低於承載量(10%):本回合成長接近舊行為「人口 × 增長率」", async () => {
  await setLoad(0.1);
  const before = await popNow();
  const rate = await expectedBirthRate();
  assert.ok(rate > 0, "前置:有效增長率應為正");
  await runOneTurn();
  const after = await popNow();
  const oldBehaviour = Math.round(before * rate / 100);
  const delta = after - before;
  // logistic 在 10% 負載時 = 舊成長 × 0.9(±擾動的小影響):落在 [0.8, 1.0] 倍舊成長之間。
  assert.ok(delta > oldBehaviour * 0.8 && delta <= oldBehaviour * 1.0 + 2, `delta=${delta} 舊=${oldBehaviour}`);
});

test("超載 2 倍:人口下降(緩慢回落),單回合降幅遠小於飢荒的 20%", async () => {
  await setLoad(2);
  const before = await popNow();
  const rate = await expectedBirthRate();
  await runOneTurn();
  const after = await popNow();
  assert.ok(after < before, `超載應該下降:${before} → ${after}`);
  const dropPct = ((before - after) / before) * 100;
  // 預期首回合降幅 ≈ 增長率 × (2−1) = rate%;上限給 1.3 倍容忍擾動與整數進位。
  assert.ok(dropPct <= rate * 1.3 + 0.01, `降幅 ${dropPct.toFixed(3)}% 超過預期 ${rate}%`);
  assert.ok(dropPct < 20, "不應是飢荒式的一次砍 20%");
  const n = await loadNation();
  assert.equal(n.consecutiveFamineTurns ?? 0, 0, "超載不得被算成飢荒");
});

test("貼近承載量(100%):本回合淨變化接近 0(在擾動範圍內)", async () => {
  await setLoad(1);
  const before = await popNow();
  const rate = await expectedBirthRate();
  await runOneTurn();
  const after = await popNow();
  const changePct = Math.abs((after - before) / before) * 100;
  // 擾動最多 ±10% 的承載量 → 淨變化最多 ≈ rate × 0.1 /1.1,放寬到 rate × 0.15。
  assert.ok(changePct <= rate * 0.15 + 0.005, `貼近上限時變化 ${changePct.toFixed(4)}% 太大 (rate ${rate}%)`);
});

test("顯示彙總:summarizeCapacity 的淨成長率與實際回合預期(無擾動)一致", async () => {
  await setLoad(0.5);
  const inputs = await loadRegionGrowthInputs(db, nationId, ERA);
  const rate = await expectedBirthRate();
  const s = summarizeCapacity(inputs, rate);
  assert.ok(Math.abs(s.loadRatio - 0.5) < 0.01, `loadRatio=${s.loadRatio}`);
  assert.ok(Math.abs(s.netGrowthPct - rate * 0.5) < rate * 0.02, `net=${s.netGrowthPct} rate=${rate}`);
  // 與含擾動的實際計算相比,誤差不超過擾動範圍。
  const withWobble = nationNetGrowth(inputs, rate, 123456);
  const total = inputs.reduce((a, r) => a + r.population, 0);
  assert.ok(Math.abs(withWobble / total * 100 - s.netGrowthPct) <= rate * 0.25);
  // 用到政治設定確認增長率來源是既有的有效增長率(基礎+修正),不是新常數。
  const settings = await getPoliticsSettings();
  assert.ok(rate >= populationGrowthRatePct(-999, settings) && rate <= settings.populationGrowthMaxAbsPct);
});

test("明細彈窗 API:承載量/負載/淨成長率三欄通過 zod 驗證,且與首頁顯示彙總同一口徑", async () => {
  for (const ratio of [0.4, 1, 2]) {
    await setLoad(ratio);
    const nation = await loadNation();
    const breakdown = await buildNationStatBreakdown(nation, ERA);
    // 與路由同樣以生成的 zod schema 驗證(欄位漂移會在這裡顯性失敗,而不是前端 undefined)。
    const data = GetNationStatBreakdownResponse.parse({ ...breakdown, eraLabel: "test" });
    const g = data.population.growth;
    assert.ok(Math.abs(g.loadRatio - ratio) < 0.02, `ratio ${ratio}: loadRatio=${g.loadRatio}`);
    assert.ok(g.capacity > 0);
    // 淨成長率符號:低於上限為正、超載為負、貼近上限約 0。
    if (ratio < 0.9) assert.ok(g.netPct > 0, `ratio ${ratio}: netPct=${g.netPct}`);
    if (ratio > 1.05) assert.ok(g.netPct < 0, `ratio ${ratio}: netPct=${g.netPct}`);
    if (ratio === 1) assert.ok(Math.abs(g.netPct) < 0.02, `ratio 1: netPct=${g.netPct}`);
    // 與首頁同一彙總:同一組輸入算出的淨成長率一致(四捨五入到 0.01)。
    const inputs = await loadRegionGrowthInputs(db, nationId, ERA);
    const summary = summarizeCapacity(inputs, g.effectivePct);
    assert.ok(Math.abs(summary.netGrowthPct - g.netPct) < 0.05, `summary ${summary.netGrowthPct} vs ${g.netPct}`);
    // 出生率(effectivePct)維持原本語意:不受承載量影響,仍是正的有效增長率。
    assert.ok(g.effectivePct > 0);
  }
});
