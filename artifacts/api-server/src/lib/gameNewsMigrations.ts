import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Task #184 — 每回合新聞的 idempotent 啟動遷移。
 *
 * game_news 無 FK（純顯示紀錄，非玩家綁定），可於 bootstrap 末段執行。
 * world_game_state.last_news_at 為新聞聚合的時間窗游標。欄位一律 ADD IF NOT
 * EXISTS、永不 DROP（避免 pg_attribute slot 洩漏）。不包 try/catch：失敗必須讓
 * bootstrap 大聲失敗。
 */
export async function runGameNewsMigrations(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_news (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      game_date text NOT NULL,
      year integer NOT NULL,
      era text NOT NULL,
      category text NOT NULL,
      title text NOT NULL,
      body text NOT NULL,
      significance text NOT NULL DEFAULT 'major',
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS game_news_created_idx
      ON game_news (created_at)
  `);

  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS last_news_at timestamptz
  `);

  logger.info("game news migrations applied");
}
