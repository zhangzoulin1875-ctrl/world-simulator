import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWarFronts, computeArrow, warFrontLabel } from "./warFronts";

const names = new Map<number, string>([[1, "關中"], [2, "河西隴右"], [3, "江漢荊楚"]]);
const camp = (id: number, a: number, d: number) => ({
  id, attackerRegionId: a, defenderRegionId: d, attackerNationName: "甲國", defenderNationName: "乙國",
});

test("buildWarFronts: 正常戰役轉成戰線並保留方向", () => {
  const r = buildWarFronts([camp(10, 1, 2)], names);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.attackerRegionName, "關中");
  assert.equal(r[0]!.defenderRegionName, "河西隴右");
});

test("buildWarFronts: 任一端找不到地區就略過，不丟錯", () => {
  const r = buildWarFronts([camp(1, 1, 999), camp(2, 999, 2), camp(3, 1, 3)], names);
  assert.deepEqual(r.map((f) => f.id), [3]);
});

test("buildWarFronts: 兩端同一地區略過", () => {
  assert.equal(buildWarFronts([camp(1, 2, 2)], names).length, 0);
});

test("buildWarFronts: 空輸入回傳空陣列", () => {
  assert.deepEqual(buildWarFronts([], names), []);
});

test("computeArrow: 距離夠長時，內縮等於 trim", () => {
  const a = computeArrow(0, 0, 100, 0, 10, 8)!;
  assert.ok(a);
  assert.ok(Math.abs(a.x1 - 10) < 1e-9 && Math.abs(a.y1) < 1e-9);
  assert.ok(Math.abs(a.x2 - 90) < 1e-9 && Math.abs(a.y2) < 1e-9);
  assert.ok(Math.abs(a.midX - 50) < 1e-9);
});

test("computeArrow: 相鄰小區（距離很近）內縮被壓在 18%，線段仍保有 64% 長度", () => {
  const a = computeArrow(0, 0, 10, 0, 9, 9)!;
  assert.ok(a);
  assert.ok(Math.abs(a.x1 - 1.8) < 1e-9);
  assert.ok(Math.abs(a.x2 - 8.2) < 1e-9);
  assert.ok(a.x2 - a.x1 > 6);
});

test("computeArrow: 箭頭尖兩翼長度不超過線段的 45%", () => {
  const a = computeArrow(0, 0, 10, 0, 9, 50)!;
  const wing = Math.hypot(a.headLeftX - a.x2, a.headLeftY - a.y2);
  assert.ok(wing <= (a.x2 - a.x1) * 0.45 + 1e-9);
});

test("computeArrow: 兩翼在尖端後方（朝起點側）且左右對稱", () => {
  const a = computeArrow(0, 0, 100, 0, 10, 8)!;
  assert.ok(a.headLeftX < a.x2 && a.headRightX < a.x2);
  assert.ok(Math.abs(a.headLeftY + a.headRightY) < 1e-9);
  assert.ok(Math.abs(Math.hypot(a.headLeftX - a.x2, a.headLeftY - a.y2) - 8) < 1e-9);
});

test("computeArrow: 斜向與反向方向正確", () => {
  const a = computeArrow(100, 100, 0, 0, 0, 10)!;
  assert.ok(a.headLeftX > a.x2 && a.headRightX > a.x2);
  assert.ok(Math.abs(a.x2) < 1e-9 && Math.abs(a.y2) < 1e-9);
});

test("computeArrow: 兩點重合回傳 null（不產生 NaN）", () => {
  assert.equal(computeArrow(5, 5, 5, 5, 0, 8), null);
});

test("computeArrow: 非有限數回傳 null", () => {
  assert.equal(computeArrow(NaN, 0, 10, 0, 1, 1), null);
  assert.equal(computeArrow(0, 0, Infinity, 0, 1, 1), null);
});

test("warFrontLabel: 正常與缺國名", () => {
  assert.equal(warFrontLabel({ attackerNationName: "甲國", defenderNationName: "乙國" }), "甲國 → 乙國");
  assert.equal(warFrontLabel({ attackerNationName: " ", defenderNationName: "乙國" }), "? → 乙國");
});
