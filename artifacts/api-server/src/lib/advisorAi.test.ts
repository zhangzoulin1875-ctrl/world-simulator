import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import {
  ADVISOR_STYLE_MAX,
  generateAdvisorTips,
} from "./advisorAi";

/**
 * Task #306 — lib/advisorAi.ts generateAdvisorTips 單元測試。
 *
 * 這條 bulk-AI 路徑（玩家存說話風格 → 一次產生 20–30 則風格化小tips）過去只
 * 能在 Discord 登入後手動驗證。這裡把 AI 回應以測試替身（stub）固定下來，鎖住
 * 純解析／驗證行為，不需真的呼叫模型：
 *
 *  1. 正常回應 → 去除首尾空白、去重、最多保留 30 則。
 *  2. 超過 30 則 → 截到 30 則。
 *  3. 回應被 ```json 圍欄包住 → 仍能解析。
 *  4. AI 呼叫拋錯 → 丟出 zh-TW 錯誤（呼叫端回 502 並保留舊tips）。
 *  5. 非 JSON 文字 → 丟出 zh-TW 錯誤。
 *  6. 通過陣列長度下限但去重後仍 >0 → 回傳去重後的清單。
 *  7. ADVISOR_STYLE_MAX 常數維持在 200（PATCH 說話風格上限的 SSOT）。
 *
 * 不需資料庫，可在 `test` workflow（src/lib/*.test.ts）直接執行。
 */

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

/** 讓 anthropic 回傳固定的一段文字（模擬模型輸出）。回傳還原函式。 */
function stubAiText(text: string): () => void {
  const fn = (async () => ({
    content: [{ type: "text", text }],
  })) as unknown as MessagesCreate;
  anthropic.messages.create = fn;
  return () => {
    anthropic.messages.create = realMessagesCreate;
  };
}

/** 讓 anthropic 呼叫拋錯（模擬 AI 失敗）。回傳還原函式。 */
function stubAiThrow(): () => void {
  const fn = (async () => {
    throw new Error("模擬 AI 失敗");
  }) as unknown as MessagesCreate;
  anthropic.messages.create = fn;
  return () => {
    anthropic.messages.create = realMessagesCreate;
  };
}

let restore: (() => void) | null = null;
afterEach(() => {
  if (restore) {
    restore();
    restore = null;
  }
});

const FAIL_MSG = "顧問小提示產生失敗，請稍後再試（已保留原本的提示）";

function tips(n: number, prefix = "小提示"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}第${i + 1}則`);
}

test("正常回應：去除空白、回傳全部（20 則）", async () => {
  const list = tips(20).map((t) => `  ${t}  `);
  restore = stubAiText(JSON.stringify({ tips: list }));
  const out = await generateAdvisorTips("溫柔的軍師");
  assert.equal(out.length, 20);
  assert.equal(out[0], "小提示第1則", "應去除首尾空白");
  assert.ok(
    out.every((t) => t === t.trim()),
    "每一則都應已去除空白",
  );
});

test("超過 30 則 → 截到 30 則", async () => {
  restore = stubAiText(JSON.stringify({ tips: tips(40) }));
  const out = await generateAdvisorTips("熱血教官");
  assert.equal(out.length, 30, "上限為 30 則");
});

test("去重：重複內容只保留一則", async () => {
  const list = [...tips(12), ...tips(12)]; // 24 項，但只有 12 種
  restore = stubAiText(JSON.stringify({ tips: list }));
  const out = await generateAdvisorTips("毒舌參謀");
  assert.equal(out.length, 12, "去重後應剩 12 則");
  assert.equal(new Set(out).size, out.length, "回傳內容不應有重複");
});

test("回應被 ```json 圍欄包住 → 仍能解析", async () => {
  const fenced = "```json\n" + JSON.stringify({ tips: tips(15) }) + "\n```";
  restore = stubAiText(fenced);
  const out = await generateAdvisorTips("冷靜謀士");
  assert.equal(out.length, 15);
});

test("AI 呼叫拋錯 → 丟出 zh-TW 錯誤", async () => {
  restore = stubAiThrow();
  await assert.rejects(generateAdvisorTips("任意風格"), (err: Error) => {
    assert.equal(err.message, FAIL_MSG);
    return true;
  });
});

test("非 JSON 文字 → 丟出 zh-TW 錯誤", async () => {
  restore = stubAiText("這不是 JSON，只是模型亂講話");
  await assert.rejects(generateAdvisorTips("任意風格"), (err: Error) => {
    assert.equal(err.message, FAIL_MSG);
    return true;
  });
});

test("陣列長度未達下限（<10）→ 驗證失敗丟出 zh-TW 錯誤", async () => {
  restore = stubAiText(JSON.stringify({ tips: tips(5) }));
  await assert.rejects(generateAdvisorTips("任意風格"), (err: Error) => {
    assert.equal(err.message, FAIL_MSG);
    return true;
  });
});

test("ADVISOR_STYLE_MAX 維持 200（說話風格字數上限 SSOT）", () => {
  assert.equal(ADVISOR_STYLE_MAX, 200);
});
