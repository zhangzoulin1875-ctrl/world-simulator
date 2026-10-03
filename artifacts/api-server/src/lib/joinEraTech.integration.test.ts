/**
 * Integration test（真實開發 DB，透過 test-integration workflow 執行）：
 * 驗證 grantJoinEraKeyTechsToPlayer 依世界時代自動補齊「前一代以前」的科技樹
 * 節點（主幹線＋關鍵科技）、把三領域時代設為世界時代、且不授予當下時代的節點，
 * 並具冪等性（Task #469 全球統一線性科技樹版）。
 *
 * 樣式沿用其他整合測試：before() 跑啟動遷移、以名稱前綴標記測試列、after() 清理 +
 * pool.end()。科技樹狀態／研發紀錄（Task #481 改鍵 nation_id）FK REFERENCES
 * player_nations(id) ON DELETE CASCADE，故只需刪 player_nations 前綴列即連帶清除。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

const { eq, like } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerResearchedTreeNodesTable,
  playerTechTreeStateTable,
  techTreeNodesTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("../lib/gameMigrations");
const { runTechTreeMigrations } = await import("../lib/techTreeMigrations");
const { grantJoinEraKeyTechsToPlayer } = await import("../lib/keyTechAdmin");
const { getEraIndex, isEraSlug } = await import("../lib/mapRegionEras");

const MARKER = `jetest_${randomBytes(4).toString("hex")}_`;
const USER_ID = `${MARKER}user`;
const WORLD_ERA = "renaissance"; // idx 4 → 前四代（classical..high_medieval）應補齊

let nationId: string;

async function cleanup(): Promise<void> {
  // FK ON DELETE CASCADE 從 player_nations.discord_user_id 連帶清除所有子表。
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.discordUserId, `${MARKER}%`));
}

before(async () => {
  await runGameMigrations();
  await runTechTreeMigrations();
  await cleanup();
  const [created] = await db
    .insert(playerNationsTable)
    .values({
      discordUserId: USER_ID,
      name: `${MARKER}國`,
      leaderName: `${MARKER}君`,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(created, "failed to create test nation");
  nationId = created.id;
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("grants all pre-world-era main-line + key nodes, sets domain eras, excludes current era", async () => {
  await db.transaction((tx) =>
    grantJoinEraKeyTechsToPlayer(tx, nationId, WORLD_ERA),
  );

  // 三領域時代皆設為世界時代。
  const states = await db
    .select({
      domain: playerTechTreeStateTable.domain,
      eraSlug: playerTechTreeStateTable.eraSlug,
    })
    .from(playerTechTreeStateTable)
    .where(eq(playerTechTreeStateTable.nationId, nationId));
  assert.equal(states.length, 3, "應為三領域各建立一列狀態");
  for (const s of states) {
    assert.equal(s.eraSlug, WORLD_ERA, `領域 ${s.domain} 時代應為 ${WORLD_ERA}`);
  }

  // 期望授予集合：時代嚴格早於世界時代的（主幹線 ∪ 關鍵科技）節點。
  const worldIdx = getEraIndex(WORLD_ERA);
  const allNodes = await db
    .select({
      id: techTreeNodesTable.id,
      eraSlug: techTreeNodesTable.eraSlug,
      lineKind: techTreeNodesTable.lineKind,
      keySlug: techTreeNodesTable.keySlug,
    })
    .from(techTreeNodesTable);
  const expectedIds = new Set(
    allNodes
      .filter(
        (n) =>
          isEraSlug(n.eraSlug) &&
          getEraIndex(n.eraSlug) < worldIdx &&
          (n.lineKind === "main" || n.keySlug !== null),
      )
      .map((n) => n.id),
  );
  assert.ok(expectedIds.size > 0, "測試前提——世界時代前應有主幹線節點");

  const grantedRows = await db
    .select({ nodeId: playerResearchedTreeNodesTable.nodeId })
    .from(playerResearchedTreeNodesTable)
    .where(eq(playerResearchedTreeNodesTable.nationId, nationId));
  const grantedIds = new Set(grantedRows.map((r) => r.nodeId));

  assert.deepEqual(
    [...grantedIds].sort((a, b) => a - b),
    [...expectedIds].sort((a, b) => a - b),
    "授予的節點應恰為世界時代前的主幹線＋關鍵科技節點",
  );

  // 當下世界時代（renaissance）的節點不得被授予。
  const currentEraIds = allNodes
    .filter((n) => n.eraSlug === WORLD_ERA)
    .map((n) => n.id);
  for (const id of currentEraIds) {
    assert.ok(
      !grantedIds.has(id),
      `不應授予當下時代 ${WORLD_ERA} 的節點（node ${id}）`,
    );
  }
});

test("is idempotent: re-running grants no duplicates and keeps domain eras", async () => {
  const beforeRows = await db
    .select({ nodeId: playerResearchedTreeNodesTable.nodeId })
    .from(playerResearchedTreeNodesTable)
    .where(eq(playerResearchedTreeNodesTable.nationId, nationId));

  await db.transaction((tx) =>
    grantJoinEraKeyTechsToPlayer(tx, nationId, WORLD_ERA),
  );

  const afterRows = await db
    .select({ nodeId: playerResearchedTreeNodesTable.nodeId })
    .from(playerResearchedTreeNodesTable)
    .where(eq(playerResearchedTreeNodesTable.nationId, nationId));
  assert.equal(afterRows.length, beforeRows.length, "重複授予不應新增重複列");

  const states = await db
    .select({ eraSlug: playerTechTreeStateTable.eraSlug })
    .from(playerTechTreeStateTable)
    .where(eq(playerTechTreeStateTable.nationId, nationId));
  assert.equal(states.length, 3);
  for (const s of states) {
    assert.equal(s.eraSlug, WORLD_ERA);
  }
});
