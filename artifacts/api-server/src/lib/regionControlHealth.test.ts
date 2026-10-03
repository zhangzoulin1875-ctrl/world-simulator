import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  pool,
  playerNationsTable,
  regionControlsTable,
  mapRegionsTable,
} from "@workspace/db";
import { runGameMigrations, runRegionControlMigrations } from "./gameMigrations";
import {
  scaleDownControls,
  findOverfullRegions,
  repairOverfullRegions,
} from "./regionControlHealth";

/**
 * Task #51 — region_controls 超額健檢的測試。
 * 前半：scaleDownControls 純函式（不需資料庫）。
 * 後半：repairOverfullRegions 整合測試（真實資料庫；專屬測試國家
 * cascade 清掉 controls，只借用目前無人掌控的地區，結束時全部刪除）。
 */

function total(controls: { percent: number }[]): number {
  return controls.reduce((s, c) => s + c.percent, 0);
}

test("scaleDownControls：加總 ≤ 100 原樣回傳", () => {
  const input = [
    { nationId: "a", percent: 60 },
    { nationId: "b", percent: 40 },
  ];
  assert.deepEqual(scaleDownControls(input), input);
  const partial = [{ nationId: "a", percent: 30 }];
  assert.deepEqual(scaleDownControls(partial), partial);
});

test("scaleDownControls：超額按比例縮到恰好 100", () => {
  const out = scaleDownControls([
    { nationId: "a", percent: 60 },
    { nationId: "b", percent: 50 },
  ]);
  assert.ok(out);
  assert.equal(total(out), 100);
  const a = out.find((c) => c.nationId === "a")!.percent;
  const b = out.find((c) => c.nationId === "b")!.percent;
  // 60/110 ≈ 54.5、50/110 ≈ 45.5 → 55 + 45
  assert.equal(a, 55);
  assert.equal(b, 45);
});

test("scaleDownControls：每筆為整數、≥1、不超過原值", () => {
  const input = [
    { nationId: "a", percent: 100 },
    { nationId: "b", percent: 100 },
    { nationId: "c", percent: 1 },
  ];
  const out = scaleDownControls(input);
  assert.ok(out);
  assert.ok(total(out) <= 100);
  for (const c of out) {
    const original = input.find((i) => i.nationId === c.nationId)!.percent;
    assert.ok(Number.isInteger(c.percent));
    assert.ok(c.percent >= 1, `${c.nationId} 不可縮到 0`);
    assert.ok(c.percent <= original, `${c.nationId} 不可放大超過原值`);
  }
  // 小國 c（原本 1%）被 min-1 保護
  assert.equal(out.find((c) => c.nationId === "c")!.percent, 1);
});

test("scaleDownControls：大量小額掌控仍能塞進 100", () => {
  // 60 筆 × 3% = 180% → 每筆至少 1，加總 ≤ 100
  const input = Array.from({ length: 60 }, (_, i) => ({
    nationId: `n${i}`,
    percent: 3,
  }));
  const out = scaleDownControls(input);
  assert.ok(out);
  assert.ok(total(out) <= 100);
  assert.ok(out.every((c) => c.percent >= 1));
});

test("scaleDownControls：超過 100 筆（min-1 塞不下）回傳 null", () => {
  const input = Array.from({ length: 101 }, (_, i) => ({
    nationId: `n${i}`,
    percent: 2,
  }));
  assert.equal(scaleDownControls(input), null);
});

test("scaleDownControls：極端不均仍保比例", () => {
  const out = scaleDownControls([
    { nationId: "big", percent: 100 },
    { nationId: "tiny", percent: 100 },
    { nationId: "mid", percent: 50 },
  ]);
  assert.ok(out);
  assert.equal(total(out), 100);
  assert.equal(out.find((c) => c.nationId === "big")!.percent, 40);
  assert.equal(out.find((c) => c.nationId === "tiny")!.percent, 40);
  assert.equal(out.find((c) => c.nationId === "mid")!.percent, 20);
});

// ---------------------------------------------------------------------------
// 整合測試（真實資料庫）
// ---------------------------------------------------------------------------

const TEST_TAG = "region-health-test";

let nationAId: string;
let nationBId: string;
let regionOverfullId: number;
let regionOkId: number;

async function createNation(name: string) {
  const [row] = await db
    .insert(playerNationsTable)
    .values({ name: `${TEST_TAG}-${name}`, leaderName: TEST_TAG })
    .returning({ id: playerNationsTable.id });
  assert.ok(row, "test nation insert failed");
  return row.id;
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

before(async () => {
  await runGameMigrations();
  await runRegionControlMigrations();

  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);

  nationAId = await createNation("alpha");
  nationBId = await createNation("beta");

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
    // （treatyActivation 用 offset 120、player.race 用 offset 0）並行搶到同一地區。
    .offset(80)
    .limit(2);
  assert.ok(rows.length >= 2, "測試需要至少 2 個無人掌控的地區");
  regionOverfullId = rows[0]!.id;
  regionOkId = rows[1]!.id;

  // 超額地區：70 + 60 = 130 > 100（per-row CHECK 1–100 允許加總超額）
  await db.insert(regionControlsTable).values([
    { regionId: regionOverfullId, nationId: nationAId, percent: 70 },
    { regionId: regionOverfullId, nationId: nationBId, percent: 60 },
    // 正常地區：40 + 30 = 70 ≤ 100，不應被動到
    { regionId: regionOkId, nationId: nationAId, percent: 40 },
    { regionId: regionOkId, nationId: nationBId, percent: 30 },
  ]);
});

after(async () => {
  await db
    .delete(playerNationsTable)
    .where(sql`${playerNationsTable.name} LIKE ${TEST_TAG + "-%"}`);
  await pool.end();
});

test("findOverfullRegions：只找出加總 > 100 的地區並含完整明細", async () => {
  const overfull = await findOverfullRegions();
  const hit = overfull.find((r) => r.regionId === regionOverfullId);
  assert.ok(hit, "應找出超額地區");
  assert.equal(hit.total, 130);
  assert.equal(hit.controls.length, 2);
  assert.ok(
    hit.controls.some(
      (c) => c.nationId === nationAId && c.percent === 70 && c.nationName,
    ),
  );
  assert.ok(
    !overfull.some((r) => r.regionId === regionOkId),
    "正常地區不應被列為超額",
  );
});

test("repairOverfullRegions：超額地區縮回 100，正常地區不動", async () => {
  const results = await repairOverfullRegions();
  const hit = results.find((r) => r.regionId === regionOverfullId);
  assert.ok(hit, "應修正超額地區");
  assert.ok(hit.repaired, "應成功自動修正");
  assert.equal(total(hit.repaired), 100);

  // 70/130 ≈ 53.8、60/130 ≈ 46.2 → 54 + 46
  assert.equal(await getControl(regionOverfullId, nationAId), 54);
  assert.equal(await getControl(regionOverfullId, nationBId), 46);

  // 正常地區原封不動
  assert.equal(await getControl(regionOkId, nationAId), 40);
  assert.equal(await getControl(regionOkId, nationBId), 30);

  // 修正後再掃：不再超額
  const overfullAfter = await findOverfullRegions();
  assert.ok(!overfullAfter.some((r) => r.regionId === regionOverfullId));
  const secondPass = await repairOverfullRegions();
  assert.ok(!secondPass.some((r) => r.regionId === regionOverfullId));
});
