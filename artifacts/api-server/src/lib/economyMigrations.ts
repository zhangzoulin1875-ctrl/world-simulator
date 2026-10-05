import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #117 — 經濟系統的 idempotent 啟動遷移。
 * 必須在 runPoliticsMigrations／runWarMigrations 之後執行（FK 依賴
 * player_nations）。欄位一律一次性 ADD、永不 DROP（避免 pg_attribute slot
 * 洩漏）。不包 try/catch：失敗必須讓 bootstrap 大聲失敗。
 */
export async function runEconomyMigrations(): Promise<void> {
  await withTestMigrationStamp("economy", runEconomyMigrationsInner);
}

async function runEconomyMigrationsInner(): Promise<void> {
  // ── player_nations 新增經濟欄位 ──
  // 稅率（%）：新國預設 3(既有國家不動),只能透過 AI 財政政策調整。CHECK 0–100。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS tax_rate_pct integer NOT NULL DEFAULT 3
        CHECK (tax_rate_pct >= 0 AND tax_rate_pct <= 100)
  `);
  // 2026-10-05:新建國家預設稅率 1 → 3。ADD COLUMN IF NOT EXISTS 在欄位已存在的庫是空操作,
  // 不會改既有欄位的 DEFAULT,所以明確 SET DEFAULT(只影響之後新建的國家,既有國家稅率不動)。
  await db.execute(sql`
    ALTER TABLE player_nations ALTER COLUMN tax_rate_pct SET DEFAULT 3
  `);
  // Task #401 — 四項預算分配（budget_*_pct）整組移除（一次性 DROP，永不再加回）。
  // 原 ADD 於此處建立，依「在原建立處覆蓋 DDL」原則改為 DROP IF EXISTS。
  await db.execute(sql`
    ALTER TABLE player_nations
      DROP COLUMN IF EXISTS budget_law_pct,
      DROP COLUMN IF EXISTS budget_culture_pct,
      DROP COLUMN IF EXISTS budget_religion_pct,
      DROP COLUMN IF EXISTS budget_rights_pct
  `);
  // 稅收效率額外加成（%）：未來經濟科技用，基礎 0。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS tax_efficiency_bonus integer NOT NULL DEFAULT 0
  `);

  // ── 財政政策待判定想法（一國一則） ──
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS finance_pending_ideas (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      idea text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS finance_pending_ideas_nation_uidx
      ON finance_pending_ideas (nation_id)
  `);

  // ── 財政政策判定歷史（好／壞事件；純顯示） ──
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS finance_entries (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      title text NOT NULL,
      description text NOT NULL,
      is_good boolean NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS finance_entries_nation_created_idx
      ON finance_entries (nation_id, created_at)
  `);

  // ── 外交／事件金錢收支流水（純顯示；金錢在來源處已即時變動） ──
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS nation_finance_ledger (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      category text NOT NULL,
      amount bigint NOT NULL,
      description text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS nation_finance_ledger_nation_created_idx
      ON nation_finance_ledger (nation_id, created_at)
  `);

  // ── 地區生產力投資（Task #405） ──
  // 全地區共享、跨時代固定的生產素質加成累積量；玩家花錢投資 +1/次。
  // 絕不寫 map_region_era_stats（確定性種子資料，鐵則）。
  await db.execute(sql`
    ALTER TABLE map_regions
      ADD COLUMN IF NOT EXISTS productivity_investment_bonus integer NOT NULL DEFAULT 0
        CHECK (productivity_investment_bonus >= 0)
  `);

  // ── 糧食政策開關（Task #382） ──
  // 兩項可開關的臨時政策：增產動員（產出 +10%）、節約配給（平民消耗 −10%）。
  // 啟用期間每回合扣滿意度；糧食本身非累積、per-request 計算，不存結餘。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS food_policy_mobilization boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS food_policy_rationing boolean NOT NULL DEFAULT false
  `);

  // ── 連續饑荒回合數（Task #443） ──
  // 饑荒回合 +1、非饑荒回合歸零；用於饑荒損失遞減緩衝與連續饑荒告警。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS consecutive_famine_turns integer NOT NULL DEFAULT 0
  `);

  // ── 財政政策獨立排程（Task #645） ──
  // 下次財政結算的到期時間：null = 從未執行，視為立即到期。
  // 原子條件式 UPDATE 認領，多實例不重跑；每次執行後前進 4 小時。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS finance_next_run_at timestamptz
  `);

  logger.info("economy migrations applied");
}

/**
 * Task #479 — 一次性修復：歸零負值 production_bonus。
 *
 * 舊回合引擎把軍隊生產力維護費持久化扣進 production_bonus（無回復機制，
 * 形成死亡螺旋）；改為流量扣除後，把歷史欠債（負值）一次性歸零。
 * 正值（自訂條約轉移／超事件累積）保留不動。
 * 以 game_flags 原子認領旗標保證只跑一次（重啟不重複、不覆蓋修復後
 * 玩家再次獲得的正/負變動）。此函式可能早於其他建立 game_flags 的遷移
 * 順序調整而執行，自建表保證自足（含測試單獨呼叫）。
 */
export async function repairNegativeProductionBonus(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_flags (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      INSERT INTO game_flags (key) VALUES ('prod-upkeep-debt-zeroed-479')
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `);
    if (claimed.rows.length === 0) return;
    const repaired = await tx.execute(sql`
      UPDATE player_nations SET production_bonus = 0
      WHERE production_bonus < 0
    `);
    logger.info(
      { repairedCount: repaired.rowCount ?? 0 },
      "negative production_bonus zeroed (Task #479 one-time repair)",
    );
  });
}

/**
 * 一次性修復：歸零「條約生產力輸送」時代的 production_bonus 歷史累積。
 *
 * 舊制自訂條約每回合把生產力累積扣進 production_bonus（付款方 −N、受益方
 * +N），廢約後偏移量永久殘留。改為純流量（treatyProductionFlows.ts）後，
 * 歷史累積無法精確重建（無結算流水、force-run 次數未知），故把「曾參與
 * 任何含生產力項自訂條約（任何 status）」的國家 production_bonus 一次性
 * 歸零；代價是這些國家過往超事件的生產力 delta 一併消失（無法區分來源，
 * 已接受的取捨）。其餘國家（只有超事件/管理員偏移）不動。
 * 以 game_flags 原子認領保證只跑一次（重啟不重複、不覆蓋修復後玩家再次
 * 獲得的超事件偏移）。自建 game_flags 表保證自足（含測試單獨呼叫）。
 * 需在 diplomacy（diplomacy_treaties 條約欄位）與 economy 遷移之後執行。
 */
export async function repairTreatyProductionBonusAccrual(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_flags (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      INSERT INTO game_flags (key) VALUES ('treaty-production-flow-zeroed')
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `);
    if (claimed.rows.length === 0) return;
    const repaired = await tx.execute(sql`
      UPDATE player_nations SET production_bonus = 0
      WHERE production_bonus <> 0
        AND id IN (
          SELECT proposer_nation_id FROM diplomacy_treaties
           WHERE type = 'custom'
             AND (per_turn_production > 0 OR request_per_turn_production > 0)
          UNION
          SELECT target_nation_id FROM diplomacy_treaties
           WHERE type = 'custom'
             AND (per_turn_production > 0 OR request_per_turn_production > 0)
        )
    `);
    logger.info(
      { repairedCount: repaired.rowCount ?? 0 },
      "treaty-accrued production_bonus zeroed (flow-based treaty production one-time repair)",
    );
  });
}
