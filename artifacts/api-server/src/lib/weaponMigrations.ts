import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * 武器系統 migration（冪等；沿用軍事 migration 慣例：一次性 ADD、
 * 永不 DROP）。
 *
 * 1. military_weapons 表：AI 設計的武器藍圖（相容類別、攻防加成、特殊技能）。
 * 2. player_nations.weapon_design_charges：武器設計次數（每回合回滿 3）。
 * 3. military_unit_templates.equipped_weapon_id：兵種裝備的武器
 *    （FK ON DELETE SET NULL — 銷毀武器自動卸裝）。
 */
export async function runWeaponMigrations(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS military_weapons (
      id serial PRIMARY KEY,
      owner_discord_user_id text
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      owner_nation_id uuid
        REFERENCES player_nations(id) ON DELETE CASCADE,
      name text NOT NULL,
      description text NOT NULL,
      compatible_categories text[] NOT NULL,
      attack_pct integer NOT NULL DEFAULT 0,
      defense_pct integer NOT NULL DEFAULT 0,
      skill_name text NOT NULL,
      skill_description text NOT NULL,
      skill_effect text NOT NULL,
      skill_bonus_pct integer NOT NULL DEFAULT 0,
      era_slug text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS military_weapons_owner_idx
      ON military_weapons (owner_discord_user_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS military_weapons_owner_nation_idx
      ON military_weapons (owner_nation_id)
  `);

  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS weapon_design_charges integer NOT NULL DEFAULT 3
  `);

  await db.execute(sql`
    ALTER TABLE military_unit_templates
      ADD COLUMN IF NOT EXISTS equipped_weapon_id integer
        REFERENCES military_weapons(id) ON DELETE SET NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS military_unit_templates_equipped_weapon_idx
      ON military_unit_templates (equipped_weapon_id)
  `);

  logger.info("weapon system migrations complete");
}
