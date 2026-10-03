import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withMigrationLockStamped } from "./migrationLock";

/**
 * Task #242 — 內閣系統的 idempotent 啟動遷移。
 * 必須在 runPoliticsMigrations 之後執行（FK 依賴 player_nations，且概念上
 * 接續政治系統）。所有欄位一律一次性 CREATE、永不 DROP（避免 pg_attribute
 * slot 洩漏）。不包 try/catch：失敗必須讓 bootstrap 大聲失敗。
 */
export async function runCabinetMigrations(): Promise<void> {
  await withMigrationLockStamped("cabinet", runCabinetMigrationsInner);
}

async function runCabinetMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cabinet_ministers (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      domain text NOT NULL,
      name text NOT NULL,
      origin text NOT NULL,
      style jsonb NOT NULL,
      era text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // 每國每領域至多一位在任大臣（partial unique index）。
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS cabinet_ministers_active_uidx
      ON cabinet_ministers (nation_id, domain)
      WHERE status = 'active'
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS cabinet_ministers_nation_status_idx
      ON cabinet_ministers (nation_id, status)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cabinet_candidates (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      domain text NOT NULL,
      name text NOT NULL,
      origin text NOT NULL,
      style jsonb NOT NULL,
      era text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS cabinet_candidates_nation_domain_idx
      ON cabinet_candidates (nation_id, domain)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cabinet_domain_settings (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      domain text NOT NULL,
      directive text NOT NULL DEFAULT '',
      enabled_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
      agency_level text NOT NULL DEFAULT 'balanced',
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS cabinet_domain_settings_uidx
      ON cabinet_domain_settings (nation_id, domain)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cabinet_approvals (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      domain text NOT NULL,
      action_key text NOT NULL,
      summary text NOT NULL,
      params jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS cabinet_approvals_nation_status_idx
      ON cabinet_approvals (nation_id, status)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS cabinet_action_logs (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      domain text NOT NULL,
      action_key text NOT NULL,
      summary text NOT NULL,
      mode text NOT NULL,
      cost_amount bigint,
      cost_kind text,
      turn_date text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS cabinet_action_logs_nation_idx
      ON cabinet_action_logs (nation_id, id)
  `);
}
