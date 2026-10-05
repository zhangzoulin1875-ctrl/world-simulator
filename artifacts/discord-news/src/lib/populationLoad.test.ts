import test from "node:test";
import assert from "node:assert/strict";
import { populationLoadState, populationLoadTextClass } from "./populationLoad";

test("負載分段:<0.9 成長、0.9~1.05 接近上限、>1.05 超載", () => {
  assert.equal(populationLoadState(0).tone, "grow");
  assert.equal(populationLoadState(0.5).tone, "grow");
  assert.equal(populationLoadState(0.899).tone, "grow");
  assert.equal(populationLoadState(0.9).tone, "near");
  assert.equal(populationLoadState(1).tone, "near");
  assert.equal(populationLoadState(1.05).tone, "near");
  assert.equal(populationLoadState(1.0501).tone, "over");
  assert.equal(populationLoadState(3).tone, "over");
});

test("顏色與分段一致:綠/黃/紅", () => {
  assert.equal(populationLoadTextClass(0.3), "text-green-400");
  assert.equal(populationLoadTextClass(1), "text-yellow-300");
  assert.equal(populationLoadTextClass(2), "text-red-400");
});

test("每段都有可讀的文字標籤,且三段互不相同", () => {
  const labels = [0.3, 1, 2].map((r) => populationLoadState(r).label);
  assert.equal(new Set(labels).size, 3);
  for (const l of labels) assert.ok(l.length > 0);
});
