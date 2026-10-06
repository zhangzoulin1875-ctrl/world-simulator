import { eq } from "drizzle-orm";
import { db, botSettingsTable } from "@workspace/db";
import { configureRoutePool, getRoutePool, type PoolRoute } from "@workspace/integrations-anthropic-ai";
import { logger } from "./logger";

/**
 * 通用 AI 線路池設定（任何 OpenAI v1 相容端點，如公益站）。
 * 存在 bot_settings.ai_route_pool（JSON 文字）；也可用環境變數 AI_ROUTE_POOL（同格式）。
 * 後台改設定後立即套用，不需重啟。API key 只進不出：GET 一律遮罩。
 */

export const MAX_ROUTES = 12;

export interface StoredRoute {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  qualityModel: string;
  bulkModel: string;
  weight: number;
  enabled: boolean;
}

export function maskKey(k: string): string {
  if (!k) return "";
  return k.length <= 8 ? "****" : `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** 正規化網址：去尾斜線；使用者常貼到 /chat/completions 或沒有 /v1，這裡盡量寬容。 */
export function normalizeBaseUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, "");
  u = u.replace(/\/chat\/completions$/i, "").replace(/\/+$/, "");
  return u;
}

/** 驗證並整理使用者輸入；不合法的線路丟 Error（訊息給管理員看）。 */
export function sanitizeRoutes(input: unknown, existing: StoredRoute[] = []): StoredRoute[] {
  if (!Array.isArray(input)) throw new Error("routes 必須是陣列");
  if (input.length > MAX_ROUTES) throw new Error(`最多 ${MAX_ROUTES} 條線路`);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const name = str(r.name) || `線路${i + 1}`;
    const id = str(r.id) || `r${Date.now().toString(36)}${i}`;
    if (seen.has(id)) throw new Error(`線路 id 重複：${id}`);
    seen.add(id);
    const baseUrl = normalizeBaseUrl(str(r.baseUrl));
    if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw new Error(`「${name}」的網址不合法（需 http(s)://…）`);
    // 空字串或遮罩值＝沿用舊 key（後台只改其他欄位時不必重貼 key）
    const incoming = str(r.apiKey);
    const old = byId.get(id);
    const apiKey = incoming === "" || incoming.includes("…") || incoming === "****" ? old?.apiKey ?? "" : incoming;
    if (!apiKey) throw new Error(`「${name}」缺少 API key`);
    const qualityModel = str(r.qualityModel);
    const bulkModel = str(r.bulkModel) || qualityModel;
    if (!qualityModel) throw new Error(`「${name}」缺少模型名稱`);
    const w = Math.floor(Number(r.weight));
    return {
      id, name: name.slice(0, 40), baseUrl, apiKey, qualityModel: qualityModel.slice(0, 120),
      bulkModel: bulkModel.slice(0, 120),
      weight: Number.isFinite(w) ? Math.min(20, Math.max(1, w)) : 1,
      enabled: r.enabled === false ? false : true,
    };
  });
}

function parseStored(text: string | null | undefined): StoredRoute[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? sanitizeRoutes(v, v as StoredRoute[]) : [];
  } catch {
    return [];
  }
}

export async function loadStoredRoutes(): Promise<StoredRoute[]> {
  let text: string | null = null;
  try {
    const rows = await db.select({ p: botSettingsTable.aiRoutePool }).from(botSettingsTable).where(eq(botSettingsTable.id, 1)).limit(1);
    text = rows[0]?.p ?? null;
  } catch (err) {
    logger.error({ err }, "ai route pool load failed (fail-open)");
  }
  return parseStored(text ?? process.env["AI_ROUTE_POOL"] ?? null);
}

/** 把已存設定套進執行中的池（啟動與後台改設定後呼叫）。 */
export async function applyStoredRoutePool(): Promise<number> {
  const routes = await loadStoredRoutes();
  configureRoutePool(routes as PoolRoute[]);
  return routes.length;
}

export async function saveRoutes(routes: StoredRoute[]): Promise<void> {
  const text = JSON.stringify(routes);
  await db.insert(botSettingsTable).values({ id: 1, aiRoutePool: text })
    .onConflictDoUpdate({ target: botSettingsTable.id, set: { aiRoutePool: text, updatedAt: new Date() } });
  configureRoutePool(routes as PoolRoute[]);
}

/** 後台顯示用：遮罩 key ＋ 即時健康狀態。 */
export async function describeRoutePool() {
  const stored = await loadStoredRoutes();
  const live = new Map(getRoutePool().snapshot().map((s) => [s.route.id, s]));
  return stored.map((r) => {
    const s = live.get(r.id);
    return {
      id: r.id, name: r.name, baseUrl: r.baseUrl, apiKey: maskKey(r.apiKey),
      qualityModel: r.qualityModel, bulkModel: r.bulkModel, weight: r.weight, enabled: r.enabled,
      state: s?.state ?? (r.enabled ? "ok" : "disabled"),
      successes: s?.health.successes ?? 0, failures: s?.health.failures ?? 0,
      consecutiveFailures: s?.health.consecutiveFailures ?? 0,
      avgMs: s?.health.avgMs !== null && s?.health.avgMs !== undefined ? Math.round(s.health.avgMs) : null,
      lastError: s?.health.lastError ?? null,
      cooldownSeconds: s && s.state === "open" ? Math.max(0, Math.ceil((s.health.openUntil - Date.now()) / 1000)) : 0,
    };
  });
}
