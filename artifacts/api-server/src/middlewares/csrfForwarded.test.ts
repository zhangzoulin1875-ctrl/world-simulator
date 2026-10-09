import assert from "node:assert/strict";
import test from "node:test";
process.env.PUBLIC_HOSTS = "game.example.workers.dev, other.example.com";
const { csrfGuard } = await import("./csrf");
const { SESSION_COOKIE_NAME } = await import("../lib/sessions");

function run(headers: Record<string, string>, method = "POST", cookie = true) {
  let status = 0, passed = false;
  const req: any = {
    method, url: "/api/x", cookies: cookie ? { [SESSION_COOKIE_NAME]: "s" } : {},
    get: (k: string) => headers[k.toLowerCase()], log: { warn() {} },
  };
  const res: any = { status(c: number) { status = c; return this; }, json() {} };
  csrfGuard(req, res, () => { passed = true; });
  return { status, passed };
}
test("轉發:Origin 是 Cloudflare 網域、X-Forwarded-Host 在白名單 → 放行", () => {
  assert.equal(run({ host: "x.onrender.com", origin: "https://game.example.workers.dev", "x-forwarded-host": "game.example.workers.dev" }).passed, true);
});
test("轉發:偽造的 X-Forwarded-Host 不在白名單 → 仍以 Host 比對,擋下", () => {
  const r = run({ host: "x.onrender.com", origin: "https://evil.com", "x-forwarded-host": "evil.com" });
  assert.equal(r.passed, false); assert.equal(r.status, 403);
});
test("轉發:白名單網域但 Origin 是別站 → 擋下", () => {
  assert.equal(run({ host: "x.onrender.com", origin: "https://evil.com", "x-forwarded-host": "game.example.workers.dev" }).status, 403);
});
test("直連 Render(沒有轉發)行為不變:同 Host 放行、跨站擋下", () => {
  assert.equal(run({ host: "x.onrender.com", origin: "https://x.onrender.com" }).passed, true);
  assert.equal(run({ host: "x.onrender.com", origin: "https://evil.com" }).status, 403);
});
test("GET 與沒有 session cookie 的請求不受影響", () => {
  assert.equal(run({ host: "a" }, "GET").passed, true);
  assert.equal(run({ host: "a", origin: "https://evil.com" }, "POST", false).passed, true);
});
