import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withMigrationLockStamped } from "./migrationLock";

/**
 * Task #43 — 內政系統的 idempotent 啟動遷移。
 * 必須在 runDiscordNewsMigrations 之後執行（FK 依賴 player_nations）。
 * 欄位一律一次性 ADD、永不 DROP（避免 pg_attribute slot 洩漏）。
 * 不包 try/catch：失敗必須讓 bootstrap 大聲失敗。
 */
export async function runPoliticsMigrations(): Promise<void> {
  await withMigrationLockStamped("politics", () => runPoliticsMigrationsInner());
}

/** 遷移可指定 executor（如整合測試的單一交易 tx）；預設走全域 db（逐句 autocommit）。 */
type MigrationExecutor = Pick<typeof db, "execute">;

/**
 * 供整合測試在「單一交易」內模擬舊 DB → 跑遷移 → 驗證，避免共用開發庫
 * 對其他連線暴露舊欄位名的中間狀態。正常啟動一律走 runPoliticsMigrations
 * （含 advisory lock）。executor 傳 tx 時不可再套 withMigrationLock
 * （鎖用專屬連線、DDL 用池連線，交易內會互等死鎖）。
 */
export async function runPoliticsMigrationsInner(
  executor: MigrationExecutor = db,
): Promise<void> {
  // 議會表決(2026-10-07):想法被否決時暫存狀態與 AI 判定,等玩家決定。
  await executor.execute(sql`
    ALTER TABLE politics_pending_ideas
      ADD COLUMN IF NOT EXISTS vote_state text,
      ADD COLUMN IF NOT EXISTS vote_payload jsonb
  `);
  // player_nations 新增內政欄位（初始值：穩定度 50、暴動度 0、厭戰度 0、
  // 四項滿意度 60）。
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS stability integer NOT NULL DEFAULT 50
  `);
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS unrest integer NOT NULL DEFAULT 0
  `);
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS war_weariness integer NOT NULL DEFAULT 0
  `);
  // Task #401 — 四項滿意度改為「四大社會階級」滿意度：
  // 法律→農民、文化→工人、權利→貴族(資本家)、宗教→教士。
  // 舊 DB 用 RENAME COLUMN 保留數值；全新 DB 直接以新名稱 ADD。
  // 嚴禁 add-then-drop（pg_attribute slot 洩漏）。
  await executor.execute(sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'player_nations' AND column_name = 'satisfaction_law') THEN
        ALTER TABLE player_nations RENAME COLUMN satisfaction_law TO satisfaction_farmers;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'player_nations' AND column_name = 'satisfaction_culture') THEN
        ALTER TABLE player_nations RENAME COLUMN satisfaction_culture TO satisfaction_workers;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'player_nations' AND column_name = 'satisfaction_rights') THEN
        ALTER TABLE player_nations RENAME COLUMN satisfaction_rights TO satisfaction_nobles;
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'player_nations' AND column_name = 'satisfaction_religion') THEN
        ALTER TABLE player_nations RENAME COLUMN satisfaction_religion TO satisfaction_clergy;
      END IF;
    END $$
  `);
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS satisfaction_farmers integer NOT NULL DEFAULT 60
  `);
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS satisfaction_workers integer NOT NULL DEFAULT 60
  `);
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS satisfaction_nobles integer NOT NULL DEFAULT 60
  `);
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS satisfaction_clergy integer NOT NULL DEFAULT 60
  `);
  // Task #402 — 第五面向「軍方」：軍方滿意度（基底值）＋軍方服從度
  // （0–100，預設 60；服從度決定新建軍團初始士氣）。
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS satisfaction_military integer NOT NULL DEFAULT 60
  `);
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS military_obedience integer NOT NULL DEFAULT 60
  `);
  // Task #584 — 政變後果倒數欄位（封鎖回合數／士氣懲罰回合數；每回合 −1 夾 ≥0）。
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS coup_policy_lock_turns integer NOT NULL DEFAULT 0
  `);
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS coup_morale_penalty_turns integer NOT NULL DEFAULT 0
  `);
  // Task #401 — 農民佔總人口百分比（0–100，預設 100；工人 = 100 − 農民）。
  // 純顯示用途，不影響玩法計算。
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS farmer_population_pct integer NOT NULL DEFAULT 100
        CHECK (farmer_population_pct >= 0 AND farmer_population_pct <= 100)
  `);
  // Task #322 — 人口成長累積量已從 player_nations 移到 region_controls
  // （per-region population_bonus）。此處不再新增 nation 層級欄位；
  // runRegionControlMigrations 會 backfill 後 DROP 舊的 player_nations 欄位。
  // Task #127 — 政府治理系統欄位（政治支持度、政體變更接受度、政治註記）。
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS political_support integer NOT NULL DEFAULT 50
  `);
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS government_change_acceptance integer NOT NULL DEFAULT 0
  `);
  await executor.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS political_note text
  `);

  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS politics_entries (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      direction text NOT NULL,
      entry_type text NOT NULL,
      title text NOT NULL,
      description text NOT NULL,
      modifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
      duration_turns integer,
      remaining_turns integer,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS politics_entries_nation_direction_idx
      ON politics_entries (nation_id, direction)
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS politics_entries_nation_status_idx
      ON politics_entries (nation_id, status)
  `);

  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS politics_pending_ideas (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      direction text NOT NULL,
      idea text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  // Task #393 — 政策想法不分方向、全國一筆待判定：
  // 1. direction 預設 'general'（新制綜合政策；舊制列保留原方向值）。
  // 2. 每國多筆待判定想法收斂成最新一筆（created_at 最大者，平手取 id 最大）。
  // 3. 唯一索引改為「部分索引：僅 direction='general' 列」。
  //    ※ 不能用全欄 (nation_id) 唯一索引——正式 DB 仍有舊制多方向遺留列，
  //      Publish 的 schema diff 會在去重之前就對正式 DB 建索引而失敗
  //      （could not create unique index）。部分索引在正式 DB 可直接建立
  //      （正式列全為舊制方向）。「全國一筆」語意由插入路由前置檢查補足。
  //    ※ 舊索引的 CREATE 原址已刪除（避免 partial run 復活舊 DDL）。
  await executor.execute(sql`
    ALTER TABLE politics_pending_ideas
      ALTER COLUMN direction SET DEFAULT 'general'
  `);
  await executor.execute(sql`
    DELETE FROM politics_pending_ideas a
    USING politics_pending_ideas b
    WHERE a.nation_id = b.nation_id
      AND (a.created_at < b.created_at
        OR (a.created_at = b.created_at AND a.id < b.id))
  `);
  await executor.execute(sql`
    DROP INDEX IF EXISTS politics_pending_ideas_nation_direction_uidx
  `);
  await executor.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS politics_pending_ideas_nation_general_uidx
      ON politics_pending_ideas (nation_id)
      WHERE direction = 'general'
  `);
  await executor.execute(sql`
    DROP INDEX IF EXISTS politics_pending_ideas_nation_uidx
  `);

  // Task #127 — 待判定政府決策（每國一筆）。
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS politics_pending_decisions (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      decision text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await executor.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS politics_pending_decisions_nation_uidx
      ON politics_pending_decisions (nation_id)
  `);

  // Task #127 — 政治歷史（時間軸）。
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS politics_history (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      event_type text NOT NULL,
      title text NOT NULL,
      description text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await executor.execute(sql`
    CREATE INDEX IF NOT EXISTS politics_history_nation_created_idx
      ON politics_history (nation_id, created_at)
  `);

  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS politics_settings (
      id integer PRIMARY KEY DEFAULT 1,
      params jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await executor.execute(sql`
    INSERT INTO politics_settings (id, params)
    VALUES (1, '{}'::jsonb)
    ON CONFLICT (id) DO NOTHING
  `);

  logger.info("politics migrations applied");
}
