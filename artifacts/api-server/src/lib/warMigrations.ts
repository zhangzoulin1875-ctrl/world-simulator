import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { REGION_COOLDOWN_MINUTES } from "./war";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #105 — 戰爭戰役系統的 idempotent 啟動遷移。
 * 必須在 politicsMigrations 之後執行（FK 依賴 player_nations、map_regions、
 * military_unit_templates、diplomacy_wars）。
 *
 * 與其他啟動遷移一樣不包 try/catch：失敗必須讓 bootstrap 大聲失敗。
 */
export async function runWarMigrations(): Promise<void> {
  await withTestMigrationStamp("war", runWarMigrationsInner);
}

async function runWarMigrationsInner(): Promise<void> {
  // ── diplomacy_wars：戰爭結束標記＋停戰提案（一次性 ADD，永不 DROP） ──
  await db.execute(sql`
    ALTER TABLE diplomacy_wars
      ADD COLUMN IF NOT EXISTS ended_at timestamptz
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_wars
      ADD COLUMN IF NOT EXISTS ceasefire_proposed_by uuid
        REFERENCES player_nations(id) ON DELETE SET NULL
  `);
  // 奪權內戰(2026-10-05):內戰標記、奪權方、意識形態(一次性 ADD,永不 DROP)
  await db.execute(sql`
    ALTER TABLE diplomacy_wars
      ADD COLUMN IF NOT EXISTS is_civil_war boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_wars
      ADD COLUMN IF NOT EXISTS rebel_nation_id uuid
        REFERENCES player_nations(id) ON DELETE SET NULL
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_wars
      ADD COLUMN IF NOT EXISTS rebel_ideology text
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_wars
      ADD COLUMN IF NOT EXISTS loser_nation_id uuid
  `);
  // pair 唯一改為 partial（僅進行中的戰爭唯一，歷史戰爭保留多筆）。
  // 先建新 partial index 再拆舊全域 index，順序保證不留下無唯一保護的空窗。
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS diplomacy_wars_pair_active_uidx
      ON diplomacy_wars (nation_a_id, nation_b_id)
      WHERE ended_at IS NULL
  `);
  await db.execute(sql`DROP INDEX IF EXISTS diplomacy_wars_pair_uidx`);

  // ── 戰役主表 ──────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS war_campaigns (
      id serial PRIMARY KEY,
      war_id integer NOT NULL
        REFERENCES diplomacy_wars(id) ON DELETE CASCADE,
      attacker_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      defender_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      attacker_region_id integer NOT NULL
        REFERENCES map_regions(id) ON DELETE CASCADE,
      defender_region_id integer NOT NULL
        REFERENCES map_regions(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'active',
      winner_nation_id uuid
        REFERENCES player_nations(id) ON DELETE SET NULL,
      end_reason text,
      terrain_brief text,
      attacker_city_state jsonb,
      defender_city_state jsonb,
      cycle_hours integer NOT NULL DEFAULT 24
        CONSTRAINT war_campaigns_cycle_hours_check
        CHECK (cycle_hours >= 1 AND cycle_hours <= 168),
      cycle_number integer NOT NULL DEFAULT 0,
      next_resolve_at timestamptz NOT NULL,
      fail_count integer NOT NULL DEFAULT 0,
      initiated_by_npc boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      ended_at timestamptz
    )
  `);
  // ── Task #152 海上登陸：登陸旗標＋開戰快照（一次性 ADD，永不 DROP） ──
  await db.execute(sql`
    ALTER TABLE war_campaigns
      ADD COLUMN IF NOT EXISTS is_sea_landing boolean NOT NULL DEFAULT false
  `);
  await db.execute(sql`
    ALTER TABLE war_campaigns
      ADD COLUMN IF NOT EXISTS landing_attack_reduction_pct integer
  `);
  await db.execute(sql`
    ALTER TABLE war_campaigns
      ADD COLUMN IF NOT EXISTS sea_landing_troop_cap bigint
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaigns_status_idx
      ON war_campaigns (status)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaigns_next_resolve_idx
      ON war_campaigns (status, next_resolve_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaigns_war_idx
      ON war_campaigns (war_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaigns_attacker_idx
      ON war_campaigns (attacker_nation_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaigns_defender_idx
      ON war_campaigns (defender_nation_id)
  `);

  // ── 地區交戰鎖（Task #648 後改複合主鍵，允許多對多攻打） ──
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS war_region_engagements (
      region_id integer NOT NULL
        REFERENCES map_regions(id) ON DELETE CASCADE,
      campaign_id integer NOT NULL
        REFERENCES war_campaigns(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (campaign_id, region_id)
    )
  `);
  // Task #648 — 冪等 PK 遷移：若現有 PK 仍是舊式 region_id 單欄，改為複合
  // (campaign_id, region_id)。新建資料庫直接用上方 CREATE TABLE（已含正確 PK）。
  await db.execute(sql`
    DO $$
    BEGIN
      -- 舊式 PK 僅有 1 欄（region_id）；新式複合 PK 有 2 欄。
      -- 條件判斷失敗（表不存在或已是複合 PK）時直接跳過。
      IF (
        SELECT array_length(conkey, 1) = 1
        FROM pg_constraint
        WHERE conrelid = 'war_region_engagements'::regclass
          AND contype = 'p'
      ) THEN
        ALTER TABLE war_region_engagements DROP CONSTRAINT war_region_engagements_pkey;
        ALTER TABLE war_region_engagements ADD PRIMARY KEY (campaign_id, region_id);
      END IF;
    END $$
  `);

  // ── 戰役結束後的地區冷卻 ──────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS war_region_cooldowns (
      region_id integer PRIMARY KEY
        REFERENCES map_regions(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL
    )
  `);
  // Task #375 — 冷卻由 24 小時改為 30 分鐘後，清理改版前留下的長冷卻殘留列。
  await capStaleRegionCooldowns();

  // ── 軍團 ─────────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS war_campaign_legions (
      id serial PRIMARY KEY,
      campaign_id integer NOT NULL
        REFERENCES war_campaigns(id) ON DELETE CASCADE,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      slot text NOT NULL
        CONSTRAINT war_campaign_legions_slot_check
        CHECK (slot IN ('A', 'B', 'C')),
      morale integer NOT NULL DEFAULT 80
        CONSTRAINT war_campaign_legions_morale_check
        CHECK (morale >= 0 AND morale <= 100),
      supply integer NOT NULL DEFAULT 100
        CONSTRAINT war_campaign_legions_supply_check
        CHECK (supply >= 0 AND supply <= 100),
      garrisoning_city boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS war_campaign_legions_slot_uidx
      ON war_campaign_legions (campaign_id, nation_id, slot)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaign_legions_campaign_idx
      ON war_campaign_legions (campaign_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaign_legions_nation_idx
      ON war_campaign_legions (nation_id)
  `);

  // ── 軍團兵種配置 ──────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS war_campaign_legion_units (
      id serial PRIMARY KEY,
      legion_id integer NOT NULL
        REFERENCES war_campaign_legions(id) ON DELETE CASCADE,
      template_id integer NOT NULL
        REFERENCES military_unit_templates(id) ON DELETE CASCADE,
      quantity bigint NOT NULL DEFAULT 0,
      wounded bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT war_campaign_legion_units_qty_check
        CHECK (quantity >= 0 AND wounded >= 0)
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS war_campaign_legion_units_uidx
      ON war_campaign_legion_units (legion_id, template_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaign_legion_units_legion_idx
      ON war_campaign_legion_units (legion_id)
  `);
  // Task #389 — NPC 常備軍抽調量（一次性 ADD，永不 DROP）。
  await db.execute(sql`
    ALTER TABLE war_campaign_legion_units
      ADD COLUMN IF NOT EXISTS npc_drawn bigint NOT NULL DEFAULT 0
  `);

  // ── Task #453 — 戰役參戰國（多國參戰：主帥＋晚加入選邊） ──────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS war_campaign_participants (
      id serial PRIMARY KEY,
      campaign_id integer NOT NULL
        REFERENCES war_campaigns(id) ON DELETE CASCADE,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      side text NOT NULL
        CONSTRAINT war_campaign_participants_side_check
        CHECK (side IN ('attacker', 'defender')),
      is_lead boolean NOT NULL DEFAULT false,
      join_war_id integer
        REFERENCES diplomacy_wars(id) ON DELETE CASCADE,
      joined_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS war_campaign_participants_uidx
      ON war_campaign_participants (campaign_id, nation_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaign_participants_campaign_idx
      ON war_campaign_participants (campaign_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaign_participants_nation_idx
      ON war_campaign_participants (nation_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaign_participants_join_war_idx
      ON war_campaign_participants (join_war_id)
  `);
  // 回填：既有戰役（含歷史列）補上攻守主帥參戰列（冪等，衝突忽略）。
  await db.execute(sql`
    INSERT INTO war_campaign_participants
      (campaign_id, nation_id, side, is_lead, join_war_id, joined_at)
    SELECT c.id, c.attacker_nation_id, 'attacker', true, c.war_id, c.created_at
    FROM war_campaigns c
    ON CONFLICT (campaign_id, nation_id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO war_campaign_participants
      (campaign_id, nation_id, side, is_lead, join_war_id, joined_at)
    SELECT c.id, c.defender_nation_id, 'defender', true, c.war_id, c.created_at
    FROM war_campaigns c
    ON CONFLICT (campaign_id, nation_id) DO NOTHING
  `);

  // ── AI 指令（每週期每類型一則，upsert 覆寫） ─────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS war_campaign_orders (
      id serial PRIMARY KEY,
      campaign_id integer NOT NULL
        REFERENCES war_campaigns(id) ON DELETE CASCADE,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      cycle_number integer NOT NULL,
      order_type text NOT NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS war_campaign_orders_uidx
      ON war_campaign_orders (campaign_id, nation_id, cycle_number, order_type)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaign_orders_campaign_cycle_idx
      ON war_campaign_orders (campaign_id, cycle_number)
  `);

  // ── 結算戰報 ─────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS war_campaign_reports (
      id serial PRIMARY KEY,
      campaign_id integer NOT NULL
        REFERENCES war_campaigns(id) ON DELETE CASCADE,
      cycle_number integer NOT NULL,
      attacker_report text NOT NULL,
      defender_report text NOT NULL,
      summary jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS war_campaign_reports_cycle_uidx
      ON war_campaign_reports (campaign_id, cycle_number)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS war_campaign_reports_campaign_idx
      ON war_campaign_reports (campaign_id)
  `);

  // ── 全國傷兵池 ────────────────────────────────────────────
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS player_wounded_units (
      id serial PRIMARY KEY,
      discord_user_id text NOT NULL
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      template_id integer NOT NULL
        REFERENCES military_unit_templates(id) ON DELETE CASCADE,
      wounded bigint NOT NULL DEFAULT 0,
      last_recovery_at timestamptz NOT NULL DEFAULT NOW(),
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS player_wounded_units_uidx
      ON player_wounded_units (discord_user_id, template_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS player_wounded_units_player_idx
      ON player_wounded_units (discord_user_id)
  `);

  // 傷兵線性復原：加 initial_wounded 欄位（基準量），補現有列使 initial=wounded。
  await db.execute(sql`
    ALTER TABLE player_wounded_units
      ADD COLUMN IF NOT EXISTS initial_wounded bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    UPDATE player_wounded_units
    SET initial_wounded = wounded
    WHERE initial_wounded = 0 AND wounded > 0
  `);

  // order_type：舊格式為 4 類型（'strategy','attack','defense','recon'），
  // 已統一為 WAR_ORDER_TYPES = ['command']（app 層強制，OpenAPI/zod 驗證）。
  // 冪等清理：刪除 CHECK 約束 + 刪除舊格式歷史列（已結算資料，不影響進行中戰役）。
  // 注意：**永不 ADD 這個 CHECK 約束**——Publish 直接比對 dev/prod DB 結構並在
  // 新程式碼部署前把 DDL 套到 prod；prod 若還有舊髒資料，ADD CHECK 會讓發布失敗
  // （雞生蛋：清理程式碼要等部署後才跑）。單一值 CHECK 無實質保護，勿再加回。
  await db.execute(sql`
    ALTER TABLE war_campaign_orders
      DROP CONSTRAINT IF EXISTS war_campaign_orders_type_check
  `);
  await db.execute(sql`
    DELETE FROM war_campaign_orders
    WHERE order_type NOT IN ('command')
  `);

  logger.info("war migrations completed");
}

/**
 * Task #375 — 把 war_region_cooldowns 中超過「現在 + REGION_COOLDOWN_MINUTES
 * 分鐘」的到期時間下修封頂（LEAST：只縮短、永不延長），清除冷卻由 24 小時改為
 * 30 分鐘前留下的長冷卻殘留列。冪等，可安全重複執行。
 */
export async function capStaleRegionCooldowns(): Promise<void> {
  await db.execute(sql`
    UPDATE war_region_cooldowns
    SET expires_at = LEAST(
      expires_at,
      NOW() + make_interval(mins => ${REGION_COOLDOWN_MINUTES})
    )
    WHERE expires_at > NOW() + make_interval(mins => ${REGION_COOLDOWN_MINUTES})
  `);
}
