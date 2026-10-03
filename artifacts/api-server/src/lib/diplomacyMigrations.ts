import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withMigrationLockStamped } from "./migrationLock";

/**
 * Task #34 — 外交系統的 idempotent 啟動遷移與 NPC「德國」種子。
 * 必須在 runRegionControlMigrations 之後執行（region_controls / map_regions
 * FK 依賴）。與其他啟動遷移一樣不包 try/catch：失敗必須讓 bootstrap 大聲失敗。
 */

/** 測試 NPC「德國」掌控的德國一帶地區（各 100%，僅在該地區完全無主時指派）。 */
const GERMANY_NPC_REGIONS = [
  "巴伐利亞",
  "符騰堡",
  "萊茵",
  "勃蘭登堡",
  "漢堡",
  "薩克森",
] as const;

export async function runDiplomacyMigrations(): Promise<void> {
  await withMigrationLockStamped("diplomacy", runDiplomacyMigrationsInner);
}

async function runDiplomacyMigrationsInner(): Promise<void> {
  // 一次性 ADD，永不 DROP — 避免 pg_attribute slot 洩漏。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS is_npc boolean NOT NULL DEFAULT false
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_flags (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS diplomacy_relations (
      id serial PRIMARY KEY,
      nation_a_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      nation_b_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      score integer NOT NULL DEFAULT 0,
      embassy_from_a boolean NOT NULL DEFAULT false,
      embassy_from_b boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT diplomacy_relations_order_check CHECK (nation_a_id < nation_b_id),
      CONSTRAINT diplomacy_relations_score_check CHECK (score >= -100 AND score <= 100)
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS diplomacy_relations_pair_uidx
      ON diplomacy_relations (nation_a_id, nation_b_id)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS diplomacy_messages (
      id serial PRIMARY KEY,
      sender_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      recipient_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      body text NOT NULL,
      read_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS diplomacy_messages_pair_idx
      ON diplomacy_messages (sender_nation_id, recipient_nation_id, id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS diplomacy_messages_unread_idx
      ON diplomacy_messages (recipient_nation_id, read_at)
  `);

  // Task #501 — 「玩家操縱 NPC 未遂」事件（反操縱守門剔除讓利動作時寫入，
  // 供管理員後台檢視）。名稱為快照、國家 id ON DELETE SET NULL 保留歷史。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS npc_chat_guard_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      player_nation_id uuid
        REFERENCES player_nations(id) ON DELETE SET NULL,
      npc_nation_id uuid
        REFERENCES player_nations(id) ON DELETE SET NULL,
      player_name text NOT NULL,
      npc_name text NOT NULL,
      action_type text NOT NULL,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS npc_chat_guard_events_created_idx
      ON npc_chat_guard_events (created_at)
  `);

  // 玩家大廳群聊：所有玩家共用的單一聊天室。無收件人／已讀欄位
  // （大廳不觸發任何通知、不算未讀）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS diplomacy_lobby_messages (
      id serial PRIMARY KEY,
      sender_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS diplomacy_lobby_messages_created_at_idx
      ON diplomacy_lobby_messages (created_at, id)
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS diplomacy_treaties (
      id serial PRIMARY KEY,
      proposer_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      target_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      type text NOT NULL,
      duration_days integer,
      offer_money bigint NOT NULL DEFAULT 0,
      offer_tech_points integer NOT NULL DEFAULT 0,
      offer_region_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'proposed',
      awaiting_nation_id uuid
        REFERENCES player_nations(id) ON DELETE CASCADE,
      counter_of_treaty_id integer,
      response_note text,
      accepted_at timestamptz,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS diplomacy_treaties_proposer_idx
      ON diplomacy_treaties (proposer_nation_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS diplomacy_treaties_target_idx
      ON diplomacy_treaties (target_nation_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS diplomacy_treaties_status_idx
      ON diplomacy_treaties (status)
  `);

  // 到期前預警：記錄已寄出預警 DM 的時間（null = 未預警），持久化避免重啟後重複通知。
  // 一次性 ADD，永不 DROP — 避免 pg_attribute slot 洩漏。
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS expiry_warned_at timestamptz
  `);

  // Task #214 — 自訂條約欄位：自由條款 + 每回合經常性轉移 + 付款方旗標。
  // 一次性 ADD，永不 DROP — 避免 pg_attribute slot 洩漏。
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS custom_clause text
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS per_turn_money bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS per_turn_tech integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS per_turn_production integer NOT NULL DEFAULT 0
  `);
  // 條約糧食輸送：每回合糧食流量（受益方 +N、付款方 −N，付款方不足也照送）。
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS per_turn_food integer NOT NULL DEFAULT 0
  `);
  // Task #476 — 條約每回合木材／礦石輸送（庫存制：不足則本回合略過該項）。
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS per_turn_wood bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS per_turn_ore bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS proposer_is_payer boolean NOT NULL DEFAULT true
  `);
  // Task #527 — 反向每回合經常性轉移（雙向定期支付）：request_per_turn_* 由
  // 「perTurn 付款方的對方」支付，兩方向各自獨立結算。舊列全 0 = 純單向。
  // 一次性 ADD，永不 DROP — 避免 pg_attribute slot 洩漏。
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_per_turn_money bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_per_turn_tech integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_per_turn_production integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_per_turn_food integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_per_turn_wood bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_per_turn_ore bigint NOT NULL DEFAULT 0
  `);

  // 附庸條約（type='vassal'）：貢金比例（附庸每回合上繳稅收 %）＋ 方向旗標
  // （proposer_is_vassal：true = 提案方為附庸）。一次性 ADD，永不 DROP。
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS tribute_pct integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS proposer_is_vassal boolean NOT NULL DEFAULT true
  `);
  // 每個附庸同時只能有一個生效中的宗主：實體欄位 vassal_nation_id（附庸方
  // nation id，只在 activateTreaty 轉為 active 時寫入）＋普通欄位的部分唯一
  // 索引。不可改回 CASE 表達式索引——發布（Publish）的 schema 重放工具
  // 無法正確重放多行 CASE 運算式，會直接讓發布失敗。
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS vassal_nation_id uuid
  `);
  await db.execute(sql`
    UPDATE diplomacy_treaties
      SET vassal_nation_id = CASE WHEN proposer_is_vassal THEN proposer_nation_id ELSE target_nation_id END
      WHERE type = 'vassal' AND status = 'active' AND vassal_nation_id IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS diplomacy_treaties_vassal_nation_active_uidx
      ON diplomacy_treaties (vassal_nation_id)
      WHERE type = 'vassal' AND status = 'active'
  `);
  // 淘汰舊的 CASE 表達式索引（發布重放會炸）；一次性 DROP，之後為 no-op。
  await db.execute(sql`
    DROP INDEX IF EXISTS diplomacy_treaties_vassal_active_uidx
  `);

  // Task #341 — 每區承諾／要求領土的轉移百分比（regionId → 百分比）＋附條件停戰綁定的戰爭 id。
  // bound_war_id 非 null 時此條約為「附條件停戰」：接受後結束該場戰爭。
  // 一次性 ADD，永不 DROP — 避免 pg_attribute slot 洩漏。
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS offer_region_percents jsonb NOT NULL DEFAULT '{}'::jsonb
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS bound_war_id integer
  `);

  // Task #374 — 條約雙向交換：「要求對方提供」側欄位（金錢／科技／地區／各地區百分比）。
  // 一次性 ADD，永不 DROP — 避免 pg_attribute slot 洩漏。
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_money bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_tech_points integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_region_ids jsonb NOT NULL DEFAULT '[]'::jsonb
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_region_percents jsonb NOT NULL DEFAULT '{}'::jsonb
  `);

  // Task #214 — 生產力持久化修正量（自訂條約每回合轉移生產力的累積偏移）。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS production_bonus bigint NOT NULL DEFAULT 0
  `);

  // Task #67 — 同一 canonical pair 最多一筆 proposed 條約，由資料庫層保證。
  // 先清理歷史重複列（保留最早的一筆，其餘標記 superseded），再建部分唯一索引；
  // 兩步皆 idempotent。
  await db.execute(sql`
    UPDATE diplomacy_treaties t
    SET status = 'superseded',
        awaiting_nation_id = NULL,
        response_note = COALESCE(
          t.response_note,
          '系統：與同一國家已有較早的待回覆提案，此重複提案已自動作廢'
        ),
        updated_at = NOW()
    WHERE t.status = 'proposed'
      AND EXISTS (
        SELECT 1 FROM diplomacy_treaties o
        WHERE o.status = 'proposed'
          AND o.id < t.id
          AND LEAST(o.proposer_nation_id, o.target_nation_id)
            = LEAST(t.proposer_nation_id, t.target_nation_id)
          AND GREATEST(o.proposer_nation_id, o.target_nation_id)
            = GREATEST(t.proposer_nation_id, t.target_nation_id)
      )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS diplomacy_treaties_proposed_pair_uidx
      ON diplomacy_treaties (
        LEAST(proposer_nation_id, target_nation_id),
        GREATEST(proposer_nation_id, target_nation_id)
      )
      WHERE status = 'proposed'
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS diplomacy_wars (
      id serial PRIMARY KEY,
      nation_a_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      nation_b_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      declared_by_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT diplomacy_wars_order_check CHECK (nation_a_id < nation_b_id)
    )
  `);
  // Task #105 起 pair 唯一為 partial（僅進行中的戰爭唯一，歷史戰爭可多筆）。
  // ended_at 在此先行補上（warMigrations 的 ADD COLUMN IF NOT EXISTS 仍保留，冪等無害），
  // 讓 partial index 能在建表當下就到位，不留無唯一保護的空窗。
  // 舊的全域唯一索引 diplomacy_wars_pair_uidx 已淘汰：絕不能再建立
  // （正式庫有同 pair 的多筆歷史戰爭，發佈時的 schema 比對若在開發庫看到它
  // 會試圖套用到正式庫而失敗），這裡改為主動清除殘留。
  await db.execute(sql`
    ALTER TABLE diplomacy_wars
      ADD COLUMN IF NOT EXISTS ended_at timestamptz
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS diplomacy_wars_pair_active_uidx
      ON diplomacy_wars (nation_a_id, nation_b_id)
      WHERE ended_at IS NULL
  `);
  await db.execute(sql`DROP INDEX IF EXISTS diplomacy_wars_pair_uidx`);

  // Task #84 — 關係動作事件紀錄（送禮／侮辱／設館／撤館），供 NPC 判斷回顧。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS diplomacy_relation_events (
      id serial PRIMARY KEY,
      actor_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      target_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      action text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS diplomacy_relation_events_actor_idx
      ON diplomacy_relation_events (actor_nation_id, created_at)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS diplomacy_relation_events_target_idx
      ON diplomacy_relation_events (target_nation_id, created_at)
  `);
  // pair 雙向查詢（NPC prompt 回顧）走這條 canonical pair 表達式索引。
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS diplomacy_relation_events_pair_idx
      ON diplomacy_relation_events (
        LEAST(actor_nation_id, target_nation_id),
        GREATEST(actor_nation_id, target_nation_id),
        created_at
      )
  `);

  // Task #159 — 每回合污辱額度：同一行動國對同一目標國、同一回合最多污辱 1 次。
  // 回合以 world_game_state.game_date 為識別；唯一鍵 (actor, target, turn_date)
  // 讓併發請求只有一個能佔用（乾淨 409）。回合引擎會清除舊回合列。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS diplomacy_insult_quotas (
      id serial PRIMARY KEY,
      actor_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      target_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      turn_date text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS diplomacy_insult_quotas_triple_uidx
      ON diplomacy_insult_quotas (actor_nation_id, target_nation_id, turn_date)
  `);

  // Task #228 — 每回合 AI 對話額度（每玩家每回合合計 5 句）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS diplomacy_ai_chat_quotas (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      turn_date text NOT NULL,
      used_count integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS diplomacy_ai_chat_quotas_pair_uidx
      ON diplomacy_ai_chat_quotas (nation_id, turn_date)
  `);

  // Task #215 — 具名多國聯盟資料表（取代一對一「同盟條約」）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS alliances (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      founder_nation_id uuid
        REFERENCES player_nations(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS alliance_members (
      id serial PRIMARY KEY,
      alliance_id uuid NOT NULL
        REFERENCES alliances(id) ON DELETE CASCADE,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      joined_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  // 多聯盟改制：一國可加入多個聯盟；同一聯盟不可重複加入。
  // （原「一國一聯盟」的 alliance_members_nation_uidx 已在原建立點退場，勿再建立。）
  await db.execute(sql`
    DROP INDEX IF EXISTS alliance_members_nation_uidx
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS alliance_members_alliance_nation_uidx
      ON alliance_members (alliance_id, nation_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alliance_members_nation_idx
      ON alliance_members (nation_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alliance_members_alliance_idx
      ON alliance_members (alliance_id)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS alliance_invites (
      id serial PRIMARY KEY,
      alliance_id uuid NOT NULL
        REFERENCES alliances(id) ON DELETE CASCADE,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      direction text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  // 同一聯盟×國家×方向，pending 時最多一筆（併發重複邀請／申請乾淨 409）。
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS alliance_invites_pending_uidx
      ON alliance_invites (alliance_id, nation_id, direction)
      WHERE status = 'pending'
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alliance_invites_nation_idx
      ON alliance_invites (nation_id, status)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS alliance_invites_alliance_idx
      ON alliance_invites (alliance_id, status)
  `);

  // 附庸外交同意請求（附庸宣戰／聯盟行動需宗主同意）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS vassal_consent_requests (
      id serial PRIMARY KEY,
      vassal_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      suzerain_nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      action_type text NOT NULL,
      target_nation_id uuid
        REFERENCES player_nations(id) ON DELETE CASCADE,
      alliance_id uuid
        REFERENCES alliances(id) ON DELETE CASCADE,
      subject_name text,
      status text NOT NULL DEFAULT 'pending',
      decided_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  // 同一附庸×行動類型，pending 時最多一筆（不重複轟炸宗主；併發乾淨 409）。
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS vassal_consent_requests_pending_uidx
      ON vassal_consent_requests (vassal_nation_id, action_type)
      WHERE status = 'pending'
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS vassal_consent_requests_suzerain_idx
      ON vassal_consent_requests (suzerain_nation_id, status)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS vassal_consent_requests_vassal_idx
      ON vassal_consent_requests (vassal_nation_id, status)
  `);

  await convertAllianceTreatiesToAlliances();

  await seedGermanyNpc();

  logger.info("diplomacy migrations applied");
}

/**
 * Task #215 — 一次性遷移：把「生效中的同盟條約」轉為具名 2 國聯盟後，退場那些條約列。
 * 以 game_flags 原子認領旗標保證只跑一次（重啟不重複、不覆蓋玩家後續建立的聯盟）。
 *
 * 轉換規則（依條約 id 遞增逐筆處理，並尊重「一國一聯盟」不變量）：
 *   - 兩國皆尚未屬於任何聯盟 → 新建一個以提案國為創始國的 2 國聯盟。
 *   - 其一已在聯盟、另一未加入 → 把未加入者併入既有聯盟（自然合併鏈狀同盟）。
 *   - 兩國皆已在（相同或不同）聯盟 → 略過（不合併不同聯盟，維持成員唯一）。
 * 無論是否轉換，所有生效中的同盟條約一律標記 superseded 退場（該條約類型已停用）。
 */
async function convertAllianceTreatiesToAlliances(): Promise<void> {
  const claimed = await db.execute(sql`
    INSERT INTO game_flags (key) VALUES ('alliance-treaties-converted')
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `);
  if (claimed.rows.length === 0) return; // 已轉換過

  await db.transaction(async (tx) => {
    const treatyRows = await tx.execute(sql`
      SELECT
        t.id AS id,
        t.proposer_nation_id AS proposer_id,
        t.target_nation_id AS target_id,
        pp.name AS proposer_name,
        pt.name AS target_name
      FROM diplomacy_treaties t
      JOIN player_nations pp ON pp.id = t.proposer_nation_id
      JOIN player_nations pt ON pt.id = t.target_nation_id
      WHERE t.type = 'alliance' AND t.status = 'active'
      ORDER BY t.id ASC
    `);

    // 現有成員對照（首次執行為空；保守查詢以防旗標被外力重置）。
    const memberRows = await tx.execute(sql`
      SELECT nation_id, alliance_id FROM alliance_members
    `);
    const allianceByNation = new Map<string, string>();
    for (const r of memberRows.rows) {
      allianceByNation.set(
        String(r["nation_id"]),
        String(r["alliance_id"]),
      );
    }

    const addMember = async (
      allianceId: string,
      nationId: string,
    ): Promise<void> => {
      await tx.execute(sql`
        INSERT INTO alliance_members (alliance_id, nation_id)
        VALUES (${allianceId}::uuid, ${nationId}::uuid)
        ON CONFLICT (alliance_id, nation_id) DO NOTHING
      `);
      allianceByNation.set(nationId, allianceId);
    };

    let created = 0;
    let joined = 0;
    for (const row of treatyRows.rows) {
      const proposerId = String(row["proposer_id"]);
      const targetId = String(row["target_id"]);
      const proposerName = (row["proposer_name"] as string | null) ?? "（未命名）";
      const targetName = (row["target_name"] as string | null) ?? "（未命名）";
      const pAlliance = allianceByNation.get(proposerId);
      const tAlliance = allianceByNation.get(targetId);

      if (pAlliance && tAlliance) {
        continue; // 皆已入盟 → 不合併不同聯盟
      }
      if (pAlliance && !tAlliance) {
        await addMember(pAlliance, targetId);
        joined++;
        continue;
      }
      if (!pAlliance && tAlliance) {
        await addMember(tAlliance, proposerId);
        joined++;
        continue;
      }
      // 皆未入盟 → 新建以提案國為創始國的聯盟。
      const name = `「${proposerName}」與「${targetName}」的聯盟`;
      const inserted = await tx.execute(sql`
        INSERT INTO alliances (name, founder_nation_id)
        VALUES (${name}, ${proposerId}::uuid)
        RETURNING id
      `);
      const allianceId = (inserted.rows[0] as { id: string } | undefined)?.id;
      if (!allianceId) throw new Error("聯盟轉換：建立聯盟失敗");
      await addMember(allianceId, proposerId);
      await addMember(allianceId, targetId);
      created++;
    }

    // 退場所有生效中的同盟條約（此條約類型已停用）。
    const retired = await tx.execute(sql`
      UPDATE diplomacy_treaties
      SET status = 'superseded',
          awaiting_nation_id = NULL,
          response_note = COALESCE(
            response_note,
            '系統：同盟條約已改制為聯盟，本條約自動退場'
          ),
          updated_at = NOW()
      WHERE type = 'alliance' AND status = 'active'
      RETURNING id
    `);

    logger.info(
      {
        alliancesCreated: created,
        membersJoined: joined,
        treatiesRetired: retired.rows.length,
      },
      "alliance treaties converted to alliances",
    );
  });
}

/**
 * 一次性種子測試 NPC「德國」。以 game_flags 原子認領旗標保證只執行一次
 * （管理員之後刪除該 NPC 也不會在重啟時被重建）。地區只在完全無任何
 * 掌控紀錄時才指派 100%，避免搶佔玩家已掌控的地區。
 */
async function seedGermanyNpc(): Promise<void> {
  const claimed = await db.execute(sql`
    INSERT INTO game_flags (key) VALUES ('npc-germany-seeded')
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `);
  if (claimed.rows.length === 0) return; // 已種子過

  await db.transaction(async (tx) => {
    const inserted = await tx.execute(sql`
      INSERT INTO player_nations (name, leader_name, government, is_npc)
      VALUES ('德國', '德意志政府', '聯邦共和制', true)
      RETURNING id
    `);
    const nationId = (inserted.rows[0] as { id: string } | undefined)?.id;
    if (!nationId) throw new Error("NPC 德國建立失敗");

    for (const regionName of GERMANY_NPC_REGIONS) {
      // 只在該地區完全無主時指派 100%。
      await tx.execute(sql`
        INSERT INTO region_controls (region_id, nation_id, percent)
        SELECT r.id, ${nationId}::uuid, 100
        FROM map_regions r
        WHERE r.name = ${regionName}
          AND NOT EXISTS (
            SELECT 1 FROM region_controls rc WHERE rc.region_id = r.id
          )
      `);
    }
  });

  logger.info("NPC Germany seeded");
}
