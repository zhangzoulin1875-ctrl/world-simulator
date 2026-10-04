import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * 武將系統資料表的 idempotent 啟動遷移：generals（本體）、
 * general_pool（預產候選池）、general_draws（每回合抽取流量）。
 * 必須在 gameMigrations（player_nations）與 warMigrations
 * （war_campaign_legions）之後執行（FK 依賴）。
 *
 * 背景：這三張表最初只在 Replit 舊資料庫以手動方式建立，遷移檔從缺。
 * 換到全新 Neon 資料庫後抽卡路由 500（relation does not exist）。
 */
export async function runGeneralsMigrations(): Promise<void> {
  await withTestMigrationStamp("generals", runGeneralsMigrationsInner);
}

async function runGeneralsMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS generals (
      id serial PRIMARY KEY,
      owner_nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      name text NOT NULL,
      title text NOT NULL,
      background text NOT NULL,
      category text NOT NULL,
      grade integer NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'candidate',
      skills jsonb NOT NULL DEFAULT '[]'::jsonb,
      era_slug text NOT NULL,
      assigned_legion_id integer REFERENCES war_campaign_legions(id) ON DELETE SET NULL,
      upgrade_narrative text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    DO $do$
    BEGIN
      ALTER TABLE generals
        ADD CONSTRAINT generals_grade_check
        CHECK (grade >= 1 AND grade <= 5);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END
    $do$
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS generals_owner_idx ON generals (owner_nation_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS generals_status_idx
      ON generals (owner_nation_id, status)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS generals_assigned_legion_uidx
      ON generals (assigned_legion_id)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS general_pool (
      id serial PRIMARY KEY,
      name text NOT NULL,
      title text NOT NULL,
      background text NOT NULL,
      category text NOT NULL,
      skills jsonb NOT NULL DEFAULT '[]'::jsonb,
      era_slug text NOT NULL,
      culture_profile text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS general_pool_era_culture_idx
      ON general_pool (era_slug, culture_profile)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS general_draws (
      id serial PRIMARY KEY,
      owner_nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      kind text NOT NULL DEFAULT 'draw',
      money_spent integer NOT NULL DEFAULT 0,
      production_spent integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS general_draws_owner_idx
      ON general_draws (owner_nation_id, created_at)
  `);

  logger.info("generals tables ready");
}
