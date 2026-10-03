import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq, or, sql } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  diplomacyTreatiesTable,
} from "@workspace/db";
import { runDiplomacyMigrations } from "./diplomacyMigrations";
import { warnExpiringTreaties, EXPIRY_WARNING_WINDOW_MS } from "./diplomacy";

/**
 * Task #57 — 條約到期前預警（warnExpiringTreaties）的整合測試。
 * 走真實資料庫驗證：
 * - 生效中、24 小時內到期、未預警 → 被認領（回傳 + expiry_warned_at 設值）
 * - 只認領一次（第二次呼叫不再回傳同一條約）
 * - 到期還很久（> 24 小時）→ 不預警
 * - 已過期（expires_at < NOW()）→ 不預警（留給到期迴圈標記 expired）
 * - 非 active（proposed/expired）→ 不預警
 * - expires_at 為 null（無期限）→ 不預警
 */

const TEST_TAG = "treaty-expiry-warning-test";

let proposerId: string;
let targetId: string;

async function createNation(name: string) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({ name: `${TEST_TAG}-${name}`, leaderName: TEST_TAG })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function createTreaty(
  overrides: Partial<{
    status: string;
    expiresInMs: number | null;
    expiryWarnedAt: Date | null;
  }> = {},
) {
  const expiresInMs =
    overrides.expiresInMs === undefined ? null : overrides.expiresInMs;
  const expiresAt =
    expiresInMs === null ? null : new Date(Date.now() + expiresInMs);
  const [row] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: proposerId,
      targetNationId: targetId,
      type: "nonaggression",
      status: overrides.status ?? "active",
      expiresAt,
      expiryWarnedAt: overrides.expiryWarnedAt ?? null,
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

before(async () => {
  await runDiplomacyMigrations();
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);
  proposerId = await createNation("proposer");
  targetId = await createNation("target");
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
});

after(async () => {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);
  await pool.end();
});

test("生效中、24 小時內到期、未預警 → 被認領並設定 expiry_warned_at", async () => {
  const treaty = await createTreaty({ expiresInMs: 12 * 60 * 60 * 1000 });
  const warned = await warnExpiringTreaties();
  const ids = warned.map((w) => w.id);
  assert.ok(ids.includes(treaty.id), "應認領即將到期的條約");
  const stored = await getTreaty(treaty.id);
  assert.ok(stored?.expiryWarnedAt, "expiry_warned_at 應被設值");
});

test("同一條約只認領一次（重啟後不重複通知）", async () => {
  const treaty = await createTreaty({ expiresInMs: 6 * 60 * 60 * 1000 });
  const first = await warnExpiringTreaties();
  assert.ok(first.map((w) => w.id).includes(treaty.id));
  const second = await warnExpiringTreaties();
  assert.ok(
    !second.map((w) => w.id).includes(treaty.id),
    "第二次呼叫不得再回傳已預警的條約",
  );
});

test("到期還很久（> 24 小時）→ 不預警", async () => {
  const treaty = await createTreaty({
    expiresInMs: EXPIRY_WARNING_WINDOW_MS + 60 * 60 * 1000,
  });
  const warned = await warnExpiringTreaties();
  assert.ok(!warned.map((w) => w.id).includes(treaty.id));
  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.expiryWarnedAt, null);
});

test("已過期（expires_at < NOW()）→ 不預警", async () => {
  const treaty = await createTreaty({ expiresInMs: -60 * 60 * 1000 });
  const warned = await warnExpiringTreaties();
  assert.ok(!warned.map((w) => w.id).includes(treaty.id));
  const stored = await getTreaty(treaty.id);
  assert.equal(stored?.expiryWarnedAt, null);
});

test("非 active（proposed）→ 不預警", async () => {
  const treaty = await createTreaty({
    status: "proposed",
    expiresInMs: 6 * 60 * 60 * 1000,
  });
  const warned = await warnExpiringTreaties();
  assert.ok(!warned.map((w) => w.id).includes(treaty.id));
});

test("無期限（expires_at 為 null）→ 不預警", async () => {
  const treaty = await createTreaty({ expiresInMs: null });
  const warned = await warnExpiringTreaties();
  assert.ok(!warned.map((w) => w.id).includes(treaty.id));
});
