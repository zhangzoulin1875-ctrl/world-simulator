/**
 * 通用 AI 線路池（任何 OpenAI v1 相容端點，例如公益站）。
 *
 * 目標：線路穩定性不確定時，也能讓遊戲 AI 呼叫盡量成功，且壞線路不拖累好線路。
 *  - 選線：平滑加權輪詢（nginx 同款）。同權重＝輪流；權重 2 的線路拿到兩倍流量。
 *  - 斷路器：連續失敗達門檻 → 開路，冷卻時間指數增加（30s→1m→2m…上限 10m）。
 *    冷卻結束進入半開，只放 1 個探測請求；成功才恢復，失敗則加倍冷卻。
 *  - 429 帶 retry-after／「retry in」時，以對方指示的時間為冷卻（有上限）。
 *  - 單次請求最多換 maxAttempts 條「不同」線路，全部失敗才丟錯（錯誤含各線路原因）。
 *
 * 本檔只有純邏輯（可注入時鐘與呼叫函式），不碰網路與資料庫，方便單測。
 */

export interface PoolRoute {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  qualityModel: string;
  bulkModel: string;
  /** 平滑加權輪詢的權重（>=1 的整數）。 */
  weight: number;
  enabled: boolean;
}

export interface RouteHealth {
  consecutiveFailures: number;
  /** 開路到何時（毫秒 epoch）；0＝閉路。 */
  openUntil: number;
  /** 半開探測是否已有人在跑。 */
  probing: boolean;
  successes: number;
  failures: number;
  lastError: string | null;
  lastUsedAt: number | null;
  /** 近期平均延遲（EMA，毫秒）。 */
  avgMs: number | null;
}

export const BREAKER_THRESHOLD = 3;
export const COOLDOWN_BASE_MS = 30_000;
export const COOLDOWN_MAX_MS = 10 * 60_000;
export const RETRY_AFTER_MAX_MS = 30 * 60_000;

/** 從錯誤訊息推測對方要求的等待時間（毫秒）；沒有則 null。 */
export function parseRetryAfterMs(message: string): number | null {
  const sec = /retry[- ]after\D{0,3}(\d+(?:\.\d+)?)\s*s?/i.exec(message);
  if (sec) return Math.min(Math.round(Number(sec[1]) * 1000), RETRY_AFTER_MAX_MS);
  const m = /retry in\s+(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
  if (m && (m[1] || m[2] || m[3])) {
    const ms = (Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000;
    if (ms > 0) return Math.min(ms, RETRY_AFTER_MAX_MS);
  }
  return null;
}

/** 這個錯誤是否「線路本身的問題」（該懲罰線路）；請求內容錯誤（400/422）不該怪線路。 */
export function isRouteFault(message: string): boolean {
  if (/\b(400|404|413|422)\b/.test(message) && !/\b(429|5\d\d)\b/.test(message)) {
    // 404 可能是模型不存在＝這條線路沒有該模型，同樣算線路問題
    return /\b404\b/.test(message);
  }
  return true;
}

export class RoutePool {
  private routes: PoolRoute[] = [];
  private health = new Map<string, RouteHealth>();
  /** 平滑加權輪詢的「目前權重」。 */
  private current = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /** 以新設定覆蓋線路清單；保留仍存在線路的健康狀態。 */
  setRoutes(routes: PoolRoute[]): void {
    const prev = new Map(this.routes.map((r) => [r.id, r]));
    this.routes = routes.filter((r) => r.enabled && r.baseUrl && r.apiKey);
    // 連線設定（網址／key／模型）有改＝管理員修過了：舊的失敗紀錄與斷路冷卻不再適用，
    // 立即重置，否則修好的線路還要乾等冷卻、畫面也一直顯示舊的失敗計數。
    // 只改權重／名稱／啟停不算（線路本身沒變，健康狀態照舊）。
    for (const r of this.routes) {
      const o = prev.get(r.id);
      if (o && (o.baseUrl !== r.baseUrl || o.apiKey !== r.apiKey || o.qualityModel !== r.qualityModel || o.bulkModel !== r.bulkModel)) {
        this.health.set(r.id, emptyHealth());
      }
    }
    const ids = new Set(this.routes.map((r) => r.id));
    for (const id of [...this.health.keys()]) if (!ids.has(id)) this.health.delete(id);
    for (const id of [...this.current.keys()]) if (!ids.has(id)) this.current.delete(id);
    for (const r of this.routes) {
      if (!this.health.has(r.id)) this.health.set(r.id, emptyHealth());
      if (!this.current.has(r.id)) this.current.set(r.id, 0);
    }
  }

  /** 此刻是否至少有一條可選的線路（不改變任何狀態）。 */
  hasAvailable(): boolean {
    return this.available(new Set()).length > 0;
  }

  size(): number {
    return this.routes.length;
  }

  getHealth(id: string): RouteHealth | undefined {
    const h = this.health.get(id);
    return h ? { ...h } : undefined;
  }

  /** 此刻可被選用的線路（閉路，或開路已到期且無人在探測）。 */
  private available(exclude: Set<string>): PoolRoute[] {
    const t = this.now();
    return this.routes.filter((r) => {
      if (exclude.has(r.id)) return false;
      const h = this.health.get(r.id)!;
      if (h.openUntil === 0) return true;
      return t >= h.openUntil && !h.probing;
    });
  }

  /**
   * 挑下一條線路（平滑加權輪詢）；沒有可用線路回 null。
   * 半開線路被挑中時標記 probing，避免同時湧入多個探測。
   */
  pick(exclude: Set<string> = new Set()): PoolRoute | null {
    const avail = this.available(exclude);
    if (avail.length === 0) return null;
    let total = 0;
    let best: PoolRoute | null = null;
    for (const r of avail) {
      const w = Math.max(1, Math.floor(r.weight));
      total += w;
      const cur = (this.current.get(r.id) ?? 0) + w;
      this.current.set(r.id, cur);
      if (best === null || cur > (this.current.get(best.id) ?? 0)) best = r;
    }
    this.current.set(best!.id, (this.current.get(best!.id) ?? 0) - total);
    const h = this.health.get(best!.id)!;
    if (h.openUntil !== 0) h.probing = true;
    h.lastUsedAt = this.now();
    return best;
  }

  reportSuccess(id: string, ms: number): void {
    const h = this.health.get(id);
    if (!h) return;
    h.successes += 1;
    h.consecutiveFailures = 0;
    h.openUntil = 0;
    h.probing = false;
    h.lastError = null;
    h.avgMs = h.avgMs === null ? ms : h.avgMs * 0.7 + ms * 0.3;
  }

  reportFailure(id: string, message: string): void {
    const h = this.health.get(id);
    if (!h) return;
    h.failures += 1;
    h.lastError = message.slice(0, 300);
    const wasProbing = h.probing;
    h.probing = false;
    if (!isRouteFault(message)) return; // 請求本身的錯，不懲罰線路
    h.consecutiveFailures += 1;
    const told = parseRetryAfterMs(message);
    if (told !== null) {
      h.openUntil = this.now() + told; // 對方明說要等多久，照辦
      return;
    }
    if (wasProbing || h.consecutiveFailures >= BREAKER_THRESHOLD) {
      const over = Math.max(0, h.consecutiveFailures - BREAKER_THRESHOLD);
      const cool = Math.min(COOLDOWN_BASE_MS * 2 ** over, COOLDOWN_MAX_MS);
      h.openUntil = this.now() + cool;
    }
  }

  /** 後台用快照。 */
  snapshot(): Array<{ route: PoolRoute; health: RouteHealth; state: "ok" | "open" | "half-open" }> {
    const t = this.now();
    return this.routes.map((route) => {
      const health = { ...this.health.get(route.id)! };
      const state = health.openUntil === 0 ? "ok" : t >= health.openUntil ? "half-open" : "open";
      return { route, health, state };
    });
  }
}

function emptyHealth(): RouteHealth {
  return {
    consecutiveFailures: 0, openUntil: 0, probing: false,
    successes: 0, failures: 0, lastError: null, lastUsedAt: null, avgMs: null,
  };
}

/**
 * 在池內逐線路嘗試：最多 maxAttempts 條「不同」線路。
 * call 丟錯或回傳被 isBad 判為壞內容（例如空字串）都算該線路失敗並換下一條。
 */
export async function runWithPool<T>(
  pool: RoutePool,
  maxAttempts: number,
  call: (route: PoolRoute) => Promise<T>,
  isBad: (result: T) => string | null = () => null,
  now: () => number = Date.now,
): Promise<T> {
  const tried = new Set<string>();
  const reasons: string[] = [];
  for (let i = 0; i < maxAttempts; i++) {
    const route = pool.pick(tried);
    if (route === null) break;
    tried.add(route.id);
    const t0 = now();
    try {
      const result = await call(route);
      const bad = isBad(result);
      if (bad !== null) {
        pool.reportFailure(route.id, bad);
        reasons.push(`${route.name}: ${bad}`);
        continue;
      }
      pool.reportSuccess(route.id, now() - t0);
      return result;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      pool.reportFailure(route.id, msg);
      reasons.push(`${route.name}: ${msg.slice(0, 120)}`);
    }
  }
  const why = reasons.length ? reasons.join(" ｜ ") : "沒有可用的線路（全部冷卻中或未設定）";
  throw new Error(`所有 AI 線路都失敗：${why}`);
}
