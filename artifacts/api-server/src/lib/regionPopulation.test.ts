/**
 * Task #322 — distributePopulationDelta 純函式單元測試。
 * 鎖住：正向 largest-remainder 依權重守恆分配；負向依權重扣減且每地區不低於 0；
 * 負向總量超過總人口時整體歸零；空/零權重與 delta=0 的邊界。
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { distributePopulationDelta } from "./regionPopulation";

test("delta=0 或空陣列回傳全 0", () => {
  assert.deepEqual(distributePopulationDelta([], 100), []);
  assert.deepEqual(distributePopulationDelta([10, 20], 0), [0, 0]);
});

test("總權重 ≤ 0 時不論方向皆回傳全 0（不灌幽靈人口）", () => {
  assert.deepEqual(distributePopulationDelta([0, 0, 0], 100), [0, 0, 0]);
  assert.deepEqual(distributePopulationDelta([0, 0], -100), [0, 0]);
});

test("正向：依權重分配且總和守恆等於 delta", () => {
  const out = distributePopulationDelta([100, 300], 100);
  assert.equal(
    out.reduce((a, b) => a + b, 0),
    100,
    "總和應守恆",
  );
  assert.ok(out[1]! > out[0]!, "權重大者分到較多");
  assert.ok(out.every((v) => v >= 0), "正向每項不為負");
});

test("正向 largest-remainder：無法整除時餘數配給最大餘數者，仍守恆", () => {
  const out = distributePopulationDelta([1, 1, 1], 10);
  assert.equal(
    out.reduce((a, b) => a + b, 0),
    10,
  );
  assert.deepEqual([...out].sort((a, b) => a - b), [3, 3, 4]);
});

test("負向：依權重扣減、總和守恆、每地區扣後不低於 0", () => {
  const weights = [100, 300];
  const out = distributePopulationDelta(weights, -100);
  assert.equal(
    out.reduce((a, b) => a + b, 0),
    -100,
    "總和應守恆",
  );
  for (let i = 0; i < weights.length; i++) {
    assert.ok(-out[i]! <= weights[i]!, "每地區移除量不超過自身人口");
  }
});

test("負向總量 ≥ 總人口：每地區至多扣掉自身全部人口（結果為各權重負值）", () => {
  const weights = [100, 300];
  assert.deepEqual(distributePopulationDelta(weights, -1000), [-100, -300]);
  assert.deepEqual(distributePopulationDelta(weights, -400), [-100, -300]);
});

test("權重含負值視為 0（clamp），不影響守恆", () => {
  const out = distributePopulationDelta([-50, 200], 100);
  assert.equal(
    out.reduce((a, b) => a + b, 0),
    100,
  );
  assert.equal(out[0], 0, "負權重不分到任何量");
});
