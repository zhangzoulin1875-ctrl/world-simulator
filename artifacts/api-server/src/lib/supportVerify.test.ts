import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCitations, extractNumbers, verifyAnswer, hasNumber, buildFixInstruction, sanitizeAnswer,
} from "./supportVerify";
import {
  RETIRED_MECHANICS, isLikelyRetired, retiredMentionedIn, SUPPORT_SYSTEM_PROMPT, SUPPORT_KNOWLEDGE,
} from "./supportKnowledge";

const ev = (paths: string[], corpus: string) => ({ codePaths: paths, corpus });

test("引用檢查：引用依據裡有的檔案 OK；引用不存在的檔案 → 判定編造", () => {
  const e = ev(["artifacts/api-server/src/lib/populationCapacity.ts"], "最多減少 6%");
  assert.equal(verifyAnswer("人口超過上限會減少 [populationCapacity.ts]", e).ok, true);
  assert.equal(verifyAnswer("看 [lib/populationCapacity.ts:51-60]", e).ok, true, "帶路徑與行號也算");
  const bad = verifyAnswer("依 [magicPopulation.ts] 規定", e);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.badCitations, ["magicPopulation.ts"]);
});

test("[遊戲知識] 與 [推測] 不算檔案引用", () => {
  assert.deepEqual(extractCitations("a [遊戲知識] b [推測] c [x.ts]"), ["x.ts"]);
});

test("數字檢查：依據裡有的數字 OK；憑空冒出的數字 → 疑似編造", () => {
  const e = ev(["a.ts"], "每回合最多減少 6%，建國需要 2000 金");
  assert.equal(verifyAnswer("最多減少 6% [a.ts]", e).ok, true);
  assert.equal(verifyAnswer("建國要 2,000 金 [a.ts]", e).ok, true, "千分位等價");
  const r = verifyAnswer("每回合會損失 37% 人口 [a.ts]", e);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unsupportedNumbers, ["37"]);
});

test("不誤殺：小數字、年份、0.06 對應依據裡的 6%、出處行號裡的數字", () => {
  const e = ev(["a.ts"], "上限 6%");
  assert.equal(verifyAnswer("共 3 步，約 5 回合 [a.ts]", e).ok, true, "小數字不查");
  assert.equal(verifyAnswer("在 1850 年代 [a.ts]", e).ok, true, "年份不查");
  assert.equal(verifyAnswer("係數是 0.06 [a.ts]", e).ok, true, "0.06 ↔ 6%");
  assert.equal(verifyAnswer("見 [a.ts:51-110] 說明", e).ok, true, "出處裡的行號不算數字");
});

test("extractNumbers：略過出處與小數字，抓百分比與大數", () => {
  assert.deepEqual(extractNumbers("損失 25% 與 12000 字，共 3 個 [x.ts:100-160]").sort(), ["12000", "25"]);
});

test("修正指示：列出不存在的出處與可疑數字，且要求直接輸出", () => {
  const v = verifyAnswer("依 [ghost.ts] 損失 77%", ev(["a.ts"], "x"));
  const ins = buildFixInstruction(v);
  assert.match(ins, /ghost\.ts/);
  assert.match(ins, /77/);
  assert.match(ins, /直接輸出修正後的回答/);
});

test("sanitizeAnswer：保底移除不被支持的數字與出處並加提醒", () => {
  const v = verifyAnswer("依 [ghost.ts] 會損失 77% 人口", ev(["a.ts"], "x"));
  const out = sanitizeAnswer("依 [ghost.ts] 會損失 77% 人口", v);
  assert.ok(!out.includes("ghost.ts") && !out.includes("77"));
  assert.match(out, /數值待確認/);
  assert.match(out, /管理員確認/);
});

// ── 廢除機制 ─────────────────────────────────────────────────────────────
test("廢除清單：科技樹／NPC主動提案／四階級滿意度／接受度／同盟條約 都在，且說明現況", () => {
  const names = RETIRED_MECHANICS.map((r) => r.name).join("|");
  for (const k of ["科技樹", "NPC 主動提案", "農民", "接受度", "同盟條約"]) assert.ok(names.includes(k), k);
  for (const k of ["科技樹已下線", "不會主動", "已永久移除", "轉型國策"]) assert.ok(SUPPORT_SYSTEM_PROMPT.includes(k), k);
});

test("手寫遊戲知識不再說科技樹可研發（舊版錯誤）", () => {
  assert.ok(!SUPPORT_KNOWLEDGE.includes("研發按回合投入"));
  assert.match(SUPPORT_KNOWLEDGE, /科技樹已下線/);
});

test("玩家問到已廢除機制 → 偵測到；一般問題不誤判", () => {
  assert.equal(retiredMentionedIn("怎麼研發科技樹？").length, 1);
  assert.ok(retiredMentionedIn("農民滿意度怎麼提升").some((r) => r.name.includes("農民")));
  assert.ok(retiredMentionedIn("政體接受度要累積到幾？").some((r) => r.name.includes("接受度")));
  assert.equal(retiredMentionedIn("怎麼讓人口變多").length, 0);
  assert.equal(retiredMentionedIn("議會滿意度怎麼回升").length, 0);
});

test("isLikelyRetired：npcInitiative 檔案、含『已停用』字樣的片段 → 疑似；一般現行程式 → 否", () => {
  assert.ok(isLikelyRetired("artifacts/api-server/src/lib/npcInitiative.ts", "export function x(){}"));
  assert.equal(isLikelyRetired("a.ts", "// 科技樹已下線:不再灌點"), "text");
  assert.equal(isLikelyRetired("artifacts/api-server/src/lib/populationCapacity.ts", "export const capacity = 1;"), null);
  assert.equal(isLikelyRetired("artifacts/api-server/src/lib/productionTechData.ts", "export const prod = 1;"), null, "科技資料結構仍被現行程式使用，不能整檔封鎖");
});

test("prompt 有三條新規則：廢除機制不當現行、答所問、具體內容標出處", () => {
  for (const k of ["已廢除機制", "玩家問 A 就答 A", "句尾標註出處", "標有【警告：疑似已廢除】"]) assert.ok(SUPPORT_SYSTEM_PROMPT.includes(k), k);
});

test("數字比對要整數邊界：37 不能被 373 命中（否則編造數字會漏網）", () => {
  assert.equal(hasNumber("共 373 個地區", "37"), false);
  assert.equal(hasNumber("共 373 個地區", "373"), true);
  assert.equal(hasNumber("稅率 1.5 倍", "1.5"), true);
  assert.equal(hasNumber("稅率 11.5 倍", "1.5"), false);
  assert.equal(hasNumber("增加 6%", "6"), true);
  assert.equal(hasNumber("12000 字", "2000"), false);
  const r = verifyAnswer("損失 37% 人口", { codePaths: [], corpus: "遊戲共 373 個地區" });
  assert.deepEqual(r.unsupportedNumbers, ["37"]);
});
