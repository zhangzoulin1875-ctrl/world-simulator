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
          deployed_campaign_id IS NULL
          OR (deployed_slot IS NOT NULL AND deployed_mode IS NOT NULL)
        )
    )
  `);
  // 升級已建好的舊表:戰役被刪時外鍵只會把 deployed_campaign_id 置空,
  // slot/mode 殘留無害(讀取一律以 campaign_id 為準),所以約束只單向要求「有戰役就要有 slot+mode」。
  await db.execute(sql`
    ALTER TABLE mercenary_states
      DROP CONSTRAINT IF EXISTS mercenary_states_deploy_consistency_check
  `);
  await db.execute(sql`
    ALTER TABLE mercenary_states
      ADD CONSTRAINT mercenary_states_deploy_consistency_check
      CHECK (
        deployed_campaign_id IS NULL
        OR (deployed_slot IS NOT NULL AND deployed_mode IS NOT NULL)
      )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS mercenary_states_campaign_idx
      ON mercenary_states (deployed_campaign_id)
      WHERE deployed_campaign_id IS NOT NULL
  `);
  // 多戰場派遣:一筆 = 傭兵團派進某一場戰役的某個欄位。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS mercenary_deployments (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      campaign_id integer NOT NULL
        REFERENCES war_campaigns(id) ON DELETE CASCADE,
      slot text NOT NULL,
      mode text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT mercenary_deployments_slot_check CHECK (slot IN ('A','B','C')),
      CONSTRAINT mercenary_deployments_mode_check CHECK (mode IN ('defend','attack'))
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS mercenary_deployments_nation_campaign_uq
      ON mercenary_deployments (nation_id, campaign_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS mercenary_deployments_campaign_idx
      ON mercenary_deployments (campaign_id)
  `);
  // 把舊的單一派遣欄位搬進新表(冪等),然後清空舊欄位,之後一律以新表為準。
  await db.execute(sql`
    INSERT INTO mercenary_deployments (nation_id, campaign_id, slot, mode)
    SELECT nation_id, deployed_campaign_id, deployed_slot, deployed_mode
      FROM mercenary_states
     WHERE deployed_campaign_id IS NOT NULL
       AND deployed_slot IS NOT NULL
       AND deployed_mode IS NOT NULL
    ON CONFLICT (nation_id, campaign_id) DO NOTHING
  `);
  await db.execute(sql`
    UPDATE mercenary_states
       SET deployed_campaign_id = NULL, deployed_slot = NULL, deployed_mode = NULL
     WHERE deployed_campaign_id IS NOT NULL
  `);
}
