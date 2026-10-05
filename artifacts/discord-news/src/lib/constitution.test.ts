import test from "node:test";
import assert from "node:assert/strict";
import {
  seatsNeeded, tallyForDisplay, draftHint, canSubmitNow, pollIntervalFor, REVIEW_POLL_MS,
  type ConstitutionView, type PartyVote,
} from "./constitution";

const limits = { maxLen: 12000, minSubmitLen: 500 };
const view = (over: Partial<ConstitutionView> = {}): ConstitutionView => ({
  status: "draft", required: true, draftText: "", finalText: null, ratifiedAt: null, submissions: 0, lastReview: null,
  limits, submit: { cost: 1000, cooldownTicks: 4, cooldownLeft: 0 }, penalty: null, ...over,
});
const pv = (vote: PartyVote["vote"], seats: number): PartyVote => ({ partyName: "x", stanceLabel: "s", seats, vote, reason: "r" });

test("過半門檻：100 席要 51，99 席要 50，1 席要 1（與後端嚴格過半一致）", () => {
  assert.equal(seatsNeeded(100), 51);
  assert.equal(seatsNeeded(99), 50);
  assert.equal(seatsNeeded(1), 1);
  assert.equal(seatsNeeded(2), 2, "2 席議會：1 席不算過半");
});

test("投票統計：依席次加總，三種票分開", () => {
  assert.deepEqual(tallyForDisplay([pv("yes", 40), pv("no", 35), pv("abstain", 25), pv("yes", 5)]), { yes: 45, no: 35, abstain: 25 });
  assert.deepEqual(tallyForDisplay([]), { yes: 0, no: 0, abstain: 0 });
});

test("字數提示：空白/不足/足夠/超過", () => {
  assert.equal(draftHint(0, limits), "至少 500 字才能送審");
  assert.equal(draftHint(120, limits), "還差 380 字才能送審");
  assert.equal(draftHint(500, limits), "字數足夠，可以送審");
  assert.equal(draftHint(12001, limits), "超過上限 1 字");
});

test("送審按鈕：只有草稿、已儲存、不在冷卻、字數在範圍內才可按", () => {
  assert.equal(canSubmitNow(view(), 600, false), true);
  assert.equal(canSubmitNow(view(), 499, false), false, "字數不足");
  assert.equal(canSubmitNow(view(), 12001, false), false, "超過上限");
  assert.equal(canSubmitNow(view(), 600, true), false, "有未儲存修改：送審的是舊稿，必須先存檔");
  assert.equal(canSubmitNow(view({ submit: { cost: 1000, cooldownTicks: 4, cooldownLeft: 2 } }), 600, false), false, "冷卻中");
  for (const status of ["none", "reviewing", "ratified"] as const) assert.equal(canSubmitNow(view({ status }), 600, false), false, status);
});

test("輪詢：只有審議中才輪詢，其餘狀態不輪詢", () => {
  assert.equal(pollIntervalFor("reviewing"), REVIEW_POLL_MS);
  for (const s of ["none", "draft", "ratified", undefined] as const) assert.equal(pollIntervalFor(s), false, String(s));
});
