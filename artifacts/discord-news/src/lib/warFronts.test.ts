import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWarFronts, computeArrow, computeFrontPath, warFrontLabel, LONG_FRONT_DIST, LONG_FRONT_MAX_LEN } from "./warFronts";

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

test("computeFrontPath: 近距離為直線，路徑為 M..L..", () => {
  const g = computeFrontPath(0, 0, 80, 0, 5, 10)!;
  assert.equal(g.curved, false);
  assert.equal(g.truncated, false);
  assert.match(g.d, /^M[\d.-]+,[\d.-]+ L/);
});

test("computeFrontPath: 超過門檻改弧線並截短，畫出長度不超過上限", () => {
  const g = computeFrontPath(0, 300, 600, 300, 5, 10)!;
  assert.equal(g.curved, true);
  assert.equal(g.truncated, true);
  const m = g.d.match(/^M([\d.-]+),([\d.-]+) Q([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)$/)!;
  assert.ok(m, g.d);
  const [x0, y0, , , xe, ye] = m.slice(1).map(Number) as number[];
  assert.ok(Math.hypot(xe! - x0!, ye! - y0!) <= LONG_FRONT_MAX_LEN + 1e-6);
  assert.ok(xe! < 600, "不應畫到守方端");
});

test("computeFrontPath: 弧線向畫面上方彎（y 變小）", () => {
  const g = computeFrontPath(0, 300, 600, 300, 5, 10)!;
  assert.ok(g.midY < 300);
  const g2 = computeFrontPath(600, 300, 0, 300, 5, 10)!;
  assert.ok(g2.midY < 300);
});

test("computeFrontPath: 箭頭尖在路徑終點，且朝守方方向（水平向右時兩翼在左側）", () => {
  const g = computeFrontPath(0, 300, 600, 300, 5, 10)!;
  assert.ok(g.headLeftX < g.headTipX && g.headRightX < g.headTipX);
});

test("computeFrontPath: 剛好等於門檻視為近距離", () => {
  const g = computeFrontPath(0, 0, LONG_FRONT_DIST, 0, 5, 10)!;
  assert.equal(g.curved, false);
});

test("computeFrontPath: 重合或非有限數回傳 null，輸出無 NaN", () => {
  assert.equal(computeFrontPath(1, 1, 1, 1, 5, 10), null);
  assert.equal(computeFrontPath(NaN, 0, 300, 0, 5, 10), null);
  const g = computeFrontPath(10, 500, 900, 20, 5, 10)!;
  assert.ok(!/NaN/.test(JSON.stringify(g)));
});
