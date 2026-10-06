import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withMigrationLockStamped } from "./migrationLock";
import { DEFAULT_ERA_SLUG } from "./mapRegionEras";
import { distributePopulationDelta } from "./regionPopulation";

/**
 * Guarded, idempotent startup migrations for the game (架空世界模擬器). Run
 * first in bootstrap so the core game tables (player_nations, region_controls,
 * appearance/music/notifications) exist before military/diplomacy/war/etc.
 *
 * Every statement is guarded (`IF NOT EXISTS` / `IF EXISTS`) so re-running is a
 * no-op. Never `ADD` a column that is `DROP`ped in the same migration (that
 * leaks a `pg_attribute` slot every boot). Intentionally NOT wrapped in
 * try/catch: failure must surface to bootstrap so it fails loudly.
 *
 * The legacy news / 微國家資訊 system was removed; this module also drops those
 * tables once (FK-ordered, children first, CASCADE) at the end.
 */
export async function runGameMigrations(): Promise<void> {
  await withMigrationLockStamped("game", runGameMigrationsInner);
}

async function runGameMigrationsInner(): Promise<void> {
  // --- Bot settings (stores the Discord bot token) ----------------------
  // Trimmed to the single field the game still needs (the bot token). On a
  // fresh DB this creates the canonical shape; on existing DBs the extra
  // news-publishing columns are reclaimed by the rebuild block + dropped
  // below.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS bot_settings (
      id integer PRIMARY KEY DEFAULT 1,
      token text,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  // Self-heal: earlier revisions repeatedly ADDed then DROPped
  // auto-publish columns on every boot. Because Postgres never reclaims a
  // dropped column's slot until the table is physically rewritten, this
  // leaked `pg_attribute` entries toward the hard 1600-column limit. Rebuild
  // the table once (to the trimmed shape) to reclaim the dead slots. Guarded
  // by the dropped-column count so it runs at most once; the DO block is
  // atomic and to_regclass-guarded so it's safe on a fresh DB.
  await db.execute(sql`
    DO $$
    DECLARE
      dropped_count int;
    BEGIN
      IF to_regclass('bot_settings') IS NULL THEN
        RETURN;
      END IF;
      SELECT count(*) INTO dropped_count
      FROM pg_attribute
      WHERE attrelid = 'bot_settings'::regclass AND attisdropped;

      IF dropped_count > 50 THEN
        ALTER TABLE bot_settings RENAME TO bot_settings_bloated;

        CREATE TABLE bot_settings (
          id integer PRIMARY KEY DEFAULT 1,
          token text,
          updated_at timestamptz NOT NULL DEFAULT NOW()
        );

        INSERT INTO bot_settings (id, token, updated_at)
        SELECT id, token, updated_at FROM bot_settings_bloated;

        DROP TABLE bot_settings_bloated;
      END IF;
    END$$;
  `);

  // One-way cleanup of the removed news-publishing columns on existing DBs
  // that weren't bloated enough to trigger the rebuild above. These columns
  // are never re-added, so re-running is a no-op (no ADD-then-DROP churn).
  await db.execute(sql`ALTER TABLE bot_settings DROP COLUMN IF EXISTS auto_publish_enabled`);
  await db.execute(sql`ALTER TABLE bot_settings DROP COLUMN IF EXISTS auto_publish_min_sources`);
  await db.execute(sql`ALTER TABLE bot_settings DROP COLUMN IF EXISTS auto_publish_max_per_run`);
  await db.execute(sql`ALTER TABLE bot_settings DROP COLUMN IF EXISTS auto_publish_max_age_hours`);
  await db.execute(sql`ALTER TABLE bot_settings DROP COLUMN IF EXISTS global_pause_enabled`);
  await db.execute(sql`ALTER TABLE bot_settings DROP COLUMN IF EXISTS enforce_freshness`);
  await db.execute(sql`ALTER TABLE bot_settings DROP COLUMN IF EXISTS server_publish_cooldown_seconds`);
  await db.execute(sql`ALTER TABLE bot_settings DROP COLUMN IF EXISTS welcome_dm_body`);

  // Task: 後台可切換 AI 模型（NIM 上游模型眾多，換模型不應該要求重新部署／
  // 重啟服務）。NULL = 沿用環境變數 AI_MODEL_QUALITY／AI_MODEL_BULK 的預設值。
  await db.execute(sql`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_model_quality text`);
  await db.execute(sql`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_model_bulk text`);

  // AI 備援（fallback）供應商：主供應商（NIM）單次呼叫失敗時自動改用
  // （預設 Gemini OpenAI 相容端點）。key／模型後台可調（/api/bot/ai-fallback）。
  await db.execute(sql`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_fallback_base_url text`);
  await db.execute(sql`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_fallback_api_key text`);
  await db.execute(sql`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_fallback_model_quality text`);
  await db.execute(sql`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_fallback_model_bulk text`);
  await db.execute(sql`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS ai_route_pool text`);
  await db.execute(sql`ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS support_channel_id text`);

  // --- Discord OAuth login sessions -------------------------------------
  // Opaque, server-issued session tokens for the game's Discord login. The
  // `manageable_guild_ids` snapshot is retained (harmless) though the game no
  // longer reads it. (Folded here from the removed task100 migration.)
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_sessions (
      token text PRIMARY KEY,
      discord_user_id text NOT NULL,
      username text NOT NULL,
      global_name text,
      avatar text,
      manageable_guild_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      expires_at timestamptz NOT NULL
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS user_sessions_expires_idx
      ON user_sessions (expires_at)
  `);

  // Task #15: per-player nations (game home page) + global appearance defaults.
  // Task #24: population/production/tech-per-turn are computed from
  // region_controls × map_region_era_stats, so fresh tables no longer carry
  // those columns and tech_points defaults to 0.
  // Task #30: nations decoupled from players — uuid PK `id`, nullable UNIQUE
  // owner `discord_user_id` (null = 無主國家), new `leader_name`.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS player_nations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      discord_user_id text UNIQUE,
      name text,
      leader_name text,
      flag_url text,
      emblem_url text,
      government text,
      tech_points integer NOT NULL DEFAULT 0,
      money bigint NOT NULL DEFAULT 10000,
      kanban_url text,
      background_url text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  // Task #24: one-way drops of the static placeholder stats on existing DBs.
  // These columns are never re-added above, so re-running is a no-op (no
  // ADD-then-DROP churn that would leak pg_attribute slots).
  await db.execute(sql`ALTER TABLE player_nations DROP COLUMN IF EXISTS tech_per_turn`);
  await db.execute(sql`ALTER TABLE player_nations DROP COLUMN IF EXISTS production`);
  await db.execute(sql`ALTER TABLE player_nations DROP COLUMN IF EXISTS population`);
  await db.execute(sql`
    ALTER TABLE player_nations ALTER COLUMN tech_points SET DEFAULT 0
  `);
  // Task #30 one-time PK swap on existing DBs: add `id` uuid, move the PK
  // from discord_user_id to id, keep discord_user_id as a nullable UNIQUE
  // owner column, and re-point the military FKs at that unique constraint.
  // Columns are only ADDed here (never dropped), so no pg_attribute churn.
  await db.execute(sql`ALTER TABLE player_nations ADD COLUMN IF NOT EXISTS leader_name text`);
  // Task #47 起 — Discord 私訊通知開關（預設開啟）。原本是單一
  // dm_notifications_enabled，現拆成外交／內政兩個獨立開關。兩個新欄位只 ADD、
  // 不再 DROP，避免 pg_attribute slot 洩漏。舊欄位存在時把值一次沿用到兩個新
  // 欄位再做「一次性」DROP（guarded，之後每次啟動都是 no-op）。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS dm_diplomacy_enabled boolean NOT NULL DEFAULT true
  `);
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS dm_politics_enabled boolean NOT NULL DEFAULT true
  `);
  // Task #303 — 看板顧問：自訂說話風格 + 已產生的隨機小tips。兩個新欄位只
  // ADD、不再 DROP（避免 pg_attribute slot 洩漏）。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS advisor_style text
  `);
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS advisor_tips jsonb NOT NULL DEFAULT '[]'::jsonb
  `);
  // 玩家自訂地圖顏色（#rrggbb）。只 ADD、不 DROP（避免 pg_attribute slot 洩漏）。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS map_color text
  `);
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'player_nations'
          AND column_name = 'dm_notifications_enabled'
      ) THEN
        UPDATE player_nations
          SET dm_diplomacy_enabled = dm_notifications_enabled,
              dm_politics_enabled = dm_notifications_enabled;
        ALTER TABLE player_nations DROP COLUMN dm_notifications_enabled;
      END IF;
    END $$;
  `);
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid()
  `);
  await db.execute(sql`
    DO $$
    DECLARE
      fk record;
    BEGIN
      -- Only when the PK is still on discord_user_id (pre-Task #30 shape).
      IF EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE c.conrelid = 'player_nations'::regclass
          AND c.contype = 'p'
          AND a.attname = 'discord_user_id'
      ) THEN
        -- Drop every FK that references player_nations (they depend on the
        -- old PK); the military ones are re-added below against the new
        -- UNIQUE constraint. region_controls is re-keyed to nation_id in
        -- runRegionControlMigrations, so its old FK is not re-added.
        FOR fk IN
          SELECT conname, conrelid::regclass AS tbl
          FROM pg_constraint
          WHERE confrelid = 'player_nations'::regclass AND contype = 'f'
        LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
        END LOOP;

        ALTER TABLE player_nations
          DROP CONSTRAINT IF EXISTS player_nations_pkey;
        ALTER TABLE player_nations ADD PRIMARY KEY (id);
        ALTER TABLE player_nations
          ADD CONSTRAINT player_nations_discord_user_id_key UNIQUE (discord_user_id);
        ALTER TABLE player_nations ALTER COLUMN discord_user_id DROP NOT NULL;

        -- Re-add military FKs (tables may not exist yet on fresh DBs — they
        -- are created later in runMilitaryMigrations with inline REFERENCES).
        IF to_regclass('military_unit_templates') IS NOT NULL THEN
          ALTER TABLE military_unit_templates
            ADD CONSTRAINT military_unit_templates_owner_discord_user_id_fkey
            FOREIGN KEY (owner_discord_user_id)
            REFERENCES player_nations(discord_user_id) ON DELETE CASCADE;
        END IF;
        IF to_regclass('player_armies') IS NOT NULL THEN
          ALTER TABLE player_armies
            ADD CONSTRAINT player_armies_discord_user_id_fkey
            FOREIGN KEY (discord_user_id)
            REFERENCES player_nations(discord_user_id) ON DELETE CASCADE;
        END IF;
        IF to_regclass('player_researched_techs') IS NOT NULL THEN
          ALTER TABLE player_researched_techs
            ADD CONSTRAINT player_researched_techs_discord_user_id_fkey
            FOREIGN KEY (discord_user_id)
            REFERENCES player_nations(discord_user_id) ON DELETE CASCADE;
        END IF;
        IF to_regclass('military_purchase_quotas') IS NOT NULL THEN
          ALTER TABLE military_purchase_quotas
            ADD CONSTRAINT military_purchase_quotas_discord_user_id_fkey
            FOREIGN KEY (discord_user_id)
            REFERENCES player_nations(discord_user_id) ON DELETE CASCADE;
        END IF;
      END IF;
    END
    $$
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_appearance_defaults (
      id integer PRIMARY KEY DEFAULT 1,
      kanban_url text,
      background_url text,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    INSERT INTO game_appearance_defaults (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    ALTER TABLE game_appearance_defaults
    ADD COLUMN IF NOT EXISTS era_backgrounds jsonb NOT NULL DEFAULT '{}'
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_images (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      content_type text NOT NULL,
      byte_size integer NOT NULL,
      bytes bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  // Task #73: game-home background-music tracks (admin-uploaded, DB-stored
  // audio — same pattern as game_images because object storage is broken).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_music_tracks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      title text NOT NULL,
      content_type text NOT NULL,
      byte_size integer NOT NULL,
      bytes bytea NOT NULL,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS game_music_tracks_sort_idx
      ON game_music_tracks (sort_order, created_at)
  `);

  // Task #79 — 站內通知（遊戲首頁鈴鐺通知中心）。Keyed by discord_user_id
  // (NOT nation id, and intentionally no FK): notifications survive quitting
  // a nation. Retention (newest 100 per player) is enforced at write time in
  // lib/playerNotify.ts, not by the schema.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS player_notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      discord_user_id text NOT NULL,
      type text NOT NULL,
      title text NOT NULL,
      body text NOT NULL,
      link_path text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      read_at timestamptz
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS player_notifications_user_read_idx
      ON player_notifications (discord_user_id, read_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS player_notifications_user_created_idx
      ON player_notifications (discord_user_id, created_at)
  `);

  // --- Remove the legacy news / 微國家資訊 system (one-way) ---------------
  // FK-ordered, children first, CASCADE clears any remaining dependents. All
  // guarded IF EXISTS so this is a no-op on a fresh DB and on re-runs.
  await db.execute(sql`DROP TABLE IF EXISTS announcement_attachments CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS announcement_people CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS info_collection_attachments CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS news_report_comments CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS news_report_likes CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS discord_news_deliveries CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS discord_news_subscriptions CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS daily_summaries CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS news_suggestions CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS announcements CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS news_reports CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS discord_guild_consent CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS guild_channel_overrides CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS edit_audit_log CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS micronations CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS countries CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS people CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS world_knowledge_entries CASCADE`);
  await db.execute(sql`DROP TABLE IF EXISTS info_collection CASCADE`);

  logger.info("game migrations applied");
}

/**
 * Task #24 — 地區掌控表。Kept separate from runGameMigrations because
 * region_controls references map_regions, which is only guaranteed to exist
 * after runMapRegionSync(); the bootstrap calls this afterwards. Idempotent.
 */
export async function runRegionControlMigrations(): Promise<void> {
  await withMigrationLockStamped("region-control", runRegionControlMigrationsInner);
}

async function runRegionControlMigrationsInner(): Promise<void> {
  // Task #30 shape: keyed by nation uuid (not player id).
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS region_controls (
      id serial PRIMARY KEY,
      region_id integer NOT NULL
        REFERENCES map_regions(id) ON DELETE CASCADE,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      percent integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT region_controls_percent_check
        CHECK (percent >= 1 AND percent <= 100)
    )
  `);
  // Task #30 one-time re-key on existing DBs (old shape keyed by
  // discord_user_id): add nation_id, backfill from player_nations, then drop
  // the old column. Runs only while discord_user_id still exists, so the
  // ADD + DROP pair touches DIFFERENT columns exactly once (no per-boot
  // ADD-then-DROP churn). The old indexes are dropped with the column; the
  // new ones are (re)created below.
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'region_controls'
          AND column_name = 'discord_user_id'
      ) THEN
        ALTER TABLE region_controls ADD COLUMN IF NOT EXISTS nation_id uuid;
        UPDATE region_controls rc
          SET nation_id = pn.id
          FROM player_nations pn
          WHERE pn.discord_user_id = rc.discord_user_id
            AND rc.nation_id IS NULL;
        -- Orphans should be impossible (old FK), but never leave NULLs.
        DELETE FROM region_controls WHERE nation_id IS NULL;
        ALTER TABLE region_controls ALTER COLUMN nation_id SET NOT NULL;
        ALTER TABLE region_controls
          ADD CONSTRAINT region_controls_nation_id_fkey
          FOREIGN KEY (nation_id)
          REFERENCES player_nations(id) ON DELETE CASCADE;
        DROP INDEX IF EXISTS region_controls_region_nation_uidx;
        DROP INDEX IF EXISTS region_controls_nation_idx;
        ALTER TABLE region_controls DROP COLUMN discord_user_id;
      END IF;
    END
    $$
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS region_controls_region_nation_uidx
      ON region_controls (region_id, nation_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS region_controls_nation_idx
      ON region_controls (nation_id)
  `);

  // Task #322 — 人口成長累積量從 nation 層級（player_nations.population_bonus）
  // 移到 per-region（region_controls.population_bonus，帶號 bigint）。
  // 永久欄位：region_controls.population_bonus。
  await db.execute(sql`
    ALTER TABLE region_controls
      ADD COLUMN IF NOT EXISTS population_bonus bigint NOT NULL DEFAULT 0
  `);
  // 一次性搬遷：僅在舊的 player_nations.population_bonus 仍存在時執行，把每個
  // 國家的絕對累積量依「地區人口權重」（percent × 數據時代地區人口；largest-
  // remainder 守恆、每地區下限 0）分配到各掌控地區，然後 DROP 舊欄位。ADD 與
  // DROP 觸及不同表/欄位且各僅一次，無每次開機的 ADD-then-DROP churn。
  const hasOldBonus = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'player_nations' AND column_name = 'population_bonus'
  `);
  if (hasOldBonus.rows.length > 0) {
    await backfillRegionPopulationBonus();
    await db.execute(sql`ALTER TABLE player_nations DROP COLUMN population_bonus`);
    logger.info("population_bonus migrated to region_controls (Task #322)");
  }

  // Task #392 — 領土變更歷史表：所有 region_controls 掌控 % 寫入路徑於同一
  // 交易內追加紀錄。FK-ordered：map_regions（runMapRegionSync）與
  // player_nations（runGameMigrations）此時皆已存在。國家硬刪 → cascade。
  // war_id / treaty_id 為關聯脈絡，刻意不設 FK（歷史不隨戰爭／條約列刪除）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS territory_change_history (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      region_id integer NOT NULL
        REFERENCES map_regions(id) ON DELETE CASCADE,
      percent_before integer NOT NULL,
      percent_after integer NOT NULL,
      change_type text NOT NULL,
      reason text NOT NULL,
      war_id integer,
      treaty_id integer,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS territory_change_history_nation_created_idx
      ON territory_change_history (nation_id, created_at)
  `);

  logger.info("region control migrations applied");
}

/**
 * Task #322 — 把舊 nation 層級 player_nations.population_bonus 依地區人口權重
 * 分配到 region_controls.population_bonus（僅在搬遷當次呼叫）。
 * 權重 = percent × 數據時代地區人口；缺該時代 era-stats 時退回以 percent 為權重。
 * 無掌控地區的國家其累積量無處歸屬，隨舊欄位一併丟棄。
 */
async function backfillRegionPopulationBonus(): Promise<void> {
  const stateRes = await db.execute(sql`
    SELECT COALESCE(stats_era, current_era) AS era
    FROM world_game_state WHERE id = 1 LIMIT 1
  `);
  const statsEra =
    (stateRes.rows[0] as { era?: string } | undefined)?.era ?? DEFAULT_ERA_SLUG;

  const nationsRes = await db.execute(sql`
    SELECT id, population_bonus FROM player_nations WHERE population_bonus <> 0
  `);
  for (const row of nationsRes.rows) {
    const nationId = String((row as { id: string }).id);
    const bonus = Number((row as { population_bonus: string }).population_bonus);
    if (!bonus) continue;

    const controlsRes = await db.execute(sql`
      SELECT rc.id AS id, rc.percent AS percent,
             COALESCE(mes.population, 0) AS era_pop
      FROM region_controls rc
      LEFT JOIN map_region_era_stats mes
        ON mes.region_id = rc.region_id AND mes.era = ${statsEra}
      WHERE rc.nation_id = ${nationId}
    `);
    const controls = controlsRes.rows as {
      id: number;
      percent: number;
      era_pop: string | number;
    }[];
    if (controls.length === 0) continue;

    let weights = controls.map((c) =>
      Math.max(0, Math.round((Number(c.percent) * Number(c.era_pop)) / 100)),
    );
    if (weights.reduce((a, b) => a + b, 0) === 0) {
      weights = controls.map((c) => Math.max(1, Number(c.percent)));
    }
    const deltas = distributePopulationDelta(weights, bonus);
    for (let i = 0; i < controls.length; i++) {
      const d = deltas[i] ?? 0;
      if (d === 0) continue;
      await db.execute(sql`
        UPDATE region_controls
          SET population_bonus = population_bonus + ${d}
          WHERE id = ${controls[i]!.id}
      `);
    }
  }
}
