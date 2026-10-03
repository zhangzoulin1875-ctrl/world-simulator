import { eq } from "drizzle-orm";
import { db, botSettingsTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * AI 模型選擇（quality／bulk 兩層）。NVIDIA NIM（或其他 OpenAI 相容供應商）上游
 * 模型眾多，管理員應該能在後台直接切換，不必改環境變數重新部署。優先順序：
 *   1. 後台設定（bot_settings.ai_model_quality／ai_model_bulk，透過
 *      /api/bot/ai-models 寫入；短 TTL 快取，admin PATCH 後立即失效）
 *   2. 環境變數 AI_MODEL_QUALITY／AI_MODEL_BULK
 *   3. 寫死的程式碼預設值
 */

const DEFAULT_QUALITY_MODEL = "meta/llama-3.3-70b-instruct";
const DEFAULT_BULK_MODEL = "meta/llama-3.3-70b-instruct";

export type AiModelTier = "quality" | "bulk";

const CACHE_TTL_MS = 30_000;

let cache: {
  loadedAt: number;
  quality: string | null;
  bulk: string | null;
} | null = null;

/** 後台 PATCH 設定後立即失效（比照 gameAi.ts 的 settings cache 作法）。 */
export function invalidateAiModelSettingsCache(): void {
  cache = null;
}

async function loadDbOverrides(): Promise<{ quality: string | null; bulk: string | null }> {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) {
    return { quality: cache.quality, bulk: cache.bulk };
  }
  let quality: string | null = null;
  let bulk: string | null = null;
  try {
    const rows = await db
      .select({ aiModelQuality: botSettingsTable.aiModelQuality, aiModelBulk: botSettingsTable.aiModelBulk })
      .from(botSettingsTable)
      .where(eq(botSettingsTable.id, 1))
      .limit(1);
    quality = rows[0]?.aiModelQuality ?? null;
    bulk = rows[0]?.aiModelBulk ?? null;
  } catch (err) {
    // Fail-open：讀取失敗就當作沒有後台覆寫，照常用環境變數/預設值；
    // 絕不能因為這張設定表故障就讓遊戲所有 AI 呼叫都掛掉。
    logger.error({ err }, "ai model db override load failed (fail-open)");
  }
  cache = { loadedAt: now, quality, bulk };
  return { quality, bulk };
}

function envModel(key: string, fallback: string): string {
  const v = process.env[key];
  if (typeof v === "string" && v.trim().length > 0) return v.trim();
  return fallback;
}

/** 目前生效的模型 ID（後台覆寫 > 環境變數 > 程式碼預設）。 */
export async function getAiModel(tier: AiModelTier): Promise<string> {
  const overrides = await loadDbOverrides();
  if (tier === "bulk") {
    const override = overrides.bulk?.trim();
    if (override) return override;
    return envModel("AI_MODEL_BULK", DEFAULT_BULK_MODEL);
  }
  const override = overrides.quality?.trim();
  if (override) return override;
  return envModel("AI_MODEL_QUALITY", DEFAULT_QUALITY_MODEL);
}

export interface AiModelTierInfo {
  /** 後台設定的覆寫值；null 表示沒有覆寫，沿用環境變數/預設值。 */
  override: string | null;
  /** 環境變數層的值（覆寫被清空時會回退到這個）。 */
  envDefault: string;
  /** 目前實際生效的模型 ID（override ?? envDefault）。 */
  effective: string;
}

/** 後台頁面顯示用：回傳兩個 tier 目前的覆寫狀態與生效值。 */
export async function getAiModelInfo(): Promise<Record<AiModelTier, AiModelTierInfo>> {
  const overrides = await loadDbOverrides();
  const qualityEnv = envModel("AI_MODEL_QUALITY", DEFAULT_QUALITY_MODEL);
  const bulkEnv = envModel("AI_MODEL_BULK", DEFAULT_BULK_MODEL);
  const qualityOverride = overrides.quality?.trim() || null;
  const bulkOverride = overrides.bulk?.trim() || null;
  return {
    quality: {
      override: qualityOverride,
      envDefault: qualityEnv,
      effective: qualityOverride ?? qualityEnv,
    },
    bulk: {
      override: bulkOverride,
      envDefault: bulkEnv,
      effective: bulkOverride ?? bulkEnv,
    },
  };
}

/** 後台 PATCH：寫入覆寫值（null／空字串＝清除覆寫，回退到環境變數）。 */
export async function setAiModelOverride(tier: AiModelTier, value: string | null): Promise<void> {
  const trimmed = value?.trim() || null;
  const column = tier === "bulk" ? { aiModelBulk: trimmed } : { aiModelQuality: trimmed };
  await db
    .insert(botSettingsTable)
    .values({ id: 1, ...column, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: botSettingsTable.id,
      set: { ...column, updatedAt: new Date() },
    });
  invalidateAiModelSettingsCache();
}
