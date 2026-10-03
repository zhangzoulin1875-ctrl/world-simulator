import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  mapRegionEraStatsTable,
  diplomacyTreatiesTable,
} from "@workspace/db";
import { runDiplomacyMigrations } from "./diplomacyMigrations";
import {
  computeGlobalAveragePopulation,
  getGlobalAveragePopulation,
  invalidateGlobalAveragePopulationCache,
  peekGlobalAveragePopulationCache,
} from "./researchCost";
import { applyNpcTreatyDecision } from "./npcTreatyDecision";

/**
 * Task #387 — 成本倍率快取（getGlobalAveragePopulation 30 秒 TTL）整合測試。
 * 鎖住三件事：
 * 1. TTL 快取行為：TTL 內領土變動「不會」自動反映（現況，靠關鍵路徑手動失效）。
 * 2. invalidateGlobalAveragePopulationCache 後立即重算，反映最新領土。
 * 3. 領土移轉關鍵路徑（NPC 接受含領土的條約 applyNpcTreatyDecision accept）
 *    成立後會使快取失效——玩家不會在 30 秒內被舊平均計算的研發成本扣點。
 *
 * 測試資料自成一體：專屬前綴國家、只借用無人掌控且該時代人口資料 > 0 的地區，
 * 結束時全部刪除（cascade 清掉 controls / treaties）。
 */

const TEST_TAG = "research-cost-cache-test";
const ERA = "classical";

let nationAId: string;
let nationBId: string;
let regionIds: number[] = [];

async function createNation(name: string) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}-${name}`,
      leaderName: TEST_TAG,
      money: 1_000,
      techPoints: 100,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function setControl(regionId: number, nationId: string, percent: number) {
  await db
    .insert(regionControlsTable)
    .values({ regionId, nationId, percent })
    .onConflictDoUpdate({
      target: [regionControlsTable.regionId, regionControlsTable.nationId],
      set: { percent },
    });
}

before(async () => {
  await runDiplomacyMigrations();
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);

  nationAId = await createNation("alpha");
  nationBId = await createNation("beta");

  // 借用無人掌控、且該時代人口 > 0 的地區（確保加入控制會改變全球人口平均）。
  // 測試隔離：offset 160，避開其他共用 dev DB 測試借用的地區段
  // （player.race 0 / regionControlHealth 80 / treatyActivation 120）。
  const rows = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .innerJoin(
      mapRegionEraStatsTable,
      and(
        eq(mapRegionEraStatsTable.regionId, mapRegionsTable.id),
        eq(mapRegionEraStatsTable.era, ERA),
        gt(mapRegionEraStatsTable.population, 0),
      ),
    )
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(160)
    .limit(3);
  regionIds = rows.map((r) => r.id);
  assert.ok(regionIds.length >= 3, "測試需要至少 3 個無人掌控且有人口資料的地區");
});

after(async () => {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);
  invalidateGlobalAveragePopulationCache();
  await pool.end();
});

test("computeGlobalAveragePopulation：新增領土掌控會提高全球人口平均", async () => {
  const before = await computeGlobalAveragePopulation(ERA);
  await setControl(regionIds[0]!, nationAId, 100);
  const after = await computeGlobalAveragePopulation(ERA);
  assert.ok(
    after > before,
    `取得地區後人口平均應上升（before=${before}, after=${after}）`,
  );
});

test("TTL 快取：TTL 內領土變動不反映；invalidate 後立即重算", async () => {
  invalidateGlobalAveragePopulationCache();
  const cached = await getGlobalAveragePopulation(ERA);

  // 領土大變動（快取仍在 TTL 內）→ 回傳值不變（現況：靠關鍵路徑手動失效）。
  await setControl(regionIds[1]!, nationBId, 100);
  const stillCached = await getGlobalAveragePopulation(ERA);
  assert.equal(stillCached, cached, "TTL 內應回快取值");

  // 失效後立即反映新領土。
  invalidateGlobalAveragePopulationCache();
  const fresh = await getGlobalAveragePopulation(ERA);
  const recomputed = await computeGlobalAveragePopulation(ERA);
  assert.equal(fresh, recomputed, "invalidate 後應重算");
  assert.ok(fresh > cached, `新領土應提高人口平均（cached=${cached}, fresh=${fresh}）`);
});

test("快取按時代區分：不同 stats_era 不會誤用他時代的快取值", async () => {
  invalidateGlobalAveragePopulationCache();
  const classical = await getGlobalAveragePopulation(ERA);
  const industrial = await getGlobalAveragePopulation("industrial");
  const industrialDirect = await computeGlobalAveragePopulation("industrial");
  assert.equal(
    industrial,
    industrialDirect,
    "換時代查詢不得沿用前一時代的快取值",
  );
  // 兩個時代的地區數據不同，平均理應不同（防止快取 key 沒帶時代）。
  assert.notEqual(classical, industrial);
});

test("領土移轉路徑：NPC 接受含領土條約後，快取立即失效", async () => {
  // A 掌控 region[2]，將透過條約把它讓給 B。
  await setControl(regionIds[2]!, nationAId, 100);

  // 先讓「不含 region[2] 效果」以外的狀態進入快取——注意 region[2] 已在
  // A 名下，之後條約只是 A→B 移轉，全球平均不變；因此改用「先預熱快取，
  // 再另外加一塊領土製造可觀測差異」的方式驗證失效確實發生。
  invalidateGlobalAveragePopulationCache();
  const warm = await getGlobalAveragePopulation(ERA);

  // 在快取仍有效期間，直接調整 region[1] 掌控比例，讓全球平均改變。
  // 若條約路徑沒有失效快取，這個變化在 30 秒內不會被看到。
  await db
    .update(regionControlsTable)
    .set({ percent: 50 })
    .where(
      and(
        eq(regionControlsTable.regionId, regionIds[1]!),
        eq(regionControlsTable.nationId, nationBId),
      ),
    );
  assert.equal(await getGlobalAveragePopulation(ERA), warm, "前置：仍為快取值");

  // 建立 A→B 的領土條約並由 NPC 決策路徑接受。
  const [treaty] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: nationAId,
      targetNationId: nationBId,
      type: "nonaggression",
      offerRegionIds: [regionIds[2]!],
      offerRegionPercents: {},
      status: "proposed",
      awaitingNationId: nationBId,
    })
    .returning({ id: diplomacyTreatiesTable.id });
  assert.ok(treaty, "test treaty insert failed");

  const activated = await applyNpcTreatyDecision(treaty.id, {
    decision: "accept",
    note: "測試接受",
    relationDelta: 0,
    counter: null,
  });
  assert.equal(activated.status, "active");

  // 領土確實移轉到 B。
  const controls = await db
    .select({ nationId: regionControlsTable.nationId })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, regionIds[2]!));
  assert.deepEqual(
    controls.map((c) => c.nationId),
    [nationBId],
  );

  // 快取已被條約路徑同步失效：直接檢視快取槽（不比較全球人口平均數值——
  // 共用開發 DB 上併發的 integration 測試會改動其他國家，讓「平均應下降」
  // 這種方向性斷言變成假性失敗）。
  assert.equal(
    peekGlobalAveragePopulationCache(),
    null,
    "條約領土移轉路徑應同步失效全球人口平均快取",
  );

  // 下一次查詢會重算並重新填入快取。
  await getGlobalAveragePopulation(ERA);
  assert.notEqual(
    peekGlobalAveragePopulationCache(),
    null,
    "失效後的查詢應重算並重新填入快取",
  );

  // 清理殘留條約（國家刪除會 cascade，這裡保險先清）。
  await db
    .delete(diplomacyTreatiesTable)
    .where(inArray(diplomacyTreatiesTable.proposerNationId, [nationAId, nationBId]));
});
