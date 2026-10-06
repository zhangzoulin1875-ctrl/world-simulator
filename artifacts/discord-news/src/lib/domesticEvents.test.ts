import test from "node:test";
import assert from "node:assert/strict";
import { shouldShowEventDialog } from "./domesticEvents";

const base = { inGame: true, tutorialActive: false, autopilotLocked: false, hasPending: true, hasResult: false };

test("正常遊戲中有待處理事件 → 顯示", () => {
  assert.equal(shouldShowEventDialog(base), true);
});
test("只有結果要看(剛處理完)→ 顯示", () => {
  assert.equal(shouldShowEventDialog({ ...base, hasPending: false, hasResult: true }), true);
});
test("AI 託管中 → 不彈(否則蓋住「解除託管」造成死結)", () => {
  assert.equal(shouldShowEventDialog({ ...base, autopilotLocked: true }), false);
  assert.equal(shouldShowEventDialog({ ...base, autopilotLocked: true, hasPending: false, hasResult: true }), false);
});
test("非遊戲頁 / 教學進行中 → 不彈", () => {
  assert.equal(shouldShowEventDialog({ ...base, inGame: false }), false);
  assert.equal(shouldShowEventDialog({ ...base, tutorialActive: true }), false);
});
test("什麼都沒有 → 不彈", () => {
  assert.equal(shouldShowEventDialog({ ...base, hasPending: false }), false);
});
