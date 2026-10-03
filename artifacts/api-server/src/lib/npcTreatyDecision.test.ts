import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, or, sql } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  diplomacyTreatiesTable,
  type DiplomacyTreaty,
} from "@workspace/db";
import { runDiplomacyMigrations } from "./diplomacyMigrations";
import { runWorldSimMigrations } from "./worldSimMigrations";
import { pgErrorCode } from "./playerValidation";
import { HttpError } from "./treatyActivation";
import { applyNpcTreatyDecision } from "./npcTreatyDecision";
import type { NpcTreatyDecision } from "./diplomacyAi";

/**
 * Task #52 — NPC 條約即時判斷套用邏輯（applyNpcTreatyDecision）的整合測試。
 * AI 呼叫在路由層完成，這裡直接以構造好的 decision 物件呼叫（等同 mock AI），
 * 走真實資料庫驗證端到端行為：
 * - accept 但玩家餘額在 AI 判斷期間已花掉 → 400、提案被撤回不卡在 proposed、餘額不動
 * - counter 的兩筆寫入（superseded ＋ 新對案列）原子性
 * - 狀態已變更（非 proposed）→ 409，不重複轉移、不產生半套資料
 */

const TEST_TAG = "npc-treaty-decision-test";

let proposerId: string;
let npcId: string;

function acceptDecision(note = "同意"): NpcTreatyDecision {
  return { decision: "accept", note, counter: null, relationDelta: 0 };
}

function rejectDecision(note = "拒絕"): NpcTreatyDecision {
  return { decision: "reject", note, counter: null, relationDelta: 0 };
}

function counterDecision(
  overrides: Partial<{
    durationDays: number | null;
    demandMoney: number;
    demandTechPoints: number;
  }> = {},
): NpcTreatyDecision {
  return {
    decision: "counter",
    note: "提出對案",
    relationDelta: 0,
    counter: {
      durationDays: overrides.durationDays ?? 90,
      demandMoney: overrides.demandMoney ?? 500,
      demandTechPoints: overrides.demandTechPoints ?? 5,
    },
  };
}

async function createNation(
  name: string,
  money: number,
  techPoints: number,
  isNpc = false,
) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}-${name}`,
      leaderName: TEST_TAG,
      money,
      techPoints,
      isNpc,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function setBalances(nationId: string, money: number, techPoints: number) {
  await db
    .update(playerNationsTable)
    .set({ money, techPoints })
    .where(eq(playerNationsTable.id, nationId));
}

async function getBalances(nationId: string) {
  const [row] = await db
    .select({
      money: playerNationsTable.money,
      techPoints: playerNationsTable.techPoints,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "nation not found");
  return row;
}

async function createTreaty(
  overrides: Partial<{
    offerMoney: number;
    offerTechPoints: number;
    durationDays: number | null;
    status: string;
    type: string;
    requestMoney: number;
    perTurnMoney: number;
    proposerIsPayer: boolean;
    customClause: string | null;
  }> = {},
): Promise<DiplomacyTreaty> {
  const [row] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: proposerId,
      targetNationId: npcId,
      type: overrides.type ?? "nonaggression",
      durationDays: overrides.durationDays ?? null,
      offerMoney: overrides.offerMoney ?? 0,
      offerTechPoints: overrides.offerTechPoints ?? 0,
      offerRegionIds: [],
      requestMoney: overrides.requestMoney ?? 0,
      perTurnMoney: overrides.perTurnMoney ?? 0,
      proposerIsPayer: overrides.proposerIsPayer ?? true,
      customClause: overrides.customClause ?? null,
      status: overrides.status ?? "proposed",
      awaitingNationId: npcId,
    })
    .returning();
  assert.ok(row, "test treaty insert failed");
  return row;
}

async function getTreaty(id: number) {
  const [row] = await db
    .select()
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.id, id));
  return row ?? null;
}

async function getCounters(originalId: number) {
  return db
    .select()
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.counterOfTreatyId, originalId));
}

before(async () => {
  await runDiplomacyMigrations();
  // Task #570 — NPC 締約資源上限欄位（world_game_state）。
  await runWorldSimMigrations();
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);

  proposerId = await createNation("proposer", 1_000, 100);
  npcId = await createNation("npc", 0, 0, true);
});

// Task #67 之後同一 pair 僅允許一筆 proposed（部分唯一索引），
// 每個測試前清掉測試國家間殘留的條約，避免跨測試互相干擾。
beforeEach(async () => {
  await db
    .delete(diplomacyTreatiesTable)
    .where(
      or(
        eq(diplomacyTreatiesTable.proposerNationId, proposerId),
        eq(diplomacyTreatiesTable.targetNationId, proposerId),
      ),
    );
});

after(async () => {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);
  await pool.end();
});

test("accept 成功：條約轉 active、responseNote 寫入、資源一次轉移", async () => {
  await setBalances(proposerId, 1_000, 100);
  await setBalances(npcId, 0, 0);

  const treaty = await createTreaty({ offerMoney: 300, offerTechPoints: 20 });
  const activated = await applyNpcTreatyDecision(
    treaty.id,
    acceptDecision("很好的提案"),
  );

  assert.equal(activated.status, "active");
  assert.equal(activated.awaitingNationId, null);
  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "active");
  assert.equal(stored?.responseNote, "很好的提案");

  const p = await getBalances(proposerId);
  const n = await getBalances(npcId);
  assert.equal(p.money, 700);
  assert.equal(p.techPoints, 80);
  assert.equal(n.money, 300);
  assert.equal(n.techPoints, 20);
});

test("accept 但 AI 判斷期間餘額已花掉：400、提案被撤回不卡在 proposed、餘額不動", async () => {
  await setBalances(proposerId, 1_000, 100);
  await setBalances(npcId, 0, 0);

  const treaty = await createTreaty({ offerMoney: 800 });
  // 模擬 AI 呼叫期間玩家在軍事頁面花掉錢（提案時餘額足夠，成立時不足）。
  await setBalances(proposerId, 100, 100);

  await assert.rejects(
    applyNpcTreatyDecision(treaty.id, acceptDecision()),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  // 提案列已刪除（與 AI 失敗路徑一致），玩家可重新提案。
  assert.equal(await getTreaty(treaty.id), null);
  const p = await getBalances(proposerId);
  const n = await getBalances(npcId);
  assert.equal(p.money, 100);
  assert.equal(p.techPoints, 100);
  assert.equal(n.money, 0);
  assert.equal(n.techPoints, 0);
});

test("accept 但條約已非 proposed：409、不刪列、不轉移資源", async () => {
  await setBalances(proposerId, 1_000, 100);
  await setBalances(npcId, 0, 0);

  const treaty = await createTreaty({ offerMoney: 100, status: "rejected" });
  await assert.rejects(
    applyNpcTreatyDecision(treaty.id, acceptDecision()),
    (err: unknown) => err instanceof HttpError && err.status === 409,
  );

  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "rejected");
  const p = await getBalances(proposerId);
  assert.equal(p.money, 1_000);
});

test("reject：轉 rejected 並寫入 note；重複 reject → 409", async () => {
  const treaty = await createTreaty();
  const rejected = await applyNpcTreatyDecision(
    treaty.id,
    rejectDecision("再談談"),
  );
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.awaitingNationId, null);
  assert.equal(rejected.responseNote, "再談談");

  await assert.rejects(
    applyNpcTreatyDecision(treaty.id, rejectDecision()),
    (err: unknown) => err instanceof HttpError && err.status === 409,
  );
});

test("counter：原提案 superseded ＋ 新對案列一次寫入", async () => {
  const treaty = await createTreaty({ offerMoney: 100, durationDays: 30 });
  const superseded = await applyNpcTreatyDecision(
    treaty.id,
    counterDecision({ durationDays: 60, demandMoney: 999, demandTechPoints: 9 }),
  );

  assert.equal(superseded.status, "superseded");
  assert.equal(superseded.awaitingNationId, null);
  assert.equal(superseded.responseNote, "提出對案");

  const counters = await getCounters(treaty.id);
  assert.equal(counters.length, 1);
  const c = counters[0]!;
  assert.equal(c.status, "proposed");
  assert.equal(c.proposerNationId, proposerId);
  assert.equal(c.targetNationId, npcId);
  assert.equal(c.awaitingNationId, proposerId);
  assert.equal(c.durationDays, 60);
  // Task #374：NPC 索求疊加在原提案 offer 上（提案方付更多），
  // 而非取代 —— offerMoney = 原 100 + 索求 999。
  assert.equal(c.offerMoney, 1_099);
  assert.equal(c.offerTechPoints, 9);
  assert.equal(c.type, "nonaggression");
});

test("counter 但條約已非 proposed：409，不產生半套資料（無新對案列）", async () => {
  const treaty = await createTreaty({ status: "active" });
  await assert.rejects(
    applyNpcTreatyDecision(treaty.id, counterDecision()),
    (err: unknown) => err instanceof HttpError && err.status === 409,
  );

  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "active");
  assert.equal((await getCounters(treaty.id)).length, 0);
});

test("counter 缺 counter 物件：502、條約維持 proposed", async () => {
  const treaty = await createTreaty();
  const bad = {
    decision: "counter",
    note: "格式錯誤",
    counter: null,
  } as NpcTreatyDecision;
  await assert.rejects(
    applyNpcTreatyDecision(treaty.id, bad),
    (err: unknown) => err instanceof HttpError && err.status === 502,
  );
  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "proposed");
  assert.equal((await getCounters(treaty.id)).length, 0);
});

test("同一條約同時 accept 與 counter：恰好一個成功，無半套資料", async () => {
  await setBalances(proposerId, 1_000, 100);
  await setBalances(npcId, 0, 0);

  const treaty = await createTreaty({ offerMoney: 400 });
  const results = await Promise.allSettled([
    applyNpcTreatyDecision(treaty.id, acceptDecision()),
    applyNpcTreatyDecision(treaty.id, counterDecision()),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  assert.equal(fulfilled.length, 1, "應恰好一個成功");
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]!.reason instanceof HttpError &&
      rejected[0]!.reason.status === 409,
    `輸家應收到 409，實際：${String(rejected[0]!.reason)}`,
  );

  const stored = await getTreaty(treaty.id);
  assert.ok(stored, "條約列不應消失");
  const counters = await getCounters(treaty.id);
  const p = await getBalances(proposerId);
  const n = await getBalances(npcId);
  if (stored.status === "active") {
    // accept 贏：資源轉移一次、沒有對案列。
    assert.equal(counters.length, 0);
    assert.equal(p.money, 600);
    assert.equal(n.money, 400);
  } else {
    // counter 贏：superseded ＋ 恰好一筆對案列、資源不動。
    assert.equal(stored.status, "superseded");
    assert.equal(counters.length, 1);
    assert.equal(p.money, 1_000);
    assert.equal(n.money, 0);
  }
});

// ---------------------------------------------------------------------------
// Task #67 — 同一 pair 最多一筆 proposed（部分唯一索引 diplomacy_treaties_proposed_pair_uidx）
// ---------------------------------------------------------------------------

async function insertProposed(fromId: string, toId: string) {
  const [row] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: fromId,
      targetNationId: toId,
      type: "nonaggression",
      durationDays: null,
      offerMoney: 0,
      offerTechPoints: 0,
      offerRegionIds: [],
      status: "proposed",
      awaitingNationId: toId,
    })
    .returning();
  assert.ok(row, "proposed insert failed");
  return row;
}

async function countProposedForPair() {
  const rows = await db
    .select({ id: diplomacyTreatiesTable.id })
    .from(diplomacyTreatiesTable)
    .where(
      and(
        eq(diplomacyTreatiesTable.status, "proposed"),
        or(
          and(
            eq(diplomacyTreatiesTable.proposerNationId, proposerId),
            eq(diplomacyTreatiesTable.targetNationId, npcId),
          ),
          and(
            eq(diplomacyTreatiesTable.proposerNationId, npcId),
            eq(diplomacyTreatiesTable.targetNationId, proposerId),
          ),
        ),
      ),
    );
  return rows.length;
}

test("併發兩筆提案（連點送出）：恰好一筆成功，輸家收到 23505 unique violation", async () => {
  const results = await Promise.allSettled([
    insertProposed(proposerId, npcId),
    insertProposed(proposerId, npcId),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  assert.equal(fulfilled.length, 1, "應恰好一筆提案成功");
  assert.equal(rejected.length, 1);
  assert.equal(
    pgErrorCode(rejected[0]!.reason),
    "23505",
    `輸家應為 unique violation，實際：${String(rejected[0]!.reason)}`,
  );
  assert.equal(await countProposedForPair(), 1);
});

test("反向提案也算同一 pair：npc→proposer 的重複提案被索引擋下", async () => {
  await insertProposed(proposerId, npcId);
  await assert.rejects(
    insertProposed(npcId, proposerId),
    (err: unknown) => pgErrorCode(err) === "23505",
  );
  assert.equal(await countProposedForPair(), 1);
});

test("counter 對案鏈時序：superseded＋新對案同交易，pair 全程僅一筆 proposed", async () => {
  const treaty = await createTreaty({ offerMoney: 100 });
  // counter 與另一筆併發提案同時進行：counter 交易內先 superseded 原提案再插入
  // 對案列；併發提案不論落在交易前後都會撞索引（原提案或對案列）→ 23505。
  const results = await Promise.allSettled([
    applyNpcTreatyDecision(treaty.id, counterDecision()),
    insertProposed(proposerId, npcId),
  ]);
  const counterResult = results[0]!;
  const insertResult = results[1]!;
  assert.equal(counterResult.status, "fulfilled", "counter 應成功");
  assert.equal(insertResult.status, "rejected", "併發提案應被索引擋下");
  assert.equal(
    pgErrorCode((insertResult as PromiseRejectedResult).reason),
    "23505",
  );

  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "superseded");
  const counters = await getCounters(treaty.id);
  assert.equal(counters.length, 1);
  assert.equal(counters[0]!.status, "proposed");
  assert.equal(await countProposedForPair(), 1);
});

test("已有待回覆對案時再提案：被索引擋下（NPC 對案鏈不會累積兩筆 proposed）", async () => {
  const treaty = await createTreaty();
  await applyNpcTreatyDecision(treaty.id, counterDecision());
  // 對案列（proposed、awaiting proposer）存在期間，任何一方再提案都應失敗。
  await assert.rejects(
    insertProposed(proposerId, npcId),
    (err: unknown) => pgErrorCode(err) === "23505",
  );
  assert.equal(await countProposedForPair(), 1);
});

test("同一條約兩個 accept 同時進來：資源只轉移一次", async () => {
  await setBalances(proposerId, 1_000, 100);
  await setBalances(npcId, 0, 0);

  const treaty = await createTreaty({ offerMoney: 250, offerTechPoints: 10 });
  const results = await Promise.allSettled([
    applyNpcTreatyDecision(treaty.id, acceptDecision()),
    applyNpcTreatyDecision(treaty.id, acceptDecision()),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.equal(fulfilled.length, 1, "應恰好一個成功");

  const p = await getBalances(proposerId);
  const n = await getBalances(npcId);
  assert.equal(p.money, 750);
  assert.equal(p.techPoints, 90);
  assert.equal(n.money, 250);
  assert.equal(n.techPoints, 10);
  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "active");
});

// ── Task #570 — NPC 締約資源上限 ──

test("accept 但 NPC 付出側超過資源上限：降為 rejected、附上限說明、不轉移資源", async () => {
  await setBalances(proposerId, 1_000, 100);
  // NPC 資源歸零 → 各項上限 = 0，requestMoney 500 必然超限。
  await setBalances(npcId, 0, 0);

  const treaty = await createTreaty({ requestMoney: 500 });
  const result = await applyNpcTreatyDecision(treaty.id, acceptDecision());

  assert.equal(result.status, "rejected");
  assert.ok(
    result.responseNote?.includes("超過我國可提供的資源上限"),
    `responseNote 應說明超限：${result.responseNote}`,
  );
  assert.ok(
    result.responseNote?.includes("金錢 500 超過上限 0"),
    `responseNote 應列出上限：${result.responseNote}`,
  );

  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "rejected");
  assert.equal(stored?.awaitingNationId, null);

  // 資源完全不動。
  const p = await getBalances(proposerId);
  const n = await getBalances(npcId);
  assert.equal(p.money, 1_000);
  assert.equal(p.techPoints, 100);
  assert.equal(n.money, 0);
  assert.equal(n.techPoints, 0);
});

test("accept 且 NPC 付出側在上限內：照常成立並轉移（NPC 有足夠庫存）", async () => {
  await setBalances(proposerId, 1_000, 100);
  // NPC 有 10000 金錢 → 預設 20% 上限 = 2000；request 400 在限內。
  await setBalances(npcId, 10_000, 0);

  const treaty = await createTreaty({ requestMoney: 400 });
  const result = await applyNpcTreatyDecision(treaty.id, acceptDecision());

  assert.equal(result.status, "active");
  const p = await getBalances(proposerId);
  const n = await getBalances(npcId);
  assert.equal(p.money, 1_400);
  assert.equal(n.money, 9_600);
});

test("counter：自訂條約 NPC 為每回合付款方時，perTurnMoney 夾進上限", async () => {
  await setBalances(proposerId, 1_000, 100);
  // NPC 零人口 → 每回合稅收 0 → perTurnMoney 上限 0。
  await setBalances(npcId, 0, 0);

  // proposerIsPayer=false → perTurn* 由 NPC（target）支付。
  const treaty = await createTreaty({
    type: "custom",
    customClause: "測試自訂條款",
    perTurnMoney: 5_000,
    proposerIsPayer: false,
  });
  await applyNpcTreatyDecision(treaty.id, counterDecision());

  const counters = await getCounters(treaty.id);
  assert.equal(counters.length, 1);
  // AI 對案未調整 perTurnMoney（沿用原提案 5000）→ 伺服器端夾到上限 0。
  assert.equal(counters[0]!.perTurnMoney, 0);
  assert.equal(counters[0]!.proposerIsPayer, false);
});

test("counter：自訂條約 proposerIsPayer=true（玩家付）時 perTurn 不受 NPC 上限影響", async () => {
  await setBalances(proposerId, 1_000, 100);
  await setBalances(npcId, 0, 0);

  const treaty = await createTreaty({
    type: "custom",
    customClause: "測試自訂條款",
    perTurnMoney: 5_000,
    proposerIsPayer: true,
  });
  await applyNpcTreatyDecision(treaty.id, counterDecision());

  const counters = await getCounters(treaty.id);
  assert.equal(counters.length, 1);
  // 玩家為付款方 → NPC 上限不適用，金額原樣保留。
  assert.equal(counters[0]!.perTurnMoney, 5_000);
});
