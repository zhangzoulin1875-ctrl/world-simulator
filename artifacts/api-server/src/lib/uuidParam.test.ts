import test from "node:test";
import assert from "node:assert/strict";
import { isUuid, uuidParam } from "./uuidParam";

test("isUuid：合法 uuid 通過，畸形字串被擋", () => {
  assert.equal(isUuid("b9eb1409-f3fd-4fbd-8a58-5c38b6c39948"), true);
  assert.equal(isUuid("B9EB1409-F3FD-4FBD-8A58-5C38B6C39948"), true);
  for (const bad of ["1", "abc", "", "%00", "b9eb1409f3fd4fbd8a585c38b6c39948", "b9eb1409-f3fd-4fbd-8a58-5c38b6c3994", undefined, 1, null]) {
    assert.equal(isUuid(bad), false, String(bad));
  }
});

test("uuidParam：畸形 id 回 404 且不呼叫 next；合法 id 放行", () => {
  let nextCalled = 0; let status = 0; let body: unknown;
  const res: any = { status(s: number) { status = s; return this; }, json(b: unknown) { body = b; return this; } };
  (uuidParam as any)({}, res, () => { nextCalled++; }, "1", "id");
  assert.equal(nextCalled, 0); assert.equal(status, 404); assert.ok(body);
  (uuidParam as any)({}, res, () => { nextCalled++; }, "b9eb1409-f3fd-4fbd-8a58-5c38b6c39948", "id");
  assert.equal(nextCalled, 1);
});
