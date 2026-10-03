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
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BotSettings = typeof botSettingsTable.$inferSelect;
