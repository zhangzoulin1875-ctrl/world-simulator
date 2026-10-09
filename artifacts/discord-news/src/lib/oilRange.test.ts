import { strict as assert } from "node:assert";
import test from "node:test";
import { rangeTier, formatRangePercent, formatDistance, rangeNotice, RANGE_FLOOR } from "./oilRigs";

test("折扣分級:邊界精確", () => {
  assert.equal(rangeTier(1), "none"); assert.equal(rangeTier(0.9), "none");
  assert.equal(rangeTier(0.8999), "light"); assert.equal(rangeTier(0.7), "light");
  assert.equal(rangeTier(0.6999), "heavy"); assert.equal(rangeTier(0.4001), "heavy");
  assert.equal(rangeTier(RANGE_FLOOR), "max"); assert.equal(rangeTier(0.3), "max");
});
test("折扣分級:舊後端沒回欄位不顯示;壞值保守當最大折扣", () => {
  assert.equal(rangeTier(undefined), "none"); assert.equal(rangeTier(null), "none");
  for (const bad of [NaN, Infinity, -Infinity, -0.1, 1.5, 2]) assert.equal(rangeTier(bad), "max", String(bad));
});
test("百分比:四捨五入;壞值回空字串", () => {
  assert.equal(formatRangePercent(1), "100%"); assert.equal(formatRangePercent(0.9692), "97%");
  assert.equal(formatRangePercent(0.6468), "65%"); assert.equal(formatRangePercent(0.4), "40%");
  for (const bad of [NaN, -1, 1.01, undefined, null]) assert.equal(formatRangePercent(bad as number), "");
});
test("距離:千分位、四捨五入、未知顯示『距離未知』", () => {
  assert.equal(formatDistance(7064), "約 7,064 公里"); assert.equal(formatDistance(615.4), "約 615 公里");
  assert.equal(formatDistance(20015), "約 20,015 公里");
  for (const bad of [null, undefined, NaN, -5, Infinity]) assert.equal(formatDistance(bad as number), "距離未知", String(bad));
});
test("出兵提示:近海不顯示;遠征顯示距離與百分比;最大折扣加註", () => {
  assert.equal(rangeNotice({ distanceKm: 615, rangeFactor: 0.969 }), null);
  assert.equal(rangeNotice(undefined), null);
  const heavy = rangeNotice({ distanceKm: 7064, rangeFactor: 0.647 })!;
  assert.equal(heavy.tier, "heavy"); assert.match(heavy.text, /約 7,064 公里/); assert.match(heavy.text, /65%/); assert.match(heavy.text, /可多派艦補足/);
  const max = rangeNotice({ distanceKm: 18000, rangeFactor: 0.4 })!;
  assert.equal(max.tier, "max"); assert.match(max.text, /40%/); assert.match(max.text, /最大折扣/);
  assert.equal(rangeNotice({ distanceKm: 4000, rangeFactor: 0.8 })!.tier, "light");
});
test("出兵提示:查無座標明說按最遠計算,不印假距離", () => {
  const n = rangeNotice({ distanceKm: null, rangeFactor: 0.4 })!;
  assert.match(n.text, /查無你的地區座標/); assert.doesNotMatch(n.text, /公里/);
});
test("出兵提示:壞係數不顯示成沒折扣,也不印 NaN", () => {
  const n = rangeNotice({ distanceKm: 100, rangeFactor: NaN })!;
  assert.equal(n.tier, "max"); assert.doesNotMatch(n.text, /NaN/);
});
