import { and, eq, gt, sql } from "drizzle-orm";
import {
  db,
  militaryUnitTemplatesTable,
  playerArmiesTable,
  playerNationsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { cumulativeBuildingProductionCost } from "./regionBuildings";
import { allocateProportionally } from "./war";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #27 — 軍事系統的 idempotent 啟動遷移（Task #549 起預設兵種種子
 * 已全面移除，原種子步驟 supersede 為一次性刪除）。
 * 必須在 runDiscordNewsMigrations 之後執行（FK 依賴 player_nations），與
 * map_regions 無關，因此不必等 runMapRegionSync。
 *
 * 與其他啟動遷移一樣不包 try/catch：失敗必須讓 bootstrap 大聲失敗。
 */
export async function runMilitaryMigrations(): Promise<void> {
  await withTestMigrationStamp("military", runMilitaryMigrationsInner);
}

async function runMilitaryMigrationsInner(): Promise<void> {
  // Task #27 additive columns on player_nations（一次性 ADD，永不 DROP —
  // 避免 pg_attribute slot 洩漏）。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS production_spent bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS population_spent bigint NOT NULL DEFAULT 0
  `);
  // NPC 來源(wild=攻打空地即時生成的對抗 AI 國,戰役出兵有上限;natural=其餘不受限)。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS npc_origin text NOT NULL DEFAULT 'natural'
  `);
  // Task #510 — 兵種設計次數制（0–5，建國滿 5、每回合 +1）。DEFAULT 5 讓
  // 既有列（含無主/NPC 國家）一次性補滿 5 次。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS unit_design_charges integer NOT NULL DEFAULT 5
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS military_unit_templates (
      id serial PRIMARY KEY,
      owner_discord_user_id text
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      category text NOT NULL,
      name text NOT NULL,
      description text,
      is_default boolean NOT NULL DEFAULT false,
      era_slug text,
      hp integer NOT NULL,
      attack integer NOT NULL,
      defense integer NOT NULL,
      speed double precision NOT NULL,
      accuracy integer NOT NULL,
      range text NOT NULL,
      anti_cavalry_pct integer NOT NULL DEFAULT 0,
      anti_ranged_pct integer NOT NULL DEFAULT 0,
      siege_pct integer NOT NULL DEFAULT 0,
      prod_cost_per_100 integer NOT NULL,
      pop_cost_per_unit integer NOT NULL,
      money_cost_per_unit bigint NOT NULL,
      upkeep_per_unit double precision NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS military_unit_templates_owner_idx
      ON military_unit_templates (owner_discord_user_id)
  `);
  // Task #389 — NPC 專屬兵種以國家 id 持有（一次性 ADD，永不 DROP）。
  await db.execute(sql`
    ALTER TABLE military_unit_templates
      ADD COLUMN IF NOT EXISTS owner_nation_id uuid
        REFERENCES player_nations(id) ON DELETE CASCADE
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS military_unit_templates_owner_nation_idx
      ON military_unit_templates (owner_nation_id)
  `);
  // Task #549 — 預設兵種全面移除：唯一索引在原建立處 supersede DROP
  // （is_default 欄位保留、永不 DROP，僅不再有 true 列）。
  await db.execute(sql`
    DROP INDEX IF EXISTS military_unit_templates_default_name_uidx
  `);
  // Task #406 — 資源系統欄位（一次性 ADD，永不 DROP）：抗火炮、生產力維護費、
  // 每單位木材／礦石製造成本。
  await db.execute(sql`
    ALTER TABLE military_unit_templates
      ADD COLUMN IF NOT EXISTS anti_artillery_pct integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE military_unit_templates
      ADD COLUMN IF NOT EXISTS prod_upkeep_per_unit double precision NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE military_unit_templates
      ADD COLUMN IF NOT EXISTS wood_cost_per_unit integer NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE military_unit_templates
      ADD COLUMN IF NOT EXISTS ore_cost_per_unit integer NOT NULL DEFAULT 0
  `);
  // Task #406 — 一次性回填：既有模板的維護費對半拆成「金錢＋生產力」兩軌，
  // 各套 0.1 下限。例外:「全民皆兵民兵」模板刻意全部為 0(不占生產力、不收維護費),
  // 不得被回填。自我限制：prod_upkeep_per_unit = 0 只在未回填時成立
  // （回填後至少 0.1），重開機不會再次對半。必須在種子 upsert 之前執行，
  // 讓種子的新值（已是拆分後數值）覆蓋預設模板。
  await db.execute(sql`
    UPDATE military_unit_templates SET
      prod_upkeep_per_unit = GREATEST(0.1, upkeep_per_unit * 0.5),
      upkeep_per_unit = GREATEST(0.1, upkeep_per_unit * 0.5)
    WHERE prod_upkeep_per_unit = 0
      AND name <> '全民皆兵民兵'
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS player_armies (
      id serial PRIMARY KEY,
      discord_user_id text NOT NULL
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      template_id integer NOT NULL
        REFERENCES military_unit_templates(id) ON DELETE CASCADE,
      quantity bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS player_armies_player_template_uidx
      ON player_armies (discord_user_id, template_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS player_armies_player_idx
      ON player_armies (discord_user_id)
  `);
  // 每支軍隊占用的生產力／人口預留量（解散／刪除時等比例釋放，修正
  // 「解散後生產力仍被占用」的問題）。一次性 ADD，永不 DROP（避免
  // pg_attribute slot 洩漏）。
  await db.execute(sql`
    ALTER TABLE player_armies
      ADD COLUMN IF NOT EXISTS production_reserved bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE player_armies
      ADD COLUMN IF NOT EXISTS population_reserved bigint NOT NULL DEFAULT 0
  `);

  // Task #389 — NPC 常備軍（以國家 id 持有；quantity 含前線、committed =
  // 抽調在前線、wounded = 恢復池）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS npc_armies (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      template_id integer NOT NULL
        REFERENCES military_unit_templates(id) ON DELETE CASCADE,
      quantity bigint NOT NULL DEFAULT 0,
      committed bigint NOT NULL DEFAULT 0,
      wounded bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS npc_armies_nation_template_uidx
      ON npc_armies (nation_id, template_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS npc_armies_nation_idx
      ON npc_armies (nation_id)
  `);

  // Task #400 — 每日全國軍力快照（回合結算寫入；只存聚合人口值，不存編制）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS nation_military_snapshots (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      snapshot_date date NOT NULL,
      army_population bigint NOT NULL DEFAULT 0,
      wounded_population bigint NOT NULL DEFAULT 0,
      committed_population bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS nation_military_snapshots_nation_date_uidx
      ON nation_military_snapshots (nation_id, snapshot_date)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS nation_military_snapshots_nation_idx
      ON nation_military_snapshots (nation_id)
  `);

  // Task #27 曾在此建立 military_techs／player_researched_techs（軍事科技
  // 抽牌系統）。Task #469 全面改為全球統一線性科技樹（techTreeMigrations.ts），
  // 舊表於原建立處 supersede DROP（子表先刪）；研發進度全面重置、不遷移。
  await db.execute(sql`DROP TABLE IF EXISTS player_researched_techs`);
  await db.execute(sql`DROP TABLE IF EXISTS military_techs`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS military_purchase_quotas (
      id serial PRIMARY KEY,
      discord_user_id text NOT NULL
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      date_label text NOT NULL,
      used_units bigint NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS military_purchase_quotas_player_date_uidx
      ON military_purchase_quotas (discord_user_id, date_label)
  `);

  // Task #63 — 玩家對兵種模板的個人化名稱（預設兵種改名只影響自己）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS player_unit_customizations (
      id serial PRIMARY KEY,
      discord_user_id text NOT NULL
        REFERENCES player_nations(discord_user_id) ON DELETE CASCADE,
      template_id integer NOT NULL
        REFERENCES military_unit_templates(id) ON DELETE CASCADE,
      custom_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS player_unit_customizations_player_template_uidx
      ON player_unit_customizations (discord_user_id, template_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS player_unit_customizations_player_idx
      ON player_unit_customizations (discord_user_id)
  `);

  // Task #568 — 招募的「立即性生產力花費」流量紀錄（flow，不是 stock）：
  // 當回合判定 = created_at > world_game_state.last_turn_at（NULL 全算當回合）；
  // 回合引擎認領新回合後刪除過期列。絕不持久化進累積欄位。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS recruit_production_spends (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      template_id integer NOT NULL
        REFERENCES military_unit_templates(id) ON DELETE CASCADE,
      quantity bigint NOT NULL,
      amount bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS recruit_production_spends_nation_idx
      ON recruit_production_spends (nation_id)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS recruit_production_spends_created_at_idx
      ON recruit_production_spends (created_at)
  `);

  // Task #549 — 預設兵種全面移除（原種子 upsert 於原址 supersede 為刪除）：
  // 同一交易內先把引用預設模板的玩家軍隊預留量從 spent 釋放（維持不變量
  // spent = Σreserved），再刪除 is_default 模板列 —— FK CASCADE 一併清掉
  // player_armies／npc_armies／war_campaign_legion_units／player_wounded_units／
  // player_unit_customizations 中的關聯資料。天然 idempotent：重跑時已無
  // is_default 列，兩步皆為 no-op。
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE player_nations pn SET
        production_spent = GREATEST(0, pn.production_spent - agg.prod_reserved),
        population_spent = GREATEST(0, pn.population_spent - agg.pop_reserved)
      FROM (
        SELECT
          pa.discord_user_id,
          COALESCE(SUM(pa.production_reserved), 0)::bigint AS prod_reserved,
          COALESCE(SUM(pa.population_reserved), 0)::bigint AS pop_reserved
        FROM player_armies pa
        JOIN military_unit_templates t ON t.id = pa.template_id
        WHERE t.is_default = true
        GROUP BY pa.discord_user_id
      ) agg
      WHERE pn.discord_user_id = agg.discord_user_id
    `);
    await tx.execute(sql`
      DELETE FROM military_unit_templates WHERE is_default = true
    `);
  });

  // 招募訓練佇列（純新增表，永不 DROP）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS recruit_queue (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL REFERENCES player_nations(id) ON DELETE CASCADE,
      template_id integer NOT NULL REFERENCES military_unit_templates(id) ON DELETE CASCADE,
      total_quantity bigint NOT NULL,
      remaining bigint NOT NULL,
      tp_per_unit integer NOT NULL DEFAULT 1,
      production_reserved bigint NOT NULL DEFAULT 0,
      population_reserved bigint NOT NULL DEFAULT 0,
      wood_paid bigint NOT NULL DEFAULT 0,
      ore_paid bigint NOT NULL DEFAULT 0,
      money_paid bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS recruit_queue_nation_idx ON recruit_queue (nation_id)
  `);
  await backfillArmyReservations();

  // Task #572 — prodCostPer100 戰力比例下限回填：#568 之前此欄位不影響
  // 玩法，AI 產生的舊模板定價混亂（高戰力兵種標 1–3，近乎免費）；#568 起
  // prodCostPer100 直接閘住招募（一次性花費 ⌈數量×prodCostPer100÷100⌉）。
  // 只「調升到下限」（條件式 UPDATE，冪等）：下限 = ⌈(HP＋攻＋防)÷210⌉，
  // 與 clampUnitDesign 的伺服器端夾限同一條規則（gameBalance.ts
  // prodCostPowerFloor）；高於下限的定價（含管理員手動調整）一律保留。
  const repriced = await db.execute(sql`
    UPDATE military_unit_templates
    SET prod_cost_per_100 = GREATEST(1, CEIL(
          (GREATEST(hp, 0) + GREATEST(attack, 0) + GREATEST(defense, 0)) / 210.0
        )),
        updated_at = NOW()
    WHERE prod_cost_per_100 < GREATEST(1, CEIL(
          (GREATEST(hp, 0) + GREATEST(attack, 0) + GREATEST(defense, 0)) / 210.0
        ))
      AND name <> '全民皆兵民兵'
  `);
  if ((repriced.rowCount ?? 0) > 0) {
    logger.info(
      { repriced: repriced.rowCount },
      "raised under-priced unit prod_cost_per_100 to power floor",
    );
  }

  const templates = await db
    .select({ id: militaryUnitTemplatesTable.id })
    .from(militaryUnitTemplatesTable);
  logger.info(
    { templateCount: templates.length },
    "military migrations applied",
  );
}

/**
 * 一次性回填軍隊資源預留量（免 game_flags 旗標、可安全重跑）。
 *
 * 舊資料的 production_spent／population_spent 是累計計數，過去從未在解散時釋放，
 * 因此出現「解散後（甚至沒軍隊了）生產力仍被占用」。這裡把既有 spent 依各軍隊數量
 * 比例回填到每支軍隊的 production_reserved／population_reserved，維持不變量
 * spent = Σreserved；已無軍隊者直接把 spent 歸零（正是回報的情境）。
 *
 * 自我保護：只處理「spent>0 且該國所有軍隊 reserved 皆為 0」的舊資料。回填後這些列
 * reserved>0（或 spent 已歸零），前置條件即消失，故重開機不會重覆執行，也不會覆蓋
 * 修正後由徵召／解散正常維護的資料。
 *
 * 地區資源建築也占用 production_spent（region_buildings.production_reserved）——
 * 分配給軍隊或歸零前必須先扣除該份額，否則「有建築、沒軍隊」的國家每次開機都會被
 * 誤歸零（建築占用被吃掉）。region_buildings 的 production_reserved 欄位由較晚執行的
 * runResourceMigrations 建立，首次部署當次可能尚不存在 → 改以等級推算累計基礎成本
 * （與 backfillBuildingReservations 同一公式），絕不把建築份額當 0 歸零。
 */
async function backfillArmyReservations(): Promise<void> {
  // region_buildings（表／production_reserved 欄位）是否已存在（migration 順序守衛）。
  const tableCheck = await db.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'region_buildings'
    LIMIT 1
  `);
  const hasBuildingTable = tableCheck.rows.length > 0;
  const colCheck = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'region_buildings'
      AND column_name = 'production_reserved'
    LIMIT 1
  `);
  const hasBuildingReserved = colCheck.rows.length > 0;

  const legacy = await db.execute(sql`
    SELECT n.id AS "nationId",
           n.discord_user_id AS "discordUserId",
           n.production_spent AS "productionSpent",
           n.population_spent AS "populationSpent"
    FROM player_nations n
    WHERE n.discord_user_id IS NOT NULL
      AND (n.production_spent > 0 OR n.population_spent > 0)
      AND NOT EXISTS (
        SELECT 1 FROM player_armies a
        WHERE a.discord_user_id = n.discord_user_id
          AND (a.production_reserved > 0 OR a.population_reserved > 0)
      )
      -- 訓練佇列中的訂單同樣持有佔用（完成前不在 player_armies）：只有佇列、
      -- 還沒有軍隊的新玩家不是「舊資料」，不能在每次開機時被歸零。
      AND NOT EXISTS (
        SELECT 1 FROM recruit_queue q WHERE q.nation_id = n.id
      )
  `);
  const rows = legacy.rows as Array<{
    nationId: string;
    discordUserId: string;
    productionSpent: string | number;
    populationSpent: string | number;
  }>;

  let repaired = 0;
  for (const row of rows) {
    const userId = row.discordUserId;
    const populationSpent = Number(row.populationSpent);

    // 建築占用的生產力份額不屬於軍隊，先扣除（拆除時由建築路徑自行釋放）。
    let buildingReserved = 0;
    if (hasBuildingReserved) {
      const br = await db.execute(sql`
        SELECT COALESCE(SUM(production_reserved), 0) AS "reserved"
        FROM region_buildings
        WHERE nation_id = ${row.nationId}
      `);
      buildingReserved = Number(
        (br.rows[0] as { reserved?: string | number } | undefined)?.reserved ??
          0,
      );
    } else if (hasBuildingTable) {
      // 欄位尚未建立（首次部署當次）→ 以等級推算累計基礎成本，
      // 與 backfillBuildingReservations 之後回填的值一致。
      const lv = await db.execute(sql`
        SELECT level FROM region_buildings WHERE nation_id = ${row.nationId}
      `);
      for (const b of lv.rows as Array<{ level: string | number }>) {
        buildingReserved += cumulativeBuildingProductionCost(Number(b.level));
      }
    }
    const productionSpent = Math.max(
      0,
      Number(row.productionSpent) - buildingReserved,
    );

    // spent 全數屬於建築占用（軍隊份額為 0）→ 保持原值，不需回填也不得歸零。
    if (productionSpent === 0 && populationSpent === 0 && buildingReserved > 0) {
      continue;
    }

    const armies = await db
      .select({
        id: playerArmiesTable.id,
        quantity: playerArmiesTable.quantity,
      })
      .from(playerArmiesTable)
      .where(
        and(
          eq(playerArmiesTable.discordUserId, userId),
          gt(playerArmiesTable.quantity, 0),
        ),
      );

    if (armies.length === 0) {
      // 沒有（有效）軍隊卻仍占著資源 → 正是回報的 bug；生產力保留建築份額。
      await db
        .update(playerNationsTable)
        .set({ productionSpent: buildingReserved, populationSpent: 0 })
        .where(eq(playerNationsTable.discordUserId, userId));
      repaired += 1;
      continue;
    }

    const weights = armies.map((a) => a.quantity);
    const prodAlloc = allocateProportionally(weights, productionSpent);
    const popAlloc = allocateProportionally(weights, populationSpent);
    await db.transaction(async (tx) => {
      for (let i = 0; i < armies.length; i += 1) {
        await tx
          .update(playerArmiesTable)
          .set({
            productionReserved: prodAlloc[i] ?? 0,
            populationReserved: popAlloc[i] ?? 0,
          })
          .where(eq(playerArmiesTable.id, armies[i]!.id));
      }
    });
    repaired += 1;
  }

  if (repaired > 0) {
    logger.info({ repaired }, "backfilled army resource reservations");
  }
}
