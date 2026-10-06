import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #176 — AI 驅動 NPC 系統的 idempotent 啟動遷移。
 *
 * 需在 player_nations／world_game_state 存在後執行（gameMigrations 之後即可，
 * 於 bootstrap 最後執行）。欄位一律一次性 ADD、永不 DROP（避免 pg_attribute
 * slot 洩漏）。不包 try/catch：失敗必須讓 bootstrap 大聲失敗。
 */
export async function runWorldSimMigrations(): Promise<void> {
  await withTestMigrationStamp("world-sim", runWorldSimMigrationsInner);
}

async function runWorldSimMigrationsInner(): Promise<void> {
  // ── player_nations：NPC 每領域科技時代指標（null = 沿用 current_era） ──
  // 純由應用層以 ERAS slug 驗證，故不加 CHECK。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS tech_era_military text
  `);
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS tech_era_social text
  `);
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS tech_era_production text
  `);

  // ── Task #233 — NPC／無主國家的「外交態度」（管理員註記或 AI 生成） ──
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS diplomatic_attitude text
  `);

  // ── world_game_state：自動世界模擬設定 ──
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS world_sim_enabled boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS world_sim_intensity integer NOT NULL DEFAULT 1
        CHECK (world_sim_intensity >= 1 AND world_sim_intensity <= 3)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS world_sim_hostile_to_players boolean NOT NULL DEFAULT false
  `);

  // ── Task #228 — 排程欄位（NPC 自動演變獨立迴圈 + AI 外交/戰役判定迴圈） ──
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS world_sim_frequency_minutes integer NOT NULL DEFAULT 1440
        CHECK (world_sim_frequency_minutes >= 1)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS world_sim_last_run_at timestamptz
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS world_sim_next_run_at timestamptz
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS ai_judgment_enabled boolean NOT NULL DEFAULT true
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS ai_judgment_frequency_minutes integer NOT NULL DEFAULT 240
        CHECK (ai_judgment_frequency_minutes >= 1)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS ai_judgment_last_run_at timestamptz
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS ai_judgment_next_run_at timestamptz
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS war_cycle_hours integer NOT NULL DEFAULT 4
        CHECK (war_cycle_hours >= 1)
  `);

  // ── 結算靜默時段（當地時間 NEWS_SCHEDULE_TZ 整點小時 0–23）：此時段內不進行
  // AI 外交／戰役判定（結算）；落在時段內的到期時間延到時段結束才結算。
  // start === end = 停用；start < end = 當日 [start,end)；start > end = 跨午夜。
  // 預設 0–8（凌晨 00:00–08:00 不結算）。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS settlement_blackout_start_hour integer NOT NULL DEFAULT 0
        CHECK (settlement_blackout_start_hour >= 0 AND settlement_blackout_start_hour <= 23)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS settlement_blackout_end_hour integer NOT NULL DEFAULT 8
        CHECK (settlement_blackout_end_hour >= 0 AND settlement_blackout_end_hour <= 23)
  `);

  // ── Task #233 — AI 外交/戰役判定的管理員干預指令（自然語言方針，可為空） ──
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS ai_judgment_directive text
  `);

  // ── NPC 對話行動等級（1 保守／2 中等／3 積極；預設 3） ──
  // 控制 NPC 在玩家↔NPC 外交對話中可主動執行的行動積極度與數量上限。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS npc_chat_action_level integer NOT NULL DEFAULT 3
        CHECK (npc_chat_action_level >= 1 AND npc_chat_action_level <= 3)
  `);

  // ── 人口增長倍率（0–100；預設 100 = 現行速度、0 = 停止增長） ──
  // 每回合以此倍率縮放算出的人口增長量；回合實際套用與玩家顯示皆一致。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS population_growth_multiplier_pct integer NOT NULL DEFAULT 100
        CHECK (population_growth_multiplier_pct >= 0 AND population_growth_multiplier_pct <= 100)
  `);

  // ── 全局開銷旋鈕(線性 10–500、函數 0–200;預設 100 = 現狀)──
  // 管理員在後台隨時調整、即時生效,不必改程式碼重新部署。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS cost_linear_pct integer NOT NULL DEFAULT 100
        CHECK (cost_linear_pct >= 10 AND cost_linear_pct <= 500)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS cost_curve_pct integer NOT NULL DEFAULT 100
        CHECK (cost_curve_pct >= 0 AND cost_curve_pct <= 200)
  `);

  // ── 生產力／科技點數基礎倍率（0–1000；預設 100 = 不縮放）──
  // 以百分比套在各國「調整後生產力／每回合科技產出」的最外層（所有內政
  // 乘數/加成計完後），管理員於回合設定頁調整（延長回合間隔時可等比提高）。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS production_multiplier_pct integer NOT NULL DEFAULT 100
        CHECK (production_multiplier_pct >= 0 AND production_multiplier_pct <= 1000)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS tech_multiplier_pct integer NOT NULL DEFAULT 100
        CHECK (tech_multiplier_pct >= 0 AND tech_multiplier_pct <= 1000)
  `);

  // ── 領先時代研發成本倍率（≥1；預設 5）──玩家某科技領域時代領先世界目前
  // 時代（current_era）時，該領域研發成本乘上此倍率（管理員可於回合設定頁調整）。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS ahead_era_cost_multiplier integer NOT NULL DEFAULT 5
        CHECK (ahead_era_cost_multiplier >= 1)
  `);

  // ── Task #412 — 全域戰爭參數：戰鬥激烈度倍率（%）與領土奪取基礎值（百分點）──
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS war_intensity_pct integer NOT NULL DEFAULT 100
        CHECK (war_intensity_pct >= 10 AND war_intensity_pct <= 500)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS territory_capture_base_pct integer NOT NULL DEFAULT 15
        CHECK (territory_capture_base_pct >= 1 AND territory_capture_base_pct <= 30)
  `);

  // ── Task #570 — NPC 締約可提供資源的上限（只約束 NPC 付出側）──
  // 一次性庫存 %／地區數／單區讓渡 %／每回合輸送 %；管理員於 /world-sim 調整。
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS npc_treaty_stock_cap_pct integer NOT NULL DEFAULT 20
        CHECK (npc_treaty_stock_cap_pct >= 0 AND npc_treaty_stock_cap_pct <= 100)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS npc_treaty_max_regions integer NOT NULL DEFAULT 3
        CHECK (npc_treaty_max_regions >= 0 AND npc_treaty_max_regions <= 10)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS npc_treaty_region_max_pct integer NOT NULL DEFAULT 50
        CHECK (npc_treaty_region_max_pct >= 0 AND npc_treaty_region_max_pct <= 100)
  `);
  await db.execute(sql`
    ALTER TABLE world_game_state
      ADD COLUMN IF NOT EXISTS npc_treaty_per_turn_cap_pct integer NOT NULL DEFAULT 10
        CHECK (npc_treaty_per_turn_cap_pct >= 0 AND npc_treaty_per_turn_cap_pct <= 100)
  `);

  // ── AI 世界變更稽核紀錄 ──
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS world_sim_audits (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source text NOT NULL,
      instruction text,
      summary text NOT NULL,
      changes jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS world_sim_audits_created_idx
      ON world_sim_audits (created_at)
  `);

  // ── 一次性把「結算頻率」預設從舊值（判定 6h／戰役 24h）改成新政策（皆 4h）。
  // 以 game_flags 原子認領旗標保證只跑一次（重啟不重複、也不覆蓋管理員後續調整）。
  // 僅對「既有 DB」有意義：全新 DB 的欄位預設已是 240／4，這裡再設一次亦無害。
  // worldSimMigrations 於 bootstrap 最後執行，war_campaigns 此時必已建立。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_flags (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  const cadenceClaim = await db.execute(sql`
    INSERT INTO game_flags (key) VALUES ('settlement-cadence-4h')
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `);
  if (cadenceClaim.rows.length > 0) {
    // 判定頻率 → 240 分（4h）、戰役週期 → 4h，並依新頻率重算下次判定到期時間。
    await db.execute(sql`
      UPDATE world_game_state
      SET ai_judgment_frequency_minutes = 240,
          war_cycle_hours = 4,
          ai_judgment_next_run_at = NOW() + make_interval(mins => 240),
          updated_at = NOW()
      WHERE id = 1
    `);
    // 進行中的戰役立即改用 4h 週期並依新頻率重算下次結算時間。
    await db.execute(sql`
      UPDATE war_campaigns
      SET cycle_hours = 4,
          next_resolve_at = NOW() + INTERVAL '4 hours'
      WHERE status = 'active'
    `);
    logger.info("settlement cadence defaults set to 4h (one-time)");
  }

  logger.info("world sim migrations applied");
}
