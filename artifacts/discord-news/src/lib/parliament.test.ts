import test from "node:test";
import assert from "node:assert/strict";
import { layoutHemicycle } from "./parliament";

test("點數恰等於總席次,各黨點數等於其席次", () => {
  const seats = [42, 30, 15, 8, 5];
  const d = layoutHemicycle(seats);
  assert.equal(d.length, 100);
  seats.forEach((n, i) => assert.equal(d.filter((x) => x.partyIndex === i).length, n));
});

test("所有點都在上半圓(y>=0)且半徑在範圍內", () => {
  for (const x of layoutHemicycle([60, 40])) {
    assert.ok(x.y >= -1e-9); const r = Math.hypot(x.x, x.y); assert.ok(r <= 1 + 1e-9 && r >= 0.42 - 1e-9);
  }
});

test("每黨是連續扇形:左派的平均角度大於右派", () => {
  const d = layoutHemicycle([50, 50]);
  const avg = (p: number) => { const a = d.filter((x) => x.partyIndex === p); return a.reduce((s, x) => s + x.angle, 0) / a.length; };
  assert.ok(avg(0) > avg(1));
});

test("橡皮圖章:單黨 100 席;邊界輸入不崩", () => {
  assert.equal(layoutHemicycle([100]).length, 100);
  assert.deepEqual(layoutHemicycle([]), []);
  assert.deepEqual(layoutHemicycle([0, 0]), []);
  assert.equal(layoutHemicycle([NaN, -3, 7]).length, 7);
  assert.equal(layoutHemicycle([1]).length, 1);
});
