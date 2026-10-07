import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { cumulativeBuildingProductionCost } from "./regionBuildings";
import { withTestMigrationStamp } from "./migrationLock";

/**
 * Task #406 — 資源系統（木材／礦石）的 idempotent 啟動遷移。
 * 必須在 runMilitaryMigrations 與 runDiplomacyMigrations 之後執行
 * （FK 依賴 player_nations／map_regions；條約欄位依賴 diplomacy_treaties）。
 *
 * 與其他啟動遷移一樣不包 try/catch：失敗必須讓 bootstrap 大聲失敗。
 * 所有 ADD COLUMN 一次性、永不 DROP（避免 pg_attribute slot 洩漏）。
 */
export async function runResourceMigrations(): Promise<void> {
  await withTestMigrationStamp("resource", runResourceMigrationsInner);
}

/**
 * 匯出供「驗證遷移本身行為」的測試直呼（繞過測試回合的遷移戳記快速路徑）：
 * regionBuildings.race.test.ts 會在測試主體內重跑本遷移驗證 spent=Σreserved
 * 的不變量修復。正常啟動一律走 runResourceMigrations。
 */
export async function runResourceMigrationsInner(): Promise<void> {
  // 國家資源庫存。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS wood bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS ore bigint NOT NULL DEFAULT 0
  `);
  // 補給系統 — 彈藥庫存(軍工廠產出/NPC 配額,戰役結算時扣減)。
  await db.execute(sql`
    ALTER TABLE player_nations
      ADD COLUMN IF NOT EXISTS ammo bigint NOT NULL DEFAULT 0
  `);

  // 地區資源建築：每地區每種建築最多一座（unique → 409）。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS region_buildings (
      id serial PRIMARY KEY,
      nation_id uuid NOT NULL
        REFERENCES player_nations(id) ON DELETE CASCADE,
      region_id integer NOT NULL
        REFERENCES map_regions(id) ON DELETE CASCADE,
      building_type text NOT NULL,
      level integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS region_buildings_region_type_uidx
      ON region_buildings (region_id, building_type)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS region_buildings_nation_idx
      ON region_buildings (nation_id)
  `);
  // 拆除釋放生產力用：本建築歷來占用的生產力總額（建造＋升級累計）。
  await db.execute(sql`
    ALTER TABLE region_buildings
      ADD COLUMN IF NOT EXISTS production_reserved bigint NOT NULL DEFAULT 0
  `);
  await backfillBuildingReservations();
  await reconcileNationProductionSpent();

  // 條約的一次性木材／礦石交換欄位（offer* 付款方付出、request* 對方付出）。
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS offer_wood bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS offer_ore bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_wood bigint NOT NULL DEFAULT 0
  `);
  await db.execute(sql`
    ALTER TABLE diplomacy_treaties
      ADD COLUMN IF NOT EXISTS request_ore bigint NOT NULL DEFAULT 0
  `);

  logger.info("resource migrations applied");
}

/**
 * 舊建築的 production_reserved 回填（免旗標、可安全重跑）：
 * 只處理 reserved = 0 的列（新建／升級路徑一律寫入 >0，活著的建築不會合法為 0），
 * 以「基礎累計成本 Σ ceil(200 × 1.2^(l−1))」估算——成本倍率（Task #523）上線
 * 前的建築即為此值。回填後前置條件消失，重開機不會重覆執行。
 */
async function backfillBuildingReservations(): Promise<void> {
  const legacy = await db.execute(sql`
    SELECT id, level FROM region_buildings WHERE production_reserved = 0
  `);
  const rows = legacy.rows as Array<{ id: number; level: number }>;
  for (const row of rows) {
    await db.execute(sql`
      UPDATE region_buildings
      SET production_reserved = ${cumulativeBuildingProductionCost(Number(row.level))}
      WHERE id = ${row.id} AND production_reserved = 0
    `);
  }
  if (rows.length > 0) {
    logger.info(
      { backfilled: rows.length },
      "backfilled region building production reservations",
    );
  }
}

/**
 * 不變量修復（idempotent、每次開機安全重跑）：production_spent 必須
 * ≥ Σ(軍隊 production_reserved) + Σ(建築 production_reserved)。
 *
 * 歷史 bug：backfillArmyReservations 在建築占用可見之前，曾把「有建築、沒軍隊」
 * 國家的 production_spent 整個歸零（建築份額被吃掉、可用生產力被灌水）。欄位回填
 * 之後這裡把 spent 拉回至少 Σreserved。只往上補、永不調低——前線／傷兵等額外
 * 占用可能讓 spent 合法高於 Σreserved。單條 UPDATE 原子執行，避免與遊戲中
 * 併發的建造／解散互踩。
 */
async function reconcileNationProductionSpent(): Promise<void> {
  const repaired = await db.execute(sql`
    UPDATE player_nations n
    SET production_spent =
      COALESCE((SELECT SUM(a.production_reserved) FROM player_armies a
                WHERE a.discord_user_id = n.discord_user_id), 0)
      + COALESCE((SELECT SUM(b.production_reserved) FROM region_buildings b
                  WHERE b.nation_id = n.id), 0)
    WHERE n.production_spent <
      COALESCE((SELECT SUM(a.production_reserved) FROM player_armies a
                WHERE a.discord_user_id = n.discord_user_id), 0)
      + COALESCE((SELECT SUM(b.production_reserved) FROM region_buildings b
                  WHERE b.nation_id = n.id), 0)
    RETURNING n.id
  `);
  if (repaired.rows.length > 0) {
    logger.info(
      { repaired: repaired.rows.length },
      "reconciled nation production_spent to reserved sums",
    );
  }
}
