import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  diplomacyTreatiesTable,
  diplomacyWarsTable,
  type DiplomacyTreaty,
} from "@workspace/db";
import { runDiplomacyMigrations } from "./diplomacyMigrations";
import { runWarMigrations } from "./warMigrations";
import { activateTreaty, HttpError } from "./treatyActivation";

/**
 * Task #42 — activateTreaty 交易邏輯的整合測試（真實資料庫）。
 * 驗證：餘額不足 400 且全額 rollback、領土已易主 400、percent 合併、
 * 合併超過 100% 被夾住不炸 CHECK、重複接受 409 不重複轉移、
 * 兩個交易同時接受同一條約只會有一個贏家。
 *
 * 測試資料自成一體：建立專屬測試國家（cascade 清掉 controls/treaties），
 * 只借用「目前完全無人掌控」的 map_regions 列，結束時全部刪除。
 */

const TEST_TAG = "treaty-activation-test";

let nationAId: string;
let nationBId: string;
let freeRegionIds: number[] = [];

async function createNation(name: string, money: number, techPoints: number) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}-${name}`,
      leaderName: TEST_TAG,
      money,
      techPoints,
      // 稅率設 0：驗證管線會與 test:integration 併跑共用開發 DB，整合測試
      // 強制觸發的回合結算會對「持有地區」的國家發稅收，污染本檔的金錢
      // 精確斷言（例：600 變 630）。稅率 0 → 稅收恆為 0，隔絕該干擾。
      taxRatePct: 0,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
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

async function setBalances(nationId: string, money: number, techPoints: number) {
  await db
    .update(playerNationsTable)
    .set({ money, techPoints })
    .where(eq(playerNationsTable.id, nationId));
}

async function createTreaty(
  overrides: Partial<{
    type: string;
    offerMoney: number;
    offerTechPoints: number;
    offerRegionIds: number[];
    offerRegionPercents: Record<string, number>;
    requestMoney: number;
    requestTechPoints: number;
    requestRegionIds: number[];
    requestRegionPercents: Record<string, number>;
    proposerIsPayer: boolean;
    boundWarId: number | null;
    durationDays: number | null;
    status: string;
  }> = {},
): Promise<DiplomacyTreaty> {
  const [row] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: nationAId,
      targetNationId: nationBId,
      type: overrides.type ?? "nonaggression",
      durationDays: overrides.durationDays ?? null,
      offerMoney: overrides.offerMoney ?? 0,
      offerTechPoints: overrides.offerTechPoints ?? 0,
      offerRegionIds: overrides.offerRegionIds ?? [],
      offerRegionPercents: overrides.offerRegionPercents ?? {},
      requestMoney: overrides.requestMoney ?? 0,
      requestTechPoints: overrides.requestTechPoints ?? 0,
      requestRegionIds: overrides.requestRegionIds ?? [],
      requestRegionPercents: overrides.requestRegionPercents ?? {},
      proposerIsPayer: overrides.proposerIsPayer ?? true,
      boundWarId: overrides.boundWarId ?? null,
      status: overrides.status ?? "proposed",
      awaitingNationId: nationBId,
    })
    .returning();
  assert.ok(row, "test treaty insert failed");
  return row;
}

/**
 * Task #345 — 建立一場進行中的戰爭（canonical pair，nation_a_id < nation_b_id），
 * 供附條件停戰測試綁定（boundWarId）。回傳 war id。
 */
async function createWar(): Promise<number> {
  const [a, b] =
    nationAId < nationBId ? [nationAId, nationBId] : [nationBId, nationAId];
  const [row] = await db
    .insert(diplomacyWarsTable)
    .values({ nationAId: a, nationBId: b, declaredByNationId: nationAId })
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

async function clearTestWars() {
  await db
    .delete(diplomacyWarsTable)
    .where(
      or(
        inArray(diplomacyWarsTable.nationAId, [nationAId, nationBId]),
        inArray(diplomacyWarsTable.nationBId, [nationAId, nationBId]),
      ),
    );
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

async function getControl(regionId: number, nationId: string) {
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

async function clearTestControls() {
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.nationId, [nationAId, nationBId]));
}

/** 模擬 accept 路由的交易：SELECT ... FOR UPDATE → 狀態檢查 → activateTreaty。 */
function acceptLikeRoute(treatyId: number) {
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
    return activateTreaty(tx, treaty);
  });
}

before(async () => {
  await runDiplomacyMigrations();
  // Task #345 — 附條件停戰測試需要 diplomacy_wars 的 ended_at / ceasefire_proposed_by
  // 欄位（由戰爭遷移補上，idempotent）。
  await runWarMigrations();

  // 清掉先前殘留的測試資料（若上次執行中斷）。
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);

  nationAId = await createNation("proposer", 1_000, 100);
  nationBId = await createNation("target", 500, 50);

  // 借用目前完全無人掌控的地區（測試結束會刪掉自己的 control 列）。
  const rows = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    // 測試隔離：跳過前段地區，避免與其他共用 dev DB 的真實資料庫測試
    // （regionControlHealth 用 offset 80、player.race 用 offset 0）並行搶到同一地區。
    .offset(120)
    .limit(4);
  freeRegionIds = rows.map((r) => r.id);
  assert.ok(
    freeRegionIds.length >= 4,
    "測試需要至少 4 個無人掌控的地區",
  );
});

// Task #67 之後同一 pair 僅允許一筆 proposed（部分唯一索引），
// 每個測試前清掉測試國家間殘留的條約，避免跨測試互相干擾。
beforeEach(async () => {
  await db
    .delete(diplomacyTreatiesTable)
    .where(
      or(
        eq(diplomacyTreatiesTable.proposerNationId, nationAId),
        eq(diplomacyTreatiesTable.targetNationId, nationAId),
      ),
    );
  // Task #345 — 進行中的戰爭 pair 有 partial unique 索引；清掉殘留戰爭避免
  // 下個附條件停戰測試 createWar 撞 23505。
  await clearTestWars();
});

after(async () => {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);
  await pool.end();
});

test("成功成立：金錢／科技點數／領土一次轉移，條約轉 active", async () => {
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 500, 50);
  await clearTestControls();
  const regionId = freeRegionIds[0]!;
  await setControl(regionId, nationAId, 40);

  const treaty = await createTreaty({
    offerMoney: 300,
    offerTechPoints: 20,
    offerRegionIds: [regionId],
    durationDays: 30,
  });
  const activated = await db.transaction((tx) => activateTreaty(tx, treaty));

  assert.equal(activated.status, "active");
  assert.equal(activated.awaitingNationId, null);
  assert.ok(activated.acceptedAt);
  assert.ok(activated.expiresAt);

  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 700);
  assert.equal(a.techPoints, 80);
  assert.equal(b.money, 800);
  assert.equal(b.techPoints, 70);
  assert.equal(await getControl(regionId, nationAId), null);
  assert.equal(await getControl(regionId, nationBId), 40);
});

test("金錢不足：400 且不動任何餘額，條約維持 proposed", async () => {
  await setBalances(nationAId, 100, 100);
  await setBalances(nationBId, 500, 50);

  const treaty = await createTreaty({ offerMoney: 999_999 });
  await assert.rejects(
    db.transaction((tx) => activateTreaty(tx, treaty)),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 100);
  assert.equal(b.money, 500);
  const [row] = await db
    .select({ status: diplomacyTreatiesTable.status })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.id, treaty.id));
  assert.equal(row?.status, "proposed");
});

test("科技點數不足：400 且不動任何餘額", async () => {
  await setBalances(nationAId, 1_000, 5);
  await setBalances(nationBId, 500, 50);

  const treaty = await createTreaty({ offerMoney: 10, offerTechPoints: 50 });
  await assert.rejects(
    db.transaction((tx) => activateTreaty(tx, treaty)),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 1_000);
  assert.equal(a.techPoints, 5);
  assert.equal(b.money, 500);
  assert.equal(b.techPoints, 50);
});

test("領土已不在提案國掌控：400 且金錢轉移也 rollback", async () => {
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 500, 50);
  await clearTestControls();
  const regionId = freeRegionIds[1]!;
  // 提案時掌控、成立前已易主 → 提案國沒有該地區 control 列。

  const treaty = await createTreaty({
    offerMoney: 300,
    offerRegionIds: [regionId],
  });
  await assert.rejects(
    db.transaction((tx) => activateTreaty(tx, treaty)),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  // 金錢扣款發生在領土檢查之前，rollback 必須把它還原。
  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 1_000);
  assert.equal(b.money, 500);
});

test("接受方已掌控部分地區：percent 相加合併為單一列", async () => {
  await clearTestControls();
  const regionId = freeRegionIds[2]!;
  await setControl(regionId, nationAId, 40);
  await setControl(regionId, nationBId, 30);

  const treaty = await createTreaty({ offerRegionIds: [regionId] });
  await db.transaction((tx) => activateTreaty(tx, treaty));

  assert.equal(await getControl(regionId, nationAId), null);
  assert.equal(await getControl(regionId, nationBId), 70);
});

test("極端資料合併超過 100%：夾在 100，不撞 CHECK constraint", async () => {
  await clearTestControls();
  const regionId = freeRegionIds[3]!;
  // 歷史資料不一致（60 + 50 = 110 > 100）也不能把交易炸成 500。
  await setControl(regionId, nationAId, 60);
  await setControl(regionId, nationBId, 50);

  const treaty = await createTreaty({ offerRegionIds: [regionId] });
  await db.transaction((tx) => activateTreaty(tx, treaty));

  assert.equal(await getControl(regionId, nationAId), null);
  assert.equal(await getControl(regionId, nationBId), 100);
});

test("重複接受：第二次 409 且資源不會重複轉移", async () => {
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 500, 50);

  const treaty = await createTreaty({ offerMoney: 200, offerTechPoints: 10 });
  await db.transaction((tx) => activateTreaty(tx, treaty));

  // 用原始（仍是 proposed 狀態）的 treaty 物件再跑一次 —
  // 模擬拿到過期快照的呼叫端。
  await assert.rejects(
    db.transaction((tx) => activateTreaty(tx, treaty)),
    (err: unknown) => err instanceof HttpError && err.status === 409,
  );

  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 800);
  assert.equal(a.techPoints, 90);
  assert.equal(b.money, 700);
  assert.equal(b.techPoints, 60);
});

test("兩個交易同時接受同一條約：恰好一個成功，資源只轉移一次", async () => {
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 500, 50);

  const treaty = await createTreaty({ offerMoney: 400, offerTechPoints: 30 });
  const results = await Promise.allSettled([
    acceptLikeRoute(treaty.id),
    acceptLikeRoute(treaty.id),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected",
  );
  assert.equal(fulfilled.length, 1, "應恰好一個交易成功");
  assert.equal(rejected.length, 1);
  const err = rejected[0]!.reason;
  assert.ok(
    err instanceof HttpError && (err.status === 400 || err.status === 409),
    `輸家應收到 400/409 HttpError，實際：${String(err)}`,
  );

  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 600);
  assert.equal(a.techPoints, 70);
  assert.equal(b.money, 900);
  assert.equal(b.techPoints, 80);
});

test("附條件停戰：索求金錢／科技與部分割地精確轉移，付款方保留其餘、受益方夾在 100，戰爭結束", async () => {
  // 提案方（nationA）向對象（nationB）索求 → proposerIsPayer=false：
  //   付款方 = nationB（對象），受益方 = nationA（提案方）。
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 500, 50);
  await clearTestControls();

  const emptyRegion = freeRegionIds[0]!; // 受益方原本沒有掌控 → 精確加上索求百分比。
  const cappedRegion = freeRegionIds[1]!; // 受益方原本已高掌控 → LEAST(..., 100) 夾住。
  // 付款方 nationB 的掌控（被索求方）。
  await setControl(emptyRegion, nationBId, 50);
  await setControl(cappedRegion, nationBId, 40);
  // 受益方 nationA 在 cappedRegion 已掌控 80，索求 30 → 應被夾在 100。
  await setControl(cappedRegion, nationAId, 80);

  const warId = await createWar();
  const treaty = await createTreaty({
    proposerIsPayer: false,
    boundWarId: warId,
    offerMoney: 200,
    offerTechPoints: 15,
    offerRegionIds: [emptyRegion, cappedRegion],
    offerRegionPercents: {
      [String(emptyRegion)]: 30,
      [String(cappedRegion)]: 30,
    },
  });

  const activated = await db.transaction((tx) => activateTreaty(tx, treaty));
  assert.equal(activated.status, "active");

  // 金錢／科技：付款方 nationB 支出、受益方 nationA 收入，精確額度。
  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 1_200);
  assert.equal(a.techPoints, 115);
  assert.equal(b.money, 300);
  assert.equal(b.techPoints, 35);

  // 部分割地：付款方保留其餘（50-30=20；40-30=10），受益方精確／夾限。
  assert.equal(await getControl(emptyRegion, nationBId), 20);
  assert.equal(await getControl(emptyRegion, nationAId), 30);
  assert.equal(await getControl(cappedRegion, nationBId), 10);
  assert.equal(await getControl(cappedRegion, nationAId), 100);

  // 綁定戰爭在同一交易內結束。
  assert.ok(await getWarEndedAt(warId), "戰爭應已結束（ended_at 設值）");
});

test("附條件停戰資源不足：整筆 rollback，割地不轉移且戰爭維持進行中", async () => {
  // 付款方 = nationB（proposerIsPayer=false），金錢遠不足以支付索求。
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 100, 50);
  await clearTestControls();

  const regionId = freeRegionIds[2]!;
  await setControl(regionId, nationBId, 60);

  const warId = await createWar();
  const treaty = await createTreaty({
    proposerIsPayer: false,
    boundWarId: warId,
    offerMoney: 999_999,
    offerRegionIds: [regionId],
    offerRegionPercents: { [String(regionId)]: 30 },
  });

  await assert.rejects(
    db.transaction((tx) => activateTreaty(tx, treaty)),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  // 餘額不變。
  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 1_000);
  assert.equal(b.money, 100);

  // 割地未轉移（付款方仍持有全部，受益方沒有）。
  assert.equal(await getControl(regionId, nationBId), 60);
  assert.equal(await getControl(regionId, nationAId), null);

  // 關鍵：戰爭結束在扣款之前執行，rollback 必須把它還原 → 戰爭仍進行中。
  assert.equal(
    await getWarEndedAt(warId),
    null,
    "資源不足 rollback 後戰爭必須維持進行中（ended_at 仍為 null）",
  );

  // 條約維持 proposed。
  const [row] = await db
    .select({ status: diplomacyTreatiesTable.status })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.id, treaty.id));
  assert.equal(row?.status, "proposed");
});

// ── Task #374 — 條約雙向交換（offer 側 + request 側）──

test("雙向交換：offer 與 request 兩側金錢／科技／部分割地同時精確轉移", async () => {
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 500, 50);
  await clearTestControls();
  const offerRegion = freeRegionIds[0]!;
  const requestRegion = freeRegionIds[1]!;
  await setControl(offerRegion, nationAId, 80);
  await setControl(requestRegion, nationBId, 60);

  const treaty = await createTreaty({
    offerMoney: 200,
    offerTechPoints: 10,
    offerRegionIds: [offerRegion],
    offerRegionPercents: { [String(offerRegion)]: 30 },
    requestMoney: 100,
    requestTechPoints: 5,
    requestRegionIds: [requestRegion],
    requestRegionPercents: { [String(requestRegion)]: 25 },
  });
  const activated = await db.transaction((tx) => activateTreaty(tx, treaty));
  assert.equal(activated.status, "active");

  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  // A: -200 +100 = 900；techPoints: -10 +5 = 95。
  assert.equal(a.money, 900);
  assert.equal(a.techPoints, 95);
  // B: +200 -100 = 600；techPoints: +10 -5 = 55。
  assert.equal(b.money, 600);
  assert.equal(b.techPoints, 55);

  // offer 側：A 保留 50，B 得 30。
  assert.equal(await getControl(offerRegion, nationAId), 50);
  assert.equal(await getControl(offerRegion, nationBId), 30);
  // request 側：B 保留 35，A 得 25。
  assert.equal(await getControl(requestRegion, nationBId), 35);
  assert.equal(await getControl(requestRegion, nationAId), 25);
});

test("request 側金錢不足：offer 側已轉移也整筆 rollback", async () => {
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 50, 50);
  await clearTestControls();
  const offerRegion = freeRegionIds[2]!;
  await setControl(offerRegion, nationAId, 40);

  const treaty = await createTreaty({
    offerMoney: 300,
    offerRegionIds: [offerRegion],
    requestMoney: 999_999,
  });
  await assert.rejects(
    db.transaction((tx) => activateTreaty(tx, treaty)),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 1_000);
  assert.equal(b.money, 50);
  // offer 側割地也必須 rollback。
  assert.equal(await getControl(offerRegion, nationAId), 40);
  assert.equal(await getControl(offerRegion, nationBId), null);

  const [row] = await db
    .select({ status: diplomacyTreatiesTable.status })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.id, treaty.id));
  assert.equal(row?.status, "proposed");
});

test("request 側領土已不在對象國掌控：400 全額 rollback", async () => {
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 500, 50);
  await clearTestControls();
  const requestRegion = freeRegionIds[3]!;
  // 提案時 B 掌控，成立前已易主 → B 沒有 control 列。

  const treaty = await createTreaty({
    offerMoney: 100,
    requestRegionIds: [requestRegion],
  });
  await assert.rejects(
    db.transaction((tx) => activateTreaty(tx, treaty)),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 1_000);
  assert.equal(b.money, 500);
});

test("request 側部分轉移百分比超過實際掌控：400 全額 rollback", async () => {
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 500, 50);
  await clearTestControls();
  const requestRegion = freeRegionIds[0]!;
  await setControl(requestRegion, nationBId, 20);

  const treaty = await createTreaty({
    offerMoney: 100,
    requestRegionIds: [requestRegion],
    requestRegionPercents: { [String(requestRegion)]: 50 },
  });
  await assert.rejects(
    db.transaction((tx) => activateTreaty(tx, treaty)),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  const a = await getBalances(nationAId);
  assert.equal(a.money, 1_000);
  assert.equal(await getControl(requestRegion, nationBId), 20);
  assert.equal(await getControl(requestRegion, nationAId), null);
});

// ── Task #423 — 附條件停戰新語意（Task #414）：custom＋boundWar＋request 側 ──

test("custom＋boundWar＋request 側：對象（玩家）付出、提案方（NPC）收到，戰爭結束", async () => {
  // Task #414 之後 execCeasefire 的產出語意：type=custom、索求放 request*、
  // proposerIsPayer=true。custom 一次性轉移不受 proposerIsPayer 影響
  // （oneTimeFlip 恆為 false）：offer=提案方付、request=對象付。
  // 這裡鎖住「索求在 request 側」的實際轉移方向：付款方必須是對象（玩家），
  // 受益方必須是提案方（NPC），且綁定戰爭在同一交易內結束。
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 500, 50);
  await clearTestControls();

  const demandRegion = freeRegionIds[1]!;
  // 付款方（對象 nationB）掌控 60%，被索求 30%。
  await setControl(demandRegion, nationBId, 60);

  const warId = await createWar();
  const treaty = await createTreaty({
    type: "custom",
    proposerIsPayer: true,
    boundWarId: warId,
    requestMoney: 150,
    requestTechPoints: 20,
    requestRegionIds: [demandRegion],
    requestRegionPercents: { [String(demandRegion)]: 30 },
  });

  const activated = await db.transaction((tx) => activateTreaty(tx, treaty));
  assert.equal(activated.status, "active");

  // 方向不得反轉：對象 nationB 付出、提案方 nationA 收到。
  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 1_150, "提案方（NPC）應收到索求金錢");
  assert.equal(a.techPoints, 120, "提案方（NPC）應收到索求科技點數");
  assert.equal(b.money, 350, "對象（玩家）應付出索求金錢");
  assert.equal(b.techPoints, 30, "對象（玩家）應付出索求科技點數");

  // 部分割地：對象保留其餘（60-30=30），提案方精確得到 30。
  assert.equal(await getControl(demandRegion, nationBId), 30);
  assert.equal(await getControl(demandRegion, nationAId), 30);

  // 綁定戰爭在同一交易內結束。
  assert.ok(await getWarEndedAt(warId), "戰爭應已結束（ended_at 設值）");
});

test("custom＋boundWar＋request 側：對象資源不足 → 400 全額 rollback，戰爭維持進行中", async () => {
  await setBalances(nationAId, 1_000, 100);
  await setBalances(nationBId, 50, 50);
  await clearTestControls();

  const demandRegion = freeRegionIds[2]!;
  await setControl(demandRegion, nationBId, 60);

  const warId = await createWar();
  const treaty = await createTreaty({
    type: "custom",
    proposerIsPayer: true,
    boundWarId: warId,
    requestMoney: 999_999,
    requestRegionIds: [demandRegion],
    requestRegionPercents: { [String(demandRegion)]: 30 },
  });

  await assert.rejects(
    db.transaction((tx) => activateTreaty(tx, treaty)),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );

  const a = await getBalances(nationAId);
  const b = await getBalances(nationBId);
  assert.equal(a.money, 1_000);
  assert.equal(b.money, 50);
  assert.equal(await getControl(demandRegion, nationBId), 60);
  assert.equal(await getControl(demandRegion, nationAId), null);
  assert.equal(
    await getWarEndedAt(warId),
    null,
    "rollback 後戰爭必須維持進行中（ended_at 仍為 null）",
  );

  const [row] = await db
    .select({ status: diplomacyTreatiesTable.status })
    .from(diplomacyTreatiesTable)
    .where(eq(diplomacyTreatiesTable.id, treaty.id));
  assert.equal(row?.status, "proposed");
});
