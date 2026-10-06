/**
 * 安全回歸:/bot/* 的所有「寫入」路由都必須有 requireAdmin。
 *
 * 曾經 POST /bot/token 漏掉守衛,任何人不需登入就能用自己的 Discord token
 * 取代機器人並觸發重啟。本測試做兩件事:
 *  1) 靜態:bot.ts 中每個 post/put/patch/delete 路由的宣告都含 requireAdmin;
 *     唯讀的 GET /bot/status 是唯一允許公開的路由。
 *  2) 動態:掛上真的 router,未帶 / 帶錯 admin token 的 POST /bot/token 一律 401,
 *     且不會執行到 saveToken(請求根本進不了 handler)。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.ADMIN_TOKEN ||= "botguardtest-token";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

test("bot.ts:所有寫入型路由都帶 requireAdmin(只有 GET /bot/status 公開)", () => {
  const src = readFileSync(new URL("./bot.ts", import.meta.url), "utf-8");
  const decls = [...src.matchAll(/router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]([^]*?)async\s*\(/g)];
  assert.ok(decls.length >= 6, `應掃到所有 bot 路由,實際 ${decls.length}`);
  const publicOk = new Set(["get /bot/status"]);
  for (const [, method, path, between] of decls) {
    const key = `${method} ${path}`;
    if (publicOk.has(key)) continue;
    assert.match(between!, /requireAdmin/, `${key} 缺少 requireAdmin 守衛`);
  }
});

let server: http.Server;
let base = "";

before(async () => {
  const express = (await import("express")).default;
  const { default: botRouter } = await import("./bot");
  const app = express();
  app.use(express.json());
  app.use(botRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function postToken(headers: Record<string, string>) {
  return fetch(`${base}/bot/token`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ token: "attacker.fake.token" }),
  });
}

test("POST /bot/token:沒有 admin token → 401", async () => {
  const r = await postToken({});
  assert.equal(r.status, 401);
});

test("POST /bot/token:錯誤 admin token → 401", async () => {
  const r = await postToken({ "x-admin-token": "wrong-token" });
  assert.equal(r.status, 401);
  const r2 = await postToken({ authorization: "Bearer wrong-token" });
  assert.equal(r2.status, 401);
});

test("POST /bot/token:正確 admin token → 通過守衛(之後因假 token 驗證失敗回 400,而非 401)", async () => {
  const r = await postToken({ "x-admin-token": ADMIN_TOKEN! });
  assert.notEqual(r.status, 401, "正確 token 不該被守衛擋下");
});
