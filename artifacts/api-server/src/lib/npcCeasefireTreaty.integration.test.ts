/**
 * Task #425 — NPC 附條件停戰（索求資源）成交方向不反轉的端到端整合測試。
 *
 * Task #413 已鎖住 NPC 主動提案（proposerIsPayer:true）的一次性轉移方向；
 * 這裡補「附條件停戰」路徑（proposerIsPayer:false + boundWarId，NPC 向玩家
 * 索求資源以停戰）的端到端驗證：
 *
 *  1. NPC↔真人玩家戰爭 → insertNpcTreatyProposal（proposerIsPayer:false +
 *     boundWarId，非 custom）→ activateTreaty：oneTimeFlip=true，
 *     offer 側改由「對象（玩家）」付出、提案 NPC 受益（金錢＋部分割地），
 *     且綁定戰爭在同一交易內結束（endedAt 原子認領）。
 *  2. 戰爭已先結束 → activateTreaty 必須 400 且零轉移（金錢／領土全數不動、
 *     條約仍 proposed、endedAt 不被覆寫）。
 *  3. Task #423 — 鎖住 Task #414 修正後 execCeasefire 的提案方向：NPC 聊天
 *     「附條件停戰」動作產生的提案必須是 type=custom、索求全部落在
 *     request*（requestMoney/requestTechPoints/requestRegionIds+percents）、
 *     offer* 全空、proposerIsPayer=true、boundWarId 綁定該場戰爭；接受後
 *     玩家付出、NPC 收到、戰爭結束（custom 不受 proposerIsPayer 翻轉影響）。
 *
 * 測試資料自成一體：專屬測試 NPC 與「真人玩家」國家（cascade 清
 * controls/treaties/wars），只借用無人掌控的 map_regions（offset 230，
 * 避開其他整合測試 0/80/120/150/160/170/200）。跑法：test-integration workflow。
 */
import { strict as assert } from "node:assert";
import test, { after, before, beforeEach } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the npc-ceasefire tests");
}

const { and, eq, inArray, isNull, or, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runDiplomacyMigrations } = await import("./diplomacyMigrations");
// player_nations 的 satisfaction_* 欄位由政治遷移補上（idempotent）。
const { runPoliticsMigrations } = await import("./politicsMigrations");
const { insertNpcTreatyProposal } = await import("./treatyPropose");
const { activateTreaty, HttpError } = await import("./treatyActivation");
const { canonicalPair } = await import("./diplomacy");
const { executeNpcChatActions } = await import("./npcChatActionExecutor");
const { __setPersistDepForTest } = await import("./diplomacyNotify");

const TEST_TAG = "__npcceasefire425__";
const runId = randomBytes(4).toString("hex");

let npcId: string; // 提案 NPC（受益方）
let playerId: string; // 真人玩家（付款方）
let regionIds: number[] = [];

async function getMoney(nationId: string): Promise<number> {
  const [row] = await db
    .select({ money: playerNationsTable.money })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "nation not found");
  return row.money;
}

async function getTechPoints(nationId: string): Promise<number> {
  const [row] = await db
    .select({ techPoints: playerNationsTable.techPoints })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "nation not found");
  return row.techPoints;
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

/** 建立一場 NPC↔玩家的進行中戰爭（canonical pair）。回傳 war id。 */
async function createWar(): Promise<number> {
  const { low, high } = canonicalPair(npcId, playerId);
  const [row] = await db
    .insert(diplomacyWarsTable)
    .values({ nationAId: low, nationBId: high, declaredByNationId: npcId })
    .returning({ id: diplomacyWarsTable.id });
  assert.ok(row, "test war insert failed");
  return row.id;
}

async function getWarEndedAt(warId: number): Promise<Date | null> {
  const [row] = await db
    .select({ endedAt: diplomacyWarsTable.endedAt })
    .from(diplomacyWarsTable)
    .where(eq(diplomacyWarsTable.id, warId));
  assert.ok(row, "war not found");
  return row.endedAt;
}

async function clearTestState() {
  const ids = [npcId, playerId];
  await db
    .delete(diplomacyTreatiesTable)
    .where(
      or(
        inArray(diplomacyTreatiesTable.proposerNationId, ids),
        inArray(diplomacyTreatiesTable.targetNationId, ids),
      ),
    );
  await db
    .delete(diplomacyWarsTable)
    .where(
      or(
        inArray(diplomacyWarsTable.nationAId, ids),
        inArray(diplomacyWarsTable.nationBId, ids),
      ),
    );
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.nationId, ids));
  await db
    .update(playerNationsTable)
    .set({ money: 1_000, techPoints: 0 })
    .where(eq(playerNationsTable.id, npcId));
  await db
    .update(playerNationsTable)
    .set({ money: 500, techPoints: 0 })
    .where(eq(playerNationsTable.id, playerId));
}

/** 模擬 accept 路由的交易：SELECT ... FOR UPDATE → activateTreaty。 */
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
  // 站內通知改為 no-op：executeNpcChatActions 會對玩家發「新的條約提案」
  // 通知，避免在共用 dev DB 留下假 discordUserId 的通知列。
  __setPersistDepForTest(() => {});

  await runGameMigrations();
  await runDiplomacyMigrations();
  await runPoliticsMigrations();

  // 清掉先前殘留的測試資料（若上次執行中斷）。
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);

  const [npcRow] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}npc-${runId}`,
      leaderName: TEST_TAG,
      money: 1_000,
      techPoints: 0,
      isNpc: true,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(npcRow, "npc nation insert failed");
  npcId = npcRow.id;

  const [playerRow] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}player-${runId}`,
      leaderName: TEST_TAG,
      money: 500,
      techPoints: 0,
      isNpc: false,
      discordUserId: `${TEST_TAG}${runId}`,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(playerRow, "player nation insert failed");
  playerId = playerRow.id;

  // 借用無人掌控的地區；offset 230 避開其他整合測試（0/80/120/150/160/170/200）。
  const rows = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(230)
    .limit(2);
  regionIds = rows.map((r) => r.id);
  assert.ok(regionIds.length >= 2, "測試需要至少 2 個無人掌控的地區");
});

beforeEach(async () => {
  await clearTestState();
});

after(async () => {
  __setPersistDepForTest(null);
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
  await pool.end();
});

test("附條件停戰成交：oneTimeFlip 方向（玩家付出、NPC 受益），戰爭在同一交易內結束", async () => {
  const fullRegion = regionIds[0]!; // 玩家整份割讓 60%
  const partRegion = regionIds[1]!; // 玩家部分割讓 40% 中的 25%
  await setControl(fullRegion, playerId, 60);
  await setControl(partRegion, playerId, 40);

  const warId = await createWar();

  // 附條件停戰語意（Task #341 legacy 路徑）：索求放 offer* ＋
  // proposerIsPayer:false，非 custom → oneTimeFlip=true，offer 側由對象付出。
  const treaty = await insertNpcTreatyProposal({
    proposerNationId: npcId,
    targetNationId: playerId,
    type: "nonaggression",
    durationDays: null,
    offerMoney: 200,
    offerRegionIds: [fullRegion, partRegion],
    offerRegionPercents: { [String(partRegion)]: 25 },
    proposerIsPayer: false,
    boundWarId: warId,
  });
  assert.ok(treaty, "提案插入應成功");
  assert.equal(treaty.proposerIsPayer, false);
  assert.equal(treaty.boundWarId, warId);

  const activated = await acceptTreaty(treaty.id);
  assert.equal(activated.status, "active");

  // 金錢方向不得反轉：玩家 −200、提案 NPC +200。
  assert.equal(await getMoney(npcId), 1_000 + 200);
  assert.equal(await getMoney(playerId), 500 - 200);

  // 領土方向：玩家整份 60% → NPC；部分 40% 割 25% → NPC，玩家剩 15%。
  assert.equal(await getControl(fullRegion, playerId), null);
  assert.equal(await getControl(fullRegion, npcId), 60);
  assert.equal(await getControl(partRegion, playerId), 15);
  assert.equal(await getControl(partRegion, npcId), 25);

  // 綁定戰爭在同一交易內結束（endedAt 原子認領）。
  assert.ok(await getWarEndedAt(warId), "戰爭應已結束（ended_at 設值）");
});

test("戰爭已先結束：activateTreaty 400 且零轉移（金錢／領土不動、條約仍 proposed）", async () => {
  const regionId = regionIds[0]!;
  await setControl(regionId, playerId, 60);

  const warId = await createWar();
  const treaty = await insertNpcTreatyProposal({
    proposerNationId: npcId,
    targetNationId: playerId,
    type: "nonaggression",
    durationDays: null,
    offerMoney: 200,
    offerRegionIds: [regionId],
    proposerIsPayer: false,
    boundWarId: warId,
  });
  assert.ok(treaty, "提案插入應成功");

  // 戰爭先由其他路徑結束（例如另一份停戰或戰役結算）。
  const endedAt = new Date(Date.now() - 60_000);
  await db
    .update(diplomacyWarsTable)
    .set({ endedAt })
    .where(eq(diplomacyWarsTable.id, warId));

  await assert.rejects(
    () => acceptTreaty(treaty.id),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  // 零轉移：金錢與領土全數不動。
  assert.equal(await getMoney(npcId), 1_000);
  assert.equal(await getMoney(playerId), 500);
  assert.equal(await getControl(regionId, playerId), 60);
  assert.equal(await getControl(regionId, npcId), null);

  // endedAt 不被覆寫（原子認領條件 endedAt IS NULL 不會二次結束）。
  const after400 = await getWarEndedAt(warId);
  assert.equal(after400?.getTime(), endedAt.getTime());

  // 條約仍 proposed。
  const [fresh] = await db
    .select({ status: diplomacyTreatiesTable.status })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.id, treaty.id));
  assert.equal(fresh?.status, "proposed");
});

// ── Task #423 — 鎖住 execCeasefire（Task #414 修正後）的提案方向 ──

test("execCeasefire 提案方向：索求在 request* 側、proposerIsPayer=true、boundWarId 綁定；接受後玩家付出、NPC 收到、戰爭結束", async () => {
  const demandRegion = regionIds[0]!;
  await setControl(demandRegion, playerId, 60);
  await db
    .update(playerNationsTable)
    .set({ techPoints: 50 })
    .where(eq(playerNationsTable.id, playerId));

  const warId = await createWar();

  // 走真正的執行層（executeNpcChatActions → execCeasefire），
  // 而非直接呼叫 insertNpcTreatyProposal，鎖住的是 execCeasefire 傳的參數方向。
  const results = await executeNpcChatActions({
    actorId: npcId,
    counterpartId: playerId,
    planned: [
      {
        type: "ceasefire",
        targetId: playerId,
        targetIsPlayer: true,
        treatyType: null,
        durationDays: null,
        offerMoney: 0,
        offerTechPoints: 0,
        offerRegionIds: [],
        clause: null,
        demandMoney: 150,
        demandTechPoints: 20,
        demandRegions: [{ regionId: demandRegion, percent: 30 }],
      },
    ],
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, true, `執行應成功：${results[0]!.detail}`);
  assert.ok(results[0]!.proposalId, "應產生條約提案 id");
  assert.equal(results[0]!.proposalNationId, npcId);

  const [proposal] = await db
    .select()
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.id, results[0]!.proposalId!));
  assert.ok(proposal, "提案列應存在");

  // 核心方向鎖：索求全部在 request* 側、offer* 全空。
  assert.equal(proposal.type, "custom", "附條件停戰提案必須是 custom 條約");
  assert.equal(proposal.requestMoney, 150, "索求金錢必須在 requestMoney");
  assert.equal(
    proposal.requestTechPoints,
    20,
    "索求科技點數必須在 requestTechPoints",
  );
  assert.deepEqual(
    proposal.requestRegionIds,
    [demandRegion],
    "索求割地必須在 requestRegionIds",
  );
  assert.deepEqual(
    proposal.requestRegionPercents,
    { [String(demandRegion)]: 30 },
    "索求割地百分比必須在 requestRegionPercents",
  );
  assert.equal(proposal.offerMoney, 0, "offer 側不得放索求金錢（方向反轉）");
  assert.equal(
    proposal.offerTechPoints,
    0,
    "offer 側不得放索求科技點數（方向反轉）",
  );
  assert.deepEqual(
    proposal.offerRegionIds,
    [],
    "offer 側不得放索求割地（方向反轉）",
  );
  assert.equal(
    proposal.proposerIsPayer,
    true,
    "custom 語意下 proposerIsPayer 必須為 true",
  );
  assert.equal(proposal.boundWarId, warId, "提案必須綁定該場戰爭");
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.awaitingNationId, playerId);

  // 端到端：玩家接受 → 玩家付出、NPC 收到、戰爭結束。
  const activated = await acceptTreaty(proposal.id);
  assert.equal(activated.status, "active");

  assert.equal(await getMoney(playerId), 500 - 150, "玩家應付出索求金錢");
  assert.equal(await getMoney(npcId), 1_000 + 150, "NPC 應收到索求金錢");
  assert.equal(await getTechPoints(playerId), 50 - 20, "玩家應付出索求科技點數");
  assert.equal(await getTechPoints(npcId), 0 + 20, "NPC 應收到索求科技點數");
  assert.equal(await getControl(demandRegion, playerId), 30, "玩家保留其餘掌控");
  assert.equal(await getControl(demandRegion, npcId), 30, "NPC 得到索求割地");
  assert.ok(await getWarEndedAt(warId), "戰爭應已結束（ended_at 設值）");
});

// ── 奪權內戰:任何路徑都不能結束它 ─────────────────────────────────
async function createCivilWar(): Promise<number> {
  const { low, high } = canonicalPair(npcId, playerId);
  const [row] = await db
    .insert(diplomacyWarsTable)
    .values({
      nationAId: low, nationBId: high, declaredByNationId: npcId,
      isCivilWar: true, rebelNationId: npcId, rebelIdeology: "red",
    })
    .returning({ id: diplomacyWarsTable.id });
  assert.ok(row);
  return row.id;
}

test("內戰:附條件停戰條約即使被接受也無法結束戰爭(409,金錢/領土零轉移)", async () => {
  const regionId = regionIds[0]!;
  await setControl(regionId, playerId, 60);
  const warId = await createCivilWar();
  const treaty = await insertNpcTreatyProposal({
    proposerNationId: npcId, targetNationId: playerId, type: "nonaggression", durationDays: null,
    offerMoney: 200, offerRegionIds: [regionId], proposerIsPayer: false, boundWarId: warId,
  });
  assert.ok(treaty);
  await assert.rejects(
    () => acceptTreaty(treaty.id),
    (err: unknown) => err instanceof HttpError && err.status === 409,
  );
  assert.equal(await getWarEndedAt(warId), null, "內戰仍在進行");
  assert.equal(await getMoney(npcId), 1_000, "NPC 沒收到錢");
  assert.equal(await getMoney(playerId), 500, "玩家沒付錢");
  assert.equal(await getControl(regionId, playerId), 60, "領土沒有轉移");
  assert.equal(await getControl(regionId, npcId), null);
});

test("內戰:NPC 聊天不能對內戰提出停戰或附條件停戰(回報失敗與原因,戰爭不變)", async () => {
  const warId = await createCivilWar();
  for (const demand of [false, true]) {
    const results = await executeNpcChatActions({
      actorId: npcId, counterpartId: playerId,
      planned: [{
        type: "ceasefire", targetId: playerId, targetIsPlayer: true, treatyType: null, durationDays: null,
        offerMoney: 0, offerTechPoints: 0, offerRegionIds: [], clause: null,
        demandMoney: demand ? 150 : 0, demandTechPoints: 0, demandRegions: [],
      }],
    });
    assert.equal(results[0]!.ok, false);
    assert.ok(results[0]!.detail.includes("內戰"), results[0]!.detail);
  }
  assert.equal(await getWarEndedAt(warId), null);
});

test("內戰:NPC 接受玩家既有的停戰提案也不會結束戰爭", async () => {
  const warId = await createCivilWar();
  await db.update(diplomacyWarsTable).set({ ceasefireProposedBy: playerId }).where(eq(diplomacyWarsTable.id, warId));
  const results = await executeNpcChatActions({
    actorId: npcId, counterpartId: playerId,
    planned: [{
      type: "ceasefire", targetId: playerId, targetIsPlayer: true, treatyType: null, durationDays: null,
      offerMoney: 0, offerTechPoints: 0, offerRegionIds: [], clause: null,
      demandMoney: 0, demandTechPoints: 0, demandRegions: [],
    }],
  });
  assert.equal(results[0]!.ok, false);
  assert.equal(await getWarEndedAt(warId), null);
});
