import { test } from "node:test";
import assert from "node:assert/strict";
import { decideNpcSuzerainConsent } from "./vassalConsent";

// ── NPC 宗主確定性判定（附庸外交受限） ──────────────────────────

test("宣戰：宗主與目標有阻擋條約 → 拒絕", () => {
  const d = decideNpcSuzerainConsent({
    actionType: "declare_war",
    suzerainVassalScore: 50,
    suzerainTargetScore: -80,
    suzerainTargetBlockingTreatyType: "nonaggression",
  });
  assert.equal(d.approved, false);
  assert.match(d.reason, /互不侵犯/);
});

test("宣戰：宗主與目標關係值 > 0 → 拒絕", () => {
  const d = decideNpcSuzerainConsent({
    actionType: "declare_war",
    suzerainVassalScore: 0,
    suzerainTargetScore: 1,
    suzerainTargetBlockingTreatyType: null,
  });
  assert.equal(d.approved, false);
  assert.match(d.reason, /關係良好/);
});

test("宣戰：無阻擋條約且宗主與目標關係值 ≤ 0 → 同意（含關係值 0 邊界）", () => {
  for (const score of [0, -1, -100]) {
    const d = decideNpcSuzerainConsent({
      actionType: "declare_war",
      suzerainVassalScore: -100, // 宗主↔附庸關係不影響宣戰判定
      suzerainTargetScore: score,
      suzerainTargetBlockingTreatyType: null,
    });
    assert.equal(d.approved, true, `score=${score} 應同意`);
  }
});

test("宣戰：未帶目標關係值（查無列）視為 0 → 同意", () => {
  const d = decideNpcSuzerainConsent({
    actionType: "declare_war",
    suzerainVassalScore: 0,
  });
  assert.equal(d.approved, true);
});

test("聯盟行動：宗主與附庸關係值 < 0 → 拒絕；≥ 0 → 同意（邊界 0）", () => {
  for (const actionType of ["alliance_create", "alliance_join"] as const) {
    assert.equal(
      decideNpcSuzerainConsent({ actionType, suzerainVassalScore: -1 })
        .approved,
      false,
      `${actionType} score=-1 應拒絕`,
    );
    assert.equal(
      decideNpcSuzerainConsent({ actionType, suzerainVassalScore: 0 })
        .approved,
      true,
      `${actionType} score=0 應同意`,
    );
    assert.equal(
      decideNpcSuzerainConsent({ actionType, suzerainVassalScore: 60 })
        .approved,
      true,
      `${actionType} score=60 應同意`,
    );
  }
});

test("聯盟行動：不受宗主↔目標欄位影響（僅看宗主↔附庸）", () => {
  const d = decideNpcSuzerainConsent({
    actionType: "alliance_join",
    suzerainVassalScore: 10,
    suzerainTargetScore: 100,
    suzerainTargetBlockingTreatyType: "nonaggression",
  });
  assert.equal(d.approved, true);
});
