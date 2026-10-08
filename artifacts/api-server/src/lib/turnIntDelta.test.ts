import test from "node:test";
import assert from "node:assert/strict";
import { toIntDelta } from "./turnEngine";

/**
 * 回歸：線上出現 `invalid input syntax for type integer: "-6.25"`——
 * 厭戰度政策增量 = 修正值 × 淡出強度（可為小數），原樣寫進 integer 欄位的 SQL 會整條失敗，
 * 該國金錢/木材/礦石/彈藥/人口全部當回合不入帳。toIntDelta 是寫入前的取整出口。
 */
test("toIntDelta：小數四捨五入成整數（含線上的 -6.25）", () => {
  assert.equal(toIntDelta(-6.25), -6);
  assert.equal(toIntDelta(-6.5), -6);
  assert.equal(toIntDelta(-6.75), -7);
  assert.equal(toIntDelta(2.4), 2);
  assert.equal(toIntDelta(2.5), 3);
  assert.equal(toIntDelta(0), 0);
});

test("toIntDelta：整數原樣、非有限值歸 0（不產生 NaN/Infinity 參數）", () => {
  assert.equal(toIntDelta(5), 5);
  assert.equal(toIntDelta(-3), -3);
  assert.equal(toIntDelta(Number.NaN), 0);
  assert.equal(toIntDelta(Number.POSITIVE_INFINITY), 0);
  assert.equal(toIntDelta(Number.NEGATIVE_INFINITY), 0);
});

test("toIntDelta：結果永遠是整數", () => {
  for (const v of [-99.99, -0.4, 0.4, 7.123456, 1e-9, -1e-9, 123456.5]) {
    assert.ok(Number.isInteger(toIntDelta(v)), `${v} → ${toIntDelta(v)}`);
  }
});
