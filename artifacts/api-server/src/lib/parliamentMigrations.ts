import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withMigrationLockStamped } from "./migrationLock";

/**
 * 選舉與議會 — idempotent 遷移。只 ADD / CREATE IF NOT EXISTS，絕不 DROP。
 * 依賴 player_nations（FK），須放在遷移鏈尾端。
 */
export async function runParliamentMigrations(): Promise<void> {
  await withMigrationLockStamped("parliament", () => runParliamentMigrationsInner());
}

type MigrationExecutor = Pick<typeof db, "execute">;

export async function runParliamentMigrationsInner(
  executor: MigrationExecutor = db,
): Promise<void> {
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS parliament_state (
      nation_id uuid PRIMARY KEY REFERENCES player_nations(id) ON DELETE CASCADE,
      satisfaction integer NOT NULL DEFAULT 60,
      tick integer NOT NULL DEFAULT 0,
      last_demand_tick integer,
      active_demand jsonb,
      protest_text text NOT NULL DEFAULT '',
      last_report_tick integer,
      last_report_feedback text NOT NULL DEFAULT '',
      revolutions integer NOT NULL DEFAULT 0,
      prev_tax_rate integer,
      prev_army_pop text,
      prev_policy_count integer,
      last_parties_tick integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT parliament_state_sat_check CHECK (satisfaction >= 0 AND satisfaction <= 100)
    )
  `);
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS parliament_parties (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      name text NOT NULL,
      stance text NOT NULL,
      description text NOT NULL DEFAULT '',
      weight integer NOT NULL DEFAULT 1,
      seats integer NOT NULL DEFAULT 0,
      color text NOT NULL DEFAULT '#888888',
      is_ruling boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT parliament_parties_seats_check CHECK (seats >= 0 AND seats <= 100)
    )
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS parliament_parties_nation_idx ON parliament_parties (nation_id)
  `);
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS parliament_log (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      tick integer NOT NULL,
      kind text NOT NULL,
      summary text NOT NULL,
      sat_delta integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS parliament_log_nation_idx ON parliament_log (nation_id, id)
  `);
  // 已存在的舊表補欄位（CREATE IF NOT EXISTS 不會補欄位）。
  await executor.execute(sql`ALTER TABLE parliament_state ADD COLUMN IF NOT EXISTS prev_tax_rate integer`);
  await executor.execute(sql`ALTER TABLE parliament_state ADD COLUMN IF NOT EXISTS prev_army_pop text`);
  await executor.execute(sql`ALTER TABLE parliament_state ADD COLUMN IF NOT EXISTS prev_policy_count integer`);
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS military_demands (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      region_id integer NOT NULL,
      region_name text NOT NULL,
      target_nation_id uuid,
      target_nation_name text,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz
    )
  `);
  await executor.execute(sql`CREATE INDEX IF NOT EXISTS military_demands_nation_idx ON military_demands (nation_id, created_at)`);
  await executor.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS military_demands_one_pending_uidx ON military_demands (nation_id) WHERE status = 'pending'`);
}
