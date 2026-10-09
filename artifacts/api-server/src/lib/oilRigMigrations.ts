import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withMigrationLockStamped } from "./migrationLock";

/**
 * 廢棄油井表(冪等:只 CREATE IF NOT EXISTS,不 DROP、不改既有表)。
 * 刻意不放進 player_nations 欄位遷移,避免影響首頁載入。
 */
export async function runOilRigMigrations(): Promise<void> {
  await withMigrationLockStamped("oil_rigs", runOilRigMigrationsInner);
}

export async function runOilRigMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oil_seasons (
      id serial PRIMARY KEY,
      season_number integer NOT NULL,
      status text NOT NULL DEFAULT 'active',
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      winner_nation_id uuid REFERENCES player_nations(id) ON DELETE SET NULL,
      winner_nation_name text,
      winner_score double precision,
      last_scored_at timestamptz NOT NULL DEFAULT now(),
      next_era text,
      CONSTRAINT oil_seasons_status_check CHECK (status IN ('active','cooldown'))
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS oil_seasons_number_uidx ON oil_seasons (season_number)`);
  // 同時只能有一個 active 賽季:部分唯一索引,擋住並行開季
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS oil_seasons_one_active_uidx ON oil_seasons (status) WHERE status = 'active'`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oil_rigs (
      id serial PRIMARY KEY,
      slug text NOT NULL,
      name text NOT NULL,
      sea text NOT NULL,
      lng double precision NOT NULL,
      lat double precision NOT NULL,
      holder_nation_id uuid REFERENCES player_nations(id) ON DELETE SET NULL,
      held_since timestamptz,
      garrison_strength integer NOT NULL DEFAULT 100,
      CONSTRAINT oil_rigs_garrison_check CHECK (garrison_strength >= 0)
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS oil_rigs_slug_uidx ON oil_rigs (slug)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS oil_rigs_holder_idx ON oil_rigs (holder_nation_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oil_scores (
      id serial PRIMARY KEY,
      season_id integer NOT NULL REFERENCES oil_seasons(id) ON DELETE CASCADE,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      score double precision NOT NULL DEFAULT 0,
      reached_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT oil_scores_score_check CHECK (score >= 0)
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS oil_scores_season_nation_uidx ON oil_scores (season_id, nation_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS oil_scores_season_score_idx ON oil_scores (season_id, score)`);
}
