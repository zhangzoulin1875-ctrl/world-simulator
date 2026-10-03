import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #451 — 遊戲平衡系統的 idempotent 啟動遷移。
 *
 * 兩張表皆無 FK（濫用紀錄刻意不 FK 到 player_nations：國家被硬刪／玩家退出後
 * 紀錄仍須保留供管理員稽核）。所有語句一律 CREATE ... IF NOT EXISTS，
 * 永不 DROP 欄位（避免 pg_attribute slot 洩漏）。不包 try/catch：失敗必須
 * 讓 bootstrap 大聲失敗。
 */
export async function runGameBalanceMigrations(): Promise<void> {
  await withTestMigrationStamp("game-balance", runGameBalanceMigrationsInner);
}

async function runGameBalanceMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_balance_settings (
      id integer PRIMARY KEY DEFAULT 1,
      params jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_abuse_records (
      id serial PRIMARY KEY,
      domain text NOT NULL,
      verdict text NOT NULL,
      discord_user_id text,
      nation_id uuid,
      nation_name text,
      input_text text NOT NULL,
      reason text NOT NULL,
      context jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ai_abuse_records_domain_created_idx
      ON ai_abuse_records (domain, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ai_abuse_records_nation_created_idx
      ON ai_abuse_records (nation_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ai_abuse_records_user_created_idx
      ON ai_abuse_records (discord_user_id, created_at)
  `);

  // Task #459 — 撤銷/補償欄位（一次性撤銷閘：reverted_at IS NULL 才可撤銷）。
  await db.execute(sql`
    ALTER TABLE ai_abuse_records
      ADD COLUMN IF NOT EXISTS reverted_at timestamptz,
      ADD COLUMN IF NOT EXISTS revert_note text,
      ADD COLUMN IF NOT EXISTS compensation jsonb NOT NULL DEFAULT '{}'::jsonb
  `);

  // Task #547 — 逐案加重處罰欄位（一次性加重閘：punished_at IS NULL 且
  // reverted_at IS NULL 才可加重；與撤銷互斥）。
  await db.execute(sql`
    ALTER TABLE ai_abuse_records
      ADD COLUMN IF NOT EXISTS punished_at timestamptz,
      ADD COLUMN IF NOT EXISTS punish_note text,
      ADD COLUMN IF NOT EXISTS punishment jsonb NOT NULL DEFAULT '{}'::jsonb
  `);

  logger.info("game balance migrations applied");
}
