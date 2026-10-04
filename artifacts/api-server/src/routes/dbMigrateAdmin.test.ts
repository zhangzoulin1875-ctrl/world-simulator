import test from "node:test";
import assert from "node:assert/strict";

process.env["ADMIN_TOKEN"] = "tok-123";
const express = (await import("express")).default;
const { default: router } = await import("./dbMigrateAdmin");
const app = express(); app.use(express.json()); app.use("/api", router);
const srv = app.listen(0);
const port = (srv.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api/admin/db-migrate`;
const call = async (method: string, body?: unknown, tok = "tok-123") => {
  const r = await fetch(base, { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, j: (await r.json()) as Record<string, any> };
};

test("db-migrate 端點護欄:驗證、確認、同庫、不洩漏密碼", async () => {
  const savedSrc = process.env["MIGRATE_SOURCE_URL"];
  try {
    assert.equal((await call("GET", undefined, "")).s, 401);
    assert.equal((await call("GET", undefined, "wrong")).s, 401);
    assert.equal((await call("POST", { confirm: "copy-into-current-db" }, "")).s, 401);
    delete process.env["MIGRATE_SOURCE_URL"];
    assert.equal((await call("POST", { confirm: "copy-into-current-db" })).s, 400);
    process.env["MIGRATE_SOURCE_URL"] = process.env["DATABASE_URL"];
    const same = await call("POST", { confirm: "copy-into-current-db" });
    assert.equal(same.s, 400); assert.match(String(same.j["error"]), /同一個資料庫/);
    process.env["MIGRATE_SOURCE_URL"] = "postgres://u:SECRETPW@other-host.invalid:5434/postgres";
    const noconf = await call("POST", {});
    assert.equal(noconf.s, 400); assert.match(String(noconf.j["error"]), /confirm/);
    assert.ok(!JSON.stringify(noconf.j).includes("SECRETPW"), "回應不得洩漏密碼");
    const g = await call("GET");
    assert.equal(g.s, 200);
    assert.ok(!JSON.stringify(g.j).includes("SECRETPW"), "GET 不得洩漏密碼");
    assert.equal(g.j["state"].status, "idle");
  } finally {
    if (savedSrc === undefined) delete process.env["MIGRATE_SOURCE_URL"]; else process.env["MIGRATE_SOURCE_URL"] = savedSrc;
    srv.close();
  }
});
