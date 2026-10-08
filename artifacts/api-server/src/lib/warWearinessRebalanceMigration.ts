import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

/**
 * 厭戰度再平衡的一次性設定升級(2026-10-08)。
 *
 * 為什麼需要:game_balance_settings 是「全量寫入」——管理員在後台按過一次儲存,
 * 資料庫裡就有整包舊值,單改程式預設值對線上不會生效。
 *
 * 做法:每個欄位獨立判斷,「等於舊預設,或欄位不存在」才改成新預設;管理員刻意
 * 調過的值(任何不同於舊預設的數字)完全不碰。以 game_flags 原子認領,只跑一次,
 * 之後管理員再改回舊值也不會被蓋掉。表或列不存在時什麼都不做(新環境直接用新預設)。
 *
 * 舊預設 → 新預設:
 *   warWearinessWartimeRecovery   0   → 2
 *   warWearinessPeacetimeRecovery 3   → 5
 *   warWearinessGainMultiplierPct 100 → 65
 */
export const WEARINESS_REBALANCE_FLAG = "war-weariness-rebalance-20261008";

const UPGRADES = [
  { key: "warWearinessWartimeRecovery", from: 0, to: 2 },
  { key: "warWearinessPeacetimeRecovery", from: 3, to: 5 },
  { key: "warWearinessGainMultiplierPct", from: 100, to: 65 },
] as const;

export async function runWarWearinessRebalanceMigration(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS game_flags (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await db.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      INSERT INTO game_flags (key) VALUES (${WEARINESS_REBALANCE_FLAG})
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `);
    if (claimed.rows.length === 0) return;

    const row = await tx.execute(
      sql`SELECT params FROM game_balance_settings WHERE id = 1 FOR UPDATE`,
    );
    if (row.rows.length === 0) return; // 沒存過設定 → 直接吃新預設
    const params = (row.rows[0] as { params: unknown }).params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return;

    const root = params as Record<string, unknown>;
    const war = root.war;
    if (!war || typeof war !== "object" || Array.isArray(war)) return;

    const next: Record<string, unknown> = { ...(war as Record<string, unknown>) };
    const changed: string[] = [];
    for (const u of UPGRADES) {
      const cur = next[u.key];
      // 欄位不存在 → zod 會補新預設,不必動;等於舊預設才升級;其餘視為管理員刻意設定。
      if (cur === u.from) {
        next[u.key] = u.to;
        changed.push(`${u.key}: ${u.from}→${u.to}`);
      }
    }
    if (changed.length === 0) return;

    await tx.execute(sql`
      UPDATE game_balance_settings
      SET params = ${JSON.stringify({ ...root, war: next })}::jsonb, updated_at = NOW()
      WHERE id = 1
    `);
    logger.info({ changed }, "war weariness rebalance applied to stored game balance");
  });
}
