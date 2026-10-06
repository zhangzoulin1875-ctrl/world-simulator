import test from "node:test";
import assert from "node:assert/strict";
import { SupportQueue, defaultBackoffMs } from "./supportQueue";

const instantSleep = async () => undefined;
const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("等待逾時");
    await new Promise((r) => setTimeout(r, 2));
  }
};

test("嚴格先進先出：前面的慢，後面的照樣排到、不會被丟", async () => {
  const order: string[] = [];
  const q = new SupportQueue<string>({
    sleep: instantSleep,
    handler: async (job) => {
      if (job.id === "a") await new Promise((r) => setTimeout(r, 40)); // 第一則很慢
      order.push(job.id);
    },
  });
  q.enqueue("a", "A"); q.enqueue("b", "B"); q.enqueue("c", "C");
  await until(() => order.length === 3);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(q.stats.done, 3);
  assert.equal(q.stats.gaveUp, 0);
});

test("單一工作者：同一時間只處理一則（不搶 AI 額度）", async () => {
  let active = 0, peak = 0, done = 0;
  const q = new SupportQueue<number>({
    sleep: instantSleep,
    handler: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; done++;
    },
  });
  for (let i = 0; i < 6; i++) q.enqueue(`m${i}`, i);
  await until(() => done === 6);
  assert.equal(peak, 1);
});

test("暫時失敗會重試直到成功；重試期間後面的不插隊", async () => {
  const order: string[] = [];
  const attempts: Record<string, number> = {};
  const q = new SupportQueue<string>({
    sleep: instantSleep,
    handler: async (job, attempt) => {
      attempts[job.id] = attempt;
      if (job.id === "a" && attempt < 4) throw new Error("AI 暫時掛了");
      order.push(job.id);
    },
  });
  q.enqueue("a", "A"); q.enqueue("b", "B");
  await until(() => order.length === 2);
  assert.deepEqual(order, ["a", "b"], "a 重試成功前 b 不能先回");
  assert.equal(attempts["a"], 4);
  assert.equal(q.stats.retries, 3);
  assert.equal(q.stats.gaveUp, 0);
});

test("重試用盡 → 呼叫 onGiveUp 交代，且後面的訊息照樣處理", async () => {
  const gaveUp: string[] = []; const done: string[] = [];
  const q = new SupportQueue<string>({
    sleep: instantSleep, maxAttempts: 3,
    handler: async (job) => { if (job.id === "bad") throw new Error("永遠失敗"); done.push(job.id); },
    onGiveUp: (job) => { gaveUp.push(job.id); },
  });
  q.enqueue("bad", "x"); q.enqueue("ok", "y");
  await until(() => done.length === 1 && gaveUp.length === 1);
  assert.deepEqual(gaveUp, ["bad"]);
  assert.deepEqual(done, ["ok"]);
  assert.equal(q.stats.gaveUp, 1);
});

test("onGiveUp 自己丟錯也不會讓佇列卡死", async () => {
  const done: string[] = [];
  const q = new SupportQueue<string>({
    sleep: instantSleep, maxAttempts: 1,
    handler: async (job) => { if (job.id === "bad") throw new Error("x"); done.push(job.id); },
    onGiveUp: () => { throw new Error("交代也失敗"); },
  });
  q.enqueue("bad", "x"); q.enqueue("ok", "y");
  await until(() => done.length === 1);
  assert.deepEqual(done, ["ok"]);
});

test("佇列上限：超過就拒收（回 null），由呼叫端明確告知，不是默默丟掉", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const q = new SupportQueue<number>({ sleep: instantSleep, maxQueueLength: 3, handler: async () => { await gate; } });
  assert.ok(q.enqueue("1", 1)); assert.ok(q.enqueue("2", 2)); assert.ok(q.enqueue("3", 3));
  assert.equal(q.enqueue("4", 4), null);
  release();
  await until(() => q.length === 0);
  assert.ok(q.enqueue("5", 5), "清空後可再收");
});

test("enqueue 回傳排隊位置", () => {
  const q = new SupportQueue<number>({ sleep: instantSleep, handler: () => new Promise(() => undefined) });
  assert.equal(q.enqueue("1", 1)!.position, 1);
  assert.equal(q.enqueue("2", 2)!.position, 2);
  assert.equal(q.enqueue("3", 3)!.position, 3);
});

test("退避時間指數成長並封頂 60 秒；預設重試總等待足以撐過長時間排隊", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(defaultBackoffMs), [2000, 4000, 8000, 16000, 32000]);
  assert.equal(defaultBackoffMs(10), 60_000);
  const total = [1, 2, 3, 4, 5].reduce((s, n) => s + defaultBackoffMs(n), 0);
  assert.ok(total >= 60_000, `預設 6 次嘗試的累計等待 ${total}ms`);
});
