import test from "node:test";
import assert from "node:assert/strict";
import {
  RoutePool, runWithPool, parseRetryAfterMs, isRouteFault,
  BREAKER_THRESHOLD, COOLDOWN_BASE_MS, COOLDOWN_MAX_MS, type PoolRoute,
} from "./routePool";

const mk = (id: string, weight = 1, over: Partial<PoolRoute> = {}): PoolRoute => ({
  id, name: id, baseUrl: `https://${id}.example/v1`, apiKey: "k", qualityModel: "q", bulkModel: "b",
  weight, enabled: true, ...over,
});

function setup(routes: PoolRoute[]) {
  let t = 1_000_000;
  const pool = new RoutePool(() => t);
  pool.setRoutes(routes);
  return { pool, tick: (ms: number) => { t += ms; }, now: () => t };
}

test("同權重＝輪流；權重 3:1 約三比一", () => {
  const a = setup([mk("a"), mk("b"), mk("c")]);
  const seq = Array.from({ length: 6 }, () => a.pool.pick()!.id);
  assert.deepEqual(seq, ["a", "b", "c", "a", "b", "c"]);
  const b = setup([mk("x", 3), mk("y", 1)]);
  const cnt = { x: 0, y: 0 } as Record<string, number>;
  for (let i = 0; i < 400; i++) cnt[b.pool.pick()!.id]!++;
  assert.equal(cnt.x, 300); assert.equal(cnt.y, 100);
});

test("停用、缺 key、缺網址的線路不會進池", () => {
  const { pool } = setup([mk("a"), mk("off", 1, { enabled: false }), mk("nokey", 1, { apiKey: "" }), mk("nourl", 1, { baseUrl: "" })]);
  assert.equal(pool.size(), 1);
});

test("連續失敗達門檻 → 開路；期間不被選；冷卻後半開只放一個探測", () => {
  const { pool, tick } = setup([mk("a"), mk("b")]);
  for (let i = 0; i < BREAKER_THRESHOLD; i++) pool.reportFailure("a", "HTTP 502 bad gateway");
  assert.equal(pool.snapshot().find((s) => s.route.id === "a")!.state, "open");
  for (let i = 0; i < 6; i++) assert.equal(pool.pick()!.id, "b", "開路線路不被選");
  tick(COOLDOWN_BASE_MS + 1);
  assert.equal(pool.snapshot().find((s) => s.route.id === "a")!.state, "half-open");
  const first = pool.pick(new Set(["b"]));
  assert.equal(first!.id, "a", "半開放一個探測");
  assert.equal(pool.pick(new Set(["b"])), null, "探測進行中不再放第二個");
});

test("探測成功 → 完全恢復；探測失敗 → 冷卻加倍", () => {
  const { pool, tick, now } = setup([mk("a")]);
  for (let i = 0; i < BREAKER_THRESHOLD; i++) pool.reportFailure("a", "HTTP 503");
  tick(COOLDOWN_BASE_MS + 1);
  pool.pick(); pool.reportFailure("a", "HTTP 503");
  const h = pool.getHealth("a")!;
  assert.ok(h.openUntil - now() >= COOLDOWN_BASE_MS * 2 - 5, "第二次冷卻約加倍");
  tick(COOLDOWN_BASE_MS * 2 + 1);
  pool.pick(); pool.reportSuccess("a", 120);
  const ok = pool.getHealth("a")!;
  assert.equal(ok.openUntil, 0); assert.equal(ok.consecutiveFailures, 0);
});

test("冷卻有上限，不會無限變長", () => {
  const { pool, tick, now } = setup([mk("a")]);
  for (let i = 0; i < 40; i++) { pool.reportFailure("a", "HTTP 500"); tick(COOLDOWN_MAX_MS + 1); pool.pick(); }
  pool.reportFailure("a", "HTTP 500");
  assert.ok(pool.getHealth("a")!.openUntil - now() <= COOLDOWN_MAX_MS);
});

test("429 帶 retry-after／retry in：照對方指示冷卻（即使未達門檻）", () => {
  const { pool, now } = setup([mk("a")]);
  pool.reportFailure("a", "HTTP 429 rate limited, retry-after: 45");
  assert.equal(pool.getHealth("a")!.openUntil - now(), 45_000);
  assert.equal(parseRetryAfterMs("429 ... retry in 2m10s"), 130_000);
  assert.equal(parseRetryAfterMs("retry in 99h"), 30 * 60_000, "上限 30 分");
  assert.equal(parseRetryAfterMs("just broken"), null);
});

test("請求本身的錯（400/422）不懲罰線路；404（線路沒有該模型）與 5xx/429/逾時要懲罰", () => {
  assert.equal(isRouteFault("HTTP 400 bad request: max_tokens too large"), false);
  assert.equal(isRouteFault("HTTP 422 unprocessable"), false);
  assert.equal(isRouteFault("HTTP 404 model not found"), true);
  assert.equal(isRouteFault("HTTP 502"), true);
  assert.equal(isRouteFault("HTTP 429"), true);
  assert.equal(isRouteFault("fetch failed: timeout"), true);
  const { pool } = setup([mk("a")]);
  for (let i = 0; i < 10; i++) pool.reportFailure("a", "HTTP 400 bad request");
  assert.equal(pool.snapshot()[0]!.state, "ok");
});

test("runWithPool：第一條壞就換下一條，成功後回傳；壞線路被記一筆", async () => {
  const { pool } = setup([mk("bad"), mk("good")]);
  const calls: string[] = [];
  const r = await runWithPool(pool, 3, async (route) => {
    calls.push(route.id);
    if (route.id === "bad") throw new Error("HTTP 502");
    return "ok";
  });
  assert.equal(r, "ok"); assert.deepEqual(calls, ["bad", "good"]);
  assert.equal(pool.getHealth("bad")!.failures, 1);
  assert.equal(pool.getHealth("good")!.successes, 1);
});

test("runWithPool：同一請求不會重試同一條線路；maxAttempts 限制嘗試條數", async () => {
  const { pool } = setup([mk("a"), mk("b"), mk("c"), mk("d")]);
  const calls: string[] = [];
  await assert.rejects(
    runWithPool(pool, 3, async (r) => { calls.push(r.id); throw new Error("HTTP 500"); }),
    /所有 AI 線路都失敗/,
  );
  assert.equal(calls.length, 3); assert.equal(new Set(calls).size, 3);
});

test("runWithPool：回 200 但內容是空的／亂碼（公益站常見）也算失敗並換線", async () => {
  const { pool } = setup([mk("empty"), mk("real")]);
  const r = await runWithPool(
    pool, 3,
    async (route) => (route.id === "empty" ? "" : "{\"ok\":true}"),
    (res) => (res.trim() === "" ? "空回應" : null),
  );
  assert.equal(r, "{\"ok\":true}");
  assert.equal(pool.getHealth("empty")!.lastError, "空回應");
});

test("runWithPool：全部開路時立刻丟出清楚的錯，不卡住", async () => {
  const { pool } = setup([mk("a")]);
  for (let i = 0; i < BREAKER_THRESHOLD; i++) pool.reportFailure("a", "HTTP 503");
  await assert.rejects(runWithPool(pool, 3, async () => "x"), /沒有可用的線路/);
});

test("setRoutes 重新載入：保留仍存在線路的健康狀態、移除已刪除的", () => {
  const { pool } = setup([mk("a"), mk("b")]);
  pool.reportSuccess("a", 100);
  pool.setRoutes([mk("a"), mk("c")]);
  assert.equal(pool.getHealth("a")!.successes, 1);
  assert.equal(pool.getHealth("b"), undefined);
  assert.ok(pool.getHealth("c"));
});
