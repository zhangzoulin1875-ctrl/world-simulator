import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_QUEUE_TEMPLATES,
  advanceQueue,
  canEnqueue,
  estimateTurnsToFinish,
  trainingPointsPerUnit,
  turnCapacity,
  type QueueEntry,
} from "./recruitQueueCore";

const e = (id: number, templateId: number, remaining: number, tp: number): QueueEntry => ({
  id, templateId, remaining, tpPerUnit: tp,
});

test("TP：步兵 1→2、騎兵 10→6、艦船 100→51，且下限 1", () => {
  assert.equal(trainingPointsPerUnit(1), 2);
  assert.equal(trainingPointsPerUnit(10), 6);
  assert.equal(trainingPointsPerUnit(100), 51);
  assert.equal(trainingPointsPerUnit(0), 1);
  assert.equal(trainingPointsPerUnit(NaN), 1);
});

test("產能：隨人口線性、下限 1、科技加成", () => {
  assert.equal(turnCapacity(10_000_000), 20_000);
  assert.equal(turnCapacity(0), 1);
  assert.equal(turnCapacity(10_000_000, 0.002, 50), 30_000);
  assert.equal(turnCapacity(NaN), 1);
});

test("FIFO：先進的訂單先吃產能", () => {
  const r = advanceQueue([e(1, 10, 100, 2), e(2, 20, 100, 2)], 150);
  assert.deepEqual(r.completed, [
    { id: 1, templateId: 10, units: 75 },
  ]);
  assert.equal(r.remaining[0]!.remaining, 25);
  assert.equal(r.remaining[1]!.remaining, 100);
});

test("前一筆吃完後，剩餘產能給下一筆", () => {
  const r = advanceQueue([e(1, 10, 10, 2), e(2, 20, 100, 2)], 100);
  assert.deepEqual(r.completed.map((c) => [c.id, c.units]), [[1, 10], [2, 40]]);
  assert.equal(r.pointsUsed, 100);
});

test("整數單位：零頭產能留給後面較便宜的訂單", () => {
  // 產能 10；第一筆單位 TP=6 只能做 1（用 6），剩 4 給第二筆 TP=2 做 2。
  const r = advanceQueue([e(1, 10, 5, 6), e(2, 20, 5, 2)], 10);
  assert.deepEqual(r.completed.map((c) => [c.id, c.units]), [[1, 1], [2, 2]]);
});

test("單位 TP 大於整個產能時仍須能推進（否則永遠練不出來）", () => {
  const r = advanceQueue([e(1, 10, 3, 51)], 20);
  assert.equal(r.completed[0]?.units, 1, "至少完成 1 單位，不能永久卡死");
});

test("佇列：同兵種可追加；滿 3 個不同兵種時拒絕第 4 個", () => {
  assert.deepEqual(canEnqueue([], 1), { ok: true, isNewTemplate: true });
  assert.deepEqual(canEnqueue([1, 2], 3), { ok: true, isNewTemplate: true });
  assert.deepEqual(canEnqueue([1, 2, 3], 2), { ok: true, isNewTemplate: false });
  assert.deepEqual(canEnqueue([1, 2, 3], 4), { ok: false, reason: "QUEUE_FULL" });
  // 同兵種多筆訂單只算 1 個兵種
  assert.deepEqual(canEnqueue([1, 1, 1, 2], 3), { ok: true, isNewTemplate: true });
  assert.equal(MAX_QUEUE_TEMPLATES, 3);
});

test("預估：FIFO 下每筆最後完成的回合數", () => {
  const m = estimateTurnsToFinish([e(1, 10, 100, 2), e(2, 20, 100, 2)], 100);
  assert.equal(m.get(1), 2); // 50/回合 → 第 2 回合
  assert.equal(m.get(2), 4); // 第 1 回合 50 給 #1、第 2 回合… 共 200 點 / 100
});

test("預估：單位 TP 大於產能也會結束（不無窮迴圈）", () => {
  const m = estimateTurnsToFinish([e(1, 10, 3, 51)], 20);
  assert.equal(m.get(1), 3);
});
