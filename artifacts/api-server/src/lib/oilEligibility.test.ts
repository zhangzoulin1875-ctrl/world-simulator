import { strict as assert } from "node:assert";
import test from "node:test";
import { canContestRig, NAVAL_TECH_SLUG } from "./oilRigCore";

const SLUG = "north_sea_1"; // 掛靠區含「荷蘭」「東英格蘭」
const NAVAL = [NAVAL_TECH_SLUG];

test("資格:有海軍科技 + 控制掛靠區 → 通過", () => {
  assert.deepEqual(canContestRig(["荷蘭"], NAVAL, SLUG), { ok: true });
});
test("資格:沒研發海戰 → no_naval_tech(最先檢查,即使其他條件也不符)", () => {
  assert.deepEqual(canContestRig([], [], SLUG), { ok: false, reason: "no_naval_tech" });
  assert.deepEqual(canContestRig(["荷蘭"], ["gunpowder"], SLUG), { ok: false, reason: "no_naval_tech" });
});
test("資格:有科技但完全沒有沿海地區 → no_coastal_region", () => {
  assert.deepEqual(canContestRig(["不存在的內陸區"], NAVAL, SLUG), { ok: false, reason: "no_coastal_region" });
  assert.deepEqual(canContestRig([], NAVAL, SLUG), { ok: false, reason: "no_coastal_region" });
});
test("資格:取消航程限制 — 沿海國打任何油井都具資格(距離只衰減戰力)", () => {
  // 佛羅里達離北海一號很遠,過去會被擋;現在具資格,代價是戰力衰減(見 oilDistance.test.ts)
  assert.deepEqual(canContestRig(["佛羅里達"], NAVAL, SLUG), { ok: true });
});
test("資格:未知油井 → unknown_rig(優先於其他檢查)", () => {
  assert.deepEqual(canContestRig(["荷蘭"], NAVAL, "nope"), { ok: false, reason: "unknown_rig" });
  assert.deepEqual(canContestRig([], [], "nope"), { ok: false, reason: "unknown_rig" });
});
test("資格:控制多區,只要有一區沿海即通過", () => {
  assert.deepEqual(canContestRig(["佛羅里達", "荷蘭", "內陸"], NAVAL, SLUG), { ok: true });
});
