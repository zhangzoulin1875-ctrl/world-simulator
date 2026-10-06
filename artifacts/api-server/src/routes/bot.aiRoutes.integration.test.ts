/**
 * AI 線路池管理 API（前端 /ai-routes 頁面使用的所有端點）整合測試：
 * 真 router + 真資料庫 + 假的上游 AI 站。
 */
import { strict as assert } from "node:assert";
import test, { after, before } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";

process.env.ADMIN_TOKEN ||= "airoutes-test-token";
const TOKEN = process.env.ADMIN_TOKEN;
const H = { "content-type": "application/json", "x-admin-token": TOKEN! };

let server: http.Server;
let base = "";
let upstream: http.Server;
let upstreamBase = "";
let upstreamMode: "ok" | "empty" | "down" = "ok";
let lastAuth = "";

before(async () => {
  upstream = http.createServer((req, res) => {
    lastAuth = String(req.headers.authorization);
    req.on("data", () => {});
    req.on("end", () => {
      if (upstreamMode === "down") { res.writeHead(503); res.end("{}"); return; }
      const text = upstreamMode === "empty" ? "" : "OK";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", model: "m", choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;

  const { runGameMigrations } = await import("../lib/gameMigrations");
  await runGameMigrations();
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
  const { saveRoutes } = await import("../lib/aiRoutePool");
  await saveRoutes([]); // 清掉測試線路，避免影響其他測試
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

const put = (routes: unknown[]) => fetch(`${base}/bot/ai-routes`, { method: "PUT", headers: H, body: JSON.stringify({ routes }) });
const get = () => fetch(`${base}/bot/ai-routes`, { headers: H });

test("沒有 admin token：四個端點全部 401", async () => {
  const calls = await Promise.all([
    fetch(`${base}/bot/ai-routes`),
    fetch(`${base}/bot/ai-routes`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }),
    fetch(`${base}/bot/ai-routes/x/test`, { method: "POST" }),
    fetch(`${base}/bot/ai-routes/concurrency`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }),
  ]);
  assert.deepEqual(calls.map((r) => r.status), [401, 401, 401, 401]);
});

test("新增線路（前端不送 id）→ 後端產生 id；key 在 GET 一律遮罩", async () => {
  const r = await put([{ name: "站A", baseUrl: upstreamBase + "/chat/completions", apiKey: "sk-secret-key-123456", qualityModel: "q", bulkModel: "", weight: 2, enabled: true }]);
  assert.equal(r.status, 200);
  const body = (await (await get()).json()) as { routes: any[]; lane: any };
  assert.equal(body.routes.length, 1);
  const row = body.routes[0];
  assert.ok(row.id && row.id.length > 0, "後端要產生 id");
  assert.equal(row.baseUrl, upstreamBase, "貼到 /chat/completions 會被整理掉");
  assert.equal(row.bulkModel, "q", "量產模型留空＝同品質模型");
  assert.equal(row.weight, 2);
  assert.ok(!JSON.stringify(body).includes("secret-key-123456"), "完整 key 絕不可出現在回應");
  assert.match(row.apiKey, /…/);
  assert.equal(typeof body.lane.concurrency, "number");
});

test("再次儲存時 key 留空或帶遮罩值 → 沿用舊 key（前端只改權重時不必重貼 key）", async () => {
  const before = ((await (await get()).json()) as any).routes[0];
  const r1 = await put([{ ...before, apiKey: "", weight: 5 }]);
  assert.equal(r1.status, 200);
  const r2 = await put([{ ...before, apiKey: before.apiKey, weight: 6 }]); // 前端若回送遮罩值
  assert.equal(r2.status, 200);
  const after2 = ((await (await get()).json()) as any).routes[0];
  assert.equal(after2.weight, 6);
  // 用測試端點驗證實際送出的還是原本的完整 key
  upstreamMode = "ok";
  const t = await fetch(`${base}/bot/ai-routes/${after2.id}/test`, { method: "POST", headers: H });
  const tb = (await t.json()) as any;
  assert.equal(tb.ok, true, JSON.stringify(tb));
  assert.equal(lastAuth, "Bearer sk-secret-key-123456", "沿用的是舊 key，不是空字串或遮罩值");
});

test("測試端點：上游回空內容 → ok=false 並說明；上游掛掉 → ok=false；不存在的 id → 404", async () => {
  const id = ((await (await get()).json()) as any).routes[0].id;
  upstreamMode = "empty";
  const e = (await (await fetch(`${base}/bot/ai-routes/${id}/test`, { method: "POST", headers: H })).json()) as any;
  assert.equal(e.ok, false); assert.match(e.error, /空/);
  upstreamMode = "down";
  const d = (await (await fetch(`${base}/bot/ai-routes/${id}/test`, { method: "POST", headers: H })).json()) as any;
  assert.equal(d.ok, false); assert.ok(d.error);
  const nf = await fetch(`${base}/bot/ai-routes/nope/test`, { method: "POST", headers: H });
  assert.equal(nf.status, 404);
  upstreamMode = "ok";
});

test("驗證失敗回 400 且帶中文原因，並且不會破壞已存的線路", async () => {
  const keep = ((await (await get()).json()) as any).routes;
  const bad = [
    [{ name: "壞", baseUrl: "ftp://x", apiKey: "k", qualityModel: "q" }],
    [{ name: "壞", baseUrl: upstreamBase, apiKey: "", qualityModel: "q" }],
    [{ name: "壞", baseUrl: upstreamBase, apiKey: "k", qualityModel: "" }],
  ];
  for (const routes of bad) {
    const r = await put(routes);
    assert.equal(r.status, 400);
    const j = (await r.json()) as any;
    assert.equal(j.ok, false); assert.ok(typeof j.error === "string" && j.error.length > 0);
  }
  const tooMany = await put(Array.from({ length: 13 }, (_, i) => ({ name: `n${i}`, baseUrl: upstreamBase, apiKey: "k", qualityModel: "q" })));
  assert.equal(tooMany.status, 400);
  const still = ((await (await get()).json()) as any).routes;
  assert.equal(still.length, keep.length, "失敗的儲存不可改動既有設定");
});

test("權重被限制在 1 到 20；停用的線路保留在清單但不進池", async () => {
  const r = await put([
    { name: "重", baseUrl: upstreamBase, apiKey: "k1", qualityModel: "q", weight: 999 },
    { name: "輕", baseUrl: upstreamBase, apiKey: "k2", qualityModel: "q", weight: -3 },
    { name: "停", baseUrl: upstreamBase, apiKey: "k3", qualityModel: "q", weight: 1, enabled: false },
  ]);
  assert.equal(r.status, 200);
  const rows = ((await (await get()).json()) as any).routes;
  assert.deepEqual(rows.map((x: any) => x.weight), [20, 1, 1]);
  assert.equal(rows[2].enabled, false);
  assert.equal(rows[2].state, "disabled");
  const { getRoutePool } = await import("@workspace/integrations-anthropic-ai");
  assert.equal(getRoutePool().size(), 2, "停用的線路不進池");
});

test("併發設定：1 到 16 生效，範圍外 400", async () => {
  const ok = await fetch(`${base}/bot/ai-routes/concurrency`, { method: "PUT", headers: H, body: JSON.stringify({ concurrency: 7 }) });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as any).lane.concurrency, 7);
  assert.equal(((await (await get()).json()) as any).lane.concurrency, 7);
  for (const v of [0, 17, "abc", null]) {
    const r = await fetch(`${base}/bot/ai-routes/concurrency`, { method: "PUT", headers: H, body: JSON.stringify({ concurrency: v }) });
    assert.equal(r.status, 400, `concurrency=${String(v)} 應 400`);
  }
  await fetch(`${base}/bot/ai-routes/concurrency`, { method: "PUT", headers: H, body: JSON.stringify({ concurrency: 4 }) });
});
