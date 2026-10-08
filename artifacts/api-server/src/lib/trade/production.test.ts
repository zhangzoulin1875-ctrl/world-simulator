import test from "node:test";
import assert from "node:assert/strict";
import {
  SPECIALTY_BASE_OUTPUT,
  regionSpecialtyOutput,
  nationSpecialtyOutput,
  splitProduction,
} from "./production";
import { REGION_SPECIALTIES } from "./regionSpecialties";

// 挑真實地區當樣本(名稱必須存在於特產表,否則下面的測試會先報錯)。
const MAIN_OIL = "利雅德"; // 油★
const MIXED = "南非德蘭"; // 礦★ 鐵煤★ 稀★
const MINOR_ONLY = "蘇格蘭高地"; // 礦(次產)

test("樣本地區確實存在於特產表(防打錯字讓後面測試空轉)", () => {
  for (const n of [MAIN_OIL, MIXED, MINOR_ONLY]) assert.ok(REGION_SPECIALTIES[n], n);
});

test("定案數值:基準量 10", () => {
  assert.equal(SPECIALTY_BASE_OUTPUT, 10);
});

test("主產全控 = 3 × 10 = 30;次產全控 = 10", () => {
  assert.deepEqual(regionSpecialtyOutput({ name: MAIN_OIL, percent: 100 }, "industrial"), { oil: 30 });
  assert.deepEqual(regionSpecialtyOutput({ name: MINOR_ONLY, percent: 100 }, "industrial"), { ore: 10 });
});

test("控制比例線性縮放並向下取整", () => {
  assert.deepEqual(regionSpecialtyOutput({ name: MAIN_OIL, percent: 50 }, "industrial"), { oil: 15 });
  // 3 × 33 × 10 / 100 = 9.9 → 9
  assert.deepEqual(regionSpecialtyOutput({ name: MAIN_OIL, percent: 33 }, "industrial"), { oil: 9 });
});

test("產量太小時歸 0 且不出現在結果裡(次產 5% = 0.5 → 0)", () => {
  assert.deepEqual(regionSpecialtyOutput({ name: MINOR_ONLY, percent: 5 }, "industrial"), {});
});

test("時代解鎖:石油與稀有金屬在工業前為 0,礦石與鐵煤始終有", () => {
  const early = regionSpecialtyOutput({ name: MIXED, percent: 100 }, "medieval_dummy_not_era");
  // 非法時代 slug:有解鎖限制的貨物一律 0(isGoodUnlocked 回 false),無限制的照產
  assert.equal(early.rare, undefined);
  const classical = regionSpecialtyOutput({ name: MIXED, percent: 100 }, "classical");
  assert.equal(classical.rare, undefined, "古典沒有稀有金屬");
  assert.equal(classical.ore, 30);
  assert.equal(classical.ironcoal, 30);
  const industrial = regionSpecialtyOutput({ name: MIXED, percent: 100 }, "industrial");
  assert.equal(industrial.rare, 30, "工業時代解鎖");
  assert.equal(regionSpecialtyOutput({ name: MAIN_OIL, percent: 100 }, "ww1").oil, 30);
  assert.deepEqual(regionSpecialtyOutput({ name: MAIN_OIL, percent: 100 }, "enlightenment"), {}, "啟蒙時代還沒有石油");
});

test("不隨時代縮放:工業與未來同一地區產量相同(實物不吃稅基係數)", () => {
  const a = regionSpecialtyOutput({ name: MAIN_OIL, percent: 100 }, "industrial");
  const b = regionSpecialtyOutput({ name: MAIN_OIL, percent: 100 }, "future");
  assert.deepEqual(a, b);
});

test("無特產或查無地區:空結果,不拋錯", () => {
  assert.deepEqual(regionSpecialtyOutput({ name: "不存在的地區", percent: 100 }, "industrial"), {});
});

test("壞輸入:百分比 NaN/負/超過 100、基準量 NaN/負,都不產生 NaN 或負數", () => {
  assert.deepEqual(regionSpecialtyOutput({ name: MAIN_OIL, percent: NaN }, "industrial"), {});
  assert.deepEqual(regionSpecialtyOutput({ name: MAIN_OIL, percent: -5 }, "industrial"), {});
  assert.deepEqual(regionSpecialtyOutput({ name: MAIN_OIL, percent: 250 }, "industrial"), { oil: 30 }, "上限夾 100");
  assert.deepEqual(regionSpecialtyOutput({ name: MAIN_OIL, percent: 100 }, "industrial", NaN), {});
  assert.deepEqual(regionSpecialtyOutput({ name: MAIN_OIL, percent: 100 }, "industrial", -10), {});
});

test("國家加總:多區同貨物相加", () => {
  const out = nationSpecialtyOutput(
    [
      { name: MAIN_OIL, percent: 100 },
      { name: MAIN_OIL, percent: 50 },
      { name: MIXED, percent: 100 },
    ],
    "industrial",
  );
  assert.deepEqual(out, { oil: 45, ore: 30, ironcoal: 30, rare: 30 });
});

test("國家加總:空清單 = 空結果", () => {
  assert.deepEqual(nationSpecialtyOutput([], "industrial"), {});
});

test("分流:木材礦石走 player_nations 欄位,其餘進 nation_goods(不雙帳)", () => {
  const s = splitProduction({ ore: 30, wood: 10, ironcoal: 30, oil: 15, rare: 5 });
  assert.deepEqual(s.playerColumns, { wood: 10, ore: 30 });
  assert.deepEqual(s.goodsTable, { ironcoal: 30, oil: 15, rare: 5 });
  assert.equal("ore" in s.goodsTable, false);
  assert.equal("wood" in s.goodsTable, false);
});

test("分流:空輸入全為 0", () => {
  const s = splitProduction({});
  assert.deepEqual(s.playerColumns, { wood: 0, ore: 0 });
  assert.deepEqual(s.goodsTable, {});
});

test("量級檢查:控 5 個「三主產」頂級區(南非德蘭型)工業時代共 450/回合,仍低於 1000 不碾壓經濟", () => {
  const five = nationSpecialtyOutput(
    Array.from({ length: 5 }, () => ({ name: MIXED, percent: 100 })),
    "industrial",
  );
  const sum = Object.values(five).reduce((a, b) => a + (b ?? 0), 0);
  assert.equal(sum, 450); // 5 區 × 3 種主產 × 30
  assert.ok(sum < 1000, "不應碾壓經濟");
});
