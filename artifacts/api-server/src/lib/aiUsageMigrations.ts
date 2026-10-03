import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #593 — AI 用量紀錄與各功能 token 上限的 idempotent 啟動遷移。
 *
 * 兩張表皆無 FK（用量紀錄按「功能別」統計，不歸戶到玩家/國家）。所有語句
 * 一律 CREATE ... IF NOT EXISTS，永不 DROP 欄位（避免 pg_attribute slot 洩漏）。
 * 不包 try/catch：失敗必須讓 bootstrap 大聲失敗。
 *
 *  - ai_usage_logs：每次 AI 呼叫一列（功能 key、tier、模型、輸入/輸出 token、
 *    成功旗標、時間）。保留期外的舊列由回合引擎清除（pruneAiUsageLogs）。
 *  - ai_feature_settings：每功能一列（max_tokens 覆寫、每日 token 配額，
 *    皆 nullable＝用程式碼預設/不限）。
 */
export async function runAiUsageMigrations(): Promise<void> {
  await withTestMigrationStamp("ai-usage", runAiUsageMigrationsInner);
}

export async function runAiUsageMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_usage_logs (
      id bigserial PRIMARY KEY,
      feature text NOT NULL,
      tier text NOT NULL,
      model text NOT NULL,
      input_tokens integer NOT NULL DEFAULT 0,
      output_tokens integer NOT NULL DEFAULT 0,
      success boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ai_usage_logs_feature_created_idx
      ON ai_usage_logs (feature, created_at)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ai_feature_settings (
      feature text PRIMARY KEY,
      max_tokens_override integer,
      daily_token_quota integer,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  logger.info("ai usage migrations applied");
}
