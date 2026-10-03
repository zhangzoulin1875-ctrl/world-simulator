/**
 * 回合引擎：領土歸零（被完全征服）的 NPC 國家自動除名整合測試。
 *
 * 驗證 runNpcExtinctionCheck()：
 *   1. is_npc=true 且無任何 region_controls 掌控（領土歸零）的 NPC → 硬刪，
 *      其進行中戰爭列 cascade 消失（＝與各國停戰），交戰中的真人對手收到
 *      「戰爭結束：敵國已滅亡」站內通知。
 *   2. is_npc=true 但仍有領土的 NPC → 不受影響。
 *   3. 無主國家（is_npc=false、discord_user_id NULL）即使零領土 → 保留。
 *   4. 真人玩家國家 → 永不自動除名。
 *
 * 測試資料自成一體（名稱前綴標記、cascade 自清），只借用無人掌控的
 * map_regions（offset 250，避開其他整合測試 0/80/120/150/160/170/200/230）。
 * 注意：runNpcExtinctionCheck 為全域掃描，斷言只針對本測試專屬國家 id，
 * 不依賴全域計數，故不受 dev DB 其他 NPC 影響。跑法：test-integration workflow。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the npc-extinction tests");
}

const { eq, isNull } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  diplomacyWarsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runDiplomacyMigrations } = await import("./diplomacyMigrations");
// player_nations 的 satisfaction_* 欄位由政治遷移補上（idempotent）。
const { runPoliticsMigrations } = await import("./politicsMigrations");
const { canonicalPair } = await import("./diplomacy");
const { runNpcExtinctionCheck } = await import("./npcExtinction");
const { __setPersistDepForTest } = await import("./diplomacyNotify");

const TEST_TAG = "__npcextinction__";
const runId = randomBytes(4).toString("hex");
const PLAYER_DISCORD = `${TEST_TAG}${runId}`;

let extinctNpcId: string; // is_npc=true、零領土 → 應被除名
let survivorNpcId: string; // is_npc=true、有領土 → 應保留
let playerId: string; // 真人玩家、與 extinctNpc 交戰 → 應保留、收到通知
let ownerlessId: string; // is_npc=false、零領土（無主）→ 應保留
let warId: number;
let survivorRegionId: number;

interface CapturedNotif {
  discordUserId: string | null;
  title: string;
}
const captured: CapturedNotif[] = [];

async function nationExists(id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, id));
  return !!row;
}

before(async () => {
  // 站內通知改為 spy：捕捉本測試觸發的通知，並避免在共用 dev DB 留下真實通知列。
  __setPersistDepForTest((n) => {
    captured.push({ discordUserId: n.discordUserId, title: n.title });
  });

  await runGameMigrations();
  await runDiplomacyMigrations();
  await runPoliticsMigrations();

  // 清掉先前殘留的測試資料（若上次執行中斷）。
  await db
    .delete(playerNationsTable)
    .where(eq(playerNationsTable.name, `${TEST_TAG}extinct-${runId}`));

  const [extinct] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}extinct-${runId}`,
      leaderName: TEST_TAG,
      isNpc: true,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(extinct, "extinct npc insert failed");
  extinctNpcId = extinct.id;

  const [survivor] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}survivor-${runId}`,
      leaderName: TEST_TAG,
      isNpc: true,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(survivor, "survivor npc insert failed");
  survivorNpcId = survivor.id;

  const [player] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}player-${runId}`,
      leaderName: TEST_TAG,
      isNpc: false,
      discordUserId: PLAYER_DISCORD,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(player, "player nation insert failed");
  playerId = player.id;

  const [ownerless] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}ownerless-${runId}`,
      leaderName: TEST_TAG,
      isNpc: false, // 無主：is_npc=false 且 discord_user_id NULL
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(ownerless, "ownerless nation insert failed");
  ownerlessId = ownerless.id;

  // 借用一個無人掌控的地區給 survivor（offset 250 避開其他整合測試）。
  const [region] = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(250)
    .limit(1);
  assert.ok(region, "測試需要至少 1 個無人掌控的地區");
  survivorRegionId = region.id;
  await db
    .insert(regionControlsTable)
    .values({ regionId: survivorRegionId, nationId: survivorNpcId, percent: 100 });

  // extinctNpc ↔ player 的進行中戰爭（canonical pair）。
  const { low, high } = canonicalPair(extinctNpcId, playerId);
  const [war] = await db
    .insert(diplomacyWarsTable)
    .values({ nationAId: low, nationBId: high, declaredByNationId: extinctNpcId })
    .returning({ id: diplomacyWarsTable.id });
  assert.ok(war, "test war insert failed");
  warId = war.id;
});

after(async () => {
  __setPersistDepForTest(null);
  await db
    .delete(regionControlsTable)
    .where(eq(regionControlsTable.nationId, survivorNpcId));
  await db
    .delete(playerNationsTable)
    .where(eq(playerNationsTable.name, `${TEST_TAG}extinct-${runId}`));
  await db
    .delete(playerNationsTable)
    .where(eq(playerNationsTable.name, `${TEST_TAG}survivor-${runId}`));
  await db
    .delete(playerNationsTable)
    .where(eq(playerNationsTable.name, `${TEST_TAG}player-${runId}`));
  await db
    .delete(playerNationsTable)
    .where(eq(playerNationsTable.name, `${TEST_TAG}ownerless-${runId}`));
  await pool.end();
});

test("零領土 NPC 被除名、戰爭 cascade 消失、真人對手收到通知；有領土 NPC／無主／玩家保留", async () => {
  captured.length = 0;

  const summary = await runNpcExtinctionCheck();

  // 除名摘要至少包含本測試的 extinctNpc。
  assert.ok(
    summary.deletedNations.some((n) => n.id === extinctNpcId),
    "摘要應列出被除名的 extinctNpc",
  );

  // 1. 零領土 NPC 被硬刪。
  assert.equal(
    await nationExists(extinctNpcId),
    false,
    "領土歸零的 NPC 應被除名",
  );

  // 進行中戰爭列 cascade 消失（＝與各國停戰）。
  const [warRow] = await db
    .select({ id: diplomacyWarsTable.id })
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, warId));
  assert.equal(warRow, undefined, "被除名 NPC 的戰爭列應 cascade 消失");

  // 交戰中的真人對手收到「敵國滅亡」通知。
  assert.ok(
    captured.some(
      (c) =>
        c.discordUserId === PLAYER_DISCORD &&
        c.title === "戰爭結束：敵國已滅亡",
    ),
    "真人對手應收到戰爭結束通知",
  );

  // 2. 有領土的 NPC 保留（掌控不動）。
  assert.equal(await nationExists(survivorNpcId), true, "有領土的 NPC 應保留");
  const [ctrl] = await db
    .select({ percent: regionControlsTable.percent })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.nationId, survivorNpcId));
  assert.equal(ctrl?.percent, 100, "有領土 NPC 的掌控不應被更動");

  // 3. 無主國家（零領土）保留。
  assert.equal(
    await nationExists(ownerlessId),
    true,
    "無主國家即使零領土也應保留",
  );

  // 4. 真人玩家保留。
  assert.equal(await nationExists(playerId), true, "真人玩家應永不被自動除名");
});
