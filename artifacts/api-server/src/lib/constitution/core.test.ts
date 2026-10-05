import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSTITUTION_MAX_LEN, CONSTITUTION_MIN_LEN, SUBMIT_COOLDOWN_TICKS, NO_CONSTITUTION_SAT_FLOOR,
  validateDraft, validateSubmission, canEditDraft, canSubmit, submitCooldownLeft, tallyVotes,
  noConstitutionPenalty, constitutionRequired, type PartyVote,
} from "./core";

/** 產生「字元夠多樣」的憲法樣本，避開灌水檢查。 */
function sample(len: number): string {
  const base = "第一條國家主權屬於全體人民權力來自於人民之授予議會掌握立法財政與監督之權領袖負責執行並對議會負責司法獨立不受干預軍隊效忠憲法而非個人稅賦之設立須經議會同意基本權利受到保障任何人不得任意逮捕";
  let out = "";
  while (out.length < len) out += base;
  return out.slice(0, len);
}

test("草稿：12000 字可以、12001 字被擋；換行縮排保留、只去頭尾空白", () => {
  assert.equal(validateDraft(sample(CONSTITUTION_MAX_LEN)).ok, true);
  const over = validateDraft(sample(CONSTITUTION_MAX_LEN + 1));
  assert.equal(over.ok, false);
  const v = validateDraft("  第一條\n\n  第二條  ");
  assert.ok(v.ok && v.text === "第一條\n\n  第二條");
  assert.equal(validateDraft(123).ok, false);
});

test("草稿可以很短（只是存檔），但送審有字數下限與灌水檢查", () => {
  assert.equal(validateDraft("短").ok, true);
  assert.equal(validateSubmission("短").ok, false);
  assert.equal(validateSubmission(sample(CONSTITUTION_MIN_LEN - 1)).ok, false);
  assert.equal(validateSubmission(sample(CONSTITUTION_MIN_LEN)).ok, true);
  const spam = validateSubmission("啊".repeat(2000));
  assert.equal(spam.ok, false);
});

test("通過後與審議中都不可改稿；草稿與退回後可改", () => {
  assert.equal(canEditDraft("none").ok, true);
  assert.equal(canEditDraft("draft").ok, true);
  const r = canEditDraft("ratified");
  assert.ok(!r.ok && r.error.includes("不可更改"));
  assert.equal(canEditDraft("reviewing").ok, false);
});

test("送審：沒草稿、審議中、已通過、冷卻中都擋；冷卻過了才放行", () => {
  assert.equal(canSubmit("none", 10, null).ok, false);
  assert.equal(canSubmit("reviewing", 10, null).ok, false);
  assert.equal(canSubmit("ratified", 10, null).ok, false);
  assert.equal(canSubmit("draft", 10, null).ok, true);
  assert.equal(canSubmit("draft", 10, 9).ok, false);
  assert.equal(submitCooldownLeft(10, 9), SUBMIT_COOLDOWN_TICKS - 1);
  assert.equal(canSubmit("draft", 10, 10 - SUBMIT_COOLDOWN_TICKS).ok, true);
});

const v = (seats: number, vote: PartyVote["vote"]): PartyVote =>
  ({ partyName: "x", stanceLabel: "x", seats, vote, reason: "" });

test("投票：贊成席次必須嚴格過半；剛好 50 不過；棄權不算贊成", () => {
  assert.equal(tallyVotes([v(51, "yes"), v(49, "no")], 100).passed, true);
  assert.equal(tallyVotes([v(50, "yes"), v(50, "no")], 100).passed, false);
  const t = tallyVotes([v(40, "yes"), v(35, "abstain"), v(25, "no")], 100);
  assert.deepEqual([t.yesSeats, t.abstainSeats, t.noSeats, t.passed], [40, 35, 25, false]);
});

test("無憲法懲罰：專制不罰、已通過不罰、其餘每回合 -1", () => {
  assert.equal(constitutionRequired("autocracy"), false);
  assert.deepEqual(noConstitutionPenalty("autocracy", "none", 80), { satisfaction: 80, delta: 0 });
  assert.deepEqual(noConstitutionPenalty("democracy", "ratified", 60), { satisfaction: 60, delta: 0 });
  assert.deepEqual(noConstitutionPenalty("democracy", "none", 60), { satisfaction: 59, delta: -1 });
  assert.deepEqual(noConstitutionPenalty("semi", "draft", 60), { satisfaction: 59, delta: -1 });
  assert.deepEqual(noConstitutionPenalty("semi", "reviewing", 60), { satisfaction: 59, delta: -1 });
});

test("無憲法懲罰有下限：壓到 15 為止，不會單憑它逼出革命（歸零才革命）", () => {
  let sat = 60, steps = 0;
  while (true) {
    const r = noConstitutionPenalty("democracy", "none", sat);
    if (r.delta === 0) break;
    sat = r.satisfaction; steps++;
    assert.ok(steps < 1000);
  }
  assert.equal(sat, NO_CONSTITUTION_SAT_FLOOR);
  assert.ok(sat > 0);
  // 本來就低於下限的不再扣（不把已經很慘的人再往下踩）。
  assert.deepEqual(noConstitutionPenalty("democracy", "none", 5), { satisfaction: 5, delta: 0 });
});
