/**
 * 生產力新算式（Task #198）整合測試。
 *
 * computeNationStats 的生產力改為 Σ(生產素質 × 控制比例 × 地區人口 ÷ 1,000,000)
 * ＝ 生產素質 × 控制人口 ÷ 10000，同時反映生產素質與人口規模。本測試鎖住兩件事：
 *
 *  1. computeNationStats 的 production 等於用該時代地區數值以新公式手算的加總
 *     （人口／科技點數仍為舊的 percent 加權，一併驗證未受影響）。
 *  2. 「人口大」的國家生產力明顯高於「同生產素質但人口小」的國家——把新公式
 *     真正反映人口規模這件事鎖起來。
 *
 * 走真實 DB（需 DATABASE_URL 指向已跑過遷移的資料庫）。資料以 `__nsprodtest__`
 * 前綴標記，跑前跑後自清，可重複執行：
 * `pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the nation production tests");
}

const { and, eq, like, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionEraStatsTable,
} = await import("@workspace/db");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runMapRegionEraStatsSync } = await import("../lib/mapRegionEraStats");
const { computeNationStats, getStatsEraSlug } = await import(
  "../lib/nationStats"
);

const NATION_MARKER = "__nsprodtest__";
const runId = randomBytes(4).toString("hex");

let eraSlug: string;
let bigPopNationId: string;
let smallPopNationId: string;

/** 用於手算期望值的地區數值（生產素質 / 人口 / 科技）。 */
type RegionEra = { regionId: number; productivity: number; population: number; techPoints: number };
let regionA: RegionEra;
let regionB: RegionEra;

async function cleanup() {
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
}

/** 依新公式手算：Σ(生產素質 × 控制比例 × 地區人口 ÷ 10,000)，四捨五入。 */
function expectedProduction(
  parts: { era: RegionEra; percent: number }[],
): number {
  const sum = parts.reduce(
    (acc, p) => acc + (p.era.productivity * p.percent * p.era.population) / 10_000,
    0,
  );
  return Math.round(sum);
}

before(async () => {
  await runMapRegionSync();
  await runMapRegionEraStatsSync();
  await cleanup();

  eraSlug = await getStatsEraSlug();

  // 找兩個該時代人口差異夠大的地區，才能明確驗證「人口大→生產力大」。
  const eraRows = await db
    .select({
      regionId: mapRegionEraStatsTable.regionId,
      productivity: mapRegionEraStatsTable.productivity,
      population: mapRegionEraStatsTable.population,
      techPoints: mapRegionEraStatsTable.techPoints,
    })
    .from(mapRegionEraStatsTable)
    .where(eq(mapRegionEraStatsTable.era, eraSlug))
    .orderBy(sql`${mapRegionEraStatsTable.population} DESC`);
  assert.ok(eraRows.length >= 2, "需要至少兩個地區時代數值");
  regionA = eraRows[0]!; // 人口最大
  regionB = eraRows[eraRows.length - 1]!; // 人口最小
  assert.ok(
    regionA.population > regionB.population,
    "測試需要兩個人口不同的地區",
  );

  const [bigPop] = await db
    .insert(playerNationsTable)
    .values({ name: `${NATION_MARKER}big-${runId}`, leaderName: NATION_MARKER })
    .returning({ id: playerNationsTable.id });
  const [smallPop] = await db
    .insert(playerNationsTable)
    .values({ name: `${NATION_MARKER}small-${runId}`, leaderName: NATION_MARKER })
    .returning({ id: playerNationsTable.id });
  assert.ok(bigPop && smallPop, "nation insert failed");
  bigPopNationId = bigPop.id;
  smallPopNationId = smallPop.id;

  // 大國拿人口最大的地區 100%，小國拿人口最小的地區 100%。
  await db.insert(regionControlsTable).values([
    { regionId: regionA.regionId, nationId: bigPopNationId, percent: 100 },
    { regionId: regionB.regionId, nationId: smallPopNationId, percent: 100 },
  ]);
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("computeNationStats 生產力符合新公式（生產素質 × 控制人口 ÷ 10000）", async () => {
  const stats = await computeNationStats(bigPopNationId, eraSlug);
  assert.equal(
    stats.production,
    expectedProduction([{ era: regionA, percent: 100 }]),
    "生產力應等於新公式手算值",
  );
  // 人口／科技點數仍為舊的 percent 加權，未受本次改動影響。
  assert.equal(stats.population, Math.round(regionA.population * 1), "人口沿用舊算式");
  assert.equal(stats.techPerTurn, Math.round(regionA.techPoints * 1), "科技沿用舊算式");
});

test("部分控制時生產力按控制人口比例縮放", async () => {
  // 直接把大國的控制比例調成 40%，重新查驗。
  await db
    .update(regionControlsTable)
    .set({ percent: 40 })
    .where(
      and(
        eq(regionControlsTable.nationId, bigPopNationId),
        eq(regionControlsTable.regionId, regionA.regionId),
      ),
    );
  const stats = await computeNationStats(bigPopNationId, eraSlug);
  assert.equal(
    stats.production,
    expectedProduction([{ era: regionA, percent: 40 }]),
    "40% 控制的生產力應等於新公式手算值",
  );
  await db
    .update(regionControlsTable)
    .set({ percent: 100 })
    .where(
      and(
        eq(regionControlsTable.nationId, bigPopNationId),
        eq(regionControlsTable.regionId, regionA.regionId),
      ),
    );
});

test("人口大的國家生產力高於同控制比例但人口小的國家", async () => {
  const big = await computeNationStats(bigPopNationId, eraSlug);
  const small = await computeNationStats(smallPopNationId, eraSlug);
  assert.ok(
    big.production > small.production,
    `人口大國生產力(${big.production})應高於人口小國(${small.production})`,
  );
});
