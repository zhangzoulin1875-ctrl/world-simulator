import test from "node:test";
import assert from "node:assert/strict";
import {
  RETIRED_MECHANICS, isLikelyRetired, retiredMentionedIn, SUPPORT_SYSTEM_PROMPT, SUPPORT_KNOWLEDGE,
} from "./supportKnowledge";

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

test("prompt 有規則：廢除機制不當現行、答所問", () => {
  for (const k of ["已廢除機制", "玩家問 A 就答 A", "標有【警告：疑似已廢除】"]) assert.ok(SUPPORT_SYSTEM_PROMPT.includes(k), k);
});
