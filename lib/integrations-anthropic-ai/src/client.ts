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
 *
 * 備援（fallback）機制：主供應商（NIM）的單次呼叫失敗時，自動改用
 * 備援供應商（例如 Gemini 的 OpenAI 相容端點）重試一次。備援的
 * baseUrl／apiKey／模型經 registerAiFallbackProvider 注入（後台可調，
 * 見 api-server lib/aiFallback.ts）；未註冊或回傳 null＝關閉備援。
 */

import { AsyncLocalStorage } from "node:async_hooks";

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
 *
 * 優先權佇列（v3）：併發 1 不變，但排隊不再單純 FIFO。數字越小越優先：
 *   0 = 預設（玩家互動、回合結算等一切既有呼叫）
 *   AI_PRIORITY_PREGEN = 背景預產（閒時預生成政策判定），永遠排在
 *   所有預設請求之後——玩家操作或結算 AI 絕不會被背景預產卡住。
 * 優先權經 AsyncLocalStorage 傳遞（runWithAiPriority）：呼叫端程式碼
 * （messages.create）介面完全不變。
 *
 * 備援呼叫也算一次網路請求，同樣佔用速率名額（保守做法：主供應商
 * 429 爆量時備援不會加倍灌爆視窗）。
 */
const MAX_CONCURRENCY = 1;
const MAX_CALLS_PER_WINDOW = 35;
const RATE_WINDOW_MS = 60_000;

/** 背景預產的優先權（最大、永遠最後）。 */
export const AI_PRIORITY_PREGEN = 10;

const priorityStorage = new AsyncLocalStorage<number>();

/** 在指定優先權下執行 fn 內的所有 AI 呼叫（數字越大越不急）。 */
export function runWithAiPriority<T>(priority: number, fn: () => Promise<T>): Promise<T> {
  return priorityStorage.run(priority, fn);
}

interface QueueEntry {
  priority: number;
  seq: number;
  run: () => Promise<void>;
}

const queue: QueueEntry[] = [];
let activeCount = 0;
let seqCounter = 0;

/** 入隊（優先權排序、同優先權 FIFO）；回傳 Promise 等到該任務完成。 */
function enqueueWithPriority<T>(
  priority: number,
  run: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queue.push({
      priority,
      seq: seqCounter++,
      run: async () => {
        try {
          resolve(await run());
        } catch (err) {
          reject(err);
        }
      },
    });
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    drainQueue();
  });
}

/** 依併發上限啟動隊首任務；完成後遞迴消化下一筆。 */
function drainQueue(): void {
  while (activeCount < MAX_CONCURRENCY && queue.length > 0) {
    const entry = queue.shift()!;
    activeCount += 1;
    void (async () => {
      // 佔用速率名額的時點 = 任務實際開始送出的瞬間（與舊行為一致）。
      await waitForRateSlot();
      try {
        await entry.run();
      } finally {
        activeCount -= 1;
        drainQueue();
      }
    })();
  }
}

const callTimestamps: number[] = [];

/** 最近一次 AI 呼叫的網路耗時（毫秒）EMA，初始保守假設 3 秒。
 *  用來估算「新進請求要等多久」：排隊人數 × 單次呼叫成本。 */
let emaCallMs = 3_000;

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

/** 呼叫層級標記：備援時用來挑對應的模型（未標記時視為品質層）。 */
export type AiModelTierLite = "quality" | "bulk";

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessageParam[];
  temperature?: number;
  /** 選填：此呼叫的層級，備援時據此挑 quality/bulk 備援模型。 */
  tier?: AiModelTierLite;
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

/**
 * 備援供應商設定（由 api-server 注入，後台可調）。
 * apiKey 為空字串/null ＝ 關閉備援。
 */
export interface AiFallbackConfig {
  baseUrl: string;
  apiKey: string;
  qualityModel: string;
  bulkModel: string;
}

type FallbackProviderFn = (tier: AiModelTierLite) => Promise<AiFallbackConfig | null>;

let fallbackProvider: FallbackProviderFn | null = null;

/** 註冊備援設定來源（遊戲後端啟動時呼叫一次；測試可不註冊）。 */
export function registerAiFallbackProvider(fn: FallbackProviderFn): void {
  fallbackProvider = fn;
}

/** 備援診斷計數（供後台顯示）。 */
export interface AiFallbackStats {
  /** 主供應商失敗後實際嘗試備援的次數。 */
  attempts: number;
  /** 備援成功的次數。 */
  successes: number;
  /** 備援也失敗的次數。 */
  failures: number;
  /** 最近一次備援成功/失敗的時間（毫秒 epoch）；null=從未。 */
  lastUsedAt: number | null;
  /** 最近一次備援失敗的錯誤訊息（截斷）；null=無。 */
  lastError: string | null;
}

const fallbackStats: AiFallbackStats = {
  attempts: 0,
  successes: 0,
  failures: 0,
  lastUsedAt: null,
  lastError: null,
};

export function getAiFallbackStats(): AiFallbackStats {
  return { ...fallbackStats };
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
  const priority = priorityStorage.getStore() ?? 0;
  return enqueueWithPriority(priority, () => sendMessage(params));
}

/**
 * 對任一 OpenAI 相容端點送出一次 chat-completions 請求並解析回應。
 * 供應商設定完全由參數決定（主路徑與備援共用；也供後台「測試備援」
 * 端點直接呼叫指定供應商，不必先讓主供應商失敗）。
 */
export async function postChatCompletion(
  url: string,
  apiKey: string,
  params: AnthropicCreateParams,
  model: string,
): Promise<AnthropicMessage> {
  const messages: Array<{ role: string; content: string }> = [];
  if (params.system !== undefined && params.system !== "") {
    messages.push({ role: "system", content: params.system });
  }
  for (const m of params.messages) {
    messages.push({ role: m.role, content: flattenContent(m.content) });
  }

  const body: Record<string, unknown> = {
    model,
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
        Authorization: `Bearer ${apiKey}`,
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
    model: data.model ?? model,
    content: [{ type: "text", text }],
    stop_reason: choice?.finish_reason ?? "end_turn",
    usage: {
      input_tokens: toInt(data.usage?.prompt_tokens),
      output_tokens: toInt(data.usage?.completion_tokens),
    },
  };
}

async function sendMessage(params: AnthropicCreateParams): Promise<AnthropicMessage> {
  const primaryUrl = `${process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL!.replace(/\/+$/, "")}/chat/completions`;
  const tier: AiModelTierLite = params.tier ?? "quality";

  const callStart = Date.now();
  let primaryError: Error;
  try {
    const message = await postChatCompletion(
      primaryUrl,
      process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY!,
      params,
      params.model,
    );
    emaCallMs = emaCallMs * 0.7 + (Date.now() - callStart) * 0.3;
    return message;
  } catch (err) {
    primaryError = err as Error;
  }

  // 主供應商失敗 → 備援（未註冊／無 key＝直接把原錯誤往上拋）。
  let config: AiFallbackConfig | null = null;
  try {
    config = fallbackProvider ? await fallbackProvider(tier) : null;
  } catch {
    config = null;
  }
  if (!config || !config.apiKey || !config.baseUrl) throw primaryError;

  fallbackStats.attempts += 1;
  fallbackStats.lastUsedAt = Date.now();
  // 備援也是一次真實網路請求：同樣排隊佔用速率名額。
  await waitForRateSlot();
  const fallbackModel = tier === "bulk" ? config.bulkModel : config.qualityModel;
  try {
    const message = await postChatCompletion(
      `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      config.apiKey,
      params,
      fallbackModel,
    );
    fallbackStats.successes += 1;
    fallbackStats.lastError = null;
    emaCallMs = emaCallMs * 0.7 + (Date.now() - callStart) * 0.3;
    return message;
  } catch (err) {
    fallbackStats.failures += 1;
    fallbackStats.lastError = String((err as Error).message).slice(0, 300);
    throw new Error(
      `primary failed: ${primaryError.message} | fallback also failed: ${fallbackStats.lastError}`,
    );
  }
}

export interface AiQueueStats {
  /** 正在執行中的請求數（0 或 1，併發鎖死為 1）。 */
  active: number;
  /** 排隊等待中的請求數。 */
  queued: number;
  /** 單次呼叫的估計成本（毫秒）＝max(實測平均耗時, 60s/35 次的限速地板)。 */
  estPerCallMs: number;
  /** 一個「現在新進來」的請求預計要等多久（毫秒）。 */
  estNewWaitMs: number;
}

/** 目前 AI 佇列狀態（供 /api/ai-queue 顯示排隊預計等待時間）。 */
export function getAiQueueStats(): AiQueueStats {
  const active = activeCount;
  const queued = queue.length;
  const perCall = Math.max(emaCallMs, RATE_WINDOW_MS / MAX_CALLS_PER_WINDOW);
  return {
    active,
    queued,
    estPerCallMs: Math.round(perCall),
    estNewWaitMs: Math.round((active + queued) * perCall),
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
