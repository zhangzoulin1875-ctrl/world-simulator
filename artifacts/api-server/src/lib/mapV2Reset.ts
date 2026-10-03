import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";
import { withMigrationLockStamped } from "./migrationLock";

const RESET_FLAG = "map-v2-343-region-reset";

/**
 * Task #270 — 地圖二代（202 → 343 區）重切：一次性重置所有「地區綁定」的
 * 遊戲資料，讓玩家在新地圖上重新建立掌控。國家本身（player_nations 列、名稱、
 * 領袖、金錢、科技、各項數值、圖片、政體）、遊戲外觀、背景音樂一律保留。
 *
 * 為何需要「顯式」重置，而不能只靠 runMapRegionSync 的 stale-delete 級聯：
 *  - runMapRegionSync 以「名稱」upsert，少數新舊同名區會以同一 id 存活，其
 *    region_controls／戰役會殘留、但地理意義已改變，形成不一致的殘留狀態。
 *  - player_wounded_units（全國傷兵池）與 diplomacy_wars（開戰狀態）沒有
 *    map_regions 外鍵，永遠不會被級聯清掉。
 * 因此在地圖同步後、軍事／外交遷移前做一次確定性的全清除。
 *
 * 一次性保證：以 game_flags 原子認領旗標，整個任務只跑一次（重啟不重複、也不
 * 會清掉玩家日後在新地圖上重新建立的掌控／戰爭）。全程單一交易：先認領旗標，
 * 認領成功才依 FK 由子到父刪除；交易若失敗，旗標與刪除一起回滾。
 *
 * 放置時機（bootstrap 在 runMapCitySync 之後、runMilitaryMigrations 之前）：
 *  - 全新 DB：此時 war_*／diplomacy_*／game_flags 尚未建立，各刪除以
 *    to_regclass 守衛跳過，等同 no-op；旗標寫入後，之後的外交遷移才植入
 *    NPC「德國」及其掌控 → 不會被本重置清掉。
 *  - 既有 202 DB：war_*／diplomacy_*／region_controls 皆存在（前次啟動建立），
 *    同名殘留掌控、戰役、傷兵、開戰狀態一次清乾淨。
 */
export async function runMapV2RegionReset(): Promise<void> {
  await withMigrationLockStamped("map-v2-reset", runMapV2RegionResetInner);
}

/** FK 由子到父的刪除順序（child tables first）。全部為硬編碼常數，故可用 sql.raw。 */
const REGION_BOUND_TABLES: readonly string[] = [
  "war_campaign_reports",
  "war_campaign_orders",
  "war_campaign_legion_units",
  "war_campaign_legions",
  "war_campaigns",
  "war_region_engagements",
  "war_region_cooldowns",
  "player_wounded_units",
  "region_controls",
  "diplomacy_wars",
];

async function runMapV2RegionResetInner(): Promise<void> {
  // 本模組在外交遷移之前執行，game_flags 可能尚未建立；自建以保證自足。
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_flags (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  await db.transaction(async (tx) => {
    // 原子認領：只有第一次成功插入者才執行清除。
    const claim = await tx.execute(sql`
      INSERT INTO game_flags (key) VALUES (${RESET_FLAG})
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `);
    if (claim.rows.length === 0) {
      return; // 先前啟動已重置過。
    }

    const cleared: string[] = [];
    for (const table of REGION_BOUND_TABLES) {
      const exists = await tx.execute<{ reg: string | null }>(
        sql`SELECT to_regclass(${table}) AS reg`,
      );
      if (!(exists.rows[0] as { reg: string | null } | undefined)?.reg) {
        continue; // 全新 DB 上尚未建立的表 → 跳過。
      }
      await tx.execute(sql.raw(`DELETE FROM ${table}`));
      cleared.push(table);
    }

    // 提案中條約可能夾帶指向舊地區 id 的 offer_region_ids（jsonb，無外鍵）。
    // 清成空陣列，避免日後啟用時嘗試轉移已不存在的地區。保留條約本身與外交關係。
    const treatyExists = await tx.execute<{ reg: string | null }>(
      sql`SELECT to_regclass('diplomacy_treaties') AS reg`,
    );
    if ((treatyExists.rows[0] as { reg: string | null } | undefined)?.reg) {
      await tx.execute(sql`
        UPDATE diplomacy_treaties
          SET offer_region_ids = '[]'::jsonb
          WHERE status = 'proposed' AND offer_region_ids <> '[]'::jsonb
      `);
    }

    logger.warn(
      { cleared },
      "map v2 (343) region reset: cleared region-bound game data (nations/appearance/music preserved)",
    );
  });
}
