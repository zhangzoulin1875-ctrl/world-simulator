import test from "node:test";
import assert from "node:assert/strict";
import { stripJargon, looksLikeCode } from "./supportPlain";

test("截圖那種回答：檔名、資料表名、變數名、公式全部去掉，其餘中文保留", () => {
  const raw = "簡單來說，根據程式碼 `nationStats.ts` 的邏輯，遊戲中的基礎人口並非在「科學革命」時期就比較低。\n1. 當你處於科學革命時代時，系統會從 `mapRegionEraStats` 資料表中尋找紀錄，取出其 `basePopulation` （基礎人口）。\n3. 公式為 `Math.max(0, basePopulation + accruedGrowth)`。";
  const out = stripJargon(raw);
  for (const bad of ["nationStats", "mapRegionEraStats", "basePopulation", "Math.max", "accruedGrowth", ".ts", "`"]) {
    assert.ok(!out.includes(bad), `仍含 ${bad}：${out}`);
  }
  assert.ok(out.includes("科學革命"));
  assert.ok(!/[，、]\s*[。，]/.test(out) && !/^\s*\d+[.、]\s*$/m.test(out), `不留破碎標點或空編號：${out}`);
});

test("術語佔句子大半 → 整句丟掉，不留『根據，由取出，公式。』這種殘句", () => {
  const raw = "根據 `nationStats.ts`，由 `mapRegionEraStats` 取出 `basePopulation`，公式 `Math.max(0, basePopulation + accruedGrowth)`。所以不是時代決定的，而是每個地區在該時代各自有設定值。";
  const out = stripJargon(raw);
  assert.equal(out, "所以不是時代決定的，而是每個地區在該時代各自有設定值。");
});

test("只有少量術語：保留其餘完整句子並修掉空括號", () => {
  const out = stripJargon("人口超過上限時每回合會減少，最多減少 6%（詳見 `populationCapacity.ts`）。這代表要多蓋糧倉。");
  assert.ok(out.includes("人口超過上限時每回合會減少，最多減少 6%"), out);
  assert.ok(out.includes("這代表要多蓋糧倉"), out);
  assert.ok(!out.includes("populationCapacity") && !out.includes("（）"), out);
});

test("保留條列結構：整條都是術語的那條被移除，其餘條列不受影響", () => {
  const out = stripJargon("要點：\n1. 先提高糧食產量，人口才養得起來。\n2. 呼叫 `calcGrowth()` 計算 `basePopulation`。\n3. 再擴大可居住的地區。");
  assert.ok(out.includes("1. 先提高糧食產量，人口才養得起來。") && out.includes("3. 再擴大可居住的地區。"), out);
  assert.ok(!out.includes("calcGrowth") && !/^2\.\s*$/m.test(out), out);
});

test("程式碼區塊整段移除", () => {
  assert.ok(!stripJargon("先看：\n```ts\nconst a = 1;\n```\n結論是不行。").includes("const"));
  assert.match(stripJargon("先看：\n```ts\nconst a = 1;\n```\n結論是不行。"), /結論是不行/);
});

test("路徑與行號形式的檔名也去掉", () => {
  const out = stripJargon("見 artifacts/api-server/src/lib/populationCapacity.ts:51-60 說明");
  assert.ok(!out.includes("populationCapacity") && !out.includes(".ts"));
});

test("不誤傷：普通中文、遊戲專有名詞、帶反引號的中文詞只拿掉反引號", () => {
  assert.equal(stripJargon("議會滿意度低於 15% 會引發革命。"), "議會滿意度低於 15% 會引發革命。");
  assert.equal(stripJargon("請使用 `國情報告` 來提升滿意度"), "請使用 國情報告 來提升滿意度");
  assert.equal(stripJargon("Discord 和 NPC 都不是程式碼"), "Discord 和 NPC 都不是程式碼");
});

test("looksLikeCode 判斷", () => {
  for (const c of ["basePopulation", "MAX_LOSS", "foo(1, 2)", "basePopulation + accruedGrowth", "x.ts", "mapRegionEraStats", "Math.max(0, a)"]) assert.equal(looksLikeCode(c), true, c);
  for (const c of ["國情報告", "6%", "議會", "軍方滿意度", "alliance", "GDP", "NPC"]) assert.equal(looksLikeCode(c), false, c);
});

test("移除後不留下空括號與孤立標點", () => {
  const out = stripJargon("人口會增加（見 `calcGrowth()`）。");
  assert.ok(!out.includes("（）") && !out.includes("()"), out);
});
