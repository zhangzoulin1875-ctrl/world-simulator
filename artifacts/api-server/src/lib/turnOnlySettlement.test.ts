/**
 * 回歸守衛：經濟政策（財政）、國家政策、政策想法都只在「每回合結算」時判定，
 * 不得再有獨立的現實時間（小時／分鐘）排程。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f: string) => readFileSync(new URL(f, import.meta.url), "utf-8");

test("worldScheduler：沒有任何財政／政治的現實時間迴圈", () => {
  const src = read("./worldScheduler.ts");
  assert.doesNotMatch(src, /runFinanceSettlement/, "排程器不得再呼叫財政結算");
  assert.doesNotMatch(src, /runPoliticsSettlement/, "排程器不得呼叫政治結算");
  assert.doesNotMatch(src, /finance_next_run_at/, "不得再推進財政的現實時間欄位");
  assert.doesNotMatch(src, /FINANCE_SETTLEMENT_FREQUENCY/, "不得再有財政固定頻率常數");
  assert.doesNotMatch(src, /tickFinanceSettlement/, "不得再有財政 tick");
});

test("schedulerWake：不再為財政註冊現實時間喚醒", () => {
  assert.doesNotMatch(read("./schedulerWake.ts"), /fin_next|financeSettlement/);
});

test("turnEngine：每回合都會結算財政與政治（它們現在唯一的觸發點）", () => {
  const src = read("./turnEngine.ts");
  assert.match(src, /await runFinanceSettlement\(\)/);
  assert.match(src, /await runPoliticsSettlement\(/);
});

test("AI 預產：財政與政治的鎖定窗都以『下次回合時間』為準", () => {
  const src = read("./aiPregenWorker.ts");
  assert.match(src, /const fiscalNext = nextTurnAt;/);
  assert.doesNotMatch(src, /financeNextRunAt \?\? null/);
});
