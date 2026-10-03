import { test } from "node:test";
import assert from "node:assert/strict";
import type { CabinetStyle } from "@workspace/db";
import {
  agencyBaseBoldness,
  interiorBoldness,
  isLastBuildingSlot,
  isMajorSpend,
  majorSpendThresholdPct,
  shouldAutoSubmitFiscalPolicy,
  willOverstepAuthorization,
} from "./cabinet/domains/interiorPolicy";

// Task #243 — 內政大臣代理決策純門檻函式單元測試（不觸 DB／AI）。

function style(overreach: number, timidity: number): CabinetStyle {
  return { overreach, timidity, description: "" };
}

test("agencyBaseBoldness 依代理程度給基準值", () => {
  assert.equal(agencyBaseBoldness("conservative"), 20);
  assert.equal(agencyBaseBoldness("balanced"), 50);
  assert.equal(agencyBaseBoldness("aggressive"), 80);
});

test("interiorBoldness：基準 + 越權加成 − 膽小扣減，夾在 0–100", () => {
  // 均衡、風格皆中位 → 基準 50。
  assert.equal(interiorBoldness("balanced", style(50, 50)), 50);
  // 越權 100（+15）、膽小 0（+15）→ 50 + 15 + 15 = 80。
  assert.equal(interiorBoldness("balanced", style(100, 0)), 80);
  // 保守 + 高膽小 → 夾在 0。
  assert.equal(interiorBoldness("conservative", style(0, 100)), 0);
  // 積極 + 越權高、膽小低 → 夾在 100。
  assert.equal(interiorBoldness("aggressive", style(100, 0)), 100);
});

test("majorSpendThresholdPct：積極度越高門檻越寬（0.15–0.65）", () => {
  assert.ok(Math.abs(majorSpendThresholdPct(0) - 0.15) < 1e-9);
  assert.ok(Math.abs(majorSpendThresholdPct(100) - 0.65) < 1e-9);
  assert.ok(majorSpendThresholdPct(50) > majorSpendThresholdPct(0));
});

test("isMajorSpend：花費≤0 非重大；國庫≤0 但要花錢視為重大", () => {
  assert.equal(isMajorSpend({ cost: 0, treasury: 1000, boldness: 50 }), false);
  assert.equal(isMajorSpend({ cost: 100, treasury: 0, boldness: 50 }), true);
  // boldness 0 → 門檻 0.15：cost 200 > 1000×0.15=150 → 重大。
  assert.equal(isMajorSpend({ cost: 200, treasury: 1000, boldness: 0 }), true);
  // 同樣花費，boldness 100 → 門檻 0.65：200 <= 650 → 非重大。
  assert.equal(isMajorSpend({ cost: 200, treasury: 1000, boldness: 100 }), false);
});

test("isLastBuildingSlot：剩餘槽 ≤1 視為用到最後一格", () => {
  assert.equal(isLastBuildingSlot(1), true);
  assert.equal(isLastBuildingSlot(0), true);
  assert.equal(isLastBuildingSlot(2), false);
  assert.equal(isLastBuildingSlot(Number.NaN), false);
});

test("shouldAutoSubmitFiscalPolicy：積極度 ≥60 才自行提交", () => {
  assert.equal(shouldAutoSubmitFiscalPolicy(59), false);
  assert.equal(shouldAutoSubmitFiscalPolicy(60), true);
  assert.equal(shouldAutoSubmitFiscalPolicy(100), true);
});

test("willOverstepAuthorization：越權傾向為『高』才越界", () => {
  assert.equal(willOverstepAuthorization(style(67, 0)), true);
  assert.equal(willOverstepAuthorization(style(66, 0)), false);
  assert.equal(willOverstepAuthorization(style(0, 0)), false);
});
