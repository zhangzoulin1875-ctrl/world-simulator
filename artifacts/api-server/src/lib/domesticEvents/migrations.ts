import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withMigrationLockStamped } from "../migrationLock";

/** 建表:idempotent,只 CREATE,不 DROP */
export async function runDomesticEventMigrations(): Promise<void> {
  await withMigrationLockStamped("domestic_events", runDomesticEventMigrationsInner);
}

export async function runDomesticEventMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS domestic_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      kind text NOT NULL,
      title text NOT NULL,
      body text NOT NULL,
      choices jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      created_tick integer NOT NULL,
      due_tick integer NOT NULL,
      chosen_id text,
      outcome text,
      ai_rewritten integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      CONSTRAINT domestic_events_status_check CHECK (status IN ('pending','resolved','expired'))
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS domestic_events_nation_idx ON domestic_events (nation_id, created_at)`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS domestic_events_one_pending_uq
      ON domestic_events (nation_id) WHERE status = 'pending'
  `);
}
