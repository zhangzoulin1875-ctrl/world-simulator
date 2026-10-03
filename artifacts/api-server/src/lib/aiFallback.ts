import { eq } from "drizzle-orm";
import { db, botSettingsTable } from "@workspace/db";
import { logger } from "./logger";
import {
  registerAiFallbackProvider,
  type AiFallbackConfig,
  type AiModelTierLite,
} from "@workspace/integrations-anthropic-ai";

/**
 * AI 備援（fallback）供應商設定 — 主供應商（NVIDIA NIM）單次呼叫失敗時，
 * adapter（lib/integrations-anthropic-ai/src/client.ts）會改用這裡解析出的
 * 備援供應商重試一次。預設備援＝Google Gemini 的 OpenAI 相容端點。
 *
 * 優先順序（比照 aiModels.ts 的模型覆寫機制）：
 *   1. 後台設定（bot_settings.ai_fallback_* 欄位，透過 /api/bot/ai-fallback
 *      寫入；短 TTL 快取，admin PATCH 後立即失效）
 *   2. 環境變數 AI_FALLBACK_BASE_URL／AI_FALLBACK_API_KEY／
 *      AI_FALLBACK_MODEL_QUALITY／AI_FALLBACK_MODEL_BULK
 *   3. 寫死的程式碼預設值（Gemini OpenAI 相容端點＋gemini-2.5 系列模型）
 *
 * apiKey 解析結果為空（後台與環境變數都沒設）＝備援關閉；主供應商的
 * 失敗照原樣往上拋，遊戲行為與本機制導入前完全一致。
 */

export const DEFAULT_FALLBACK_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai";
const DEFAULT_FALLBACK_QUALITY_MODEL = "gemini-2.5-pro";
const DEFAULT_FALLBACK_BULK_MODEL = "gemini-2.5-flash";

const CACHE_TTL_MS = 30_000;

interface FallbackOverrides {
  baseUrl: string | null;
  apiKey: string | null;
  qualityModel: string | null;
  bulkModel: string | null;
}

let cache: {
  loadedAt: number;
  overrides: FallbackOverrides;
} | null = null;

/** 後台 PATCH 設定後立即失效（比照 aiModels.ts 的作法）。 */
export function invalidateAiFallbackSettingsCache(): void {
  cache = null;
}

async function loadDbOverrides(): Promise<FallbackOverrides> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return cache.overrides;
  }
  let overrides: FallbackOverrides = {
    baseUrl: null,
    apiKey: null,
    qualityModel: null,
    bulkModel: null,
  };
  try {
    const rows = await db
      .select({
        baseUrl: botSettingsTable.aiFallbackBaseUrl,
        apiKey: botSettingsTable.aiFallbackApiKey,
        qualityModel: botSettingsTable.aiFallbackModelQuality,
        bulkModel: botSettingsTable.aiFallbackModelBulk,
      })
      .from(botSettingsTable)
      .where(eq(botSettingsTable.id, 1))
      .limit(1);
    const row = rows[0];
    overrides = {
      baseUrl: row?.baseUrl ?? null,
      apiKey: row?.apiKey ?? null,
      qualityModel: row?.qualityModel ?? null,
      bulkModel: row?.bulkModel ?? null,
    };
  } catch (err) {
    // Fail-open：讀取失敗就當作沒有後台覆寫（沿用環境變數/預設值），
    // 絕不能因為這張設定表故障就影響遊戲 AI 呼叫。
    logger.error({ err }, "ai fallback db override load failed (fail-open)");
  }
  cache = { loadedAt: now, overrides };
  return overrides;
}

function envString(key: string): string | null {
  const v = process.env[key];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** 目前生效的備援設定；apiKey 為空 ＝ 備援關閉（回傳 null）。 */
export async function getAiFallbackConfig(): Promise<AiFallbackConfig | null> {
  const o = await loadDbOverrides();
  const baseUrl = (o.baseUrl?.trim() || envString("AI_FALLBACK_BASE_URL") || DEFAULT_FALLBACK_BASE_URL).replace(/\/+$/, "");
  const apiKey = o.apiKey?.trim() || envString("AI_FALLBACK_API_KEY") || "";
  const qualityModel =
    o.qualityModel?.trim() || envString("AI_FALLBACK_MODEL_QUALITY") || DEFAULT_FALLBACK_QUALITY_MODEL;
  const bulkModel =
    o.bulkModel?.trim() || envString("AI_FALLBACK_MODEL_BULK") || DEFAULT_FALLBACK_BULK_MODEL;
  if (!apiKey) return null;
  return { baseUrl, apiKey, qualityModel, bulkModel };
}

/** 後台顯示用：生效值（永不回傳 API key 本體，只回報遮罩與是否已設定）。 */
export async function getAiFallbackInfo(): Promise<{
  enabled: boolean;
  baseUrl: string;
  apiKeySet: boolean;
  apiKeyMasked: string | null;
  qualityModel: string;
  bulkModel: string;
}> {
  const o = await loadDbOverrides();
  const config = await getAiFallbackConfig();
  return {
    enabled: config !== null,
    baseUrl:
      (o.baseUrl?.trim() || envString("AI_FALLBACK_BASE_URL") || DEFAULT_FALLBACK_BASE_URL).replace(/\/+$/, ""),
    apiKeySet: config !== null,
    apiKeyMasked: o.apiKey ? `${o.apiKey.slice(0, 4)}…${o.apiKey.slice(-4)}` : null,
    qualityModel:
      o.qualityModel?.trim() || envString("AI_FALLBACK_MODEL_QUALITY") || DEFAULT_FALLBACK_QUALITY_MODEL,
    bulkModel:
      o.bulkModel?.trim() || envString("AI_FALLBACK_MODEL_BULK") || DEFAULT_FALLBACK_BULK_MODEL,
  };
}

export interface AiFallbackOverridePatch {
  /** null／空字串＝清除覆寫，回退到環境變數。 */
  baseUrl?: string | null;
  apiKey?: string | null;
  qualityModel?: string | null;
  bulkModel?: string | null;
}

/** 後台 PATCH：部分更新 bot_settings 的備援欄位（未提供的欄位不動）。 */
export async function setAiFallbackOverrides(patch: AiFallbackOverridePatch): Promise<void> {
  const values: Record<string, unknown> = { id: 1 };
  const updateSet: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.baseUrl !== undefined) {
    const v = patch.baseUrl?.trim() || null;
    values.aiFallbackBaseUrl = v;
    updateSet.aiFallbackBaseUrl = v;
  }
  if (patch.apiKey !== undefined) {
    const v = patch.apiKey?.trim() || null;
    values.aiFallbackApiKey = v;
    updateSet.aiFallbackApiKey = v;
  }
  if (patch.qualityModel !== undefined) {
    const v = patch.qualityModel?.trim() || null;
    values.aiFallbackModelQuality = v;
    updateSet.aiFallbackModelQuality = v;
  }
  if (patch.bulkModel !== undefined) {
    const v = patch.bulkModel?.trim() || null;
    values.aiFallbackModelBulk = v;
    updateSet.aiFallbackModelBulk = v;
  }

  await db
    .insert(botSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: botSettingsTable.id, set: updateSet });

  invalidateAiFallbackSettingsCache();
}

/**
 * 服務啟動時呼叫一次：把備援設定解析器註冊進 adapter。
 * adapter 每次「主供應商失敗」時動態呼叫（讀 30 秒 TTL 快取，失敗
 * 不會打爆資料庫），後台改設定後不需重啟即生效。
 */
export function bootstrapAiFallback(): void {
  registerAiFallbackProvider(async (_tier: AiModelTierLite) => {
    try {
      return await getAiFallbackConfig();
    } catch (err) {
      logger.error({ err }, "ai fallback config resolve failed (fail-open)");
      return null;
    }
  });
  logger.info("ai fallback provider registered (gemini-compatible default)");
}
