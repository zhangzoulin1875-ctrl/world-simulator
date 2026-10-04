import test from "node:test";
import assert from "node:assert/strict";
import { startDbKeepalive } from "./dbKeepalive";

test("未設定 DB_KEEPALIVE 時不啟動任何計時器（Neon 不被定時喚醒）", () => {
  delete process.env["DB_KEEPALIVE"];
  const calls: string[] = [];
  const st = global.setTimeout, si = global.setInterval;
  // @ts-expect-error 測試用攔截
  global.setTimeout = (...a) => { calls.push("timeout"); return st(...(a as [any])); };
  // @ts-expect-error 測試用攔截
  global.setInterval = (...a) => { calls.push("interval"); return si(...(a as [any])); };
  try { startDbKeepalive(); } finally { global.setTimeout = st; global.setInterval = si; }
  assert.deepEqual(calls, []);
});
