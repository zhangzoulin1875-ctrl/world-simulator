import test from "node:test";
import assert from "node:assert/strict";
import { startDbKeepalive, shouldKeepalive, resolveKeepaliveMinutes, pingDatabaseOnce } from "./dbKeepalive";

const AIVEN = "postgres://u:p@pg-x.g.aivencloud.com:23307/defaultdb";
const NEON = "postgres://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb";

test("是否啟動:Neon 預設不啟動(避免喚醒燒額度),Aiven/Supabase 預設啟動,DB_KEEPALIVE 可覆蓋", () => {
  assert.equal(shouldKeepalive({ DATABASE_URL: NEON }), false);
  assert.equal(shouldKeepalive({ DATABASE_URL: AIVEN }), true);
  assert.equal(shouldKeepalive({ DATABASE_URL: "postgres://u:p@db.abc.supabase.co/postgres" }), true);
  assert.equal(shouldKeepalive({ DATABASE_URL: NEON, DB_KEEPALIVE: "1" }), true);
  assert.equal(shouldKeepalive({ DATABASE_URL: AIVEN, DB_KEEPALIVE: "0" }), false);
  assert.equal(shouldKeepalive({}), true);
});

test("間隔解析:預設 10,夾在 1~1440,亂填回預設", () => {
  assert.equal(resolveKeepaliveMinutes(undefined), 10);
  assert.equal(resolveKeepaliveMinutes(""), 10);
  assert.equal(resolveKeepaliveMinutes("abc"), 10);
  assert.equal(resolveKeepaliveMinutes("0"), 10);
  assert.equal(resolveKeepaliveMinutes("0.4"), 1);
  assert.equal(resolveKeepaliveMinutes("15"), 15);
  assert.equal(resolveKeepaliveMinutes("99999"), 1440);
});

test("Neon 主機未設 DB_KEEPALIVE 時不建立任何計時器", () => {
  const saved = { k: process.env["DB_KEEPALIVE"], u: process.env["DATABASE_URL"] };
  delete process.env["DB_KEEPALIVE"]; process.env["DATABASE_URL"] = NEON;
  const calls: string[] = [];
  const st = global.setTimeout, si = global.setInterval;
  // @ts-expect-error 測試替身
  global.setTimeout = (...a) => { calls.push("timeout"); return st(...(a as [any])); };
  // @ts-expect-error 測試替身
  global.setInterval = (...a) => { calls.push("interval"); return si(...(a as [any])); };
  try { startDbKeepalive(); } finally {
    global.setTimeout = st; global.setInterval = si;
    if (saved.k === undefined) delete process.env["DB_KEEPALIVE"]; else process.env["DB_KEEPALIVE"] = saved.k;
    process.env["DATABASE_URL"] = saved.u!;
  }
  assert.deepEqual(calls, []);
});

test("Aiven 主機會建立計時器,且間隔依 DB_KEEPALIVE_MINUTES", () => {
  const saved = { k: process.env["DB_KEEPALIVE"], u: process.env["DATABASE_URL"], m: process.env["DB_KEEPALIVE_MINUTES"] };
  delete process.env["DB_KEEPALIVE"]; process.env["DATABASE_URL"] = AIVEN; process.env["DB_KEEPALIVE_MINUTES"] = "7";
  const delays: number[] = [];
  const st = global.setTimeout, si = global.setInterval;
  // @ts-expect-error 測試替身
  global.setTimeout = (fn, ms, ...r) => { delays.push(ms); return st(() => {}, 0, ...r); };
  // @ts-expect-error 測試替身
  global.setInterval = (fn, ms, ...r) => { delays.push(ms); return si(() => {}, 1e9, ...r); };
  try { startDbKeepalive(); } finally {
    global.setTimeout = st; global.setInterval = si;
    if (saved.k === undefined) delete process.env["DB_KEEPALIVE"]; else process.env["DB_KEEPALIVE"] = saved.k;
    process.env["DATABASE_URL"] = saved.u!;
    if (saved.m === undefined) delete process.env["DB_KEEPALIVE_MINUTES"]; else process.env["DB_KEEPALIVE_MINUTES"] = saved.m;
  }
  assert.deepEqual(delays, [60_000, 7 * 60_000]);
});

test("查詢成功 true;失敗 false 且不丟例外;上一次未完成時不重疊", async () => {
  assert.equal(await pingDatabaseOnce(async () => {}), true);
  assert.equal(await pingDatabaseOnce(async () => { throw new Error("boom"); }), false);
  let calls = 0; let release!: () => void;
  const slow = () => new Promise<void>((r) => { calls++; release = r; });
  const first = pingDatabaseOnce(slow);
  assert.equal(await pingDatabaseOnce(slow), true);
  assert.equal(calls, 1);
  release(); await first;
});

test("對真實資料庫查詢可成功", async () => {
  assert.equal(await pingDatabaseOnce(), true);
});

test.after(async () => { const { pool } = await import("@workspace/db"); await pool.end(); });
