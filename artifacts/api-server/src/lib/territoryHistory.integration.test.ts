/**
 * Task #395 — 領土變更歷史「寫入路徑」的整合測試（真實資料庫）。
 *
 * diffRegionControls 純函式已有單元測試，但若未來新增或改動 region_controls
 * 寫入路徑時漏了 recordTerritoryChanges，歷史會靜默缺漏。這裡對三條代表性
 * 路徑做端到端驗證，鎖住「寫入 → 同交易內留下正確 before/after/changeType
 * 歷史列」的合約：
 *
 *  1. admin PUT /api/region-controls/:regionId（full-replace，含自訂理由）
 *     → changeType=admin_edit，縮減／新增／移除各留一列，理由帶入自訂文字。
 *  2. 條約割讓 activateTreaty（內部 transferOneTimeSide 全額轉移）
 *     → changeType=treaty，轉出方 before→0、取得方 0→after，treatyId 填入。
 *  3. 超額自動修復 repairOverfullRegions（等比縮減回 100）
 *     → changeType=overfull_repair，各國 before=原值、after 加總 = 100。
 *  另外驗證 admin PUT 完全沒有實際變更（內容相同）時不會多寫歷史列。
 *
 * 測試資料自成一體：專屬測試國家（cascade 清掉 controls 與歷史列）、只借用
 * 無人掌控的 map_regions（offset 170，避開其他整合測試的 offset 0/80/120/150/160）。
 * 跑法：test-integration workflow（pnpm --filter @workspace/api-server run
 * test:integration）。
 */
import { strict as assert } from "node:assert";
import test, { after, before, beforeEach } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set to run the territory-history tests",
  );
}

// requireAdmin 在 module load 時讀 ADMIN_TOKEN，動態 import 前先確保有值。
const adminToken =
  process.env.ADMIN_TOKEN ??
  (process.env.ADMIN_TOKEN = `terrhist-admin-${randomBytes(8).toString("hex")}`);

const express = (await import("express")).default;
const { asc, eq, inArray, isNull, or, sql } = await import("drizzle-orm");
const {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
  diplomacyTreatiesTable,
  territoryChangeHistoryTable,
} = await import("@workspace/db");
const { runGameMigrations } = await import("./gameMigrations");
const { runDiplomacyMigrations } = await import("./diplomacyMigrations");
const { activateTreaty } = await import("./treatyActivation");
const { repairOverfullRegions } = await import("./regionControlHealth");
const regionControlsRouter = (await import("../routes/regionControls"))
  .default;

const TEST_TAG = "__terrhist__";
const runId = randomBytes(4).toString("hex");

let nationAId: string;
let nationBId: string;
let regionIds: number[] = [];
let server: http.Server;
let baseUrl: string;

async function createNation(label: string) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({
      name: `${TEST_TAG}${label}-${runId}`,
      leaderName: TEST_TAG,
      money: 1_000,
      techPoints: 100,
    })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
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

/** 本測試國家在指定地區的歷史列（依 id 排序，穩定可比對）。 */
async function historyRows(regionId: number) {
  return db
    .select({
      nationId: territoryChangeHistoryTable.nationId,
      percentBefore: territoryChangeHistoryTable.percentBefore,
      percentAfter: territoryChangeHistoryTable.percentAfter,
      changeType: territoryChangeHistoryTable.changeType,
      reason: territoryChangeHistoryTable.reason,
      warId: territoryChangeHistoryTable.warId,
      treatyId: territoryChangeHistoryTable.treatyId,
    })
    .from(territoryChangeHistoryTable)
    .where(eq(territoryChangeHistoryTable.regionId, regionId))
    .orderBy(asc(territoryChangeHistoryTable.id));
}

async function clearTestState() {
  await db
    .delete(diplomacyTreatiesTable)
    .where(
      or(
        eq(diplomacyTreatiesTable.proposerNationId, nationAId),
        eq(diplomacyTreatiesTable.targetNationId, nationAId),
      ),
    );
  await db
    .delete(regionControlsTable)
    .where(inArray(regionControlsTable.nationId, [nationAId, nationBId]));
  await db
    .delete(territoryChangeHistoryTable)
    .where(
      inArray(territoryChangeHistoryTable.nationId, [nationAId, nationBId]),
    );
}

function adminPut(regionId: number, body: unknown) {
  return fetch(`${baseUrl}/api/region-controls/${regionId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-admin-token": adminToken,
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  await runGameMigrations();
  await runDiplomacyMigrations();

  // 清掉先前殘留的測試資料（若上次執行中斷）。
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);

  nationAId = await createNation("a");
  nationBId = await createNation("b");

  // 借用無人掌控的地區；offset 170 避開其他整合測試（0/80/120/150/160）。
  const rows = await db
    .select({ id: mapRegionsTable.id })
    .from(mapRegionsTable)
    .leftJoin(
      regionControlsTable,
      eq(regionControlsTable.regionId, mapRegionsTable.id),
    )
    .where(isNull(regionControlsTable.id))
    .orderBy(mapRegionsTable.id)
    .offset(170)
    .limit(3);
  regionIds = rows.map((r) => r.id);
  assert.ok(regionIds.length >= 3, "測試需要至少 3 個無人掌控的地區");

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info() {},
      warn() {},
      error() {},
    };
    next();
  });
  app.use(express.json());
  app.use("/api", regionControlsRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await clearTestState();
});

after(async () => {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "%"}`);
  if (server) {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
  await pool.end();
});

test("admin PUT full-replace：縮減／新增／移除各留一列 admin_edit 歷史，含自訂理由", async () => {
  const regionId = regionIds[0]!;
  await setControl(regionId, nationAId, 40);
  await setControl(regionId, nationBId, 10);

  // A 40→20（縮減）、B 10→0（移除）… 再加回 B 為新掌控者的情境：
  // 這裡 full-replace 成 [A=20]，B 應記為移除（10→0）。
  const res = await adminPut(regionId, {
    controls: [{ nationId: nationAId, percent: 20 }],
    reason: "測試理由-395",
  });
  assert.equal(res.status, 200, await res.text());

  const rows = await historyRows(regionId);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  const aRow = rows.find((r) => r.nationId === nationAId);
  const bRow = rows.find((r) => r.nationId === nationBId);
  assert.ok(aRow && bRow, "A、B 各應有一列歷史");
  assert.deepEqual(
    { before: aRow.percentBefore, after: aRow.percentAfter, type: aRow.changeType },
    { before: 40, after: 20, type: "admin_edit" },
  );
  assert.deepEqual(
    { before: bRow.percentBefore, after: bRow.percentAfter, type: bRow.changeType },
    { before: 10, after: 0, type: "admin_edit" },
  );
  assert.ok(
    aRow.reason.includes("測試理由-395"),
    `自訂理由應帶入歷史列，實際：${aRow.reason}`,
  );
  assert.equal(aRow.warId, null);
  assert.equal(aRow.treatyId, null);
});

test("admin PUT 內容完全相同：不寫任何歷史列", async () => {
  const regionId = regionIds[0]!;
  await setControl(regionId, nationAId, 30);

  const res = await adminPut(regionId, {
    controls: [{ nationId: nationAId, percent: 30 }],
  });
  assert.equal(res.status, 200, await res.text());

  const rows = await historyRows(regionId);
  assert.equal(rows.length, 0, JSON.stringify(rows));
});

test("條約割讓 activateTreaty：轉出／取得雙方各留一列 treaty 歷史，treatyId 填入", async () => {
  const regionId = regionIds[1]!;
  await setControl(regionId, nationAId, 40);

  const [treaty] = await db
    .insert(diplomacyTreatiesTable)
    .values({
      proposerNationId: nationAId,
      targetNationId: nationBId,
      type: "nonaggression",
      offerRegionIds: [regionId],
      offerRegionPercents: {},
      requestRegionIds: [],
      requestRegionPercents: {},
      status: "proposed",
      awaitingNationId: nationBId,
    })
    .returning();
  assert.ok(treaty, "test treaty insert failed");

  await db.transaction((tx) => activateTreaty(tx, treaty));

  const rows = await historyRows(regionId);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  const fromRow = rows.find((r) => r.nationId === nationAId);
  const toRow = rows.find((r) => r.nationId === nationBId);
  assert.ok(fromRow && toRow, "轉出方與取得方各應有一列歷史");
  assert.deepEqual(
    {
      before: fromRow.percentBefore,
      after: fromRow.percentAfter,
      type: fromRow.changeType,
      treatyId: fromRow.treatyId,
    },
    { before: 40, after: 0, type: "treaty", treatyId: treaty.id },
  );
  assert.deepEqual(
    {
      before: toRow.percentBefore,
      after: toRow.percentAfter,
      type: toRow.changeType,
      treatyId: toRow.treatyId,
    },
    { before: 0, after: 40, type: "treaty", treatyId: treaty.id },
  );
});

test("超額自動修復：等比縮減的每一筆變更都留下 overfull_repair 歷史", async () => {
  const regionId = regionIds[2]!;
  // 直接製造超額（70 + 60 = 130 > 100，單筆各自 ≤ 100 不撞 CHECK）。
  await setControl(regionId, nationAId, 70);
  await setControl(regionId, nationBId, 60);

  const results = await repairOverfullRegions();
  const ours = results.find((r) => r.regionId === regionId);
  assert.ok(ours, "修復結果應包含本測試地區");
  assert.ok(ours.repaired, "本測試地區應被成功修復");

  const rows = await historyRows(regionId);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  for (const row of rows) {
    assert.equal(row.changeType, "overfull_repair");
    assert.ok(
      row.percentAfter < row.percentBefore,
      `等比縮減後應變小：${JSON.stringify(row)}`,
    );
  }
  const beforeByNation = new Map(rows.map((r) => [r.nationId, r]));
  assert.equal(beforeByNation.get(nationAId)?.percentBefore, 70);
  assert.equal(beforeByNation.get(nationBId)?.percentBefore, 60);
  // 歷史 after 必須與實際落庫結果一致，且加總為 100。
  const controls = await db
    .select({
      nationId: regionControlsTable.nationId,
      percent: regionControlsTable.percent,
    })
    .from(regionControlsTable)
    .where(eq(regionControlsTable.regionId, regionId));
  assert.equal(
    controls.reduce((s, c) => s + c.percent, 0),
    100,
    "修復後加總應為 100",
  );
  for (const c of controls) {
    assert.equal(
      beforeByNation.get(c.nationId)?.percentAfter,
      c.percent,
      "歷史 percentAfter 應與實際掌控一致",
    );
  }
});
