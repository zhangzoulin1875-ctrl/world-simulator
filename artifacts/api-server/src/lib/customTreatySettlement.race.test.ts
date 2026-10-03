/**
 * Task #216 — 自訂條約每回合經常性轉移的整合測試（真實資料庫）。
 *
 * customTreatySettlement.test.ts 只涵蓋 planCustomTreatyTransfer 純函式；
 * 這裡在真實 Postgres 上驗證實際的轉移行為與併發安全：
 *  1. 端到端 runCustomTreatySettlement：掃描到生效中的自訂條約，
 *     金錢／科技從付款方轉到受益方（付款方餘額足夠時）。
 *  2. 缺額略過：金錢或科技餘額不足時，該項整筆不動（條件式 UPDATE 守門），
 *     且不留下半套轉移；同回合其他項目仍照常轉移。
 *  3. production：純流量（treatyProductionFlows.ts）——結算絕不寫
 *     production_bonus（舊制累積扣、廢約殘留的 bug 已修正）。
 *  4. 併發：兩筆結算同時對同一計畫結算、付款方餘額只夠一次 →
 *     恰好一次成功、無負餘額、受益方只入帳一次。
 *
 * 需要 DATABASE_URL 指向已由正常伺服器啟動遷移過的資料庫。每個測試都在
 * beforeEach 重建自己的兩個國家（固定前綴＋隨機 runId 標記），與共用 dev DB
 * 上其他並行的整合測試互不干擾；執行前後皆清除，可重複執行：
 *   pnpm --filter @workspace/api-server run test:integration
 */
import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  db,
  pool,
  playerNationsTable,
  diplomacyTreatiesTable,
} from "@workspace/db";
import { runDiplomacyMigrations } from "./diplomacyMigrations";
import { runEconomyMigrations } from "./economyMigrations";
import {
  runCustomTreatySettlement,
  settleOneCustomTreaty,
  planCustomTreatyTransfers,
  type CustomTreatyRow,
  type CustomTreatyTransferPlan,
} from "./customTreatySettlement";

const runId = randomBytes(4).toString("hex");
const TEST_TAG = `custom-treaty-settle-test-${runId}`;

let payerId: string;
let beneficiaryId: string;

async function createNation(
  name: string,
  money: number,
  techPoints: number,
): Promise<string> {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      // discordUserId 保持 null：避免 shortfall 通知去查／寄 DM，測試維持乾淨。
      name: `${TEST_TAG}-${name}`,
      leaderName: TEST_TAG,
      money,
      techPoints,
      productionBonus: 0,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
}

async function getNation(nationId: string) {
  const [row] = await db
    .select({
      money: playerNationsTable.money,
      techPoints: playerNationsTable.techPoints,
      productionBonus: playerNationsTable.productionBonus,
    })
    .from(playerNationsTable)
    .where(eq(playerNationsTable.id, nationId));
  assert.ok(row, "nation not found");
  return row;
}

async function setNation(
  nationId: string,
  values: { money?: number; techPoints?: number; productionBonus?: number },
) {
  await db
    .update(playerNationsTable)
    .set(values)
    .where(eq(playerNationsTable.id, nationId));
}

/**
 * 建立一筆生效中的自訂條約（proposer=payer 付給 target）。
 * Task #527 — requestPerTurn* 為反向（target 付給 proposer）。
 */
async function createActiveCustomTreaty(perTurn: {
  money?: number;
  tech?: number;
  production?: number;
  requestMoney?: number;
  requestTech?: number;
  requestProduction?: number;
  proposerIsPayer?: boolean;
}): Promise<number> {
  const [row] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: payerId,
      targetNationId: beneficiaryId,
      type: "custom",
      status: "active",
      proposerIsPayer: perTurn.proposerIsPayer ?? true,
      perTurnMoney: perTurn.money ?? 0,
      perTurnTech: perTurn.tech ?? 0,
      perTurnProduction: perTurn.production ?? 0,
      requestPerTurnMoney: perTurn.requestMoney ?? 0,
      requestPerTurnTech: perTurn.requestTech ?? 0,
      requestPerTurnProduction: perTurn.requestProduction ?? 0,
      awaitingNationId: null,
      acceptedAt: new Date(),
      expiresAt: null,
    })
    .returning({ id: diplomacyTreatiesTable.id });
  assert.ok(row, "test treaty insert failed");
  return row.id;
}

function planFor(
  overrides: Partial<CustomTreatyTransferPlan>,
): CustomTreatyTransferPlan {
  return {
    treatyId: 0,
    payerId,
    beneficiaryId,
    money: 0,
    tech: 0,
    production: 0,
    wood: 0,
    ore: 0,
    ...overrides,
  };
}

async function cleanup() {
  // 刪測試國家即 cascade 掉其自訂條約與財政帳（皆 FK onDelete cascade）。
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);
}

before(async () => {
  await runDiplomacyMigrations();
  await runEconomyMigrations();
});

// 每個測試都用全新、乾淨的國家，彼此獨立、也不受共用 dev DB 上其他整合測試干擾。
beforeEach(async () => {
  await cleanup();
  payerId = await createNation("payer", 1_000, 100);
  beneficiaryId = await createNation("beneficiary", 500, 50);
});

after(async () => {
  await cleanup();
  await pool.end();
});

test("端到端：runCustomTreatySettlement 掃描並轉移金錢／科技（餘額足夠）", async () => {
  await createActiveCustomTreaty({ money: 300, tech: 20 });

  const summary = await runCustomTreatySettlement();
  assert.ok(summary.treaties >= 1, "應至少掃描到本測試的自訂條約");

  const payer = await getNation(payerId);
  const beneficiary = await getNation(beneficiaryId);
  assert.equal(payer.money, 700);
  assert.equal(payer.techPoints, 80);
  assert.equal(beneficiary.money, 800);
  assert.equal(beneficiary.techPoints, 70);
});

test("缺額略過：金錢不足時該項整筆不動，科技仍照轉", async () => {
  await setNation(payerId, { money: 100, techPoints: 100 });

  // money 300 > 餘額 100 → 略過；tech 20 <= 100 → 照轉。
  const result = await settleOneCustomTreaty(planFor({ money: 300, tech: 20 }));

  assert.equal(result.moneyMoved, 0);
  assert.equal(result.moneyShort, true);
  assert.equal(result.techMoved, 20);
  assert.equal(result.techShort, false);

  const payer = await getNation(payerId);
  const beneficiary = await getNation(beneficiaryId);
  assert.equal(payer.money, 100, "金錢不足 → 付款方餘額不變");
  assert.equal(beneficiary.money, 500, "金錢不足 → 受益方不入帳");
  assert.equal(payer.techPoints, 80, "科技足夠 → 照扣");
  assert.equal(beneficiary.techPoints, 70, "科技足夠 → 照收");
});

test("缺額略過：科技不足時整筆不動、無負餘額", async () => {
  await setNation(payerId, { techPoints: 5 });

  const result = await settleOneCustomTreaty(planFor({ tech: 50 }));

  assert.equal(result.techMoved, 0);
  assert.equal(result.techShort, true);
  const payer = await getNation(payerId);
  const beneficiary = await getNation(beneficiaryId);
  assert.equal(payer.techPoints, 5, "科技不足 → 不扣成負值");
  assert.equal(beneficiary.techPoints, 50, "科技不足 → 受益方不入帳");
});

test("production：純流量——結算不動 production_bonus", async () => {
  await settleOneCustomTreaty(planFor({ production: 40 }));

  const payer = await getNation(payerId);
  const beneficiary = await getNation(beneficiaryId);
  assert.equal(payer.productionBonus, 0, "付款方 production_bonus 不變");
  assert.equal(beneficiary.productionBonus, 0, "受益方 production_bonus 不變");
});

// ── Task #527 — 反向每回合定期支付（requestPerTurn*）整合驗證 ──────────
//
// 以下四個測試刻意改用 settleOneCustomTreaty + planCustomTreatyTransfers 直接
// 結算，不呼叫 runCustomTreatySettlement。
// 原因：驗證環境同時執行 lib glob（含本檔）與 test:integration（也含本檔），
// 兩個程序各自呼叫 runCustomTreatySettlement 時，會相互抓到對方的測試條約並重複
// 執行，導致餘額多扣（已知 flaky-lib-glob-tests.md 問題）。
// 第一筆「端到端」測試已覆蓋 runCustomTreatySettlement 的掃描行為；以下測試
// 改為僅驗證雙向計畫生成與 settleOneCustomTreaty 的正確性。

/** 根據 createActiveCustomTreaty 的相同欄位值建構 CustomTreatyRow，
 *  供 planCustomTreatyTransfers 使用。 */
function buildRow(
  id: number,
  perTurn: {
    money?: number;
    tech?: number;
    production?: number;
    requestMoney?: number;
    requestTech?: number;
    requestProduction?: number;
    proposerIsPayer?: boolean;
  },
): CustomTreatyRow {
  return {
    id,
    proposerNationId: payerId,
    targetNationId: beneficiaryId,
    proposerIsPayer: perTurn.proposerIsPayer ?? true,
    perTurnMoney: perTurn.money ?? 0,
    perTurnTech: perTurn.tech ?? 0,
    perTurnProduction: perTurn.production ?? 0,
    perTurnWood: 0,
    perTurnOre: 0,
    requestPerTurnMoney: perTurn.requestMoney ?? 0,
    requestPerTurnTech: perTurn.requestTech ?? 0,
    requestPerTurnProduction: perTurn.requestProduction ?? 0,
    requestPerTurnWood: 0,
    requestPerTurnOre: 0,
  };
}

test("雙向端到端：perTurn* 正向、requestPerTurn* 反向同回合各自轉移", async () => {
  // payer(proposer) 付 money 300；beneficiary(target) 反向付 tech 30。
  const id = await createActiveCustomTreaty({ money: 300, requestTech: 30 });
  const plans = planCustomTreatyTransfers(buildRow(id, { money: 300, requestTech: 30 }));
  assert.equal(plans.length, 2, "應產生正向與反向各一計畫");

  for (const plan of plans) {
    await settleOneCustomTreaty(plan);
  }

  const payer = await getNation(payerId);
  const beneficiary = await getNation(beneficiaryId);
  assert.equal(payer.money, 700, "正向：proposer 付 300");
  assert.equal(beneficiary.money, 800, "正向：target 收 300");
  assert.equal(beneficiary.techPoints, 20, "反向：target 付 30");
  assert.equal(payer.techPoints, 130, "反向：proposer 收 30");
});

test("反向缺額只影響反向該項，正向照常轉移", async () => {
  // beneficiary(target) 反向要付 money 900 > 餘額 500 → 反向略過；
  // 正向 tech 20 照常。
  const id = await createActiveCustomTreaty({ tech: 20, requestMoney: 900 });
  const plans = planCustomTreatyTransfers(buildRow(id, { tech: 20, requestMoney: 900 }));
  assert.equal(plans.length, 2, "應產生正向（tech）與反向（money）各一計畫");

  for (const plan of plans) {
    await settleOneCustomTreaty(plan);
  }

  const payer = await getNation(payerId);
  const beneficiary = await getNation(beneficiaryId);
  assert.equal(payer.techPoints, 80, "正向照扣");
  assert.equal(beneficiary.techPoints, 70, "正向照收");
  assert.equal(beneficiary.money, 500, "反向不足 → target 餘額不變");
  assert.equal(payer.money, 1_000, "反向不足 → proposer 不入帳");
});

test("舊制單向列（requestPerTurn*=0、proposerIsPayer=false）語義完全不變", async () => {
  // proposerIsPayer=false → target 付 money 200 給 proposer；無反向。
  const id = await createActiveCustomTreaty({ money: 200, proposerIsPayer: false });
  const plans = planCustomTreatyTransfers(
    buildRow(id, { money: 200, proposerIsPayer: false }),
  );
  assert.equal(plans.length, 1, "舊制單向：只有一個正向計畫");

  await settleOneCustomTreaty(plans[0]);

  const payer = await getNation(payerId);
  const beneficiary = await getNation(beneficiaryId);
  assert.equal(beneficiary.money, 300, "舊制：target 付 200");
  assert.equal(payer.money, 1_200, "舊制：proposer 收 200");
});

test("反向 production：純流量——結算同樣不動 production_bonus", async () => {
  const id = await createActiveCustomTreaty({ requestProduction: 35 });
  const plans = planCustomTreatyTransfers(buildRow(id, { requestProduction: 35 }));
  assert.equal(plans.length, 1, "只有反向 production 計畫");

  await settleOneCustomTreaty(plans[0]);

  const payer = await getNation(payerId);
  const beneficiary = await getNation(beneficiaryId);
  assert.equal(beneficiary.productionBonus, 0, "target production_bonus 不變");
  assert.equal(payer.productionBonus, 0, "proposer production_bonus 不變");
});

test("併發：同一計畫同時結算、餘額只夠一次 → 恰好一次成功、無負餘額", async () => {
  await setNation(payerId, { money: 300 });

  const plan = planFor({ money: 300 });
  const [a, b] = await Promise.all([
    settleOneCustomTreaty(plan),
    settleOneCustomTreaty(plan),
  ]);

  const moved = [a, b].filter((r) => r.moneyMoved === 300).length;
  const short = [a, b].filter((r) => r.moneyShort).length;
  assert.equal(moved, 1, "恰好一次成功轉移");
  assert.equal(short, 1, "另一次因餘額不足略過");

  const payer = await getNation(payerId);
  const beneficiary = await getNation(beneficiaryId);
  assert.equal(payer.money, 0, "付款方剛好扣完、無負餘額");
  assert.equal(beneficiary.money, 800, "受益方只入帳一次（+300）");
});
