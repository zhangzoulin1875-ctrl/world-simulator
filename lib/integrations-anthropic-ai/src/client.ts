/**
 * Provider-agnostic AI client — OpenAI chat-completions wire format.
 *
 * 歷史介面 `anthropic.messages.create(params)` 保持不變（params 與回傳
 * 物件皆為 Anthropic Message 形狀），因此 gameAi.ts 與所有以覆寫
 * messages.create 為樁的測試皆不需修改。實際請求改走任何 OpenAI
 * 相容端點（NVIDIA NIM、OpenRouter、Groq、DeepSeek 等）：
 *
 *   POST {AI_INTEGRATIONS_ANTHROPIC_BASE_URL}/chat/completions
 *
 * 環境變數名稱沿用既有 key（部署腳本零改動）：
 *   AI_INTEGRATIONS_ANTHROPIC_BASE_URL — 例如 https://integrate.api.nvidia.com/v1
 *   AI_INTEGRATIONS_ANTHROPIC_API_KEY  — 例如 nvapi-...
 */

import pLimit from "p-limit";

if (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL) {
  throw new Error(
    "AI_INTEGRATIONS_ANTHROPIC_BASE_URL must be set (OpenAI-compatible base URL, e.g. https://integrate.api.nvidia.com/v1).",
  );
}

if (!process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_ANTHROPIC_API_KEY must be set (API key of the AI provider).",
  );
}

/** 請求逾時（毫秒）。NIM 長文生成偶爾偏慢，給足餘裕。 */
const REQUEST_TIMEOUT_MS = 120_000;

/**
 * NVIDIA NIM 免費版硬性限速：40 RPM、並發數 1，超過直接 429。
 * 這裡在「送出網路請求」這一層做節流（所有呼叫點，包含遊戲邏輯與
 * 後台診斷測試，都共用這個 adapter，故此處是唯一必經的收斂點）：
 *   - 併發數鎖死為 1：永遠排隊，絕不同時發出第二個請求。
 *   - 每 60 秒滑動視窗最多 35 次（40 的硬限打八折留餘量），超過時
 *     用 await 讓下一筆排隊等待，不丟棄、不報錯——呼叫端完全無感。
 */
const MAX_CONCURRENCY = 1;
const MAX_CALLS_PER_WINDOW = 35;
const RATE_WINDOW_MS = 60_000;

const requestLimit = pLimit(MAX_CONCURRENCY);
const callTimestamps: number[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 排隊等到視窗內還有名額才放行；放行的瞬間立即佔用一個名額。 */
async function waitForRateSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (callTimestamps.length > 0 && now - callTimestamps[0] >= RATE_WINDOW_MS) {
      callTimestamps.shift();
    }
    if (callTimestamps.length < MAX_CALLS_PER_WINDOW) {
      callTimestamps.push(now);
      return;
    }
    // 等到視窗內最舊的那一筆過期，多留 50ms 緩衝避免邊界誤差。
    const waitMs = RATE_WINDOW_MS - (now - callTimestamps[0]) + 50;
    await sleep(Math.max(waitMs, 50));
  }
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface AnthropicMessageParam {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string }>;
}

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessageParam[];
  temperature?: number;
}

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: TextBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

function flattenContent(content: AnthropicMessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter((s) => s.length > 0)
    .join("");
}

function toInt(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

async function createMessage(params: AnthropicCreateParams): Promise<AnthropicMessage> {
  return requestLimit(() => sendMessage(params));
}

async function sendMessage(params: AnthropicCreateParams): Promise<AnthropicMessage> {
  await waitForRateSlot();

  const baseUrl = process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL!.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  const messages: Array<{ role: string; content: string }> = [];
  if (params.system !== undefined && params.system !== "") {
    messages.push({ role: "system", content: params.system });
  }
  for (const m of params.messages) {
    messages.push({ role: m.role, content: flattenContent(m.content) });
  }

  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.max_tokens,
    messages,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY}`,
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`AI provider request failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 訊息內含 HTTP 狀態碼（如 "429"），供 isRateLimitError() 識別。
    throw new Error(`AI provider error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    id?: string;
    model?: string;
    choices?: Array<{
      message?: { content?: string | Array<{ type?: string; text?: string }> };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };

  const choice = data.choices?.[0];
  let text = "";
  if (typeof choice?.message?.content === "string") {
    text = choice.message.content;
  } else if (Array.isArray(choice?.message?.content)) {
    text = choice.message.content
      .map((b) => (b.type === "text" ? b.text ?? "" : ""))
      .join("");
  }

  return {
    id: data.id ?? `chatcmpl-${Date.now()}`,
    type: "message",
    role: "assistant",
    model: data.model ?? params.model,
    content: [{ type: "text", text }],
    stop_reason: choice?.finish_reason ?? "end_turn",
    usage: {
      input_tokens: toInt(data.usage?.prompt_tokens),
      output_tokens: toInt(data.usage?.completion_tokens),
    },
  };
}

/**
 * 共享單例。歷史名稱 `anthropic` 保留（import 路徑不變）；
 * 呼叫點一律經 `anthropic.messages.create` 動態取用（見 gameAi.ts 註記）。
 */
export const anthropic = {
  messages: {
    create: createMessage,
  },
};

export type { createMessage };
