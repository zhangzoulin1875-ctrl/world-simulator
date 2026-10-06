import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #333 — 超事件系統的 idempotent 啟動遷移。
 *
 * 依 FK 順序建立（super_events → super_event_regions/turn_logs/responses；
 * settings 無 FK）。所有語句一律 CREATE ... IF NOT EXISTS，永不 DROP 欄位
 * （避免 pg_attribute slot 洩漏）。不包 try/catch：失敗必須讓 bootstrap
 * 大聲失敗。super_event_regions/responses FK 至 map_regions／player_nations，
 * 故須在 runGameMigrations（建立 player_nations／map_regions）之後執行。
 */
export async function runSuperEventMigrations(): Promise<void> {
  await withTestMigrationStamp("super-event", () => runSuperEventMigrationsInner());
}

/** 遷移可指定 executor（如整合測試的單一交易 tx）；預設走全域 db（逐句 autocommit）。 */
type MigrationExecutor = Pick<typeof db, "execute">;

/**
 * 供整合測試在「單一交易」內模擬舊 DB → 跑遷移 → 驗證，避免共用開發庫
 * 對其他連線暴露舊欄位名的中間狀態。正常啟動一律走 runSuperEventMigrations。
 */
export async function runSuperEventMigrationsInner(
  executor: MigrationExecutor = db,
): Promise<void> {
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS super_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      summary text NOT NULL DEFAULT '',
      narrative text NOT NULL DEFAULT '',
      category text NOT NULL DEFAULT '其他',
      scope text NOT NULL DEFAULT 'global',
      cause text NOT NULL DEFAULT 'admin',
      status text NOT NULL DEFAULT 'active',
      severity integer NOT NULL DEFAULT 50,
      impact_pct integer NOT NULL DEFAULT 100,
      turns_elapsed integer NOT NULL DEFAULT 0,
      max_turns integer,
      ai_context text,
      granted_techs jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      ended_at timestamptz
    )
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS super_events_status_idx ON super_events (status)
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS super_events_created_idx ON super_events (created_at)
  `);

  // Task #356 — 屬性（災難／機會）、目前階段、是否可蔓延。ADD ... IF NOT EXISTS
  // 為 idempotent；永不 DROP（避免 pg_attribute slot 洩漏）。
  await executor.execute(sql`
    ALTER TABLE super_events
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'disaster'
  `);
  await executor.execute(sql`
    ALTER TABLE super_events
      ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'outbreak'
  `);
  await executor.execute(sql`
    ALTER TABLE super_events
      ADD COLUMN IF NOT EXISTS can_spread boolean NOT NULL DEFAULT false
  `);
  // 管理員指定的目標數據欄位（null＝不限，由 AI 自行決定）。
  await executor.execute(sql`
    ALTER TABLE super_events
      ADD COLUMN IF NOT EXISTS target_stats jsonb
  `);

  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS super_event_regions (
      id serial PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES super_events (id) ON DELETE CASCADE,
      region_id integer NOT NULL REFERENCES map_regions (id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await executor.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS super_event_regions_event_region_uidx
      ON super_event_regions (event_id, region_id)
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS super_event_regions_event_idx
      ON super_event_regions (event_id)
  `);

  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS super_event_turn_logs (
      id serial PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES super_events (id) ON DELETE CASCADE,
      turn_number integer NOT NULL,
      narrative text NOT NULL DEFAULT '',
      effect_summary text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS super_event_turn_logs_event_idx
      ON super_event_turn_logs (event_id)
  `);
  // Task #356 — 回合歷史記錄本回合推進到的階段，以及傳染擴散新增的地區清單。
  // ADD ... IF NOT EXISTS 為 idempotent；永不 DROP（避免 pg_attribute slot 洩漏）。
  await executor.execute(sql`
    ALTER TABLE super_event_turn_logs
      ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'outbreak'
  `);
  await executor.execute(sql`
    ALTER TABLE super_event_turn_logs
      ADD COLUMN IF NOT EXISTS spread_region_ids jsonb NOT NULL DEFAULT '[]'::jsonb
  `);

  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS super_event_responses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL REFERENCES super_events (id) ON DELETE CASCADE,
      nation_id uuid NOT NULL REFERENCES player_nations (id) ON DELETE CASCADE,
      discord_user_id text NOT NULL,
      response_text text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      result_title text,
      result_description text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      judged_at timestamptz
    )
  `);
  await executor.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS super_event_responses_event_nation_uidx
      ON super_event_responses (event_id, nation_id)
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS super_event_responses_event_idx
      ON super_event_responses (event_id)
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS super_event_responses_nation_idx
      ON super_event_responses (nation_id)
  `);

  // Task #356 — 指定國家範圍（scope = targeted）的目標國家清單。FK player_nations。
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS super_event_nations (
      id serial PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES super_events (id) ON DELETE CASCADE,
      nation_id uuid NOT NULL REFERENCES player_nations (id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await executor.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS super_event_nations_event_nation_uidx
      ON super_event_nations (event_id, nation_id)
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS super_event_nations_event_idx
      ON super_event_nations (event_id)
  `);

  // Task #356 — 每回合每國實際套用的數值變動紀錄（供管理員檢視與累計）。
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS super_event_nation_impacts (
      id serial PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES super_events (id) ON DELETE CASCADE,
      nation_id uuid NOT NULL REFERENCES player_nations (id) ON DELETE CASCADE,
      turn_number integer NOT NULL,
      population_delta integer NOT NULL DEFAULT 0,
      production_delta integer NOT NULL DEFAULT 0,
      satisfaction_farmers_delta integer NOT NULL DEFAULT 0,
      satisfaction_workers_delta integer NOT NULL DEFAULT 0,
      satisfaction_nobles_delta integer NOT NULL DEFAULT 0,
      satisfaction_clergy_delta integer NOT NULL DEFAULT 0,
      stability_delta integer NOT NULL DEFAULT 0,
      unrest_delta integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  // Task #401 — 四項滿意度改為四大社會階級：舊 DB 的影響紀錄欄位 RENAME 保值
  // （法律→農民、文化→工人、權利→貴族、宗教→教士）。嚴禁 add-then-drop。
  await executor.execute(sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'super_event_nation_impacts' AND column_name = 'satisfaction_law_delta') THEN
        ALTER TABLE super_event_nation_impacts RENAME COLUMN satisfaction_law_delta TO satisfaction_farmers_delta;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'super_event_nation_impacts' AND column_name = 'satisfaction_culture_delta') THEN
        ALTER TABLE super_event_nation_impacts RENAME COLUMN satisfaction_culture_delta TO satisfaction_workers_delta;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'super_event_nation_impacts' AND column_name = 'satisfaction_rights_delta') THEN
        ALTER TABLE super_event_nation_impacts RENAME COLUMN satisfaction_rights_delta TO satisfaction_nobles_delta;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'super_event_nation_impacts' AND column_name = 'satisfaction_religion_delta') THEN
        ALTER TABLE super_event_nation_impacts RENAME COLUMN satisfaction_religion_delta TO satisfaction_clergy_delta;
      END IF;
    END $$
  `);
  // Task #401 — 既存事件列 target_stats 內的舊鍵名一次性改寫為新階級鍵名
  // （idempotent：改寫後不再命中 WHERE 條件）。
  await executor.execute(sql`
    UPDATE super_events
    SET target_stats = (
      SELECT jsonb_agg(
        CASE elem
          WHEN 'satisfactionLaw' THEN 'satisfactionFarmers'
          WHEN 'satisfactionCulture' THEN 'satisfactionWorkers'
          WHEN 'satisfactionRights' THEN 'satisfactionNobles'
          WHEN 'satisfactionReligion' THEN 'satisfactionClergy'
          ELSE elem
        END
      )
      FROM jsonb_array_elements_text(target_stats) AS elem
    )
    WHERE target_stats IS NOT NULL
      AND jsonb_typeof(target_stats) = 'array'
      AND target_stats ?| ARRAY['satisfactionLaw','satisfactionCulture','satisfactionReligion','satisfactionRights']
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS super_event_nation_impacts_event_idx
      ON super_event_nation_impacts (event_id)
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS super_event_nation_impacts_event_nation_idx
      ON super_event_nation_impacts (event_id, nation_id)
  `);

  // 革命浪潮(2026-10-06):每個受波及地區的革命壓力。壓力以整數 0~100 存放
  // (公式內部用小數,寫入前四捨五入),revolted_at 非 null = 已脫離。
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS super_event_region_pressure (
      id serial PRIMARY KEY,
      event_id uuid NOT NULL REFERENCES super_events (id) ON DELETE CASCADE,
      region_id integer NOT NULL REFERENCES map_regions (id) ON DELETE CASCADE,
      pressure integer NOT NULL DEFAULT 20,
      revolted_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await executor.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS super_event_region_pressure_uidx
      ON super_event_region_pressure (event_id, region_id)
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS super_event_region_pressure_event_idx
      ON super_event_region_pressure (event_id)
  `);

  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS super_event_settings (
      id integer PRIMARY KEY DEFAULT 1,
      auto_generate_chance_pct integer NOT NULL DEFAULT 5,
      global_impact_pct integer NOT NULL DEFAULT 100,
      ai_generation_prompt text NOT NULL DEFAULT '',
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  // 損失上下限（每回合負面影響的最低／最高幅度）。ADD ... IF NOT EXISTS 為
  // idempotent；永不 DROP（避免 pg_attribute slot 洩漏）。預設 0／100＝不設限。
  await executor.execute(sql`
    ALTER TABLE super_event_settings
      ADD COLUMN IF NOT EXISTS loss_min_pct integer NOT NULL DEFAULT 0
  `);
  await executor.execute(sql`
    ALTER TABLE super_event_settings
      ADD COLUMN IF NOT EXISTS loss_max_pct integer NOT NULL DEFAULT 100
  `);
  await executor.execute(sql`
    INSERT INTO super_event_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);

  logger.info("super event migrations applied");
}
