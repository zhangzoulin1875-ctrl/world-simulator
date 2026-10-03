import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * 封禁 Discord 帳號的 idempotent 啟動遷移。
 *
 * account_bans 無 FK（封禁必須在帳號從未建國時仍成立），可於 bootstrap 末段
 * 執行。欄位一律 ADD/CREATE IF NOT EXISTS、永不 DROP（避免 pg_attribute slot
 * 洩漏）。不包 try/catch：失敗必須讓 bootstrap 大聲失敗。
 */
export async function runAccountBanMigrations(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS account_bans (
      discord_user_id text PRIMARY KEY,
      username text,
      reason text,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS account_bans_created_idx
      ON account_bans (created_at)
  `);

  logger.info("account ban migrations applied");
}
