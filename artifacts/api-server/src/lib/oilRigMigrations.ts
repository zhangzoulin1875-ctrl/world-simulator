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

  // ── 油井戰役(階段二) ──────────────────────────────────────
  // 一場戰役 = 某國對某座油井發起的攻擊。結算時間到才打(真實時間,不綁回合)。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oil_campaigns (
      id serial PRIMARY KEY,
      season_id integer NOT NULL REFERENCES oil_seasons(id) ON DELETE CASCADE,
      rig_id integer NOT NULL REFERENCES oil_rigs(id) ON DELETE CASCADE,
      attacker_nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      -- 發起時的守方(null = 無人佔領,由油井守軍迎戰)
      defender_nation_id uuid REFERENCES player_nations(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'active',
      started_at timestamptz NOT NULL DEFAULT now(),
      settle_at timestamptz NOT NULL,
      settled_at timestamptz,
      outcome text,
      attacker_power double precision,
      defender_power double precision,
      CONSTRAINT oil_campaigns_status_check CHECK (status IN ('active','settled','cancelled')),
      CONSTRAINT oil_campaigns_outcome_check CHECK (outcome IS NULL OR outcome IN ('attacker_wins','defender_wins'))
    )
  `);
  // 同一座油井同時只能有一場進行中的戰役(部分唯一索引,擋並行發起)
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS oil_campaigns_one_active_per_rig_uidx ON oil_campaigns (rig_id) WHERE status = 'active'`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS oil_campaigns_settle_idx ON oil_campaigns (settle_at) WHERE status = 'active'`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS oil_campaigns_attacker_idx ON oil_campaigns (attacker_nation_id)`);

  // 投入戰役的艦隊。side='attacker'|'defender'。quantity = 投入時鎖定的艦數(結算後依損失歸還生還者)。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS oil_campaign_fleets (
      id serial PRIMARY KEY,
      campaign_id integer NOT NULL REFERENCES oil_campaigns(id) ON DELETE CASCADE,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      side text NOT NULL,
      template_id integer NOT NULL REFERENCES military_unit_templates(id) ON DELETE CASCADE,
      quantity bigint NOT NULL,
      CONSTRAINT oil_campaign_fleets_side_check CHECK (side IN ('attacker','defender')),
      CONSTRAINT oil_campaign_fleets_qty_check CHECK (quantity > 0)
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS oil_campaign_fleets_uidx ON oil_campaign_fleets (campaign_id, nation_id, side, template_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS oil_campaign_fleets_nation_idx ON oil_campaign_fleets (nation_id)`);
}
