import { strict as assert } from "node:assert";
import test, { afterEach } from "node:test";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { judgeFiscalPolicyIdea, type FiscalPolicyJudgement } from "./financeAi";

/**
 * Task #564 — 財政政策完全不再變動國庫金錢：judgeFiscalPolicyIdea 單元測試。
 *
 * 以測試替身（stub）固定 AI 回應，鎖住純解析／驗證行為：
 *
 *  1. 正常回應（無 moneyDelta）→ 解析成功，判定結果不含任何金錢欄位。
 *  2. AI 多回傳舊格式的 moneyDelta 欄位 → 寬容忽略、不導致 parse 失敗，
 *     且結果物件中沒有 moneyDelta key。
 *  3. system prompt 不再要求或提及 moneyDelta，且包含「不能直接增減國庫
 *     金錢」的規則（避免 AI 把金錢效果塞進敘事誤導玩家）。
 *  4. 非 JSON 回應 → 丟出 zh-TW 錯誤（呼叫端保留想法下回合重試）。
 *
 * 不需資料庫，可在 `test` workflow（src/lib/*.test.ts）直接執行。
 */

type MessagesCreate = typeof anthropic.messages.create;
const realMessagesCreate: MessagesCreate = anthropic.messages.create.bind(
  anthropic.messages,
);

let capturedSystem: string | null = null;

/** 讓 anthropic 回傳固定文字並側錄 system prompt。回傳還原函式。 */
function stubAiText(text: string): () => void {
  const fn = (async (params: { system?: string }) => {
    capturedSystem = typeof params.system === "string" ? params.system : null;
    return { content: [{ type: "text", text }] };
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
  capturedSystem = null;
});

const baseParams = {
  government: "君主制",
  eraSlug: "classical",
  currentTaxRatePct: 10,
  taxEfficiencyPct: 50,
  idea: "變賣國產、吸引外資，充實國庫",
};

const goodJudgement = {
  title: "稅制改革",
  description: "政策順利推行，稅基擴大。",
  isGood: true,
  newRatePct: 12,
  satisfactionDelta: -2,
  stabilityDelta: 1,
  abuseReason: null,
};

test("正常回應：解析成功且結果不含金錢欄位", async () => {
  restore = stubAiText(JSON.stringify(goodJudgement));
  const out = await judgeFiscalPolicyIdea(baseParams);
  assert.equal(out.title, "稅制改革");
  assert.equal(out.newRatePct, 12);
  assert.equal(out.satisfactionDelta, -2);
  assert.equal(out.stabilityDelta, 1);
  assert.ok(
    !("moneyDelta" in out),
    "判定結果不得含 moneyDelta（財政政策不動國庫）",
  );
});

test("AI 多回傳舊格式 moneyDelta → 寬容忽略、不導致 parse 失敗", async () => {
  restore = stubAiText(
    JSON.stringify({ ...goodJudgement, moneyDelta: 5_000_000 }),
  );
  const out = await judgeFiscalPolicyIdea(baseParams);
  assert.equal(out.isGood, true);
  assert.ok(
    !("moneyDelta" in out),
    "多餘的 moneyDelta 欄位必須被剝除，不得出現在結果中",
  );
  assert.equal(
    (out as FiscalPolicyJudgement & { moneyDelta?: number }).moneyDelta,
    undefined,
  );
});

test("system prompt 不提 moneyDelta、明確禁止直接增減國庫金錢", async () => {
  restore = stubAiText(JSON.stringify(goodJudgement));
  await judgeFiscalPolicyIdea(baseParams);
  assert.ok(capturedSystem, "應側錄到 system prompt");
  assert.ok(
    !capturedSystem!.includes("moneyDelta"),
    "prompt 不得再要求或提及 moneyDelta",
  );
  assert.ok(
    capturedSystem!.includes("不能」直接增減國庫金錢"),
    "prompt 必須明確告知財政政策不能直接增減國庫金錢",
  );
});

test("非 JSON 回應 → 丟出 zh-TW 錯誤", async () => {
  restore = stubAiText("這不是 JSON");
  await assert.rejects(
    () => judgeFiscalPolicyIdea(baseParams),
    /AI 財政政策判定結果格式不正確/,
  );
});
