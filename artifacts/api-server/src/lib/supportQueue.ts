/**
 * AI 客服訊息佇列（純邏輯，與 Discord / AI 解耦以便測試）。
 *
 * 目標：頻道內每則訊息「一定會被回答」，不會因為前面還有別的 AI 任務在排隊、
 * 或某次呼叫暫時失敗而被丟掉。
 *  - 嚴格先進先出（FIFO）、單一工作者逐則處理，不會互相搶 AI 額度。
 *  - 處理失敗 → 指數退避後重試（預設最多 6 次，總等待可超過 10 分鐘），
 *    重試期間該訊息仍卡在隊首，後面的不會插隊也不會被跳過。
 *  - 全部重試用盡才放棄，並呼叫 onGiveUp 讓呼叫端給玩家一個交代（不沉默）。
 *  - 佇列有上限（防洪）：超過就拒收並回傳 false，由呼叫端明確告知「客服忙碌」。
 */
export interface SupportJob<T> {
  id: string;
  payload: T;
  enqueuedAt: number;
}

export interface SupportQueueOptions<T> {
  /** 真正處理一則訊息；丟錯代表要重試。 */
  handler: (job: SupportJob<T>, attempt: number) => Promise<void>;
  /** 重試用盡後呼叫（給玩家交代）。 */
  onGiveUp?: (job: SupportJob<T>, err: unknown) => Promise<void> | void;
  maxAttempts?: number;
  /** 第 n 次失敗後的等待毫秒（預設 2s、4s、8s… 上限 60s）。 */
  backoffMs?: (failedAttempt: number) => number;
  maxQueueLength?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const SUPPORT_MAX_ATTEMPTS = 6;
export const SUPPORT_MAX_QUEUE = 200;

export function defaultBackoffMs(failedAttempt: number): number {
  return Math.min(60_000, 2_000 * 2 ** (failedAttempt - 1));
}

export class SupportQueue<T> {
  private readonly jobs: SupportJob<T>[] = [];
  private running = false;
  private readonly opt: Required<
    Pick<SupportQueueOptions<T>, "maxAttempts" | "backoffMs" | "maxQueueLength" | "sleep" | "now">
  > & SupportQueueOptions<T>;
  /** 診斷用：累計處理成功／放棄。 */
  readonly stats = { done: 0, gaveUp: 0, retries: 0 };

  constructor(options: SupportQueueOptions<T>) {
    this.opt = {
      ...options,
      maxAttempts: options.maxAttempts ?? SUPPORT_MAX_ATTEMPTS,
      backoffMs: options.backoffMs ?? defaultBackoffMs,
      maxQueueLength: options.maxQueueLength ?? SUPPORT_MAX_QUEUE,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: options.now ?? Date.now,
    };
  }

  /** 排入佇列。回傳 position（1＝下一個就輪到）；佇列已滿回傳 null。 */
  enqueue(id: string, payload: T): { position: number } | null {
    if (this.jobs.length >= this.opt.maxQueueLength) return null;
    this.jobs.push({ id, payload, enqueuedAt: this.opt.now() });
    const position = this.jobs.length;
    void this.pump();
    return { position };
  }

  /** 目前待處理數（含正在處理的那則）。 */
  get length(): number {
    return this.jobs.length;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs[0]!;
        await this.runWithRetry(job);
        this.jobs.shift();
      }
    } finally {
      this.running = false;
    }
  }

  private async runWithRetry(job: SupportJob<T>): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.opt.maxAttempts; attempt++) {
      try {
        await this.opt.handler(job, attempt);
        this.stats.done += 1;
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < this.opt.maxAttempts) {
          this.stats.retries += 1;
          await this.opt.sleep(this.opt.backoffMs(attempt));
        }
      }
    }
    this.stats.gaveUp += 1;
    try {
      await this.opt.onGiveUp?.(job, lastErr);
    } catch {
      /* 交代失敗也不能讓佇列卡死 */
    }
  }
}
