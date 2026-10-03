import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Banned Discord accounts. Keyed by the Discord user id (the same opaque id
 * stored on `user_sessions.discord_user_id` / `player_nations.discord_user_id`
 * — deliberately NOT an FK, since a ban must survive even if the account never
 * founded a nation). A row here blocks both new logins (checked in the OAuth
 * callback) and any existing session (checked in `getSession`, which also
 * revokes the session). `username` is a display snapshot captured at ban time.
 */
export const accountBansTable = pgTable(
  "account_bans",
  {
    discordUserId: text("discord_user_id").primaryKey(),
    username: text("username"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    createdIdx: index("account_bans_created_idx").on(t.createdAt),
  }),
);

export type AccountBan = typeof accountBansTable.$inferSelect;
export type InsertAccountBan = typeof accountBansTable.$inferInsert;
