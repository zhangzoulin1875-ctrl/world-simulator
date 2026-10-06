/**
 * Provider-agnostic AI client — OpenAI chat-completions wire format.
 *
 * 歷史介面 `anthropic.messages.create(params)` 保持不變（params 與回傳
 * 物件皆為 Anthropic Message 形狀），因此 gameAi.ts 與所有以覆寫
 * messages.create 為樁的測試皆不需修改。實際請求改走任何 OpenAI 相容
 * 端點（NVIDIA NIM、OpenRouter、Groq、DeepSeek 等）：
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
 *
 * 雙線道（v4，解決「單一慢請求卡死整個佇列」）：
 *   - 主線道（NIM）併發鎖死 1：佇列不再被一個卡住的請求無限阻塞。
 *   - 主線道請求「送出後 PRIMARY_STUCK_MS（預設 20 秒）仍未收到回應」
 *     即視為卡死：佇列中下一個任務改走備援線道（若備援已設定），
 *     玩家互動與結算不必等卡死的請求。備援線道併發同樣鎖死 1
 *     （Gemini 免費層也有自己的限速，保守處理）。
 *   - 主請求完全逾時（AI_REQUEST_TIMEOUT_MS，預設 120 秒）後 abort，
 *     該任務「退回交給備援」重試一次（與既有失敗→備援路徑一致）。
 *   - 兩線道各自獨立計數；速率視窗（每 60 秒最多 35 次網路請求）為
 *     兩線道共享：備援呼叫同樣佔用名額，主供應商 429 爆量時備援不會
 *     加倍灌爆視窗。
 *
 * 優先權佇列（v3）：數字越小越優先。0 = 預設（玩家互動、回合結算等
 * 一切既有呼叫）；AI_PRIORITY_PREGEN = 背景預產，永遠排在所有預設
 * 請求之後。優先權經 AsyncLocalStorage 傳遞（runWithAiPriority）。
 */

import { RoutePool, runWithPool, type PoolRoute } from "./routePool";
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

function envNum(name: string): number | null {
  const v = process.env[name];
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 請求逾時（毫秒）。NIM 長文生成偶爾偏慢，給足餘裕。 */
const REQUEST_TIMEOUT_MS = envNum("AI_REQUEST_TIMEOUT_MS") ?? 120_000;

/**
 * 主線道卡死判定（毫秒）：請求送出後超過這個時間尚未收到 HTTP 回應，
 * 就讓佇列的下一個任務改走備援線道（卡死的請求本身不中斷，仍等到
 * 完全逾時才退回備援）。
 */
const PRIMARY_STUCK_MS = envNum("AI_PRIMARY_STUCK_MS") ?? 20_000;

/**
 * NVIDIA NIM 免費版硬性限速：40 RPM、並發數 1，超過直接 429。
 * 速率視窗為兩線道共享（備援呼叫也算一次網路請求）：
 *   - 每 60 秒滑動視窗最多 35 次（40 的硬限打八折留餘量），超過時
 *     用 await 讓下一筆排隊等待，不丟棄、不報錯——呼叫端完全無感。
 */
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
  params: AnthropicCreateParams;
  resolve: (m: AnthropicMessage) => void;
  reject: (e: Error) => void;
  /** 已被線路池試過且全滅：退回佇列後不再走池，改走主線（避免無限循環）。 */
  poolTried?: boolean;
}

const queue: QueueEntry[] = [];
let seqCounter = 0;

/**
 * 單一線道號誌：併發 1，等待者依優先權排序。
 * release() 時若有等待者就直接交棒（active 維持 1），否則歸零。
 * （交棒會跳過全域佇列的優先權排序——只有「主供應商失敗後的備援重試」
 * 會成為備援線道等待者，且任務失敗當下通常正是忙時，誤差可忽略。）
 */
class Lane {
  private active = 0;
  private waiters: Array<{ priority: number; seq: number; resolve: () => void }> = [];

  busy(): boolean {
    return this.active > 0;
  }

  waiterCount(): number {
    return this.waiters.length;
  }

  tryAcquire(): boolean {
    if (this.active > 0) return false;
    this.active = 1;
    return true;
  }

  async acquire(priority: number, seq: number): Promise<void> {
    if (this.tryAcquire()) return;
    await new Promise<void>((resolve) => {
      this.waiters.push({ priority, seq, resolve });
      this.waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    });
  }

  release(): void {
    const w = this.waiters.shift();
    if (w) {
      w.resolve();
      return;
    }
    this.active = 0;
  }
}

const primaryLane = new Lane();
const fallbackLane = new Lane();

/** 主線道請求送出中的起算時刻；null = 目前沒有進行中的主線道請求。 */
let primaryInFlightSince: number | null = null;

function isPrimaryStuck(): boolean {
  return (
    primaryInFlightSince !== null &&
    Date.now() - primaryInFlightSince >= PRIMARY_STUCK_MS
  );
}

/**
 * 卡死看門狗：主線道請求送出時啟動，PRIMARY_STUCK_MS 後觸發一次
 * drainQueue() —— 此刻佇列裡的任務就能改走備援線道。收到回應
 * （或請求結束）時解除。
 */
let stuckWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearStuckWatchdog(): void {
  if (stuckWatchdog !== null) {
    clearTimeout(stuckWatchdog);
    stuckWatchdog = null;
  }
}

function armStuckWatchdog(): void {
  clearStuckWatchdog();
  stuckWatchdog = setTimeout(() => {
    stuckWatchdog = null;
    drainQueue();
  }, PRIMARY_STUCK_MS + 100);
  stuckWatchdog.unref?.();
}

/**
 * 派發佇列隊首任務（依優先權排序、同優先權 FIFO）：
 *   1. 主線道有空位 → 走主線道。
 *   2. 主線道卡死（送出超過 PRIMARY_STUCK_MS 未回應）且已註冊備援
 *      → 隊首任務改走備援線道（隊首仍是最優先者，不會讓預產插隊）。
 *   3. 都不行 → 等下一個喚醒點（任務入隊／線道釋放／卡死看門狗）。
 */
function drainQueue(): void {
  for (;;) {
    const entry = queue[0];
    if (entry === undefined) return;
    // 線路池優先接管：有健康線路、未超過池併發、此任務沒被池試過 → 走池（無全域速率限制）。
    if (!entry.poolTried && routePool.hasAvailable()) {
      if (poolActive < poolConcurrency) {
        queue.shift();
        poolActive += 1;
        void runPoolTask(entry);
        continue;
      }
      // 池健康但併發已滿：任務留在佇列等池空位，不外流到有速率限制的主線。
      return;
    }
    if (primaryLane.tryAcquire()) {
      queue.shift();
      void runTask(entry, "primary");
      continue;
    }
    if (
      isPrimaryStuck() &&
      fallbackProvider !== null &&
      !isFallbackCoolingDown() &&
      fallbackLane.tryAcquire()
    ) {
      queue.shift();
      void runTask(entry, "fallback");
      continue;
    }
    return;
  }
}

/** 入隊（優先權排序）；回傳 Promise 等到該任務完成。 */
function enqueueWithPriority<T>(
  priority: number,
  params: AnthropicCreateParams,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const seq = seqCounter++;
    queue.push({
      priority,
      seq,
      params,
      resolve: resolve as (m: AnthropicMessage) => void,
      reject,
    });
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    drainQueue();
  });
}

/**
 * 池線道：逐線路輪詢（見 routePool.ts）。成功 → 直接完成；
 * 池內所有線路都失敗 → 任務不報錯，標記 poolTried 後「退回佇列」，
 * 由主線（NIM）與其備援照原流程處理。
 */
async function runPoolTask(entry: QueueEntry): Promise<void> {
  const tier: AiModelTierLite = entry.params.tier ?? "quality";
  try {
    const message = await runWithPool<AnthropicMessage>(
      routePool,
      routePoolMaxAttempts,
      (route) =>
        postChatCompletion(
          `${route.baseUrl.replace(/\/+$/, "")}/chat/completions`,
          route.apiKey,
          entry.params,
          tier === "bulk" ? route.bulkModel : route.qualityModel,
        ),
      (m) => (m.content.map((b) => b.text).join("").trim() === "" ? "回應內容為空" : null),
    );
    poolLaneStats.handled += 1;
    poolActive -= 1;
    drainQueue();
    entry.resolve(message);
  } catch {
    // 通用 API 掛了：退回佇列隊首（保持原優先權與序號），改走主線。
    poolLaneStats.requeued += 1;
    poolActive -= 1;
    entry.poolTried = true;
    queue.push(entry);
    queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    drainQueue();
  }
}

async function runTask(entry: QueueEntry, lane: "primary" | "fallback"): Promise<void> {
  if (lane === "fallback") {
    // 派發時已註冊備援；執行時載入設定（絕不丟出）。
    const config = await loadFallbackConfig(entry.params.tier ?? "quality");
    if (config === null) {
      // 罕見：派發時有備援、執行時已停用（管理員剛改設定）。退回
      // 主線道排隊，任務不因快取失準而丟失；主線道恢復後照常處理。
      fallbackLane.release();
      drainQueue();
      await primaryLane.acquire(entry.priority, entry.seq);
      try {
        const msg = await sendPrimary(entry.params);
        primaryLane.release();
        drainQueue();
        entry.resolve(msg);
      } catch (err) {
        primaryLane.release();
        drainQueue();
        entry.reject(err as Error);
      }
      return;
    }
    try {
      const msg = await sendFallbackCall(entry.params, config);
      fallbackLane.release();
      drainQueue();
      entry.resolve(msg);
    } catch (err) {
      fallbackLane.release();
      drainQueue();
      entry.reject(err as Error);
    }
    return;
  }

  // lane === "primary"
  try {
    const msg = await sendPrimary(entry.params);
    primaryLane.release();
    drainQueue();
    entry.resolve(msg);
    return;
  } catch (primaryError) {
    // 主供應商失敗（含完全逾時 abort）→「退回交給備援」。先釋放主線道
    // 讓下一個任務立刻上場，再等備援線道空位（不佔住主線道）。
    primaryLane.release();
    drainQueue();
    await fallbackLane.acquire(entry.priority, entry.seq);
    try {
      const msg = await sendFallbackRetry(entry.params, primaryError as Error);
      fallbackLane.release();
      drainQueue();
      entry.resolve(msg);
    } catch (err) {
      fallbackLane.release();
      drainQueue();
      entry.reject(err as Error);
    }
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

/** 通用線路池（任意 OpenAI v1 相容端點）。有線路時，備援槽改走池，否則沿用單一備援。 */
const routePool = new RoutePool();
let routePoolMaxAttempts = 3;
export function getRoutePool(): RoutePool { return routePool; }

/** 池線道：可多條併發、不吃全域速率名額。 */
let poolConcurrency = 4;
let poolActive = 0;
export interface RoutePoolLaneStats { active: number; concurrency: number; handled: number; requeued: number; }
const poolLaneStats = { handled: 0, requeued: 0 };
export function getRoutePoolLaneStats(): RoutePoolLaneStats {
  return { active: poolActive, concurrency: poolConcurrency, ...poolLaneStats };
}
export function setRoutePoolConcurrency(n: number): void {
  poolConcurrency = Math.min(16, Math.max(1, Math.floor(n)));
  drainQueue();
}
export function configureRoutePool(routes: PoolRoute[], maxAttempts = 3): void {
  routePool.setRoutes(routes);
  routePoolMaxAttempts = Math.min(6, Math.max(1, Math.floor(maxAttempts)));
}

/** 註冊備援設定來源（遊戲後端啟動時呼叫一次；測試可不註冊）。 */
export function registerAiFallbackProvider(fn: FallbackProviderFn): void {
  fallbackProvider = fn;
}

/** 備援診斷計數（供後台顯示）。 */
export interface AiFallbackStats {
  /** 實際嘗試備援的次數（含卡死 bypass 直接走備援與失敗重試）。 */
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
  return enqueueWithPriority<AnthropicMessage>(priority, params);
}

/**
 * 對任一 OpenAI 相容端點送出一次 chat-completions 請求並解析回應。
 * 供應商設定完全由參數決定（主路徑與備援共用；也供後台「測試備援」
 * 端點直接呼叫指定供應商，不必先讓主供應商失敗）。
 * onResponse：收到 HTTP 回應（headers）的瞬間回呼一次——主線道用來
 * 解除「卡死看門狗」。
 */
/**
 * 是否對該模型關閉推理（thinking）。預設只對 nemotron 系列關；環境變數
 * AI_DISABLE_THINKING = "0"/"false" 可整個停用、"1"/"true" 對所有模型啟用。
 */
export function shouldDisableThinking(model: string): boolean {
  const env = (process.env.AI_DISABLE_THINKING ?? "").trim().toLowerCase();
  if (env === "0" || env === "false") return false;
  if (env === "1" || env === "true") return true;
  return /nemotron/i.test(model);
}

/** 供應商明確拒絕 chat_template_kwargs 後，本程序內不再附帶。 */
let thinkingFlagRejected = false;
export function __resetThinkingFlagForTest(): void {
  thinkingFlagRejected = false;
}

export async function postChatCompletion(
  url: string,
  apiKey: string,
  params: AnthropicCreateParams,
  model: string,
  onResponse?: () => void,
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
  // Nemotron 3 系列是推理模型：預設先輸出一長串推理再給答案，平均一次 30+ 秒，
  // 且推理會吃掉 max_tokens 預算（答案被截斷或逾時）。遊戲的 AI 呼叫都是結構化
  // JSON／短敘事，不需要推理，關掉可大幅降低延遲與逾時。
  // 旗標見模型卡（enable_thinking 可經 chat template 開關）。
  if (shouldDisableThinking(model) && !thinkingFlagRejected) {
    body.chat_template_kwargs = { enable_thinking: false };
  }

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

  // 收到回應＝沒有卡死：先解除看門狗再解析 body。
  onResponse?.();

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 供應商不認得 chat_template_kwargs（400/422 且訊息點名該欄位）→ 記住並不帶旗標
    // 重打一次，避免我們對參數格式的假設讓整個 AI 功能掛掉。
    if (
      (res.status === 400 || res.status === 422) &&
      body.chat_template_kwargs !== undefined &&
      /chat_template_kwargs|enable_thinking|extra.*(forbidden|not permitted)|unknown.*(field|param)/i.test(text)
    ) {
      thinkingFlagRejected = true;
      return postChatCompletion(url, apiKey, params, model, onResponse);
    }
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

const PRIMARY_URL = `${process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL!.replace(/\/+$/, "")}/chat/completions`;
const PRIMARY_API_KEY = process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY!;

/** 主供應商一次呼叫（含速率名額佔用與卡死看門狗）。 */
async function sendPrimary(params: AnthropicCreateParams): Promise<AnthropicMessage> {
  const callStart = Date.now();
  await waitForRateSlot();
  primaryInFlightSince = Date.now();
  armStuckWatchdog();
  try {
    const message = await postChatCompletion(
      PRIMARY_URL,
      PRIMARY_API_KEY,
      params,
      params.model,
      () => {
        // 收到回應：主線道不再卡死。
        primaryInFlightSince = null;
        clearStuckWatchdog();
      },
    );
    emaCallMs = emaCallMs * 0.7 + (Date.now() - callStart) * 0.3;
    return message;
  } finally {
    primaryInFlightSince = null;
    clearStuckWatchdog();
  }
}

/** 載入備援設定；未註冊／無 key ＝ null（備援關閉）。內部絕不丟出。 */
async function loadFallbackConfig(tier: AiModelTierLite): Promise<AiFallbackConfig | null> {
  try {
    const c = fallbackProvider ? await fallbackProvider(tier) : null;
    if (c === null || c.apiKey === "" || c.baseUrl === "") return null;
    return c;
  } catch {
    return null;
  }
}

/** 備援一次呼叫（含速率名額佔用與統計）。 */
/**
 * 備援每日配額用盡的冷卻：Gemini 免費版每日請求數很低（例如 20 次），用完後
 * 回 429 並附「retry in 18h41m」。此時再打只是白白浪費一次呼叫並把主因蓋住，
 * 所以記下冷卻到期時間，期間直接略過備援、如實回報主供應商的錯誤。
 */
let fallbackCooldownUntil = 0;
const FALLBACK_QUOTA_COOLDOWN_MAX_MS = 6 * 60 * 60 * 1000;

/** 從 429 訊息判斷是否為「每日配額用盡」，回傳建議冷卻毫秒數；否則 null。 */
export function parseDailyQuotaCooldownMs(message: string): number | null {
  if (!/\b429\b/.test(message)) return null;
  const daily =
    /PerDay|per\s*day|RESOURCE_EXHAUSTED|exceeded your current quota/i.test(message);
  if (!daily) return null;
  const m = /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
  let ms = 0;
  if (m) {
    ms =
      (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) *
      1000;
  }
  if (!Number.isFinite(ms) || ms <= 0) ms = 30 * 60 * 1000;
  return Math.min(ms, FALLBACK_QUOTA_COOLDOWN_MAX_MS);
}

/** 測試用：目前備援是否在配額冷卻中。 */
export function isFallbackCoolingDown(now = Date.now()): boolean {
  return now < fallbackCooldownUntil;
}

export function __resetFallbackCooldownForTest(): void {
  fallbackCooldownUntil = 0;
}

async function sendFallbackCall(
  params: AnthropicCreateParams,
  config: AiFallbackConfig,
): Promise<AnthropicMessage> {
  const tier: AiModelTierLite = params.tier ?? "quality";
  const model = tier === "bulk" ? config.bulkModel : config.qualityModel;
  fallbackStats.attempts += 1;
  fallbackStats.lastUsedAt = Date.now();
  await waitForRateSlot();
  try {
    const message = await postChatCompletion(
      `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`,
      config.apiKey,
      params,
      model,
    );
    fallbackStats.successes += 1;
    fallbackStats.lastError = null;
    return message;
  } catch (err) {
    fallbackStats.failures += 1;
    fallbackStats.lastError = String((err as Error).message).slice(0, 300);
    const cool = parseDailyQuotaCooldownMs(String((err as Error).message));
    if (cool !== null) fallbackCooldownUntil = Date.now() + cool;
    throw err;
  }
}

/** 主供應商失敗後的備援重試；備援也失敗時錯誤同時含主因與備援因。 */
async function sendFallbackRetry(
  params: AnthropicCreateParams,
  primaryError: Error,
): Promise<AnthropicMessage> {
  const tier: AiModelTierLite = params.tier ?? "quality";

  const config = await loadFallbackConfig(tier);
  if (config === null) throw primaryError;
  // 備援今日配額已用盡 → 不再浪費呼叫，直接如實回報主供應商的錯誤。
  if (isFallbackCoolingDown()) throw primaryError;
  try {
    return await sendFallbackCall(params, config);
  } catch (err) {
    // 主因放最前面且先截短，避免 UI 只截到備援那段而看不到真正原因。
    const primaryShort = primaryError.message.slice(0, 160);
    const fallbackShort = (err as Error).message.slice(0, 160);
    throw new Error(
      `AI 服務暫時無法使用。主供應商失敗：${primaryShort} ｜ 備援也失敗：${fallbackShort}`,
    );
  }
}

export interface AiQueueStats {
  /** 正在執行中的網路請求數（主線道＋備援線道，各併發 1）。 */
  active: number;
  /** 排隊等待中的請求數（全域佇列＋線道等待者）。 */
  queued: number;
  /** 單次呼叫的估計成本（毫秒）＝max(實測平均耗時, 60s/35 次的限速地板)。 */
  estPerCallMs: number;
  /** 一個「現在新進來」的請求預計要等多久（毫秒）。 */
  estNewWaitMs: number;
  /** 主線道卡死持續時間（毫秒）；null = 主線道沒有卡死的請求。 */
  primaryStuckMs: number | null;
}

/** 目前 AI 佇列狀態（供 /api/ai-queue 顯示排隊預計等待時間）。 */
export function getAiQueueStats(): AiQueueStats {
  const active =
    (primaryLane.busy() ? 1 : 0) + (fallbackLane.busy() ? 1 : 0);
  const queued =
    queue.length + primaryLane.waiterCount() + fallbackLane.waiterCount();
  const perCall = Math.max(emaCallMs, RATE_WINDOW_MS / MAX_CALLS_PER_WINDOW);
  return {
    active,
    queued,
    estPerCallMs: Math.round(perCall),
    estNewWaitMs: Math.round((active + queued) * perCall),
    primaryStuckMs: isPrimaryStuck()
      ? Math.round(Date.now() - (primaryInFlightSince ?? Date.now()))
      : null,
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
