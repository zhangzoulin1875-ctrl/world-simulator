import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { eq, isNull, sql } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  playerArmiesTable,
  militaryUnitTemplatesTable,
  regionBuildingsTable,
  mapRegionsTable,
  regionControlsTable,
} from "@workspace/db";
import { runGameMigrations } from "./gameMigrations";
import { runPoliticsMigrations } from "./politicsMigrations";
import { runMilitaryMigrations } from "./militaryMigrations";
import { runResourceMigrations } from "./resourceMigrations";
import {
  findOverchargedProductionNations,
  repairOverchargedProductionNation,
  runProductionSpentHealthTick,
} from "./productionSpentHealth";

/**
 * Task #560 — production_spent 幽靈佔用健檢的測試（真實資料庫）。
 *
 * 人工製造 spent > Σ(軍隊 reserved) + Σ(建築 reserved) 的國家，斷言：
 *  1. 掃描能找出超額國家與正確差額；健康／spent 偏低的國家不被誤報。
 *  2. 第一次 tick 只警告不修復（持續存在門檻）。
 *  3. 第二次 tick（上輪也被掃到）才下修到 Σ reserved。
 *  4. 鎖內複核：掃描後已被修正的國家不會被重複下修。
 *
 * 資料以 runId 尾碼標記、self-cleaning（只刪自己這輪的列，容忍與
 * test-integration 併行）。建築借用無人掌控的 map_regions（offset 300，
 * 避開其他測試的 0／80／120／250）。
 */

const TEST_TAG = "__prodspent560__";
const runId = randomBytes(4).toString("hex");
const tag = (name: string) => `${TEST_TAG}${runId}-${name}`;

const ARMY_RESERVED = 100;
const BUILDING_RESERVED = 200;
const GHOST_SPENT = 700; // 幽靈佔用 = 700 − 300 = 400

let ghostNationId: string;
let ghostUserId: string;
let healthyNationId: string;
let underNationId: string;
let regionGhostId: number;
let regionHealthyId: number;

async function cleanup(): Promise<void> {
  // 刪國家會 cascade 掉 armies（經 discord_user_id FK）與 buildings。
  await db
    .delete(militaryUnitTemplatesTable)
    .where(
      sql`${militaryUnitTemplatesTable.name} LIKE ${TEST_TAG + runId + "%"}`,
    );
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + runId + "%"}`);
}

async function getSpent(nationId: string): Promise<number> {
  const [row] = await db
    .select({ spent: playerNationsTable.productionSpent })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "nation must exist");
  return row.spent;
}

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await runMilitaryMigrations();
  await runResourceMigrations();

  await cleanup();

  // 借兩個無人掌控的地區放建築（offset 300 避開其他測試）。
  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(300)
    .limit(2);
  assert.ok(regions.length >= 2, "測試需要至少 2 個無人掌控的地區");
  regionGhostId = regions[0]!.id;
  regionHealthyId = regions[1]!.id;

  // 幽靈國家：spent 700，實際 Σ reserved = 100（軍隊）+ 200（建築）= 300。
  ghostUserId = tag("user");
  const [ghost] = await db
    .insert(playerNationsTable)
    .values({
      discordUserId: ghostUserId,
      name: tag("ghost"),
      leaderName: TEST_TAG,
      productionSpent: GHOST_SPENT,
    })
    .returning({ id: playerNationsTable.id });
  ghostNationId = ghost!.id;

  const [template] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ownerDiscordUserId: ghostUserId,
      name: tag("unit"),
      category: "infantry",
      hp: 10,
      attack: 5,
      defense: 5,
      speed: 1,
      accuracy: 50,
      range: "melee",
      prodCostPer100: 1,
      popCostPerUnit: 1,
      moneyCostPerUnit: 1,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  await db.insert(playerArmiesTable).values({
    discordUserId: ghostUserId,
    templateId: template!.id,
    quantity: 100,
    productionReserved: ARMY_RESERVED,
  });
  await db.insert(regionBuildingsTable).values({
    nationId: ghostNationId,
    regionId: regionGhostId,
    buildingType: "lumber_mill",
    level: 1,
    productionReserved: BUILDING_RESERVED,
  });

  // 健康國家：spent 恰等於建築 reserved（不變量成立，不得誤報）。
  const [healthy] = await db
    .insert(playerNationsTable)
    .values({
      name: tag("healthy"),
      leaderName: TEST_TAG,
      productionSpent: 150,
    })
    .returning({ id: playerNationsTable.id });
  healthyNationId = healthy!.id;
  await db.insert(regionBuildingsTable).values({
    nationId: healthyNationId,
    regionId: regionHealthyId,
    buildingType: "mine",
    level: 1,
    productionReserved: 150,
  });

  // spent 偏低的國家：這是開機 reconcile（往上補）的守備範圍，不得被本健檢誤報。
  const [under] = await db
    .insert(playerNationsTable)
    .values({
      name: tag("under"),
      leaderName: TEST_TAG,
      productionSpent: 40,
    })
    .returning({ id: playerNationsTable.id });
  underNationId = under!.id;
  await db.insert(regionBuildingsTable).values({
    nationId: underNationId,
    regionId: regionHealthyId,
    buildingType: "lumber_mill",
    level: 1,
    productionReserved: 100,
  });
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("findOverchargedProductionNations：找出幽靈佔用國家與正確差額", async () => {
  const flagged = await findOverchargedProductionNations();
  const hit = flagged.find((n) => n.nationId === ghostNationId);
  assert.ok(hit, "應找出 spent 偏高的國家");
  assert.equal(hit.productionSpent, GHOST_SPENT);
  assert.equal(hit.armyReserved, ARMY_RESERVED);
  assert.equal(hit.buildingReserved, BUILDING_RESERVED);
  assert.equal(hit.excess, GHOST_SPENT - ARMY_RESERVED - BUILDING_RESERVED);
  assert.equal(hit.discordUserId, ghostUserId);

  assert.ok(
    !flagged.some((n) => n.nationId === healthyNationId),
    "不變量成立的國家不得被誤報",
  );
  assert.ok(
    !flagged.some((n) => n.nationId === underNationId),
    "spent 偏低（往上補的守備範圍）不得被本健檢誤報",
  );
});

test("runProductionSpentHealthTick：第一次只警告、第二次才修復", async () => {
  // 第一次 tick：previouslyFlagged 為空 → 只記 warning、不動資料。
  const first = await runProductionSpentHealthTick(new Set());
  assert.ok(
    first.flagged.some((n) => n.nationId === ghostNationId),
    "第一次掃描應標記幽靈國家",
  );
  assert.ok(
    !first.repaired.some((n) => n.nationId === ghostNationId),
    "第一次不得修復",
  );
  assert.equal(await getSpent(ghostNationId), GHOST_SPENT, "spent 不得被動到");

  // 第二次 tick：上一輪也被掃到 → 下修到 Σ reserved。
  const second = await runProductionSpentHealthTick(
    new Set(first.flagged.map((n) => n.nationId)),
  );
  const repaired = second.repaired.find((n) => n.nationId === ghostNationId);
  assert.ok(repaired, "持續超額應被修復");
  assert.equal(repaired.repairedTo, ARMY_RESERVED + BUILDING_RESERVED);
  assert.equal(repaired.excess, GHOST_SPENT - ARMY_RESERVED - BUILDING_RESERVED);
  assert.equal(
    await getSpent(ghostNationId),
    ARMY_RESERVED + BUILDING_RESERVED,
    "spent 應下修到 Σ reserved",
  );

  // 修復後再掃：不再超額。
  const third = await findOverchargedProductionNations();
  assert.ok(!third.some((n) => n.nationId === ghostNationId));
});

test("repairOverchargedProductionNation：鎖內複核，已被修正的國家不重複下修", async () => {
  // 模擬「掃描時看到超額，但修復前已被其他路徑修正」：以過期的掃描結果呼叫修復。
  const stale = {
    nationId: ghostNationId,
    nationName: tag("ghost"),
    discordUserId: ghostUserId,
    productionSpent: GHOST_SPENT,
    armyReserved: ARMY_RESERVED,
    buildingReserved: BUILDING_RESERVED,
    excess: GHOST_SPENT - ARMY_RESERVED - BUILDING_RESERVED,
  };
  const result = await repairOverchargedProductionNation(stale);
  assert.equal(result, null, "鎖內複核已無超額 → 不動資料");
  assert.equal(
    await getSpent(ghostNationId),
    ARMY_RESERVED + BUILDING_RESERVED,
    "spent 不得被重複下修",
  );
});
