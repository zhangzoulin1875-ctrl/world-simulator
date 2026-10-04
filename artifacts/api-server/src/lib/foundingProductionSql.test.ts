import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 回歸：建國 2+ 塊地區時的生產力上限檢查 SQL，productivity 與 population
 * 皆為 int4，大航海時代之後兩者乘積可超過 2^31（最大約 3.9e12），必須在相乘前
 * 先轉 bigint，否則整個 POST /player/nation 會以「numeric out of range」回 500。
 */
test("建國生產力檢查 SQL 在相乘前先轉 bigint（避免 int4 溢位）", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../routes/player.ts"), "utf8");
  assert.match(src, /productivity::bigint\s*\*\s*population::bigint/);
  assert.doesNotMatch(src, /FLOOR\(productivity\s*\*\s*population/);
});

test("int4 相乘確實會溢位、bigint 不會（數值佐證）", () => {
  const INT4_MAX = 2147483647;
  const worstCase = 26000 * 251000000; // future 時代實測上界附近
  assert.ok(worstCase > INT4_MAX);
  assert.ok(BigInt(26000) * BigInt(251000000) > BigInt(INT4_MAX));
});
