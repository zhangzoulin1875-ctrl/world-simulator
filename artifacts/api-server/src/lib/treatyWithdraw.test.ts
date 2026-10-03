import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq, or, sql } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  diplomacyTreatiesTable,
  type DiplomacyTreaty,
} from "@workspace/db";
import { runDiplomacyMigrations } from "./diplomacyMigrations";
import { HttpError, activateTreaty } from "./treatyActivation";
import { withdrawTreatyAsNation } from "./treatyWithdraw";

/**
 * Task #71 — 撤回條約提案（withdrawTreatyAsNation）的整合測試。
 * 走真實資料庫驗證：
 * - 提案國撤回 proposed 提案成功（status → withdrawn、awaiting 清空）
 * - 撤回後同一 pair 可再送出新提案（部分唯一索引解鎖）
 * - 非當事國 → 403
 * - 非 proposed → 409
 * - awaiting 是自己（NPC 對案）→ 400（應改用接受／拒絕）
 * - 與對方同時接受的競態 → 恰好一方成功
 */

const TEST_TAG = "treaty-withdraw-test";

let proposerId: string;
let targetId: string;
let outsiderId: string;

async function createNation(name: string, money = 1_000, techPoints = 100) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}-${name}`,
      leaderName: TEST_TAG,
      money,
      techPoints,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function createTreaty(
  overrides: Partial<{
    status: string;
    awaitingNationId: string;
    offerMoney: number;
  }> = {},
): Promise<DiplomacyTreaty> {
  const [row] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: proposerId,
      targetNationId: targetId,
      type: "nonaggression",
      durationDays: null,
      offerMoney: overrides.offerMoney ?? 0,
      offerTechPoints: 0,
      offerRegionIds: [],
      status: overrides.status ?? "proposed",
      awaitingNationId: overrides.awaitingNationId ?? targetId,
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

/** 模擬 accept 路由的交易（FOR UPDATE ＋ proposed 檢查 ＋ activateTreaty）。 */
async function acceptAsTarget(treatyId: number) {
  return db.transaction(async (tx) => {
    const [treaty] = await tx
      .select()
      .from(diplomacyTreatiesTable)
      .where(eq(diplomacyTreatiesTable.id, treatyId))
      .for("update");
    if (!treaty) throw new HttpError(404, "找不到這個條約");
    if (treaty.status !== "proposed") {
      throw new HttpError(400, "這個條約已不在待回覆狀態");
    }
    if (treaty.awaitingNationId !== targetId) {
      throw new HttpError(403, "這個條約目前不需要你回覆");
    }
    return activateTreaty(tx, treaty);
  });
}

before(async () => {
  await runDiplomacyMigrations();
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);

  proposerId = await createNation("proposer");
  targetId = await createNation("target");
  outsiderId = await createNation("outsider");
});

beforeEach(async () => {
  await db
    .delete(diplomacyTreatiesTable)
    .where(
      or(
        eq(diplomacyTreatiesTable.proposerNationId, proposerId),
        eq(diplomacyTreatiesTable.targetNationId, proposerId),
      ),
    );
  await db
    .update(playerNationsTable)
    .set({ money: 1_000, techPoints: 100 })
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);
});

after(async () => {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);
  await pool.end();
});

test("提案國撤回 proposed 提案：status → withdrawn、awaiting 清空", async () => {
  const treaty = await createTreaty();
  const withdrawn = await withdrawTreatyAsNation(treaty.id, proposerId);

  assert.equal(withdrawn.status, "withdrawn");
  assert.equal(withdrawn.awaitingNationId, null);
  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "withdrawn");
  assert.equal(stored?.awaitingNationId, null);
});

test("撤回後同一 pair 可再送出新提案（部分唯一索引解鎖）", async () => {
  const treaty = await createTreaty();
  await withdrawTreatyAsNation(treaty.id, proposerId);

  // 撤回前若直接再插入 proposed 會撞 diplomacy_treaties_proposed_pair_uidx。
  const second = await createTreaty();
  assert.equal(second.status, "proposed");
});

test("非當事國撤回 → 403，條約不變", async () => {
  const treaty = await createTreaty();
  await assert.rejects(
    withdrawTreatyAsNation(treaty.id, outsiderId),
    (err: unknown) => err instanceof HttpError && err.status === 403,
  );
  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "proposed");
});

test("非 proposed 條約撤回 → 409", async () => {
  const treaty = await createTreaty({ status: "active" });
  await assert.rejects(
    withdrawTreatyAsNation(treaty.id, proposerId),
    (err: unknown) => err instanceof HttpError && err.status === 409,
  );
  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "active");
});

test("awaiting 是自己（NPC 對案等我回覆）→ 400，應改用接受／拒絕", async () => {
  const treaty = await createTreaty({ awaitingNationId: proposerId });
  await assert.rejects(
    withdrawTreatyAsNation(treaty.id, proposerId),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );
  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.status, "proposed");
});

test("不存在的條約 → 404", async () => {
  await assert.rejects(
    withdrawTreatyAsNation(999_999_999, proposerId),
    (err: unknown) => err instanceof HttpError && err.status === 404,
  );
});

test("提案國撤回與對方接受同時進來：恰好一方成功", async () => {
  const treaty = await createTreaty({ offerMoney: 400 });
  const results = await Promise.allSettled([
    withdrawTreatyAsNation(treaty.id, proposerId),
    acceptAsTarget(treaty.id),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  assert.equal(fulfilled.length, 1, "應恰好一方成功");
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]!.reason instanceof HttpError,
    `輸家應收到 HttpError，實際：${String(rejected[0]!.reason)}`,
  );

  const stored = await getTreaty(treaty.id);
  assert.ok(stored, "條約列不應消失");
  const [p] = await db
    .select({ money: playerNationsTable.money })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, proposerId));
  const [t] = await db
    .select({ money: playerNationsTable.money })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, targetId));
  if (stored.status === "withdrawn") {
    // 撤回贏：資源完全不動。
    assert.equal(p?.money, 1_000);
    assert.equal(t?.money, 1_000);
  } else {
    // 接受贏：資源恰好轉移一次。
    assert.equal(stored.status, "active");
    assert.equal(p?.money, 600);
    assert.equal(t?.money, 1_400);
  }
});
