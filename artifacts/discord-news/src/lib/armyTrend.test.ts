import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { armyTrendSummary, type ArmyTrendPoint } from "./armyTrend.ts";

/**
 * Task #400 — 守住國情面板軍力趨勢的判定語意：比較最新與最舊快照，
 * ±3% 為擴軍／縮編門檻，其餘持平；少於 2 點不顯示趨勢。
 */
const pt = (date: string, armyPopulation: number): ArmyTrendPoint => ({
  date,
  armyPopulation,
});

describe("armyTrendSummary", () => {
  it("少於 2 點回傳 null（不顯示趨勢）", () => {
    assert.equal(armyTrendSummary([]), null);
    assert.equal(armyTrendSummary([pt("2001-01-01", 500)]), null);
  });

  it("成長 ≥3% 判定為擴軍", () => {
    const s = armyTrendSummary([pt("2001-01-01", 1000), pt("2002-01-01", 1100)]);
    assert.equal(s?.kind, "up");
    assert.ok(Math.abs((s?.pct ?? 0) - 10) < 1e-9);
  });

  it("下滑 ≥3% 判定為縮編", () => {
    const s = armyTrendSummary([pt("2001-01-01", 1000), pt("2002-01-01", 900)]);
    assert.equal(s?.kind, "down");
    assert.ok(Math.abs((s?.pct ?? 0) + 10) < 1e-9);
  });

  it("±3% 以內視為持平", () => {
    assert.equal(
      armyTrendSummary([pt("2001-01-01", 1000), pt("2002-01-01", 1020)])?.kind,
      "flat",
    );
    assert.equal(
      armyTrendSummary([pt("2001-01-01", 1000), pt("2002-01-01", 985)])?.kind,
      "flat",
    );
  });

  it("從 0 長出軍隊視為擴軍 +100%；一直為 0 視為持平", () => {
    const up = armyTrendSummary([pt("2001-01-01", 0), pt("2002-01-01", 300)]);
    assert.deepEqual(up, { kind: "up", pct: 100 });
    const flat = armyTrendSummary([pt("2001-01-01", 0), pt("2002-01-01", 0)]);
    assert.deepEqual(flat, { kind: "flat", pct: 0 });
  });

  it("只看最舊與最新點（中間波動不影響）", () => {
    const s = armyTrendSummary([
      pt("2001-01-01", 1000),
      pt("2002-01-01", 5000),
      pt("2003-01-01", 1000),
    ]);
    assert.equal(s?.kind, "flat");
  });
});
