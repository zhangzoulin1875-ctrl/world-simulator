import { strict as assert } from "node:assert";
import test from "node:test";
import { computeTributeAmount } from "./vassalTribute";

test("computeTributeAmount: 貢金 = floor(稅收 × pct / 100)", () => {
  assert.equal(computeTributeAmount(1000, 10), 100);
  assert.equal(computeTributeAmount(999, 10), 99); // floor
  assert.equal(computeTributeAmount(1, 50), 0); // floor(0.5) = 0
  assert.equal(computeTributeAmount(12345, 33), 4073); // floor(4073.85)
  assert.equal(computeTributeAmount(1000, 100), 1000);
});

test("computeTributeAmount: 稅收非正或非有限 → 0", () => {
  assert.equal(computeTributeAmount(0, 50), 0);
  assert.equal(computeTributeAmount(-100, 50), 0);
  assert.equal(computeTributeAmount(Number.NaN, 50), 0);
  assert.equal(computeTributeAmount(Number.POSITIVE_INFINITY, 50), 0);
});

test("computeTributeAmount: pct 夾限 0–100 並取整", () => {
  assert.equal(computeTributeAmount(1000, 0), 0);
  assert.equal(computeTributeAmount(1000, -5), 0);
  assert.equal(computeTributeAmount(1000, 150), 1000); // 夾到 100
  assert.equal(computeTributeAmount(1000, 10.9), 100); // trunc(10.9) = 10
  assert.equal(computeTributeAmount(1000, Number.NaN), 0);
});
