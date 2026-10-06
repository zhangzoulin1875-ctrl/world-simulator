import { sql } from "drizzle-orm";
import {
  withWorldNeutrality,
  stripChineseDynasty,
} from "./worldNeutrality";
import { db } from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { getAiModel, type AiModelTier } from "./aiModels";
import { localDateString, localSlotInstant } from "./time";
import { logger } from "./logger";

/**
 * Task #593 — 統一 AI 呼叫包裝層。
 *
 * 全系統所有 anthropic 呼叫點一律經 `callGameAi(feature, tier, params)`：
 *  1. 讀取該功能的管理員設定（短 TTL 快取；admin PATCH 後以
 *     invalidateAiFeatureSettingsCache() 失效——比照 global-avg cache 教訓）。
 *  2. max_tokens = 覆寫值 ?? 程式碼預設，並夾到下限 AI_MAX_TOKENS_FLOOR，
 *     防止過低值截斷 JSON 輸出導致解析失敗。
 *  3. 每日 token 配額：以 NEWS_SCHEDULE_TZ 當地日期起點加總當日用量，
 *     超過即丟 AiQuotaExceededError（各功能沿既有 AI 失敗路徑處理；玩家
 *     手動觸發的路由攔截後回明確 zh-TW 錯誤）。
 *  4. 呼叫後從回應 usage 欄位寫入 ai_usage_logs（含失敗列）；紀錄寫入
 *     失敗以 try/catch 吞掉，絕不影響遊戲呼叫本身。
 *
 * 關鍵約束：**呼叫當下**動態取用共享 anthropic 單例的 messages.create
 * （不可在 import 時綁定引用），否則所有以覆寫 anthropic.messages.create
 * 為樁的既有戰爭/政治/外交測試會全部失效。
 *
 * 設定/用量讀取失敗一律 fail-open（記 log 後照常呼叫）：用量控管是
 * 營運工具，不能因它故障而癱瘓遊戲本體。
 */

/** max_tokens 有效值下限（防止截斷 JSON 輸出造成該功能整組失敗）。 */
export const AI_MAX_TOKENS_FLOOR = 256;

/** 原始用量紀錄保留天數（保留期外的舊列由回合引擎刪除）。 */
export const AI_USAGE_RETENTION_DAYS = 30;

/** 功能設定快取 TTL（毫秒）。admin 寫入時另以 invalidate 立即失效。 */
const SETTINGS_CACHE_TTL_MS = 30_000;

export interface AiFeatureDef {
  /** zh-TW 顯示名稱（admin 面板用）。 */
  label: string;
  /** 程式碼預設 max_tokens（admin 未覆寫時使用；面板顯示供參考）。 */
  defaultMaxTokens: number;
}

/**
 * 全部 AI 呼叫點的功能註冊表（key 穩定、入庫；勿改既有 key）。
 * defaultMaxTokens 與各呼叫點遷移前的字面值一致。
 */
export const AI_FEATURES = {
  "war.terrain_brief": { label: "戰爭：地形簡報", defaultMaxTokens: 1000 },
  "war.unit_analysis": { label: "戰爭：兵種分析", defaultMaxTokens: 200 },
  "war.cycle_settlement": { label: "戰爭：戰役結算", defaultMaxTokens: 1500 },
  "war.npc_orders": { label: "戰爭：NPC 作戰指令", defaultMaxTokens: 150 },
  "politics.settlement": { label: "內政結算", defaultMaxTokens: 1500 },
  "finance.settlement": { label: "財政結算", defaultMaxTokens: 1200 },
  "military.unit_design": { label: "兵種設計（玩家）", defaultMaxTokens: 2000 },
  "military.weapon_design": { label: "武器設計（玩家）", defaultMaxTokens: 2000 },
  "general.gacha": { label: "武將生成（玩家抽取）", defaultMaxTokens: 3000 },
  "military.npc_unit_set": {
    label: "兵種設計（NPC 兵種組）",
    defaultMaxTokens: 3000,
  },
  "diplomacy.treaty": { label: "NPC 條約決策", defaultMaxTokens: 1000 },
  "diplomacy.chat": { label: "NPC 外交對話", defaultMaxTokens: 1200 },
  "super_event.generate": { label: "超事件：生成", defaultMaxTokens: 1500 },
  "super_event.turn_judgment": {
    label: "超事件：回合判定",
    defaultMaxTokens: 1500,
  },
  "super_event.response_judgment": {
    label: "超事件：應對判定",
    defaultMaxTokens: 1500,
  },
  "cabinet.candidates": { label: "內閣：候選人生成", defaultMaxTokens: 1500 },
  "cabinet.military_planning": {
    label: "內閣：軍事代理",
    defaultMaxTokens: 1500,
  },
  "cabinet.diplomacy": { label: "內閣：外交代理", defaultMaxTokens: 2048 },
  "cabinet.interior": { label: "內閣：內政代理", defaultMaxTokens: 800 },
  "autopilot.extras": { label: "AI 託管：政策／決策／事件應對", defaultMaxTokens: 900 },
  "game_news.turn_news": { label: "回合新聞", defaultMaxTokens: 2048 },
  "world_sim.proposal": { label: "世界模擬提案", defaultMaxTokens: 8192 },
  "advisor.tips": { label: "顧問小提示", defaultMaxTokens: 2000 },
  "npc_initiative.proposals": {
    label: "NPC 主動提案（已停用）",
    defaultMaxTokens: 4096,
  },
  "focus.story": { label: "國策:發動背景故事", defaultMaxTokens: 500 },
  "domestic.event": { label: "國內事件文字", defaultMaxTokens: 700 },
  "parliament.report": { label: "議會:國情報告評分", defaultMaxTokens: 400 },
  "constitution.quality": { label: "憲法:品質審查", defaultMaxTokens: 900 },
  "constitution.vote": { label: "憲法:各黨投票", defaultMaxTokens: 1200 },
  "constitution.flaws": { label: "憲法:漏洞掃描", defaultMaxTokens: 1400 },
  "support.search": { label: "Discord：AI 客服程式碼搜尋關鍵字", defaultMaxTokens: 200 },
  "support.chat": { label: "Discord：AI 客服回答", defaultMaxTokens: 900 },
  "diagnostics.ping": { label: "系統：AI 連線測試", defaultMaxTokens: 200 },
} as const satisfies Record<string, AiFeatureDef>;

export type AiFeatureKey = keyof typeof AI_FEATURES;

export function isAiFeatureKey(key: string): key is AiFeatureKey {
  return Object.prototype.hasOwnProperty.call(AI_FEATURES, key);
}

/** 每日 token 配額超限錯誤（可辨識；玩家手動路由攔截後回 zh-TW 訊息）。 */
export class AiQuotaExceededError extends Error {
  readonly feature: AiFeatureKey;

  constructor(feature: AiFeatureKey) {
    super(
      `AI 功能「${AI_FEATURES[feature].label}」已達今日 token 用量上限，暫停至明日；請稍後再試或聯絡管理員調整配額`,
    );
    this.name = "AiQuotaExceededError";
    this.feature = feature;
  }
}

export interface AiFeatureSettings {
  maxTokensOverride: number | null;
  dailyTokenQuota: number | null;
}

let settingsCache: {
  loadedAt: number;
  map: Map<string, AiFeatureSettings>;
} | null = null;

/** admin PATCH 設定後立即失效（比照 global-avg-production cache 的教訓）。 */
export function invalidateAiFeatureSettingsCache(): void {
  settingsCache = null;
}

async function loadFeatureSettings(): Promise<Map<string, AiFeatureSettings>> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.loadedAt < SETTINGS_CACHE_TTL_MS) {
    return settingsCache.map;
  }
  const res = await db.execute(sql`
    SELECT feature, max_tokens_override, daily_token_quota
    FROM ai_feature_settings
  `);
  const map = new Map<string, AiFeatureSettings>();
  for (const row of res.rows as Array<{
    feature: string;
    max_tokens_override: number | null;
    daily_token_quota: number | null;
  }>) {
    map.set(row.feature, {
      maxTokensOverride: row.max_tokens_override,
      dailyTokenQuota: row.daily_token_quota,
    });
  }
  settingsCache = { loadedAt: now, map };
  return map;
}

/** 當日（NEWS_SCHEDULE_TZ 當地日期）的起始 UTC 時刻。 */
export function todayStartInstant(now: Date = new Date()): Date {
  return localSlotInstant(localDateString(now), 0, 0);
}

/** 加總某功能當日（當地日期）已用 token（輸入＋輸出，含失敗列）。 */
export async function getTodayTokenUsage(
  feature: string,
  now: Date = new Date(),
): Promise<number> {
  const start = todayStartInstant(now);
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS total
    FROM ai_usage_logs
    WHERE feature = ${feature} AND created_at >= ${start}
  `);
  const row = res.rows[0] as { total?: unknown } | undefined;
  return Number(row?.total ?? 0);
}

function usageTokens(message: unknown): { input: number; output: number } {
  const usage = (
    message as { usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null
  )?.usage;
  const toInt = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
  return { input: toInt(usage?.input_tokens), output: toInt(usage?.output_tokens) };
}

/** 寫入一列用量紀錄；任何失敗吞掉只記 log，絕不影響遊戲呼叫。 */
async function recordUsage(
  feature: AiFeatureKey,
  tier: AiModelTier,
  model: string,
  message: unknown,
  success: boolean,
): Promise<void> {
  try {
    const { input, output } = usageTokens(message);
    await db.execute(sql`
      INSERT INTO ai_usage_logs (feature, tier, model, input_tokens, output_tokens, success)
      VALUES (${feature}, ${tier}, ${model}, ${input}, ${output}, ${success})
    `);
  } catch (err) {
    logger.error({ err, feature }, "ai usage log insert failed (ignored)");
  }
}

export interface GameAiParams {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * 統一 AI 呼叫入口。回傳 anthropic 訊息物件（結構同 messages.create）。
 * @throws AiQuotaExceededError 該功能當日 token 用量已達管理員設定的配額。
 * @throws 底層 anthropic 呼叫的原始錯誤（已先記一列 success=false）。
 */
export async function callGameAi(
  feature: AiFeatureKey,
  tier: AiModelTier,
  params: GameAiParams,
) {
  const def = AI_FEATURES[feature];

  let settings: AiFeatureSettings | undefined;
  try {
    settings = (await loadFeatureSettings()).get(feature);
  } catch (err) {
    logger.error({ err, feature }, "ai feature settings load failed (fail-open)");
  }

  if (settings && settings.dailyTokenQuota !== null) {
    let used: number | null = null;
    try {
      used = await getTodayTokenUsage(feature);
    } catch (err) {
      logger.error({ err, feature }, "ai daily usage check failed (fail-open)");
    }
    if (used !== null && used >= settings.dailyTokenQuota) {
      throw new AiQuotaExceededError(feature);
    }
  }

  const maxTokens = Math.max(
    AI_MAX_TOKENS_FLOOR,
    settings?.maxTokensOverride ?? def.defaultMaxTokens,
  );
  const model = await getAiModel(tier);

  try {
    // 呼叫當下動態取用共享單例的 messages.create（測試以覆寫該方法為樁）。
    // 世界中立化：所有 AI 功能共用出口，一次涵蓋（政治／財政／內閣／戰爭／
    // 新聞／武器／兵種…）。system 加「世界中立原則」前言；system 與訊息內文
    // 都去掉時代標籤的中國朝代括號，避免 AI 把所有玩家都當成中國人。
    const message = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: withWorldNeutrality(
        params.system !== undefined ? stripChineseDynasty(params.system) : undefined,
      ),
      messages: params.messages.map((m) => ({
        ...m,
        content: stripChineseDynasty(m.content),
      })),
      // 層級標記：備援重試時據此挑對應的備援模型（quality/bulk）。
      tier,
    });
    await recordUsage(feature, tier, model, message, true);
    return message;
  } catch (err) {
    await recordUsage(feature, tier, model, null, false);
    throw err;
  }
}

/** 從 AI 回覆取出第一個文字區塊（沒有就是空字串）。 */
export function firstText(message: { content: Array<{ type: string; text?: string }> }): string {
  const block = message.content[0];
  return block && block.type === "text" ? (block.text ?? "") : "";
}

/**
 * 呼叫 AI 並驗證輸出；格式不對（空回應、壞 JSON、欄位不符）就自動重問，
 * 最多 maxAttempts 次。玩家的政策判定過去只問一次，量產模型偶爾吐出空內容
 * 或壞 JSON 就整筆被跳過、等下一回合，玩家看起來就是「AI 沒讀我的政策」。
 * parse 丟錯＝這次輸出不可用；全部失敗才把最後一次的錯誤丟出（呼叫端照舊
 * 「保留想法、下回合重試」）。AI 呼叫本身失敗（逾時、額度）不在這裡重試，
 * 交給底層佇列與備援處理，避免放大請求量。
 */
export async function callGameAiParsed<T>(
  feature: AiFeatureKey,
  tier: AiModelTier,
  params: GameAiParams,
  parse: (raw: string) => T,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const message = await callGameAi(feature, tier, params);
    const raw = firstText(message as { content: Array<{ type: string; text?: string }> });
    try {
      return parse(raw);
    } catch (err) {
      lastErr = err;
      logger.warn(
        { feature, attempt, maxAttempts, rawHead: raw.slice(0, 120) },
        "ai output unusable, retrying",
      );
    }
  }
  throw lastErr;
}

/** 刪除保留期外的原始用量紀錄列；回傳刪除筆數（回合引擎每回合呼叫）。 */
export async function pruneAiUsageLogs(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(
    now.getTime() - AI_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const res = await db.execute(sql`
    DELETE FROM ai_usage_logs WHERE created_at < ${cutoff}
  `);
  return res.rowCount ?? 0;
}
