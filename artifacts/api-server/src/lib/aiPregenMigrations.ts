import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * AI 閒時預產快取表（v3）的 idempotent 啟動遷移。
 * 必須在 gameMigrations（player_nations）之後執行（FK 依賴）。
 */
export async function runAiPregenMigrations(): Promise<void> {
  await withTestMigrationStamp("aiPregen", runAiPregenMigrationsInner);
}

async function runAiPregenMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_pregen_cache (
      id serial PRIMARY KEY,
      kind text NOT NULL,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      input_hash text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_pregen_cache_nation_kind_idx
      ON ai_pregen_cache (nation_id, kind)
  `);
  logger.info("ai_pregen_cache ready");
}
