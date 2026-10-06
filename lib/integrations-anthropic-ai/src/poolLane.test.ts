import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// 主線與池的假伺服器：必須在 import client 之前決定主線網址（client 載入時讀環境變數）。
process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "http://127.0.0.1:19101/v1";
process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "primary-key";

const hits = { primary: 0, poolA: 0, poolB: 0 };
let poolMode: "ok" | "down" = "ok";
const reply = (t: string) => ({ id: "x", model: "m", choices: [{ message: { content: t }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const mk = (port: number, onHit: () => { status: number; body: unknown }) =>
  new Promise<http.Server>((ok) => {
    const s = http.createServer((req, res) => {
      req.on("data", () => {}); req.on("end", () => {
        const r = onHit(); res.writeHead(r.status, { "content-type": "application/json" }); res.end(JSON.stringify(r.body));
      });
    }).listen(port, "127.0.0.1", () => ok(s));
  });

test("池線道：接管全部排隊任務、池全滅退回主線、池恢復後再接管", async (t) => {
  const servers = await Promise.all([
    mk(19101, () => { hits.primary++; return { status: 200, body: reply("from-primary") }; }),
    mk(19102, () => { hits.poolA++; return poolMode === "ok" ? { status: 200, body: reply("from-pool") } : { status: 503, body: { error: "down" } }; }),
    mk(19103, () => { hits.poolB++; return poolMode === "ok" ? { status: 200, body: reply("from-pool") } : { status: 503, body: { error: "down" } }; }),
  ]);
  t.after(() => servers.forEach((s) => s.close()));
  const { anthropic, configureRoutePool, getRoutePoolLaneStats, getRoutePool } = await import("./client");
  const R = (id: string, port: number) => ({ id, name: id, baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k-" + id, qualityModel: "q", bulkModel: "b", weight: 1, enabled: true });
  configureRoutePool([R("a", 19102), R("b", 19103)], 2);
  const call = () => anthropic.messages.create({ model: "x", max_tokens: 20, messages: [{ role: "user", content: "hi" }] } as never);

  // 1) 60 個同時排隊的任務（遠超 NIM 的 35 RPM）→ 全部由池完成、主線 0 次
  const t0 = Date.now();
  const many = await Promise.all(Array.from({ length: 60 }, call));
  assert.ok(many.every((m) => (m as { content: { text: string }[] }).content[0]!.text === "from-pool"));
  assert.equal(hits.primary, 0, "池健康時主線完全不碰");
  assert.ok(Date.now() - t0 < 5000, "60 個任務不受 35 RPM 限制");
  assert.equal(getRoutePoolLaneStats().handled, 60);

  // 2) 池全掛 → 任務不報錯，退回佇列改由主線完成
  poolMode = "down";
  const r = (await call()) as { content: { text: string }[] };
  assert.equal(r.content[0]!.text, "from-primary", "池掛了退回主線");
  assert.ok(getRoutePoolLaneStats().requeued >= 1);
  assert.ok(hits.primary >= 1);

  // 3) 壞線路累積到門檻（連續 3 次）後進入斷路；之後的任務不再白打它們，直接走主線
  for (let i = 0; i < 4; i++) await call();
  assert.ok(getRoutePool().snapshot().every((x) => x.state === "open"), "兩條壞線路都應已斷路");
  const poolHitsBefore = hits.poolA + hits.poolB;
  for (let i = 0; i < 5; i++) {
    const m = (await call()) as { content: { text: string }[] };
    assert.equal(m.content[0]!.text, "from-primary");
  }
  assert.equal(hits.poolA + hits.poolB, poolHitsBefore, "斷路後不再打壞線路");

  // 4) 池恢復並過冷卻 → 再度接管
  poolMode = "ok";
  for (const s of getRoutePool().snapshot()) getRoutePool().reportSuccess(s.route.id, 50); // 模擬探測成功解除斷路
  const back = (await call()) as { content: { text: string }[] };
  assert.equal(back.content[0]!.text, "from-pool", "恢復後再度由池處理");
});
