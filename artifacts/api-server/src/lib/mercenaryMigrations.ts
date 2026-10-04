import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withMigrationLockStamped } from "./migrationLock";

/** 僱傭兵狀態表:idempotent,只 CREATE,不 DROP。 */
export async function runMercenaryMigrations(): Promise<void> {
  await withMigrationLockStamped("mercenary", runMercenaryMigrationsInner);
}

export async function runMercenaryMigrationsInner(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS mercenary_states (
      nation_id uuid PRIMARY KEY
        REFERENCES player_nations(id) ON DELETE CASCADE,
      disarmed boolean NOT NULL DEFAULT false,
      company_id text,
      signed_at timestamptz,
      deployed_campaign_id integer
        REFERENCES war_campaigns(id) ON DELETE SET NULL,
      deployed_slot text,
      deployed_mode text,
      total_rent_paid bigint NOT NULL DEFAULT 0,
      total_deploy_paid bigint NOT NULL DEFAULT 0,
      last_termination_note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mercenary_states_slot_check
        CHECK (deployed_slot IS NULL OR deployed_slot IN ('A','B','C')),
      CONSTRAINT mercenary_states_mode_check
        CHECK (deployed_mode IS NULL OR deployed_mode IN ('defend','attack')),
      CONSTRAINT mercenary_states_deploy_consistency_check
        CHECK (
          (deployed_campaign_id IS NULL AND deployed_slot IS NULL AND deployed_mode IS NULL)
          OR (deployed_campaign_id IS NOT NULL AND deployed_slot IS NOT NULL AND deployed_mode IS NOT NULL)
        )
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS mercenary_states_campaign_idx
      ON mercenary_states (deployed_campaign_id)
      WHERE deployed_campaign_id IS NOT NULL
  `);
}
