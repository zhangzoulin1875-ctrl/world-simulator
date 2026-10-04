import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withMigrationLockStamped } from "./migrationLock";

/** 國策樹遷移:idempotent,只 CREATE,不 DROP。 */
export async function runFocusMigrations(): Promise<void> {
  await withMigrationLockStamped("focus", runFocusMigrationsInner);
}

export async function runFocusMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS focus_states (
      nation_id uuid PRIMARY KEY
        REFERENCES player_nations(id) ON DELETE CASCADE,
      points integer NOT NULL DEFAULT 0,
      black_lean integer NOT NULL DEFAULT 0,
      red_lean integer NOT NULL DEFAULT 0,
      tree_seed text,
      tree_version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT focus_states_points_check CHECK (points >= 0),
      CONSTRAINT focus_states_black_check CHECK (black_lean >= 0 AND black_lean <= 100),
      CONSTRAINT focus_states_red_check CHECK (red_lean >= 0 AND red_lean <= 100)
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS focus_active (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      focus_id text NOT NULL,
      slot text NOT NULL,
      total_turns integer NOT NULL,
      progress real NOT NULL DEFAULT 0,
      spent_points integer NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT focus_active_slot_check CHECK (slot IN ('main','side')),
      CONSTRAINT focus_active_progress_check CHECK (progress >= 0)
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS focus_active_nation_slot_uq
      ON focus_active (nation_id, slot)
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS focus_active_nation_focus_uq
      ON focus_active (nation_id, focus_id)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS focus_completed (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      focus_id text NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now(),
      era_slug text
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS focus_completed_nation_focus_uq
      ON focus_completed (nation_id, focus_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS focus_completed_nation_idx
      ON focus_completed (nation_id)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS focus_text_overrides (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      focus_id text NOT NULL,
      title text NOT NULL,
      description text NOT NULL,
      flavor text,
      source text NOT NULL DEFAULT 'template',
      meta jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT focus_text_source_check CHECK (source IN ('ai','template'))
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS focus_text_nation_focus_uq
      ON focus_text_overrides (nation_id, focus_id)
  `);
}
