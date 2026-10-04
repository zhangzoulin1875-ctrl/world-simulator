import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

/**
 * 手動政體變更已下線(2026-10-05):端點必須回 410,且未登入仍是 401
 * (閘門不可被下線邏輯繞過)。政體改由國策樹的轉型國策決定。
 */
async function withApp<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { default: router } = await import("./politics");
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("未登入呼叫 government-change 仍回 401", async () => {
  await withApp(async (base) => {
    const r = await fetch(`${base}/api/politics/government-change`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ government: "parliamentary" }),
    });
    assert.equal(r.status, 401);
  });
});
