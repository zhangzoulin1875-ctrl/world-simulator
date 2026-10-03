import { strict as assert } from "node:assert";
import test from "node:test";
import {
  ALLIANCE_NAME_MAX,
  haveCommonAlliance,
  defaultAllianceName,
  isValidAllianceName,
} from "./alliances";

test("isValidAllianceName: 1..MAX trimmed chars only", () => {
  assert.equal(isValidAllianceName("北方聯盟"), true);
  assert.equal(isValidAllianceName("A"), true);
  assert.equal(isValidAllianceName("  邊界  "), true); // 去頭尾空白後仍有字
  assert.equal(isValidAllianceName(""), false);
  assert.equal(isValidAllianceName("   "), false); // 全空白
  assert.equal(isValidAllianceName("x".repeat(ALLIANCE_NAME_MAX)), true);
  assert.equal(isValidAllianceName("x".repeat(ALLIANCE_NAME_MAX + 1)), false);
  assert.equal(isValidAllianceName(null), false);
  assert.equal(isValidAllianceName(undefined), false);
  assert.equal(isValidAllianceName(123), false);
});

test("haveCommonAlliance: 任一共同聯盟即為真（多聯盟制）", () => {
  assert.equal(haveCommonAlliance(["al1"], ["al1"]), true);
  assert.equal(haveCommonAlliance(["al1", "al2"], ["al2", "al3"]), true);
  assert.equal(haveCommonAlliance(["al1"], ["al2"]), false);
  assert.equal(haveCommonAlliance(["al1"], []), false); // 對方無聯盟
  assert.equal(haveCommonAlliance([], []), false); // 皆無聯盟
});

test("defaultAllianceName: appends 聯盟, falls back, caps at MAX", () => {
  assert.equal(defaultAllianceName("大明"), "大明聯盟");
  assert.equal(defaultAllianceName(null), "無名國聯盟");
  assert.equal(defaultAllianceName("   "), "無名國聯盟");
  assert.equal(defaultAllianceName("  秦  "), "秦聯盟");
  const long = defaultAllianceName("國".repeat(ALLIANCE_NAME_MAX));
  assert.equal(long.length, ALLIANCE_NAME_MAX);
});
