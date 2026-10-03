import { pgTable, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Opaque, server-issued Discord login sessions. The token is a random opaque
 * string stored in an httpOnly cookie. `manageableGuildIds` is a login-time
 * snapshot of the guilds the user can manage (owner or Manage Guild bit) — we
 * deliberately do NOT persist Discord access tokens; a re-login refreshes it.
 */
export const userSessionsTable = pgTable(
  "user_sessions",
  {
    token: text("token").primaryKey(),
    discordUserId: text("discord_user_id").notNull(),
    username: text("username").notNull(),
    globalName: text("global_name"),
    avatar: text("avatar"),
    manageableGuildIds: jsonb("manageable_guild_ids")
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    expiresIdx: index("user_sessions_expires_idx").on(t.expiresAt),
  }),
);

export type UserSession = typeof userSessionsTable.$inferSelect;
export type InsertUserSession = typeof userSessionsTable.$inferInsert;
