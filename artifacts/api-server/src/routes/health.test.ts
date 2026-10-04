import test from "node:test";
import assert from "node:assert/strict";

const express = (await import("express")).default;
const { default: router } = await import("./health");
const { pool } = await import("@workspace/db");
const app = express(); app.use("/api", router);
const srv = app.listen(0);
const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api`;

test("/healthz 不碰資料庫,永遠 200", async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { status: string }).status, "ok");
});

test("/healthz/db 資料庫正常時 200 並回報 db ok", async () => {
  const r = await fetch(`${base}/healthz/db`);
  const j = (await r.json()) as { status: string; db: string; ms: number };
  assert.equal(r.status, 200);
  assert.equal(j.db, "ok");
  assert.ok(j.ms >= 0);
});

test("/healthz/db 資料庫出錯時 503,且 /healthz 不受影響", async () => {
  const orig = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = async () => { throw new Error("connection refused"); };
  try {
    const bad = await fetch(`${base}/healthz/db`);
    assert.equal(bad.status, 503);
    assert.equal(((await bad.json()) as { db: string }).db, "error");
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    (pool as unknown as { query: unknown }).query = orig;
  }
});

test.after(() => srv.close());
