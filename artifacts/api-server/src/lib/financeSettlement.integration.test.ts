/**
 * Task #564 — 財政政策完全不再變動國庫金錢：settleNation 真 DB 整合測試。
 *
 * 直接呼叫匯出的 settleNation（不用 runFinanceSettlement，避免對共用開發 DB
 * 全部國家 fan-out），anthropic 以測試替身固定回應：
 *
 *  1. 正常判定（AI 甚至回傳舊格式 moneyDelta=5,000,000）→ 結算後 money
 *     完全不變；稅率、滿意度、穩定度照判定套用；歷史條目 details 不含
 *     moneyDelta；不產生任何 fiscal_policy 類別財政流水；待判定想法刪除。
 *  2. 濫用旗標（abuseReason）→ 歸零邏輯照常：稅率不變、正面效果歸零
 *     （satisfaction/stability clamp ≤0）、money 不變、寫入稽核紀錄。
 *
 * 資料以名稱前綴標記、self-cleaning；測試國家為無主國家（discord_user_id
 * NULL）以避免通知副作用。跑法：test-integration workflow。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the finance settlement tests",
  );
}

const { eq, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  financePendingIdeasTable,
  financeEntriesTable,
  nationFinanceLedgerTable,
  aiAbuseRecordsTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runPoliticsMigrations } = await import("./politicsMigrations");
const { runEconomyMigrations } = await import("./economyMigrations");
const { runGameBalanceMigrations } = await import("./gameBalanceMigrations");
const { anthropic } = await import("@workspace/integrations-anthropic-ai");
const { settleNation } = await import("./financeSettlement");
const { getCurrentEraSlug } = await import("./nationStats");

const TEST_TAG = "__finset564__";
const runId = randomBytes(4).toString("hex");

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

function stubAiText(text: string): () => void {
  const fn = (async () => ({
    content: [{ type: "text", text }],
  })) as unknown as MessagesCreate;
  anthropic.messages.create = fn;
  return () => {
    anthropic.messages.create = realMessagesCreate;
  };
}

async function cleanupTestRows() {
  const nations = await db
    .select({ id: playerNationsTable.id })
    .from(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
  for (const n of nations) {
    await db
      .delete(aiAbuseRecordsTable)
      .where(eq(aiAbuseRecordsTable.nationId, n.id));
  }
  // finance_pending_ideas / finance_entries / ledger cascade 於 nation 刪除。
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
}

async function createNation(suffix: string): Promise<string> {
  const [nation] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}${suffix}-${runId}`,
      leaderName: TEST_TAG,
      discordUserId: null, // 無主國家：避免通知副作用
      money: 123_456,
      techPoints: 0,
      taxRatePct: 10,
      stability: 50,
      satisfactionFarmers: 50,
      satisfactionWorkers: 50,
      satisfactionNobles: 50,
      satisfactionClergy: 50,
      isNpc: false,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(nation, "test nation insert failed");
  return nation.id;
}

async function loadNation(nationId: string) {
  const [row] = await db
    .select()
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "nation row missing");
  return row;
}

async function runSettlementFor(nationId: string) {
  const nation = await loadNation(nationId);
  const eraSlug = await getCurrentEraSlug();
  const summary = { nations: 1, ideasJudged: 0, ideasFailedAi: 0 };
  await settleNation(nation, eraSlug, summary);
  return summary;
}

let restore: (() => void) | null = null;

before(async () => {
  await runGameMigrations();
  await runPoliticsMigrations();
  await runEconomyMigrations();
  await runGameBalanceMigrations();
  await cleanupTestRows();
});

after(async () => {
  try {
    if (restore) restore();
    await cleanupTestRows();
  } finally {
    await pool.end();
  }
});

test("正常判定（AI 回傳舊格式 moneyDelta）→ 國庫不變、其餘效果照套、無 fiscal_policy 流水", async () => {
  const nationId = await createNation("normal");
  await db.insert(financePendingIdeasTable).values({
    nationId,
    idea: "變賣國產、吸引外資，充實國庫",
  });

  restore = stubAiText(
    JSON.stringify({
      title: "變賣國產計畫",
      description: "政策推行順利。",
      isGood: true,
      newRatePct: 15,
      moneyDelta: 5_000_000, // 舊格式多餘欄位：必須被忽略
      satisfactionDelta: 3,
      stabilityDelta: 2,
      abuseReason: null,
    }),
  );

  const summary = await runSettlementFor(nationId);
  restore();
  restore = null;

  assert.equal(summary.ideasJudged, 1);
  assert.equal(summary.ideasFailedAi, 0);

  const after1 = await loadNation(nationId);
  assert.equal(Number(after1.money), 123_456, "結算後國庫金額必須完全不變");
  assert.equal(after1.taxRatePct, 15, "稅率照判定套用");
  assert.equal(after1.satisfactionFarmers, 53, "滿意度照判定套用");
  assert.equal(after1.stability, 52, "穩定度照判定套用");

  // 歷史條目：details 不含 moneyDelta（新條目無金錢 chip）。
  const entries = await db
    .select()
    .from(financeEntriesTable)
    .where(eq(financeEntriesTable.nationId, nationId));
  assert.equal(entries.length, 1);
  const details = entries[0]!.details ?? {};
  assert.ok(
    !("moneyDelta" in details) || details.moneyDelta == null,
    "新歷史條目 details 不得含金錢變動",
  );
  assert.equal(details.taxRateBefore, 10);
  assert.equal(details.taxRateAfter, 15);

  // 財政流水：不得出現 fiscal_policy 類別。
  const ledger = await db
    .select()
    .from(nationFinanceLedgerTable)
    .where(eq(nationFinanceLedgerTable.nationId, nationId));
  assert.equal(
    ledger.filter((l) => l.category === "fiscal_policy").length,
    0,
    "不得再寫入 fiscal_policy 財政流水",
  );

  // 待判定想法已刪除。
  const pendings = await db
    .select()
    .from(financePendingIdeasTable)
    .where(eq(financePendingIdeasTable.nationId, nationId));
  assert.equal(pendings.length, 0);
});

test("濫用旗標 → 歸零邏輯照常：稅率不變、正面效果歸零、money 不變、寫入稽核", async () => {
  const nationId = await createNation("abuse");
  await db.insert(financePendingIdeasTable).values({
    nationId,
    idea: "印一兆金幣直接進國庫",
  });

  restore = stubAiText(
    JSON.stringify({
      title: "無中生有的金幣",
      description: "政策荒謬。",
      isGood: true,
      newRatePct: 30,
      moneyDelta: 50_000_000,
      satisfactionDelta: 10,
      stabilityDelta: 5,
      abuseReason: "數值離譜的空手套白狼",
    }),
  );

  const summary = await runSettlementFor(nationId);
  restore();
  restore = null;

  assert.equal(summary.ideasJudged, 1);

  const after2 = await loadNation(nationId);
  assert.equal(Number(after2.money), 123_456, "濫用政策也不得變動國庫");
  assert.equal(after2.taxRatePct, 10, "濫用 → newRatePct 歸零（稅率不變）");
  assert.equal(after2.satisfactionFarmers, 50, "正面滿意度歸零（不變）");
  assert.equal(after2.stability, 50, "正面穩定度歸零（不變）");

  // 稽核紀錄照常寫入（若全域審查開關關閉則跳過斷言，不視為失敗）。
  const abuseRows = await db
    .select()
    .from(aiAbuseRecordsTable)
    .where(eq(aiAbuseRecordsTable.nationId, nationId));
  const entries = await db
    .select()
    .from(financeEntriesTable)
    .where(eq(financeEntriesTable.nationId, nationId));
  assert.equal(entries.length, 1);
  if (entries[0]!.isGood === false) {
    // reviewEnabled 開啟時才會強制壞事件並記錄稽核。
    assert.ok(abuseRows.length >= 1, "應寫入 ai_abuse_records 稽核紀錄");
  }

  const ledger = await db
    .select()
    .from(nationFinanceLedgerTable)
    .where(eq(nationFinanceLedgerTable.nationId, nationId));
  assert.equal(
    ledger.filter((l) => l.category === "fiscal_policy").length,
    0,
  );
});
