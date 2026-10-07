import test from "node:test";
import assert from "node:assert/strict";
import type { SeatedParty } from "./core";
import {
  partyAttitude, tallyVote, normalizeTags, needsParliamentVote,
  overridePenalty, satisfactionAfterOverride, summarizeVote, MAX_POLICY_TAGS,
  OVERRIDE_PENALTY_MIN, OVERRIDE_PENALTY_MAX, type PolicyTag,
} from "./vote";

const P = (id: string, stance: SeatedParty["stance"], seats: number): SeatedParty =>
  ({ id, name: id, stance, weight: seats, seats });
const tag = (stance: PolicyTag["stance"], direction: 1 | -1 = 1): PolicyTag => ({ stance, direction });

test("忠誠黨一律贊成，不管標籤是什麼", () => {
  assert.equal(partyAttitude("loyalist", []), 1);
  assert.equal(partyAttitude("loyalist", [tag("pacifist"), tag("welfare", -1)]), 1);
});

test("同向 +1、反向 -1、無關 0", () => {
  assert.equal(partyAttitude("militarist", [tag("militarist")]), 1);
  assert.equal(partyAttitude("militarist", [tag("militarist", -1)]), -1);
  assert.equal(partyAttitude("militarist", [tag("welfare")]), 0);
});

test("對立立場：推進和平 = 擴軍派反對；削減和平 = 擴軍派贊成", () => {
  assert.equal(partyAttitude("militarist", [tag("pacifist")]), -1);
  assert.equal(partyAttitude("militarist", [tag("pacifist", -1)]), 1);
  assert.equal(partyAttitude("secular", [tag("religious")]), -1);
  assert.equal(partyAttitude("welfare", [tag("fiscal_hawk")]), -1);
  assert.equal(partyAttitude("fiscal_hawk", [tag("welfare")]), -1);
});

test("商貿派沒有對立面，只看自己的標籤", () => {
  assert.equal(partyAttitude("mercantile", [tag("mercantile")]), 1);
  assert.equal(partyAttitude("mercantile", [tag("militarist")]), 0);
});

test("多標籤加總：增稅福利（fiscal_hawk -1 + welfare +1）福利派 +2、節流派 -2", () => {
  const tags = [tag("fiscal_hawk", -1), tag("welfare")];
  assert.equal(partyAttitude("welfare", tags), 2);
  assert.equal(partyAttitude("fiscal_hawk", tags), -2);
});

test("表決：贊成席 > 反對席 才通過，棄權不計", () => {
  const parties = [P("a", "welfare", 40), P("b", "fiscal_hawk", 35), P("c", "religious", 25)];
  const r = tallyVote(parties, [tag("welfare")]);
  assert.equal(r.seatsFor, 40);
  assert.equal(r.seatsAgainst, 35);
  assert.equal(r.seatsAbstain, 25);
  assert.equal(r.passed, true);
  assert.ok(Math.abs(r.againstRatio - 35 / 75) < 1e-9);
});

test("平手視為否決", () => {
  const r = tallyVote([P("a", "welfare", 50), P("b", "fiscal_hawk", 50)], [tag("welfare")]);
  assert.equal(r.seatsFor, 50);
  assert.equal(r.seatsAgainst, 50);
  assert.equal(r.passed, false);
});

test("全員棄權（無標籤）視為通過，不卡玩家", () => {
  const r = tallyVote([P("a", "welfare", 60), P("b", "militarist", 40)], []);
  assert.equal(r.seatsAbstain, 100);
  assert.equal(r.passed, true);
  assert.equal(r.againstRatio, 0);
});

test("無黨（空議會）視為通過", () => {
  assert.equal(tallyVote([], [tag("welfare")]).passed, true);
});

test("執政忠誠黨過半 → 任何政策都過（橡皮圖章式）", () => {
  const parties = [P("rule", "loyalist", 60), P("opp", "pacifist", 40)];
  assert.equal(tallyVote(parties, [tag("pacifist", -1)]).passed, true);
});

test("標籤清洗：丟掉無效立場/方向、去重、截斷上限", () => {
  const dirty = [
    tag("welfare"), tag("welfare", -1),
    { stance: "loyalist", direction: 1 } as unknown as PolicyTag,
    { stance: "welfare", direction: 0 } as unknown as PolicyTag,
    tag("militarist"), tag("religious"), tag("secular"), tag("mercantile"),
  ];
  const out = normalizeTags(dirty);
  assert.equal(out.length, MAX_POLICY_TAGS);
  assert.deepEqual(out.map((t) => t.stance), ["welfare", "militarist", "religious"]);
  assert.deepEqual(normalizeTags(null), []);
  assert.deepEqual(normalizeTags(undefined), []);
});

test("哪些政策要表決：民主全部、半專制只有 tradition/reform、專制都不用", () => {
  for (const t of ["policy", "tradition", "reform"] as const) {
    assert.equal(needsParliamentVote("democracy", t), true);
    assert.equal(needsParliamentVote("autocracy", t), false);
  }
  assert.equal(needsParliamentVote("semi", "policy"), false);
  assert.equal(needsParliamentVote("semi", "tradition"), true);
  assert.equal(needsParliamentVote("semi", "reform"), true);
});

test("強行通過扣分：下限 6、上限 20，隨反對比例單調上升，且夾在 0–100", () => {
  assert.equal(overridePenalty(0), OVERRIDE_PENALTY_MIN);
  assert.equal(overridePenalty(1), OVERRIDE_PENALTY_MAX);
  assert.equal(overridePenalty(-5), OVERRIDE_PENALTY_MIN);
  assert.equal(overridePenalty(9), OVERRIDE_PENALTY_MAX);
  let prev = 0;
  for (let r = 0; r <= 1; r += 0.1) { const v = overridePenalty(r); assert.ok(v >= prev); prev = v; }
  assert.equal(satisfactionAfterOverride(60, 1), 40);
  assert.equal(satisfactionAfterOverride(10, 1), 0);
});

test("摘要文字", () => {
  const r = tallyVote([P("a", "welfare", 58), P("b", "fiscal_hawk", 31), P("c", "religious", 11)], [tag("welfare")]);
  assert.equal(summarizeVote(r), "贊成 58 席 · 反對 31 席 · 棄權 11 席，通過");
});
