/**
 * 國際組織 AI 決策執行層:呼叫 AI → 解析 → 護欄驗證;任何失敗都退回規則版,絕不阻塞回合結算。
 *
 *  - 走 AI_PRIORITY_PREGEN(最低優先權),玩家互動與結算 AI 一律插隊在前。
 *  - 硬逾時 AI_DECISION_TIMEOUT_MS:結算內等不到就用規則版(AI 慢不能拖住回合)。
 *  - 每 DECISION_EVERY_TURNS 個 tick 才一次,一次一個請求,負載極小。
 *  - AI 合法輸出為空陣列 = 「刻意按兵不動」,尊重它;只有「呼叫失敗/逾時/格式壞掉/額度滿」才退回規則版。
 */
import { runWithAiPriority, AI_PRIORITY_PREGEN } from "@workspace/integrations-anthropic-ai";
import { AiQuotaExceededError, callGameAi, firstText } from "../gameAi";
import { logger } from "../logger";
import { getCurrentEraSlug } from "../nationStats";
import { buildDecisionPrompt, resolveAiDecisions } from "./aiDecision";
import { ruleBasedDecision, type Decision, type DecisionContext } from "./core";

export const AI_DECISION_TIMEOUT_MS = 8_000;

export type DecideResult = { decisions: Decision[]; source: "rule" | "ai" };
type AiCaller = (prompt: string) => Promise<string>;

const defaultCaller: AiCaller = async (prompt) => {
  const message = await runWithAiPriority(AI_PRIORITY_PREGEN, () =>
    callGameAi("intl_org.decision", "bulk", { messages: [{ role: "user", content: prompt }] }),
  );
  return firstText(message as { content: Array<{ type: string; text?: string }> });
};
let caller: AiCaller = defaultCaller;
/** 測試用:換掉 AI 呼叫。傳 null 還原。 */
export function setAiCallerForTest(fn: AiCaller | null): void { caller = fn ?? defaultCaller; }

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`AI timeout ${ms}ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** 供 runIntlOrgSettlement({ decide }) 使用。 */
export async function decideWithAi(
  org: { ideology: string },
  ctx: DecisionContext,
  timeoutMs: number = AI_DECISION_TIMEOUT_MS,
): Promise<DecideResult> {
  const fallback = (): DecideResult => ({ decisions: ruleBasedDecision(ctx), source: "rule" });
  // 沒有任何國家可選(全是內戰或同路人)就不必花 AI
  if (ctx.nations.every((n) => n.inCivilWar || n.aligned)) return { decisions: [], source: "rule" };
  try {
    const eraSlug = await getCurrentEraSlug();
    const { prompt, anon } = buildDecisionPrompt(ctx, { ideology: org.ideology, eraSlug });
    const raw = await withTimeout(caller(prompt), timeoutMs);
    return { decisions: resolveAiDecisions(raw, anon, ctx), source: "ai" };
  } catch (err) {
    if (!(err instanceof AiQuotaExceededError)) logger.warn({ err }, "intl org AI decision failed; using rule-based fallback");
    return fallback();
  }
}
