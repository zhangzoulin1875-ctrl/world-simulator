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

test("/healthz/bot：沒設 Token 的全新部署不算異常（200 not-configured），且不影響 /healthz", async () => {
  process.env["DISCORD_BOT_TOKEN"] = "";
  const { db, botSettingsTable } = await import("@workspace/db");
  await db.delete(botSettingsTable);
  const r = await fetch(`${base}/healthz/bot`);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { bot: string }).bot, "not-configured");
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("/healthz/bot：有 Token 但機器人沒連上 → 503 degraded，並帶出診斷；/healthz 仍 200（Render 不會因此重啟服務）", async () => {
  process.env["DISCORD_BOT_TOKEN"] = "fake-token";
  try {
    const r = await fetch(`${base}/healthz/bot`);
    const j = (await r.json()) as { status: string; bot: string; autoRestarts: number };
    assert.equal(r.status, 503);
    assert.equal(j.status, "degraded");
    assert.equal(j.bot, "down");
    assert.equal(typeof j.autoRestarts, "number");
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  } finally {
    process.env["DISCORD_BOT_TOKEN"] = "";
  }
});

test.after(() => srv.close());
