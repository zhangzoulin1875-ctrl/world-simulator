import test from "node:test";
import assert from "node:assert/strict";
import { findPgCode, apiErrorHandler } from "./apiErrorHandler";

function run(err: unknown) {
  let status = 0, body: any = null;
  const res: any = { headersSent: false, status(s: number) { status = s; return this; }, json(b: unknown) { body = b; return this; } };
  let nexted = false;
  apiErrorHandler(err as any, { originalUrl: "/x" } as any, res, () => { nexted = true; });
  return { status, body, nexted };
}

test("drizzle 包裝的 pg 22003(數值超出範圍)→ 400", () => {
  const e = Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("out of range"), { code: "22003" }) });
  assert.equal(findPgCode(e), "22003");
  assert.equal(run(e).status, 400);
});
test("22P02(非法 uuid/數字)→ 400", () => {
  assert.equal(run(Object.assign(new Error("x"), { code: "22P02" })).status, 400);
});
test("其他 pg 錯誤(例:23505 唯一鍵)不當成輸入錯誤 → 500 JSON", () => {
  const r = run(Object.assign(new Error("dup"), { code: "23505" }));
  assert.equal(r.status, 500); assert.equal(typeof r.body.error, "string");
});
test("JSON 解析錯誤(status 400)與過大 payload(413)保留 4xx", () => {
  assert.equal(run(Object.assign(new Error("bad json"), { status: 400 })).status, 400);
  assert.equal(run(Object.assign(new Error("big"), { status: 413 })).status, 413);
});
test("一般例外 → 500 JSON,不洩漏內部訊息", () => {
  const r = run(new Error("secret internal detail"));
  assert.equal(r.status, 500); assert.ok(!JSON.stringify(r.body).includes("secret"));
});
test("回應已送出 → 交給下一個處理器", () => {
  let nexted = false;
  apiErrorHandler(new Error("x") as any, {} as any, { headersSent: true } as any, () => { nexted = true; });
  assert.equal(nexted, true);
});
test("無 code 的物件與循環 cause 不會無限迴圈", () => {
  const a: any = {}; a.cause = a; assert.equal(findPgCode(a), null);
  assert.equal(findPgCode(null), null);
});
