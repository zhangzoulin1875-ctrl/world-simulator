/**
 * Integration test（真實開發 DB，透過 test-integration workflow 執行）：
 * Task #418 — 軍力快照 recordNationMilitarySnapshots(gameDate)：
 *
 *  1. 同一 gameDate 重跑（回合補跑）→ 每國只留一列（upsert 覆寫，不重複）。
 *  2. 每國快照超過 MILITARY_SNAPSHOT_KEEP_PER_NATION → 修剪到上限、
 *     刪最舊留最新。
 *  3. 彙總值正確：
 *     - 玩家：player_armies（現役）＋ player_wounded_units（傷兵計入
 *       armyPopulation 與 woundedPopulation）＋ 軍團兵種列（quantity+wounded
 *       → committedPopulation）。
 *     - NPC：npc_armies（quantity+wounded → army、wounded → wounded、
 *       committed → committed）。
 *
 * 共用 DB 慣例：名稱前綴標記、自我清理（player_nations 只刪「本行程」的
 * marker，cascade 清掉 armies/wounded/wars/campaigns/snapshots/templates；
 * 另做 age-gated 的殘留清理）；測試 gameDate 用本行程隨機抽出的 19xx 年
 * （不會與真實回合日期相撞、也幾乎不會與並行行程相撞），after() 再整批
 * 刪掉「該年度」快照列，避免替其他開發國家留下髒資料。不動
 * world_game_state（直接呼叫純寫入函式，不經回合引擎）。
 *
 * 併發防護：驗證流程會同時跑 lib glob 與 test:integration（共用 dev DB），
 * 本檔在兩邊都有；且任何 recordNationMilitarySnapshots / forced-turn 都會
 * 替「所有」國家寫當時遊戲日期的快照列（觀察到 0401-01-01 之類的外部列）。
 * 因此：(1) 斷言一律過濾到本行程年度；(2) 清理不得用共用前綴硬刪、
 * 年度清理只動本行程年度；(3) 修剪數量斷言容忍外部較新列的擠壓。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the military-snapshot tests");
}

const { and, asc, eq, like, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerArmiesTable,
  playerWoundedUnitsTable,
  npcArmiesTable,
  militaryUnitTemplatesTable,
  nationMilitarySnapshotsTable,
  diplomacyWarsTable,
  warCampaignsTable,
  warCampaignLegionsTable,
  warCampaignLegionUnitsTable,
  mapRegionsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runMilitaryMigrations } = await import("./militaryMigrations");
const { runDiplomacyMigrations } = await import("./diplomacyMigrations");
const { runWarMigrations } = await import("./warMigrations");
const {
  recordNationMilitarySnapshots,
  MILITARY_SNAPSHOT_KEEP_PER_NATION,
} = await import("./militarySnapshots");

const MARKER = `milsnap_${randomBytes(4).toString("hex")}_`;
const PLAYER_USER = `${MARKER}user`;
/**
 * 測試專用遊戲日期年度：每個行程隨機抽 1900–1999（真實回合日期不會落在
 * 這個世紀；隨機年度讓並行的雙生行程幾乎不會共用同一年度）。
 */
const TEST_YEAR = String(1900 + (randomBytes(2).readUInt16BE(0) % 100));
const YEAR_START = `${TEST_YEAR}-01-01`;
const YEAR_END = `${TEST_YEAR}-12-31`;
const DATE_A = `${TEST_YEAR}-06-01`;

const PLAYER_POP_COST = 3;
const NPC_POP_COST = 2;

let playerNationId = "";
let npcNationId = "";
let playerTemplateId = 0;
let npcTemplateId = 0;

async function cleanup(): Promise<void> {
  // 只刪「本行程」的 marker 國家（cascade：armies/wounded/templates/wars/
  // campaigns/legions/snapshots）——不得用共用前綴硬刪，否則會把並行行程
  // 的活體資料連鎖刪掉。
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${MARKER}%`));
  // Age-gated 殘留清理：只刪 30 分鐘前建立的 milsnap_ 前綴國家（先前
  // 崩潰跑留下的），不會碰到並行行程的新鮮列。
  await db
    .delete(playerNationsTable)
    .where(
      sql`${playerNationsTable.name} LIKE 'milsnap_%'
          AND ${playerNationsTable.createdAt} < NOW() - INTERVAL '30 minutes'`,
    );
  // record 會替「所有」國家寫測試日期的快照列；整批刪掉「本行程年度」的列
  // （年度為本行程專屬，不會動到並行行程的年度）。
  await db
    .delete(nationMilitarySnapshotsTable)
    .where(
      sql`${nationMilitarySnapshotsTable.snapshotDate} >= ${YEAR_START}::date
          AND ${nationMilitarySnapshotsTable.snapshotDate} <= ${YEAR_END}::date`,
    );
}

/** 只取「本行程年度」的快照列：外部行程（forced-turn／雙生 lib glob）會替
 * 所有國家寫其他日期的列，不得混入斷言。 */
async function snapshotRows(nationId: string) {
  return db
    .select({
      snapshotDate: nationMilitarySnapshotsTable.snapshotDate,
      armyPopulation: nationMilitarySnapshotsTable.armyPopulation,
      woundedPopulation: nationMilitarySnapshotsTable.woundedPopulation,
      committedPopulation: nationMilitarySnapshotsTable.committedPopulation,
    })
    .from(nationMilitarySnapshotsTable)
    .where(
      and(
        eq(nationMilitarySnapshotsTable.nationId, nationId),
        sql`${nationMilitarySnapshotsTable.snapshotDate} >= ${YEAR_START}::date
            AND ${nationMilitarySnapshotsTable.snapshotDate} <= ${YEAR_END}::date`,
      ),
    )
    .orderBy(asc(nationMilitarySnapshotsTable.snapshotDate));
}

/** 本行程年度之後的外部列數（並行行程寫入且日期較新時會擠壓修剪配額）。 */
async function externalNewerCount(nationId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`COUNT(*)` })
    .from(nationMilitarySnapshotsTable)
    .where(
      and(
        eq(nationMilitarySnapshotsTable.nationId, nationId),
        sql`${nationMilitarySnapshotsTable.snapshotDate} > ${YEAR_END}::date`,
      ),
    );
  return Number(row?.n ?? 0);
}

before(async () => {
  await runGameMigrations();
  await runMilitaryMigrations();
  await runDiplomacyMigrations();
  await runWarMigrations();
  await cleanup();

  // 玩家國家（有 discord_user_id）與 NPC 國家。
  const [playerNation] = await db
    .insert(playerNationsTable)
    .values({ name: `${MARKER}玩家國`, discordUserId: PLAYER_USER })
    .returning({ id: playerNationsTable.id });
  playerNationId = playerNation!.id;
  const [npcNation] = await db
    .insert(playerNationsTable)
    .values({ name: `${MARKER}NPC國`, isNpc: true })
    .returning({ id: playerNationsTable.id });
  npcNationId = npcNation!.id;

  const baseTemplate = {
    category: "infantry",
    eraSlug: "classical",
    hp: 10,
    attack: 5,
    defense: 5,
    speed: 5,
    accuracy: 50,
    range: "melee",
    prodCostPer100: 1,
    moneyCostPerUnit: 1,
    upkeepPerUnit: 1,
    isDefault: false,
  } as const;
  const [playerTpl] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ...baseTemplate,
      name: `${MARKER}玩家步兵`,
      popCostPerUnit: PLAYER_POP_COST,
      ownerDiscordUserId: PLAYER_USER,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  playerTemplateId = playerTpl!.id;
  const [npcTpl] = await db
    .insert(militaryUnitTemplatesTable)
    .values({
      ...baseTemplate,
      name: `${MARKER}NPC步兵`,
      popCostPerUnit: NPC_POP_COST,
      ownerNationId: npcNationId,
    })
    .returning({ id: militaryUnitTemplatesTable.id });
  npcTemplateId = npcTpl!.id;

  // 玩家：現役 100（含前線）、全國傷兵池 10。
  await db.insert(playerArmiesTable).values({
    discordUserId: PLAYER_USER,
    templateId: playerTemplateId,
    quantity: 100,
  });
  await db.insert(playerWoundedUnitsTable).values({
    discordUserId: PLAYER_USER,
    templateId: playerTemplateId,
    wounded: 10,
  });

  // NPC：quantity 200（含前線抽調）、committed 50、恢復池 wounded 20。
  await db.insert(npcArmiesTable).values({
    nationId: npcNationId,
    templateId: npcTemplateId,
    quantity: 200,
    committed: 50,
    wounded: 20,
  });

  // 玩家前線：戰爭 → 戰役 → 軍團 → 兵種列（quantity 20 + wounded 5）。
  const regionRows = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .orderBy(mapRegionsTable.id)
    .limit(2);
  assert.ok(regionRows.length >= 2, "測試需要至少 2 個 map_regions");
  const [war] = await db
    .insert(diplomacyWarsTable)
    .values({
      // canonical pair 順序（diplomacy_wars_order_check：a < b）。
      nationAId: playerNationId < npcNationId ? playerNationId : npcNationId,
      nationBId: playerNationId < npcNationId ? npcNationId : playerNationId,
      declaredByNationId: playerNationId,
    })
    .returning({ id: diplomacyWarsTable.id });
  const [campaign] = await db
    .insert(warCampaignsTable)
    .values({
      warId: war!.id,
      attackerNationId: playerNationId,
      defenderNationId: npcNationId,
      attackerRegionId: regionRows[0]!.id,
      defenderRegionId: regionRows[1]!.id,
      nextResolveAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
    .returning({ id: warCampaignsTable.id });
  const [legion] = await db
    .insert(warCampaignLegionsTable)
    .values({ campaignId: campaign!.id, nationId: playerNationId, slot: "A" })
    .returning({ id: warCampaignLegionsTable.id });
  await db.insert(warCampaignLegionUnitsTable).values({
    legionId: legion!.id,
    templateId: playerTemplateId,
    quantity: 20,
    wounded: 5,
  });

  // NPC 軍團（含民兵補足）不得計入 committed（由 committed 欄位表示）——
  // 加一列 NPC 軍團兵種列，驗證會被 isNpc 過濾掉。
  const [npcLegion] = await db
    .insert(warCampaignLegionsTable)
    .values({ campaignId: campaign!.id, nationId: npcNationId, slot: "A" })
    .returning({ id: warCampaignLegionsTable.id });
  await db.insert(warCampaignLegionUnitsTable).values({
    legionId: npcLegion!.id,
    templateId: npcTemplateId,
    quantity: 999,
    wounded: 0,
  });
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("同一 gameDate 重跑回合 → 每國單列 upsert，且彙總值正確", async () => {
  await recordNationMilitarySnapshots(DATE_A);

  // 玩家：army = 100×3 + 傷兵 10×3 = 330；wounded = 30；
  // committed = 軍團 (20+5)×3 = 75。
  let playerRows = await snapshotRows(playerNationId);
  assert.equal(playerRows.length, 1, JSON.stringify(playerRows));
  assert.deepEqual(playerRows[0], {
    snapshotDate: DATE_A,
    armyPopulation: 330,
    woundedPopulation: 30,
    committedPopulation: 75,
  });

  // NPC：army = (200+20)×2 = 440；wounded = 20×2 = 40；
  // committed = 50×2 = 100（軍團民兵列 999 不得混入）。
  let npcRows = await snapshotRows(npcNationId);
  assert.equal(npcRows.length, 1, JSON.stringify(npcRows));
  assert.deepEqual(npcRows[0], {
    snapshotDate: DATE_A,
    armyPopulation: 440,
    woundedPopulation: 40,
    committedPopulation: 100,
  });

  // 模擬回合補跑：狀態變動後同日再跑一次 → 仍單列，值被覆寫成最新。
  await db
    .update(playerArmiesTable)
    .set({ quantity: 150 })
    .where(
      and(
        eq(playerArmiesTable.discordUserId, PLAYER_USER),
        eq(playerArmiesTable.templateId, playerTemplateId),
      ),
    );
  await recordNationMilitarySnapshots(DATE_A);

  playerRows = await snapshotRows(playerNationId);
  assert.equal(playerRows.length, 1, "同日重跑不得多寫列");
  assert.deepEqual(playerRows[0], {
    snapshotDate: DATE_A,
    armyPopulation: 480, // 150×3 + 10×3
    woundedPopulation: 30,
    committedPopulation: 75,
  });

  npcRows = await snapshotRows(npcNationId);
  assert.equal(npcRows.length, 1, "同日重跑不得多寫 NPC 列");
  assert.equal(npcRows[0]!.armyPopulation, 440);
});

test("超過每國保留上限 → 修剪到上限、刪最舊留最新", async () => {
  const keep = MILITARY_SNAPSHOT_KEEP_PER_NATION;
  // 預灌 keep+5 筆舊快照（TEST_YEAR-01-01 起連續日期，由 date 運算展開）。
  const values = [];
  for (let i = 0; i < keep + 5; i++) {
    const d = new Date(Date.UTC(Number(TEST_YEAR), 0, 1 + i));
    values.push({
      nationId: playerNationId,
      snapshotDate: d.toISOString().slice(0, 10),
      armyPopulation: i,
    });
  }
  // 併發防護：外部行程的 record 會「全域」修剪所有國家；若在預灌與計數
  // 之間跑到，會把本國列剪回 keep。重灌重數（幂等 onConflictDoNothing），
  // 視窗極小，數次即收斂。
  let beforeCount = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    await db
      .insert(nationMilitarySnapshotsTable)
      .values(values)
      .onConflictDoNothing();
    beforeCount = (await snapshotRows(playerNationId)).length;
    if (beforeCount > keep) break;
  }
  assert.ok(beforeCount > keep, `預灌後應超過上限（實際 ${beforeCount}）`);

  await recordNationMilitarySnapshots(DATE_A);

  // 併發防護：並行行程可能替本國寫入「較新日期」的外部列，佔掉修剪配額，
  // 使本年度剩餘列比 keep 少；以外部較新列數放寬下界（上界仍為 keep）。
  const rows = await snapshotRows(playerNationId);
  const newerExternal = await externalNewerCount(playerNationId);
  assert.ok(
    rows.length <= keep && rows.length >= keep - newerExternal,
    `修剪後本年度應剩 ${keep} 列（容忍 ${newerExternal} 列外部較新列擠壓，實際 ${rows.length}）`,
  );
  // 留下的是最新的 keep 列：最舊那批（1 月初）被刪、DATE_A（6 月）仍在。
  const dates = rows.map((r) => r.snapshotDate);
  assert.ok(dates.includes(DATE_A), "最新日期必須保留");
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted, "查詢已按日期排序");
  assert.ok(
    sorted[0]! > `${TEST_YEAR}-01-05`,
    `最舊的列應被刪除（實際最舊 ${sorted[0]}）`,
  );

  // NPC 國家未超額 → 不受修剪影響（仍有 DATE_A 一列）。
  const npcRows = await snapshotRows(npcNationId);
  assert.ok(
    npcRows.some((r) => r.snapshotDate === DATE_A),
    "未超額國家的快照不得被誤刪",
  );
});
