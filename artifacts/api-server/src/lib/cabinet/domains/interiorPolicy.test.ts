import { test } from "node:test";
import assert from "node:assert/strict";
import { isMajorFoodPolicyChange } from "./interiorPolicy";

// Task #435 — 糧食政策切換重大判定純函式單元測試（不觸 DB／IO）。

test("饑荒中開啟政策屬 minor（救急）", () => {
  assert.equal(isMajorFoodPolicyChange({ enable: true, famine: true }), false);
});

test("無饑荒時關閉政策屬 minor（止血滿意度）", () => {
  assert.equal(
    isMajorFoodPolicyChange({ enable: false, famine: false }),
    false,
  );
});

test("無饑荒卻開啟政策屬重大（平白扣滿意度）", () => {
  assert.equal(isMajorFoodPolicyChange({ enable: true, famine: false }), true);
});

test("饑荒中關閉政策屬重大（可能加劇饑荒）", () => {
  assert.equal(isMajorFoodPolicyChange({ enable: false, famine: true }), true);
});
