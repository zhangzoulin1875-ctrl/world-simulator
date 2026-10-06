import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// Stores the Discord bot token (single row, id=1). The bot no longer ingests
// news, so all the former publishing-config columns were removed.
// ai_model_quality / ai_model_bulk let the admin dashboard override the
// AI_MODEL_QUALITY / AI_MODEL_BULK env defaults at runtime (no redeploy —
// see aiModels.ts), since NVIDIA NIM exposes many interchangeable upstream
// models and admins may want to swap one without restarting the service.
export const botSettingsTable = pgTable("bot_settings", {
  id: integer("id").primaryKey().default(1),
  token: text("token"),
  aiModelQuality: text("ai_model_quality"),
  aiModelBulk: text("ai_model_bulk"),
  // AI 備援（fallback）供應商設定：主供應商失敗時改用（預設 Gemini 的
  // OpenAI 相容端點）。key 存這裡讓後台可調（見 aiFallback.ts）。
  aiFallbackBaseUrl: text("ai_fallback_base_url"),
  aiFallbackApiKey: text("ai_fallback_api_key"),
  aiFallbackModelQuality: text("ai_fallback_model_quality"),
  aiFallbackModelBulk: text("ai_fallback_model_bulk"),
  // 通用線路池（JSON 陣列，見 routePool.ts／aiRoutePool.ts）。有設定時優先於單一備援。
  aiRoutePool: text("ai_route_pool"),
  // AI 客服頻道（Discord channel id）。只有機器人擁有者能設定；null＝未啟用。
  supportChannelId: text("support_channel_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BotSettings = typeof botSettingsTable.$inferSelect;
