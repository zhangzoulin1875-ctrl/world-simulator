/**
 * Task #58 — GET /api/map/political 新增欄位（flagUrl / government / 大略人口）
 * 整合測試。鎖住三件事：
 *
 *  1. 每國序列化含 flagUrl（可為 null）、government（可為 null）、population（整數）。
 *  2. 大略人口 = Σ(控制比例/100 × 該數據時代地區人口 + 該地區累積量)，取整數、下限 0。
 *  3. 端點防呆：某地區在該時代缺 era-stats 時只是不計入該地區人口，不會整頁掛掉；
 *     地區累積量為大負值時人口夾在 0（Task #322，累積量改掛在 region_controls）。
 *
 * 走真正的 Express 端點（公開，不需 session）。需要 DATABASE_URL 指向已由正常
 * 伺服器啟動遷移過的資料庫。資料以 `__mappoltest__` 前綴標記，跑前跑後自清，
 * 可重複執行：`pnpm --filter @workspace/api-server run test:integration`。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the map political tests");
}

const express = (await import("express")).default;
const { and, eq, isNull, like } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  mapRegionEraStatsTable,
  playerArmiesTable,
  playerWoundedUnitsTable,
  militaryUnitTemplatesTable,
  techTreeNodesTable,
  playerResearchedTreeNodesTable,
} = await import("@workspace/db");
const { runMapRegionSync } = await import("../lib/mapRegions");
const { runMapRegionEraStatsSync } = await import("../lib/mapRegionEraStats");
const { getStatsEraSlug } = await import("../lib/nationStats");
const mapRouter = (await import("./mapRegions")).default;

const NATION_MARKER = "__mappoltest__";
const runId = randomBytes(4).toString("hex");

let server: http.Server;
let baseUrl: string;
let eraSlug: string;
let flaggedNationId: string;
let plainNationId: string;
let clampNationId: string;
let armyNationId: string;
let techNationId: string;
// Task #388 — 軍隊人口數 = Σ(數量 × popCostPerUnit)＋傷兵池同法折算。
// 現役：步兵 100×2 + 射手 50×3 = 350；傷兵：步兵 10×2 = 20 → 370。
const expectedArmyPop = 100 * 2 + 50 * 3 + 10 * 2;
// tech 國家同編制（popCostPerUnit 皆 1）、已研發攻擊 +100% 科技：
// 軍隊人口數不受科技加成影響，仍為 100×1 + 50×1 = 150。
const expectedTechArmyPop = 100 * 1 + 50 * 1;
let regionAId: number;
let regionBId: number;
let regionAPop: number;
let regionBPop: number;

async function cleanup() {
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${NATION_MARKER}%`));
  // Task #300／#469 — 全域科技樹節點不隨國家 cascade，需依名稱標記自清。
  await db
    .delete(techTreeNodesTable)
    .where(like(techTreeNodesTable.name, `${NATION_MARKER}%`));
}

interface PoliticalNation {
  id: string;
  name: string | null;
  isNpc: boolean;
  isUnowned: boolean;
  flagUrl: string | null;
  government: string | null;
  population: number;
  armyPopulation: number;
  money: number;
  techPoints: number;
}

async function fetchPolitical(): Promise<{ nations: PoliticalNation[] }> {
  const res = await fetch(`${baseUrl}/api/map/political`);
  assert.equal(res.status, 200, "端點應回 200");
  return (await res.json()) as { nations: PoliticalNation[] };
}

before(async () => {
  await runMapRegionSync();
  await runMapRegionEraStatsSync();
  await cleanup();

  eraSlug = await getStatsEraSlug();

  // 借用兩個目前無人掌控的地區（offset 150 避開其他共用 dev DB 的整合測試）。
  const freeRegions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(150)
    .limit(2);
  assert.ok(freeRegions.length >= 2, "測試需要至少 2 個無人掌控的地區");
  regionAId = freeRegions[0]!.id;
  regionBId = freeRegions[1]!.id;

  const eraStats = await db
    .select({
      regionId: mapRegionEraStatsTable.regionId,
      population: mapRegionEraStatsTable.population,
    })
    .from(mapRegionEraStatsTable)
    .where(
      and(
        eq(mapRegionEraStatsTable.era, eraSlug),
        eq(mapRegionEraStatsTable.regionId, regionAId),
      ),
    );
  regionAPop = Number(eraStats[0]?.population ?? 0);
  const eraStatsB = await db
    .select({ population: mapRegionEraStatsTable.population })
    .from(mapRegionEraStatsTable)
    .where(
      and(
        eq(mapRegionEraStatsTable.era, eraSlug),
        eq(mapRegionEraStatsTable.regionId, regionBId),
      ),
    );
  regionBPop = Number(eraStatsB[0]?.population ?? 0);

  const [flagged] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}-flag-${runId}`,
      leaderName: NATION_MARKER,
      flagUrl: "/api/storage/images/flag-test",
      government: "君主專制",
      // Task #302 — 金錢／科技點數應原樣序列化供國情面板比較。
      money: 123_456,
      techPoints: 7_890,
    })
    .returning({ id: playerNationsTable.id });
  flaggedNationId = flagged!.id;

  const [plain] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}-plain-${runId}`,
      leaderName: NATION_MARKER,
      // flagUrl / government 皆 null（退回僅顯示國名／未定政體）。
    })
    .returning({ id: playerNationsTable.id });
  plainNationId = plain!.id;

  // 人口下限測試：巨額負的「地區累積量」應把大略人口夾在 0（Task #322）。
  const [clamp] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}-clamp-${runId}`,
      leaderName: NATION_MARKER,
    })
    .returning({ id: playerNationsTable.id });
  clampNationId = clamp!.id;

  // Task #293 — 有常備軍的玩家國家：綁定 discordUserId 才能掛 player_armies。
  const armyUid = `${NATION_MARKER}-uid-${runId}`;
  const [army] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}-army-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: armyUid,
    })
    .returning({ id: playerNationsTable.id });
  armyNationId = army!.id;

  // 兩個自訂兵種（綁定該玩家；popCostPerUnit 各異以鎖住加權聚合）。
  const templates = await db
    .insert(militaryUnitTemplatesTable)
    .values([
      {
        ownerDiscordUserId: armyUid,
        category: "infantry",
        name: `${NATION_MARKER}-t1-${runId}`,
        hp: 20,
        attack: 10,
        defense: 5,
        speed: 1,
        accuracy: 50,
        range: "melee",
        prodCostPer100: 1,
        popCostPerUnit: 2,
        moneyCostPerUnit: 1,
      },
      {
        ownerDiscordUserId: armyUid,
        category: "ranged",
        name: `${NATION_MARKER}-t2-${runId}`,
        hp: 14,
        attack: 8,
        defense: 8,
        speed: 1,
        accuracy: 50,
        range: "ranged",
        prodCostPer100: 1,
        popCostPerUnit: 3,
        moneyCostPerUnit: 1,
      },
    ])
    .returning({ id: militaryUnitTemplatesTable.id });
  await db.insert(playerArmiesTable).values([
    { discordUserId: armyUid, templateId: templates[0]!.id, quantity: 100 },
    { discordUserId: armyUid, templateId: templates[1]!.id, quantity: 50 },
  ]);
  // Task #388 — 傷兵仍屬軍隊編制：傷兵池也以 popCostPerUnit 折算計入。
  await db.insert(playerWoundedUnitsTable).values({
    discordUserId: armyUid,
    templateId: templates[0]!.id,
    wounded: 10,
  });

  // Task #300 — 同編制但已研發「攻擊 +100%」科技的國家，用來鎖住軍隊人口數
  // 不受科技加成影響（科技只改攻防，不改人口占用）。
  const techUid = `${NATION_MARKER}-techuid-${runId}`;
  const [techNation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${NATION_MARKER}-tech-${runId}`,
      leaderName: NATION_MARKER,
      discordUserId: techUid,
    })
    .returning({ id: playerNationsTable.id });
  techNationId = techNation!.id;

  const techTemplates = await db
    .insert(militaryUnitTemplatesTable)
    .values([
      {
        ownerDiscordUserId: techUid,
        category: "infantry",
        name: `${NATION_MARKER}-tt1-${runId}`,
        hp: 20,
        attack: 10,
        defense: 5,
        speed: 1,
        accuracy: 50,
        range: "melee",
        prodCostPer100: 1,
        popCostPerUnit: 1,
        moneyCostPerUnit: 1,
      },
      {
        ownerDiscordUserId: techUid,
        category: "ranged",
        name: `${NATION_MARKER}-tt2-${runId}`,
        hp: 14,
        attack: 8,
        defense: 8,
        speed: 1,
        accuracy: 50,
        range: "ranged",
        prodCostPer100: 1,
        popCostPerUnit: 1,
        moneyCostPerUnit: 1,
      },
    ])
    .returning({ id: militaryUnitTemplatesTable.id });
  await db.insert(playerArmiesTable).values([
    { discordUserId: techUid, templateId: techTemplates[0]!.id, quantity: 100 },
    { discordUserId: techUid, templateId: techTemplates[1]!.id, quantity: 50 },
  ]);

  // 全兵種攻擊 +100% 的軍事科技樹節點（測試專用支線），並讓 tech 國家研發之。
  const [tech] = await db
    .insert(techTreeNodesTable)
    .values({
      domain: "military",
      eraSlug,
      lineKey: `${NATION_MARKER}-line-${runId}`,
      lineLabel: `${NATION_MARKER}測試線`,
      lineKind: "branch",
      sortOrder: 1,
      name: `${NATION_MARKER}-attack-${runId}`,
      description: NATION_MARKER,
      baseCost: 1,
      effects: [{ target: "attack", category: null, pct: 100 }],
    })
    .returning({ id: techTreeNodesTable.id });
  await db
    .insert(playerResearchedTreeNodesTable)
    .values({ nationId: techNationId, nodeId: tech!.id });

  // 掌控地區：flagged 拿 region A 60%、region B 40%；plain 拿 region A 40%；
  // clamp 拿 region B 50%（會被負累積量夾到 0）；army 拿 region B 10%。
  // Task #322 — 累積人口成長量掛在地區上：flagged 的 +1000 放在 region A
  // （保有 era-stats，供缺列測試驗證仍計入），clamp 的巨額負值放在 region B。
  await db.insert(regionControlsTable).values([
    {
      regionId: regionAId,
      nationId: flaggedNationId,
      percent: 60,
      populationBonus: 1000,
    },
    { regionId: regionBId, nationId: flaggedNationId, percent: 40 },
    { regionId: regionAId, nationId: plainNationId, percent: 40 },
    {
      regionId: regionBId,
      nationId: clampNationId,
      percent: 50,
      populationBonus: -999_999_999_999,
    },
    { regionId: regionBId, nationId: armyNationId, percent: 10 },
  ]);

  const app = express();
  app.use("/api", mapRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await cleanup();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
});

test("每國序列化含 flagUrl／government／整數 population", async () => {
  const { nations } = await fetchPolitical();
  const flagged = nations.find((n) => n.id === flaggedNationId);
  const plain = nations.find((n) => n.id === plainNationId);
  assert.ok(flagged, "應回傳有國旗的國家");
  assert.ok(plain, "應回傳無國旗的國家");

  assert.equal(flagged.flagUrl, "/api/storage/images/flag-test");
  assert.equal(flagged.government, "君主專制");
  assert.ok(Number.isInteger(flagged.population));

  // 無國旗國家退回 null（前端僅顯示國名），government 亦為 null。
  assert.equal(plain.flagUrl, null);
  assert.equal(plain.government, null);
  assert.ok(Number.isInteger(plain.population));
});

test("每國序列化含整數 money／techPoints（Task #302）", async () => {
  const { nations } = await fetchPolitical();
  const flagged = nations.find((n) => n.id === flaggedNationId)!;
  const plain = nations.find((n) => n.id === plainNationId)!;

  // 明確設定的金錢／科技點數應原樣回傳。
  assert.equal(flagged.money, 123_456);
  assert.equal(flagged.techPoints, 7_890);

  // 未設定者採欄位預設（money 預設 10000、techPoints 預設 0），皆為整數、下限 0。
  assert.ok(Number.isInteger(plain.money) && plain.money >= 0);
  assert.ok(Number.isInteger(plain.techPoints) && plain.techPoints >= 0);
});

test("大略人口 = Σ(控制比例 × 該時代地區人口 + 地區累積量)", async () => {
  const { nations } = await fetchPolitical();
  const flagged = nations.find((n) => n.id === flaggedNationId)!;
  const plain = nations.find((n) => n.id === plainNationId)!;

  const expectedFlagged =
    Math.round((60 * regionAPop) / 100 + (40 * regionBPop) / 100) + 1000;
  const expectedPlain = Math.round((40 * regionAPop) / 100);

  assert.equal(flagged.population, Math.max(0, expectedFlagged));
  assert.equal(plain.population, Math.max(0, expectedPlain));
});

test("地區累積量大負值時人口夾在 0（不為負）", async () => {
  const { nations } = await fetchPolitical();
  const clamp = nations.find((n) => n.id === clampNationId)!;
  assert.equal(clamp.population, 0);
});

test("某地區在該時代缺 era-stats 時只是不計入該地區人口，不整頁掛掉", async () => {
  // 刪掉 flagged 所控 region B 於當前數據時代的 era-stats，模擬缺列情境。
  await db
    .delete(mapRegionEraStatsTable)
    .where(
      and(
        eq(mapRegionEraStatsTable.era, eraSlug),
        eq(mapRegionEraStatsTable.regionId, regionBId),
      ),
    );
  try {
    const { nations } = await fetchPolitical();
    const flagged = nations.find((n) => n.id === flaggedNationId)!;
    // region B 已無 era-stats → 只剩 region A 60% 貢獻，仍為整數且不為負。
    const expected = Math.round((60 * regionAPop) / 100) + 1000;
    assert.ok(Number.isInteger(flagged.population));
    assert.equal(flagged.population, Math.max(0, expected));
  } finally {
    // 還原 era-stats，避免污染共用 dev DB（下次 sync 會重建，但這裡先補回）。
    await runMapRegionEraStatsSync();
  }
});

test("軍隊人口數 = Σ(部隊數量 × popCostPerUnit)＋傷兵池折算，整數", async () => {
  const { nations } = await fetchPolitical();
  const army = nations.find((n) => n.id === armyNationId)!;
  assert.ok(Number.isInteger(army.armyPopulation));
  assert.equal(army.armyPopulation, expectedArmyPop);
});

test("無常備軍的國家 armyPopulation 為 0", async () => {
  const { nations } = await fetchPolitical();
  const plain = nations.find((n) => n.id === plainNationId)!;
  const flagged = nations.find((n) => n.id === flaggedNationId)!;
  assert.equal(plain.armyPopulation, 0);
  assert.equal(flagged.armyPopulation, 0);
});

test("軍隊人口數不受已研發軍事科技加成影響（科技只改攻防）", async () => {
  const { nations } = await fetchPolitical();
  const tech = nations.find((n) => n.id === techNationId)!;
  assert.ok(Number.isInteger(tech.armyPopulation));
  // 有研發「攻擊 +100%」科技者，軍隊人口數仍只依 popCostPerUnit 折算。
  assert.equal(tech.armyPopulation, expectedTechArmyPop);
});

test("不外洩 discordUserId 等私有欄位", async () => {
  const res = await fetch(`${baseUrl}/api/map/political`);
  const text = await res.text();
  assert.ok(
    !text.includes("discordUserId") && !text.includes("discord_user_id"),
    "回應不得含 discordUserId",
  );
});
