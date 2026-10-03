import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #149 — 生產系統（城市建築／人口與滿意度 buff）的 idempotent 啟動遷移。
 * 需在 player_nations 之後執行（FK 依賴 discord_user_id 與 map_cities）。
 * 與其他啟動遷移一致：不包 try/catch，失敗必須讓 bootstrap 大聲失敗。
 */
export async function runProductionMigrations(): Promise<void> {
  await withTestMigrationStamp("production", runProductionMigrationsInner);
}

async function runProductionMigrationsInner(): Promise<void> {
  // Task #149 曾在此建立 production_techs／player_researched_production_techs
  // （生產科技抽牌系統）。Task #469 全面改為全球統一線性科技樹
  // （techTreeMigrations.ts），舊表於原建立處 supersede DROP（子表先刪）；
  // 研發進度全面重置、不遷移。
  await db.execute(sql`DROP TABLE IF EXISTS player_researched_production_techs`);
  await db.execute(sql`DROP TABLE IF EXISTS production_techs`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS city_buildings (
      id serial PRIMARY KEY,
      discord_user_id text NOT NULL
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      city_id integer NOT NULL
        REFERENCES map_cities(id) ON DELETE CASCADE,
      building_type text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS city_buildings_user_idx ON city_buildings (discord_user_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS city_buildings_city_idx ON city_buildings (city_id)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS nation_population_buffs (
      id serial PRIMARY KEY,
      discord_user_id text NOT NULL
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      growth_pct integer NOT NULL,
      remaining_turns integer NOT NULL,
      source text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS nation_population_buffs_user_idx
      ON nation_population_buffs (discord_user_id)
  `);

  // Task #355 — 國家暫時滿意度 buff（管理員發放限回合數的滿意度加成）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS nation_satisfaction_buffs (
      id serial PRIMARY KEY,
      discord_user_id text NOT NULL
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      direction text NOT NULL,
      satisfaction_offset integer NOT NULL,
      remaining_turns integer NOT NULL,
      source text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS nation_satisfaction_buffs_user_idx
      ON nation_satisfaction_buffs (discord_user_id)
  `);

  logger.info("production migrations applied");
}
