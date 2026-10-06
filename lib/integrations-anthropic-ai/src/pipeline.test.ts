/**
 * 管線總驗證：NIM 主線永遠最多 1 個在途請求；其他線路（池、備援）不受該限制。
 * 用三個本機假站：NIM 主線、通用池站、備援站，記錄各自「同時在途」峰值。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

type Probe = { inflight: number; peak: number; total: number };
function fakeSite(delayMs: number, mode: () => "ok" | "down" | "reasoning") {
  const p: Probe = { inflight: 0, peak: 0, total: 0 };
  const srv = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      p.inflight++; p.total++; p.peak = Math.max(p.peak, p.inflight);
      setTimeout(() => {
        p.inflight--;
        const m = mode();
        if (m === "down") { res.writeHead(503); res.end("{}"); return; }
        const message = m === "reasoning" ? { content: "", reasoning_content: "thinking…" } : { content: "OK" };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", model: "m", choices: [{ message, finish_reason: m === "reasoning" ? "length" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      }, delayMs);
    });
  });
  return { p, srv };
}

let nimMode: "ok" | "down" | "reasoning" = "ok";
let poolMode: "ok" | "down" | "reasoning" = "ok";
const nim = fakeSite(25, () => nimMode);
const pool = fakeSite(25, () => poolMode);
const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`)));
const nimUrl = await listen(nim.srv);
const poolUrl = await listen(pool.srv);

process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = nimUrl;
process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "nim-key";
const { anthropic } = await import("./client");
const { configureRoutePool, setRoutePoolConcurrency } = await import("./index");

const call = () => anthropic.messages.create({ model: "x", max_tokens: 64, messages: [{ role: "user", content: "hi" }] } as any);
const reset = () => { for (const s of [nim, pool]) { s.p.inflight = 0; s.p.peak = 0; s.p.total = 0; } };

test("池健康：40 個任務全由池處理，NIM 主線 0 次；池並行受設定的併發數限制", async () => {
  reset(); nimMode = "ok"; poolMode = "ok";
  configureRoutePool([{ id: "p1", name: "池", baseUrl: poolUrl, apiKey: "k", qualityModel: "q", bulkModel: "q", weight: 1, enabled: true }]);
  setRoutePoolConcurrency(6);
  await Promise.all(Array.from({ length: 40 }, call));
  assert.equal(nim.p.total, 0, "池健康時 NIM 一次都不該被打");
  assert.equal(pool.p.total, 40);
  assert.ok(pool.p.peak > 1 && pool.p.peak <= 6, `池並行峰值=${pool.p.peak}，應在 2~6`);
});

test("池全滅：任務退回佇列改走 NIM，且 NIM 同時在途永遠 ≤ 1", async () => {
  reset(); nimMode = "ok"; poolMode = "down";
  await Promise.all(Array.from({ length: 30 }, call));
  assert.equal(nim.p.total, 30, "30 個任務全部要完成（經由 NIM）");
  assert.equal(nim.p.peak, 1, `NIM 同時在途峰值=${nim.p.peak}，必須恰好為 1`);
});

test("沒有任何池線路：純 NIM，同時在途 ≤ 1", async () => {
  reset(); configureRoutePool([]); nimMode = "ok";
  await Promise.all(Array.from({ length: 20 }, call));
  assert.equal(nim.p.total, 20);
  assert.equal(nim.p.peak, 1);
});

test("池站是推理模型（content 空 + reasoning_content）：視為壞回應、改走 NIM，錯誤訊息具體", async () => {
  reset(); nimMode = "ok"; poolMode = "reasoning";
  configureRoutePool([{ id: "p1", name: "池", baseUrl: poolUrl, apiKey: "k", qualityModel: "q", bulkModel: "q", weight: 1, enabled: true }]);
  const outs = await Promise.all(Array.from({ length: 5 }, call));
  assert.ok(outs.every((o: any) => o.content[0].text === "OK"), "最終答案來自 NIM，不是推理過程");
  assert.equal(nim.p.peak <= 1, true);
  const { postChatCompletion } = await import("./client");
  await assert.rejects(
    postChatCompletion(`${poolUrl}/chat/completions`, "k", { model: "q", max_tokens: 8, messages: [{ role: "user", content: "x" }] } as any, "q"),
    /推理模型只輸出了思考過程/,
  );
});

test("池線路與 NIM 同時忙碌時互不阻塞（池不受 NIM 單併發拖慢）", async () => {
  reset(); nimMode = "ok"; poolMode = "ok";
  // 第 4 項讓 p1 斷路；管理員換 key 後存檔＝修好，斷路應立即重置而非乾等冷卻
  configureRoutePool([{ id: "p1", name: "池", baseUrl: poolUrl, apiKey: "k-fixed", qualityModel: "q", bulkModel: "q", weight: 1, enabled: true }]);
  setRoutePoolConcurrency(8);
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 32 }, call));
  const ms = Date.now() - t0;
  // 32 個任務 × 25ms，若被 NIM 的單併發串行化需 ≥ 800ms；並行 8 路約 100ms 上下
  assert.ok(ms < 500, `32 個任務花了 ${ms}ms，池應並行處理而非串行`);
});

test.after(() => { nim.srv.close(); pool.srv.close(); });

