import test from "node:test";
import assert from "node:assert/strict";
import { buildEraAndRegionRules } from "./designReviewRules";

test("strict：嚴格比照真實歷史，無地區公平條款", () => {
  const r = buildEraAndRegionRules("strict", "兵種").join("\n");
  assert.match(r, /嚴格比照真實歷史/);
  assert.doesNotMatch(r, /地區公平條款/);
});

test("balanced：含地區公平條款，地理（如美洲無馬）不是退件理由", () => {
  const r = buildEraAndRegionRules("balanced", "兵種").join("\n");
  assert.match(r, /地區公平條款/);
  assert.match(r, /不是退件理由/);
  assert.match(r, /略早一點的合理原型/);
});

test("lenient：放寬約一個時代且保留地區公平條款", () => {
  const r = buildEraAndRegionRules("lenient", "武器").join("\n");
  assert.match(r, /最多約 1 個時代/);
  assert.match(r, /地區公平條款/);
  assert.match(r, /武器/);
});
