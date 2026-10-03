/**
 * NPC 對話即時行動「執行層」的真實資料庫整合測試（executeNpcChatActions）。
 *
 * sanitizeChatActions 的純函式已在 lib/npcChatActions.test.ts 覆蓋；本檔鎖住
 * executor 真正落地時的副作用與硬性守門（這些都在寫入層再次把關，executor
 * 只負責串接與轉譯）：
 *
 *  1. 空計畫 → 回傳空陣列，完全不動資料庫。
 *  2. 送禮（僅限對話中的玩家）→ NPC 精確扣款、對方精確增額、關係值 +10、
 *     雙方各寫一筆 category=gift 的財政流水、寫一筆 gift 互動事件。
 *  3. 送禮但 NPC 資源不足 → ok=false，餘額與關係值皆不變。
 *  4. 宣戰（需關係值 < 0）→ 建立唯一戰爭列（canonical low/high）；重複宣戰
 *     → ok=false「雙方已在交戰中」，不新增戰爭列。
 *  5. 停戰：對方已提議 → NPC 接受後戰爭結束（endedAt 落地）。
 *  6. 締約（互不侵犯）對玩家 → 產生 status=proposed 的條約列。
 *  7. 交換對玩家 → 產生 type=custom、帶 offer 的 proposed 條約列。
 *  8. 出兵但雙方皆無掌控地區 → ok=false，且不建立任何戰役／戰爭列（護欄：
 *     絕不對非交戰或無相鄰地區的對象自動開戰役）。
 *
 * 所有測試國家以 `__npcacttest__` 前綴標記，跑前跑後清除，可重複執行：
 *   pnpm --filter @workspace/api-server run test:integration
 */
import { strict as assert } from "node:assert";
import test, { after, before, beforeEach } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set to run the npc chat action tests");
}

const { and, eq, inArray, isNull, like } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  playerNotificationsTable,
  diplomacyRelationsTable,
  diplomacyRelationEventsTable,
  diplomacyWarsTable,
  diplomacyTreatiesTable,
  nationFinanceLedgerTable,
  warCampaignsTable,
  warRegionCooldownsTable,
  mapRegionsTable,
} = await import("@workspace/db");
const { executeNpcChatActions } = await import(
  "../lib/npcChatActionExecutor"
);
const { canonicalPair, RELATION_ACTIONS } = await import("../lib/diplomacy");
const { runDiplomacyMigrations } = await import("../lib/diplomacyMigrations");

import type { PlannedChatAction, ChatActionType } from "../lib/npcChatActions";

const MARKER = "__npcacttest__";
const runId = randomBytes(4).toString("hex");
const playerUserId = `npcacttest-player-${runId}`;

let actorId: string; // NPC（採取行動方）
let playerId: string; // 對話中的玩家（動作目標）

const GIFT_DELTA = RELATION_ACTIONS.gift.delta;

function mkAction(
  type: ChatActionType,
  targetId: string,
  overrides: Partial<PlannedChatAction> = {},
): PlannedChatAction {
  return {
    type,
    targetId,
    targetIsPlayer: true,
    treatyType: null,
    durationDays: null,
    offerMoney: 0,
    offerTechPoints: 0,
    offerRegionIds: [],
    clause: null,
    demandMoney: 0,
    demandTechPoints: 0,
    demandRegions: [],
    ...overrides,
  };
}

async function testIds(): Promise<string[]> {
  const rows = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(like(playerNationsTable.name, `${MARKER}%`));
  return rows.map((r) => r.id);
}

async function clearPairState() {
  const ids = await testIds();
  if (ids.length === 0) return;
  await db
    .delete(diplomacyWarsTable)
    .where(
      and(
        inArray(diplomacyWarsTable.nationAId, ids),
        inArray(diplomacyWarsTable.nationBId, ids),
      ),
    );
  await db
    .delete(diplomacyTreatiesTable)
    .where(
      inArray(diplomacyTreatiesTable.proposerNationId, ids),
    );
  await db
    .delete(diplomacyRelationEventsTable)
    .where(inArray(diplomacyRelationEventsTable.actorNationId, ids));
  await db
    .delete(diplomacyRelationsTable)
    .where(
      and(
        inArray(diplomacyRelationsTable.nationAId, ids),
        inArray(diplomacyRelationsTable.nationBId, ids),
      ),
    );
  await db
    .delete(nationFinanceLedgerTable)
    .where(inArray(nationFinanceLedgerTable.nationId, ids));
}

async function cleanup() {
  await clearPairState();
  await db
    .delete(playerNotificationsTable)
    .where(eq(playerNotificationsTable.discordUserId, playerUserId));
  await db
    .delete(playerNationsTable)
    .where(like(playerNationsTable.name, `${MARKER}%`));
}

async function setRelation(score: number) {
  const { low, high } = canonicalPair(actorId, playerId);
  await db
    .insert(diplomacyRelationsTable)
    .values({ nationAId: low, nationBId: high, score })
    .onConflictDoUpdate({
      target: [
        diplomacyRelationsTable.nationAId,
        diplomacyRelationsTable.nationBId,
      ],
      set: { score },
    });
}

async function readNation(id: string) {
  const [row] = await db
    .select({
      money: playerNationsTable.money,
      techPoints: playerNationsTable.techPoints,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, id))
    .limit(1);
  assert.ok(row, "找不到測試國家");
  return row;
}

async function resetActorBalance(money: number, tech: number) {
  await db
    .update(playerNationsTable)
    .set({ money, techPoints: tech })
    .where(eq(playerNationsTable.id, actorId));
}

async function activeWar() {
  const { low, high } = canonicalPair(actorId, playerId);
  return db
    .select()
    .from(diplomacyWarsTable)
    .where(
      and(
        eq(diplomacyWarsTable.nationAId, low),
        eq(diplomacyWarsTable.nationBId, high),
        isNull(diplomacyWarsTable.endedAt),
      ),
    );
}

before(async () => {
  await runDiplomacyMigrations();
  await cleanup();

  const [actor] = await db
    .insert(playerNationsTable)
    .values({
      name: `${MARKER}npc-${runId}`,
      leaderName: MARKER,
      discordUserId: null,
      isNpc: true,
      money: 1000,
      techPoints: 100,
    })
    .returning({ id: playerNationsTable.id });
  actorId = actor!.id;

  const [player] = await db
    .insert(playerNationsTable)
    .values({
      name: `${MARKER}player-${runId}`,
      leaderName: MARKER,
      discordUserId: playerUserId,
      isNpc: false,
      money: 500,
      techPoints: 50,
    })
    .returning({ id: playerNationsTable.id });
  playerId = player!.id;
});

beforeEach(async () => {
  await clearPairState();
  await resetActorBalance(1000, 100);
  await db
    .update(playerNationsTable)
    .set({ money: 500, techPoints: 50 })
    .where(eq(playerNationsTable.id, playerId));
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("空計畫 → 回傳空陣列", async () => {
  const results = await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [],
  });
  assert.deepEqual(results, []);
});

test("送禮 → 精確轉移資源、關係 +10、雙邊財政流水與互動事件", async () => {
  const results = await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [
      mkAction("gift", playerId, { offerMoney: 300, offerTechPoints: 40 }),
    ],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]!.ok, true);
  assert.equal(results[0]!.type, "gift");

  const actor = await readNation(actorId);
  const player = await readNation(playerId);
  assert.equal(actor.money, 700);
  assert.equal(actor.techPoints, 60);
  assert.equal(player.money, 800);
  assert.equal(player.techPoints, 90);

  const { low, high } = canonicalPair(actorId, playerId);
  const [rel] = await db
    .select({ score: diplomacyRelationsTable.score })
    .from(diplomacyRelationsTable)
    .where(
      and(
        eq(diplomacyRelationsTable.nationAId, low),
        eq(diplomacyRelationsTable.nationBId, high),
      ),
    );
  assert.equal(rel!.score, GIFT_DELTA);

  const ledger = await db
    .select({
      nationId: nationFinanceLedgerTable.nationId,
      amount: nationFinanceLedgerTable.amount,
    })
    .from(nationFinanceLedgerTable)
    .where(
      and(
        inArray(nationFinanceLedgerTable.nationId, [actorId, playerId]),
        eq(nationFinanceLedgerTable.category, "gift"),
      ),
    );
  assert.equal(ledger.length, 2);
  const actorEntry = ledger.find((l) => l.nationId === actorId);
  const playerEntry = ledger.find((l) => l.nationId === playerId);
  assert.equal(actorEntry!.amount, -300);
  assert.equal(playerEntry!.amount, 300);

  const events = await db
    .select({ action: diplomacyRelationEventsTable.action })
    .from(diplomacyRelationEventsTable)
    .where(eq(diplomacyRelationEventsTable.actorNationId, actorId));
  assert.ok(events.some((e) => e.action === "gift"));
});

test("送禮但資源不足 → ok=false，餘額與關係值不變", async () => {
  await resetActorBalance(10, 0);
  const results = await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [mkAction("gift", playerId, { offerMoney: 300 })],
  });
  assert.equal(results[0]!.ok, false);

  const actor = await readNation(actorId);
  const player = await readNation(playerId);
  assert.equal(actor.money, 10);
  assert.equal(player.money, 500);

  const ledger = await db
    .select({ id: nationFinanceLedgerTable.id })
    .from(nationFinanceLedgerTable)
    .where(inArray(nationFinanceLedgerTable.nationId, [actorId, playerId]));
  assert.equal(ledger.length, 0);
});

test("宣戰（關係 < 0）→ 建立唯一戰爭列；重複宣戰 → 已交戰、不新增", async () => {
  await setRelation(-20);
  const first = await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [mkAction("declare_war", playerId)],
  });
  assert.equal(first[0]!.ok, true);
  let wars = await activeWar();
  assert.equal(wars.length, 1);

  const second = await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [mkAction("declare_war", playerId)],
  });
  assert.equal(second[0]!.ok, false);
  assert.match(second[0]!.detail, /交戰/);
  wars = await activeWar();
  assert.equal(wars.length, 1);
});

test("停戰：對方已提議 → NPC 接受後戰爭結束", async () => {
  await setRelation(-20);
  await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [mkAction("declare_war", playerId)],
  });
  const [war] = await activeWar();
  assert.ok(war, "應已建立戰爭");
  // 模擬對方（玩家）先提議停戰。
  await db
    .update(diplomacyWarsTable)
    .set({ ceasefireProposedBy: playerId })
    .where(eq(diplomacyWarsTable.id, war!.id));

  const results = await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [mkAction("ceasefire", playerId)],
  });
  assert.equal(results[0]!.ok, true);
  assert.match(results[0]!.detail, /結束/);
  const stillActive = await activeWar();
  assert.equal(stillActive.length, 0);
});

test("停戰：接受時一併收束進行中的戰役（避免戰爭已結束仍持續結算）", async () => {
  await setRelation(-20);
  await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [mkAction("declare_war", playerId)],
  });
  const [war] = await activeWar();
  assert.ok(war, "應已建立戰爭");

  // 取兩個真實地區作為戰役出發地／目標地（map_regions 已種子化）。
  const regions = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .limit(2);
  assert.equal(regions.length, 2, "需要至少兩個地區來建立戰役");
  const attackerRegionId = regions[0]!.id;
  const defenderRegionId = regions[1]!.id;

  // 插入一場進行中的戰役掛在該戰爭下。
  const [campaign] = await db
    .insert(warCampaignsTable)
    .values({
      warId: war!.id,
      attackerNationId: actorId,
      defenderNationId: playerId,
      attackerRegionId,
      defenderRegionId,
      status: "active",
      nextResolveAt: new Date(Date.now() + 24 * 3_600_000),
    })
    .returning({ id: warCampaignsTable.id });
  assert.ok(campaign, "應已建立戰役");

  // 模擬對方（玩家）提議停戰，NPC 接受。
  await db
    .update(diplomacyWarsTable)
    .set({ ceasefireProposedBy: playerId })
    .where(eq(diplomacyWarsTable.id, war!.id));

  const results = await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [mkAction("ceasefire", playerId)],
  });
  assert.equal(results[0]!.ok, true);

  // 戰爭結束，且其戰役也被收束（status=ended、endReason=ceasefire），
  // 否則 settleDueCampaigns 會在戰爭結束後繼續結算此戰役。
  const stillActive = await activeWar();
  assert.equal(stillActive.length, 0);
  const [after] = await db
    .select({
      status: warCampaignsTable.status,
      endReason: warCampaignsTable.endReason,
    })
    .from(warCampaignsTable)
    .where(eq(warCampaignsTable.id, campaign!.id));
  assert.equal(after!.status, "ended");
  assert.equal(after!.endReason, "ceasefire");

  // 清理：收束戰役會為真實地區寫入冷卻列（非測試前綴，clearPairState 掃不到）。
  await db
    .delete(warRegionCooldownsTable)
    .where(inArray(warRegionCooldownsTable.regionId, [attackerRegionId, defenderRegionId]));
});

test("締約（互不侵犯）對玩家 → 產生 proposed 條約列", async () => {
  const results = await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [
      mkAction("propose_treaty", playerId, {
        treatyType: "nonaggression",
        durationDays: 30,
      }),
    ],
  });
  assert.equal(results[0]!.ok, true);

  const treaties = await db
    .select({
      type: diplomacyTreatiesTable.type,
      status: diplomacyTreatiesTable.status,
      targetNationId: diplomacyTreatiesTable.targetNationId,
    })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.proposerNationId, actorId));
  assert.equal(treaties.length, 1);
  assert.equal(treaties[0]!.type, "nonaggression");
  assert.equal(treaties[0]!.status, "proposed");
  assert.equal(treaties[0]!.targetNationId, playerId);
});

test("交換對玩家 → 產生 type=custom 且帶 offer 的 proposed 條約列", async () => {
  const results = await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [
      mkAction("exchange", playerId, {
        offerMoney: 200,
        offerTechPoints: 10,
        clause: "以科技點數換取互市",
      }),
    ],
  });
  assert.equal(results[0]!.ok, true);

  const [treaty] = await db
    .select({
      type: diplomacyTreatiesTable.type,
      status: diplomacyTreatiesTable.status,
    })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.proposerNationId, actorId));
  assert.ok(treaty, "應建立一筆 custom 條約提案");
  assert.equal(treaty!.type, "custom");
  assert.equal(treaty!.status, "proposed");
});

test("出兵但雙方皆無掌控地區 → ok=false，且不建立戰爭列", async () => {
  const results = await executeNpcChatActions({
    actorId,
    counterpartId: playerId,
    planned: [mkAction("initiate_campaign", playerId)],
  });
  assert.equal(results[0]!.ok, false);
  const wars = await activeWar();
  assert.equal(wars.length, 0);
});
