/**
 * Task #413 — NPC 附帶領土的提案在真實資料庫中能完整成交的整合測試。
 *
 * Task #380 讓 NPC 主動提案（npcInitiative）可附帶金錢／領土 offer/request，
 * 並固定 proposerIsPayer:true 寫入 insertNpcTreatyProposal。sanitize 純函式
 * 已有單元測試，這裡補「插入提案 → activateTreaty 成交」的端到端方向驗證：
 *
 *  1. offer（金錢＋整份領土）＝提案 NPC 付出、對方取得；
 *     request（金錢＋部分 % 領土）＝對方付出、提案 NPC 取得。
 *     proposerIsPayer=true 且非 custom → oneTimeFlip=false，方向不得翻轉。
 *  2. 對照組：proposerIsPayer=false（附條件停戰語意）→ oneTimeFlip=true，
 *     offer 側改由「對方」付出——鎖住 npcInitiative 必須傳 true 的理由。
 *  3. 對方 request 金錢不足 → HttpError(400) 且全額 rollback（提案方已轉出的
 *     offer 金錢／領土全數回復，條約仍為 proposed）。
 *
 * 測試資料自成一體：專屬測試 NPC 國家（cascade 清 controls/treaties），只借用
 * 無人掌控的 map_regions（offset 200，避開其他整合測試 0/80/120/150/160/170）。
 * 跑法：test-integration workflow。
 */
import { strict as assert } from "node:assert";
import test, { after, before, beforeEach } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the npc-treaty tests");
}

const { and, eq, inArray, isNull, or, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  diplomacyTreatiesTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runDiplomacyMigrations } = await import("./diplomacyMigrations");
// player_nations 的 satisfaction_* 欄位由政治遷移補上（idempotent）。
const { runPoliticsMigrations } = await import("./politicsMigrations");
const { insertNpcTreatyProposal } = await import("./treatyPropose");
const { activateTreaty, HttpError } = await import("./treatyActivation");

const TEST_TAG = "__npctreaty413__";
const runId = randomBytes(4).toString("hex");

let proposerId: string; // 提案 NPC
let targetId: string; // 對方 NPC
let regionIds: number[] = [];

async function createNpcNation(label: string, money: number) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}${label}-${runId}`,
      leaderName: TEST_TAG,
      money,
      techPoints: 0,
      isNpc: true,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function setMoney(nationId: string, money: number) {
  await db
    .update(playerNationsTable)
    .set({ money })
    .where(eq(playerNationsTable.id, nationId));
}

async function getMoney(nationId: string): Promise<number> {
  const [row] = await db
    .select({ money: playerNationsTable.money })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "nation not found");
  return row.money;
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

async function getControl(
  regionId: number,
  nationId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ percent: regionControlsTable.percent })
    .from(regionControlsTable)
    .where(
      and(
        eq(regionControlsTable.regionId, regionId),
        eq(regionControlsTable.nationId, nationId),
      ),
    );
  return row?.percent ?? null;
}

async function clearTestState() {
  await db
    .delete(diplomacyTreatiesTable)
    .where(
      or(
        inArray(diplomacyTreatiesTable.proposerNationId, [
          proposerId,
          targetId,
        ]),
        inArray(diplomacyTreatiesTable.targetNationId, [proposerId, targetId]),
      ),
    );
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.nationId, [proposerId, targetId]));
}

/** 模擬 accept 路由／NPC 裁決的交易：SELECT ... FOR UPDATE → activateTreaty。 */
function acceptTreaty(treatyId: number) {
  return db.transaction(async (tx) => {
    const [treaty] = await tx
      .select()
      .from(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.id, treatyId))
      .for("update");
    assert.ok(treaty, "treaty not found");
    assert.equal(treaty.status, "proposed");
    return activateTreaty(tx, treaty);
  });
}

before(async () => {
  await runGameMigrations();
  await runDiplomacyMigrations();
  await runPoliticsMigrations();

  // 清掉先前殘留的測試資料（若上次執行中斷）。
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);

  proposerId = await createNpcNation("proposer", 1_000);
  targetId = await createNpcNation("target", 500);

  // 借用無人掌控的地區；offset 200 避開其他整合測試（0/80/120/150/160/170）。
  const rows = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(200)
    .limit(3);
  regionIds = rows.map((r) => r.id);
  assert.ok(regionIds.length >= 3, "測試需要至少 3 個無人掌控的地區");
});

beforeEach(async () => {
  await clearTestState();
  await setMoney(proposerId, 1_000);
  await setMoney(targetId, 500);
});

after(async () => {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
  await pool.end();
});

test("NPC 提案（proposerIsPayer=true）成交：offer=提案方付出、request=對方付出，含整份與部分領土", async () => {
  const offerRegion = regionIds[0]!; // 提案方整份割讓 60%
  const requestRegion = regionIds[1]!; // 對方部分割讓 40% 中的 25%
  await setControl(offerRegion, proposerId, 60);
  await setControl(requestRegion, targetId, 40);

  // 與 runNpcInitiativesTurn 完全相同的參數形狀（Task #380）。
  const treaty = await insertNpcTreatyProposal({
    proposerNationId: proposerId,
    targetNationId: targetId,
    type: "nonaggression",
    durationDays: 30,
    offerMoney: 200,
    offerRegionIds: [offerRegion],
    offerRegionPercents: {},
    requestMoney: 100,
    requestRegionIds: [requestRegion],
    requestRegionPercents: { [String(requestRegion)]: 25 },
    proposerIsPayer: true,
  });
  assert.ok(treaty, "提案插入應成功");
  assert.equal(treaty.proposerIsPayer, true);

  const activated = await acceptTreaty(treaty.id);
  assert.equal(activated.status, "active");

  // 金錢方向：提案方 −200 +100、對方 +200 −100。
  assert.equal(await getMoney(proposerId), 1_000 - 200 + 100);
  assert.equal(await getMoney(targetId), 500 + 200 - 100);

  // offer 領土：提案方（NPC 出資側）整份 60% 被 Task #570 上限夾到
  // 60% × regionMaxPct 50% = 30% → 對方拿 30%、提案方留 30%。
  assert.equal(await getControl(offerRegion, proposerId), 30);
  assert.equal(await getControl(offerRegion, targetId), 30);

  // request 領土：對方 40% 中割 25% → 提案方，對方剩 15%。
  assert.equal(await getControl(requestRegion, targetId), 15);
  assert.equal(await getControl(requestRegion, proposerId), 25);
});

test("對照組 proposerIsPayer=false（非 custom）：oneTimeFlip 翻轉，offer 改由對方付出", async () => {
  const offerRegion = regionIds[0]!;
  // 若 npcInitiative 誤傳 false，「NPC 的 offer 領土」需在對方名下才能成交，
  // 方向整個反過來——這裡鎖住該語意，證明必須傳 true。
  await setControl(offerRegion, targetId, 50);

  const treaty = await insertNpcTreatyProposal({
    proposerNationId: proposerId,
    targetNationId: targetId,
    type: "nonaggression",
    durationDays: null,
    offerMoney: 100,
    offerRegionIds: [offerRegion],
    proposerIsPayer: false,
  });
  assert.ok(treaty, "提案插入應成功");

  const activated = await acceptTreaty(treaty.id);
  assert.equal(activated.status, "active");

  // 翻轉後：對方付 offer（金錢與領土流向提案方）。
  assert.equal(await getMoney(proposerId), 1_000 + 100);
  assert.equal(await getMoney(targetId), 500 - 100);
  assert.equal(await getControl(offerRegion, targetId), null);
  assert.equal(await getControl(offerRegion, proposerId), 50);
});

test("對方 request 金錢不足：400 且全額 rollback（offer 金錢／領土回復、條約仍 proposed）", async () => {
  const offerRegion = regionIds[2]!;
  await setControl(offerRegion, proposerId, 80);
  // activateTreaty 先執行 offer 側（對方先收到 300），再執行 request 側扣款；
  // 因此 request 必須大於「原餘額＋offer 金額」才會不足（50 + 300 < 500）。
  await setMoney(targetId, 50);

  const treaty = await insertNpcTreatyProposal({
    proposerNationId: proposerId,
    targetNationId: targetId,
    type: "military_access",
    durationDays: 30,
    offerMoney: 300,
    offerRegionIds: [offerRegion],
    requestMoney: 500,
    proposerIsPayer: true,
  });
  assert.ok(treaty, "提案插入應成功");

  await assert.rejects(
    () => acceptTreaty(treaty.id),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  // 全額 rollback：offer 側已執行的轉移全部回復。
  assert.equal(await getMoney(proposerId), 1_000);
  assert.equal(await getMoney(targetId), 50);
  assert.equal(await getControl(offerRegion, proposerId), 80);
  assert.equal(await getControl(offerRegion, targetId), null);

  const [fresh] = await db
    .select({ status: diplomacyTreatiesTable.status })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.id, treaty.id));
  assert.equal(fresh?.status, "proposed");
});
