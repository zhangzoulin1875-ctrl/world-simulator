/**
 * Task #215 — 整合測試（真實資料庫）：聯盟（alliances）的併發保護。
 * 多聯盟制（一國可屬多個聯盟）語意：
 *
 *  1. 同一國家同時建立兩個聯盟 → 兩者皆成功（多聯盟制不再互斥）；
 *     alliance_members 對該國恰兩列，且分屬兩個聯盟。
 *  2. 同一國家同時加入兩個不同聯盟 → 兩者皆成功；
 *     同時重複加入「同一個」聯盟 → 恰好一個成功、另一個 already_member
 *     （複合唯一索引 alliance_id+nation_id + 建議鎖）。
 *
 * Task #569 — 原第 3 項「convertAllianceTreatiesToAlliances 一次性遷移」測試
 * 已退役：該遷移已在 prod 套用（game_flags 有 alliance-treaties-converted），
 * 使命完成；且該測試需清旗標重跑 runDiplomacyMigrations，與測試回合的遷移
 * 戳記快速路徑（MIGRATION_TEST_RUN_ID）衝突。
 *
 * 需要 DATABASE_URL 指向已由正常啟動遷移過的資料庫。所有列以識別前綴標記，
 * 執行前後皆清理，可重複執行：
 *   `pnpm --filter @workspace/api-server run test:integration`
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, like, sql, type SQL } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  alliancesTable,
  allianceMembersTable,
} from "@workspace/db";
import { runDiplomacyMigrations } from "./diplomacyMigrations";
import {
  createAlliance,
  joinAlliance,
  getNationAllianceIds,
} from "./alliances";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the alliance race tests");
}

// pid 後綴：lib glob 與 test-integration 併發跑同一檔時，各行程資料互不碰撞
// （固定前綴會讓一方的 cleanup 連鎖刪掉另一方的活資料／聯盟名重複）。
const TAG_PREFIX = "__alliancerace";
const TAG = `${TAG_PREFIX}_${process.pid}_`;

async function createNation(label: string): Promise<string> {
  const [row] = await db
    .insert(playerNationsTable)
    .values({ name: `${TAG}${label}`, leaderName: TAG })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function cleanupWhere(cond: SQL): Promise<void> {
  // 刪除測試國家會 cascade 掉 alliance_members / diplomacy_treaties。
  const nations = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(cond);
  const ids = nations.map((n) => n.id);
  if (ids.length > 0) {
    // 明確刪 alliances（founder 指向測試國，且 alliances 無 cascade 自 nation）。
    await db
      .delete(alliancesTable)
      .where(inArray(alliancesTable.founderNationId, ids));
  }
  await db.delete(playerNationsTable).where(cond);
}

/** 只清本行程（pid 前綴）的資料。 */
async function cleanup(): Promise<void> {
  await cleanupWhere(like(playerNationsTable.name, `${TAG}%`));
  // 兜底：founder 已被（例如並行測試或中斷的執行）刪除時，孤兒聯盟列的
  // 唯一名稱會讓後續執行的 createAlliance 撞名失敗——一併以名稱前綴清掉。
  await db.delete(alliancesTable).where(like(alliancesTable.name, `${TAG}%`));
}

/**
 * 清除前次「中斷」執行殘留：同泛用前綴、超過 30 分鐘的舊列。
 * 只清舊列，避免刪到併發中另一行程的活資料。
 */
async function cleanupStale(): Promise<void> {
  const cond = and(
    like(playerNationsTable.name, `${TAG_PREFIX}%`),
    sql`${playerNationsTable.createdAt} < NOW() - INTERVAL '30 minutes'`,
  );
  if (cond) await cleanupWhere(cond);
  // 孤兒聯盟兜底（泛用前綴、age-gated）：founder 被刪後 alliances 不會 cascade。
  await db
    .delete(alliancesTable)
    .where(
      and(
        like(alliancesTable.name, `${TAG_PREFIX}%`),
        sql`${alliancesTable.createdAt} < NOW() - INTERVAL '30 minutes'`,
      ),
    );
}

before(async () => {
  await runDiplomacyMigrations();
  await cleanupStale();
  await cleanup();
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("同一國家併發建立兩個聯盟 → 多聯盟制下兩者皆成功", async () => {
  const nationId = await createNation("create-race");

  const [a, b] = await Promise.all([
    createAlliance(nationId, `${TAG}盟甲`),
    createAlliance(nationId, `${TAG}盟乙`),
  ]);

  assert.ok(a.ok, `盟甲應建立成功，實得 ${JSON.stringify(a)}`);
  assert.ok(b.ok, `盟乙應建立成功，實得 ${JSON.stringify(b)}`);

  // 該國屬於兩個不同聯盟。
  const members = await db
    .select({ allianceId: allianceMembersTable.allianceId })
    .from(allianceMembersTable)
    .where(eq(allianceMembersTable.nationId, nationId));
  assert.equal(members.length, 2, "該國在 alliance_members 應有兩列");
  assert.equal(
    new Set(members.map((m) => m.allianceId)).size,
    2,
    "兩列應分屬不同聯盟",
  );
});

test("同一國家併發加入兩個不同聯盟 → 兩者皆成功（多聯盟制）", async () => {
  const founderX = await createNation("founder-x");
  const founderY = await createNation("founder-y");
  const joiner = await createNation("joiner");

  const [ax, ay] = await Promise.all([
    createAlliance(founderX, `${TAG}盟丙`),
    createAlliance(founderY, `${TAG}盟丁`),
  ]);
  assert.ok(ax.ok && ay.ok, "兩個聯盟都應建立成功");
  const allianceX = ax.ok ? ax.alliance.id : "";
  const allianceY = ay.ok ? ay.alliance.id : "";

  const [j1, j2] = await Promise.all([
    joinAlliance(allianceX, joiner),
    joinAlliance(allianceY, joiner),
  ]);
  assert.ok(j1.ok, `加入盟丙應成功，實得 ${JSON.stringify(j1)}`);
  assert.ok(j2.ok, `加入盟丁應成功，實得 ${JSON.stringify(j2)}`);

  const allianceIds = await getNationAllianceIds(joiner);
  assert.equal(allianceIds.length, 2, "加入者應同時屬於兩個聯盟");
  assert.ok(
    allianceIds.includes(allianceX) && allianceIds.includes(allianceY),
    "所屬聯盟應為兩個目標聯盟",
  );
});

test("同一國家併發重複加入同一聯盟 → 恰好一個成功，另一個 already_member", async () => {
  const founder = await createNation("founder-dup");
  const joiner = await createNation("joiner-dup");

  const created = await createAlliance(founder, `${TAG}盟戊`);
  assert.ok(created.ok, "聯盟應建立成功");
  const allianceId = created.ok ? created.alliance.id : "";

  const [j1, j2] = await Promise.all([
    joinAlliance(allianceId, joiner),
    joinAlliance(allianceId, joiner),
  ]);

  const okCount = [j1, j2].filter((r) => r.ok).length;
  assert.equal(okCount, 1, `恰好一個加入成功，實得 ${JSON.stringify([j1, j2])}`);
  const loser = j1.ok ? j2 : j1;
  assert.equal(loser.ok, false);
  if (!loser.ok) assert.equal(loser.code, "already_member");

  // 該國對該聯盟僅一列（複合唯一索引）。
  const members = await db
    .select({ id: allianceMembersTable.id })
    .from(allianceMembersTable)
    .where(eq(allianceMembersTable.nationId, joiner));
  assert.equal(members.length, 1, "同一聯盟只能有一列成員紀錄");
});
