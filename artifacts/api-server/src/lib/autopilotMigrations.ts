import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withMigrationLockStamped } from "./migrationLock";

/** AI 全權託管的 idempotent 啟動遷移（只 CREATE、永不 DROP）。 */
export async function runAutopilotMigrations(): Promise<void> {
  await withMigrationLockStamped("autopilot", runAutopilotMigrationsInner);
}

export async function runAutopilotMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS autopilot_settings (
      nation_id uuid PRIMARY KEY
        REFERENCES player_nations(id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT false,
      style text NOT NULL DEFAULT 'balanced',
      directive text NOT NULL DEFAULT '',
      enabled_at timestamptz,
      turns_run integer NOT NULL DEFAULT 0,
      recent_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // 回合引擎只掃「已啟用」的國家。
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS autopilot_settings_enabled_idx
      ON autopilot_settings (nation_id) WHERE enabled = true
  `);
}
