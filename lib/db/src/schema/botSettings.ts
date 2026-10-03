import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

// Stores the Discord bot token (single row, id=1). The bot no longer ingests
// news, so all the former publishing-config columns were removed.
export const botSettingsTable = pgTable("bot_settings", {
  id: integer("id").primaryKey().default(1),
  token: text("token"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BotSettings = typeof botSettingsTable.$inferSelect;
