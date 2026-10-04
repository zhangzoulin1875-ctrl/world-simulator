import test from "node:test";
import assert from "node:assert/strict";
import { isPgInt4Id, PG_INT4_MAX } from "./pgInt";
test("isPgInt4Id 邊界", () => {
  assert.equal(isPgInt4Id(1), true);
  assert.equal(isPgInt4Id(PG_INT4_MAX), true);
  for (const bad of [0, -1, PG_INT4_MAX + 1, 99999999999, 1.5, NaN, Infinity, "3", null, undefined])
    assert.equal(isPgInt4Id(bad), false, String(bad));
});
