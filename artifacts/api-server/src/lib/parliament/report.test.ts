import test from "node:test";
import assert from "node:assert/strict";
import { validateReportText, reportCooldownLeft, parseReportJson, fallbackReport, REPORT_COOLDOWN_TICKS } from "./reportCore";
import { reportBonus } from "./core";

test("文字驗證:非字串/過短/過長/正常", () => {
  assert.equal(validateReportText(undefined).ok, false);
  assert.equal(validateReportText("太短").ok, false);
  assert.equal(validateReportText("字".repeat(601)).ok, false);
  const ok = validateReportText("  " + "我".repeat(30) + "  ");
  assert.equal(ok.ok, true); if (ok.ok) assert.equal(ok.text.length, 30);
});

test("冷卻:從未提交=0;期內回剩餘;期滿=0", () => {
  assert.equal(reportCooldownLeft(5, null), 0);
  assert.equal(reportCooldownLeft(5, 5), REPORT_COOLDOWN_TICKS);
  assert.equal(reportCooldownLeft(9, 5), REPORT_COOLDOWN_TICKS - 4);
  assert.equal(reportCooldownLeft(5 + REPORT_COOLDOWN_TICKS, 5), 0);
});

test("解析 AI 輸出:正常/code fence/字串分數/越界夾限", () => {
  assert.deepEqual(parseReportJson('{"score":70,"feedback":"不錯"}'), { score: 70, feedback: "不錯" });
  assert.equal(parseReportJson('```json\n{"score":55,"feedback":"x"}\n```')!.score, 55);
  assert.equal(parseReportJson('{"score":"80"}')!.score, 80);
  assert.equal(parseReportJson('{"score":999}')!.score, 100);
  assert.equal(parseReportJson('{"score":-50}')!.score, 0);
});

test("解析 AI 輸出:垃圾一律回 null(走備援)", () => {
  for (const bad of ["", "not json", "null", "[]", '{"score":"abc"}', '{"feedback":"x"}', '{"score":NaN}']) {
    assert.equal(parseReportJson(bad), null, bad);
  }
});

test("備援分數中性偏低,換算後不會大幅加分(防刷)", () => {
  const f = fallbackReport("字".repeat(300));
  assert.ok(f.score < 50 && f.source === "fallback");
  assert.ok(reportBonus(f.score, 50) <= 1);
});

test("AI 給 0 分的操縱型報告 → 扣分;給高分 → 加分;上下限夾住", () => {
  assert.ok(reportBonus(0, 50) < 0 && reportBonus(0, 50) >= -5);
  assert.ok(reportBonus(100, 50) <= 10);
  assert.ok(reportBonus(100, 5) <= 20);
});
